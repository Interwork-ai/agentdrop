import {
  AgentDropError,
  type ExportHeader,
  type ExportInput,
  type ExportRecord,
  LIMITS,
} from '@agentdrop/contracts';
import {
  appUsers,
  attachments,
  type Database,
  deliveries,
  deliveryGrants,
  dropAttachments,
  drops,
  groupMemberships,
  groups,
  type Tx,
} from '@agentdrop/db';
import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { openDropForList } from '../content/codec.js';
import type { MailboxScope } from '../principals.js';
import { isGroupAdmin, isHistoryVisibleMember, visibleEndpointIds } from './authorization.js';
import { type AuthorSnapshot, authorCards, notExpired, preview, toAttachmentMeta } from './read.js';

/**
 * Date-ranged export, in two phases on purpose.
 *
 * Phase one resolves which drops are in scope and commits the audit row; phase two reads their bodies outside
 * any transaction. Doing it in one pass would hold a pooled connection for the whole download — the pool is 10
 * connections wide and there is no statement timeout, so a handful of slow exports would starve every other
 * request. It also means the count is known before the first byte, which is what makes a truncated file
 * detectable, and that the audit row survives a client that disconnects mid-stream.
 */

const CHUNK = 200;

export interface ExportPlan {
  header: Omit<ExportHeader, 'record' | 'format_version' | 'generated_at'>;
  dropIds: string[];
  /** Resolved once so phase two does not re-derive it per chunk. */
  visibleHIds: string[];
  adminHistory: boolean;
  /** The group's history is visible to its members (ADR 0022) and the exporter is one: an ordinary read. */
  memberHistory: boolean;
}

function parseRange(input: ExportInput): { since: Date; until: Date } {
  const since = new Date(input.since);
  const until = new Date(input.until);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()))
    throw new AgentDropError('VALIDATION_FAILED', 'since and until must be ISO timestamps');
  if (until <= since)
    throw new AgentDropError('VALIDATION_FAILED', 'until must be after since', { field: 'until' });
  const days = (until.getTime() - since.getTime()) / 86_400_000;
  if (days > LIMITS.EXPORT_MAX_DAYS)
    throw new AgentDropError('VALIDATION_FAILED', 'the range is too long; export it in shorter periods', {
      field: 'until',
      max_days: LIMITS.EXPORT_MAX_DAYS,
    });
  return { since, until };
}

/** Drops nobody may read any more are absent from every other reader; an audit export is not an exception. */
function liveInRange(since: Date, until: Date) {
  return and(isNull(drops.revokedAt), notExpired(), gte(drops.createdAt, since), lt(drops.createdAt, until))!;
}

/**
 * Peer scope: **direct traffic only**, both directions.
 *
 * Outbound is answered from the author's own frozen `target_snapshot.user_ids` rather than by joining the other
 * person's deliveries. The join would be cheap and wrong: for a group send it would disclose which members
 * received which drop, which is exactly what the group recipient card withholds (it reports a count and no
 * addresses). The snapshot only ever records direct and route targets, so this is also why a per-contact export
 * has no group traffic in it — that belongs to the group export, where the authorization is explicit.
 */
function peerSelection(peerUserId: string, visibleHIds: string[], since: Date, until: Date) {
  const containment = JSON.stringify({ user_ids: [peerUserId] });
  const inbound = and(
    eq(drops.authorUserId, peerUserId),
    sql`exists (
      select 1 from ${deliveries} dl
      join ${deliveryGrants} g on g.delivery_id = dl.id and g.revoked_at is null and g.kind = 'direct'
      where dl.drop_id = ${drops.id} and dl.h_id in ${visibleHIds}
    )`,
  )!;
  // Endpoint-scoped, not account-scoped: a user who turned cross-agent reading off, or a caller narrowing to
  // `current`, must not get what their other agents sent. `author_user_id` alone would hand over the account.
  const outbound = and(
    inArray(drops.originHId, visibleHIds),
    sql`${drops.targetSnapshot} @> ${containment}::jsonb`,
  )!;
  return and(liveInRange(since, until), or(inbound, outbound))!;
}

async function planPeer(
  tx: Tx,
  input: ExportInput,
  visibleHIds: string[],
  since: Date,
  until: Date,
): Promise<{ ids: Array<{ id: string }>; peerHandle: string | null }> {
  const peerUserId = input.peer_user_id;
  if (!peerUserId)
    throw new AgentDropError('VALIDATION_FAILED', 'peer_user_id is required for a peer export', {
      field: 'peer_user_id',
    });
  const peer = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, peerUserId) });
  // Selecting from `drops` rather than from deliveries: one row per drop, so no dedup pass is needed even when
  // a drop reached several of my agents, and `peer === me` cannot yield it twice.
  const rows = await tx
    .select({ id: drops.id })
    .from(drops)
    .where(peerSelection(peerUserId, visibleHIds, since, until))
    .orderBy(asc(drops.createdAt), asc(drops.id))
    .limit(LIMITS.EXPORT_MAX_DROPS + 1);
  // An unknown id and a real-but-unrelated one must look the same, or this route becomes a user-id probe.
  return { ids: rows, peerHandle: rows.length > 0 && peer ? peer.handle : null };
}

async function planGroup(
  tx: Tx,
  scope: MailboxScope,
  input: ExportInput,
  visibility: { endpointScope: 'account' | 'current'; hIds: string[] },
  since: Date,
  until: Date,
): Promise<{
  ids: Array<{ id: string }>;
  slug: string | null;
  adminHistory: boolean;
  memberHistory: boolean;
}> {
  const visibleHIds = visibility.hIds;
  const groupId = input.group_id;
  if (!groupId)
    throw new AgentDropError('VALIDATION_FAILED', 'group_id is required for a group export', {
      field: 'group_id',
    });
  /*
   * No 404 for a group that exists but is not mine, and no 404 for one that does not exist: both answer with an
   * empty export. Distinguishing them would turn this route into a probe for which group ids are real.
   */
  const member = await tx.query.groupMemberships.findFirst({
    where: and(
      eq(groupMemberships.groupId, groupId),
      eq(groupMemberships.userId, scope.userId),
      eq(groupMemberships.status, 'active'),
    ),
  });
  const group = member ? await tx.query.groups.findFirst({ where: eq(groups.id, groupId) }) : null;
  if (!group) return { ids: [], slug: null, adminHistory: false, memberHistory: false };
  const narrowed = visibility.endpointScope === 'current' ? scope.hId : undefined;
  // When the owner made earlier messages visible to members (ADR 0022), the whole history is what every member
  // reads anyway, so it is what their export holds, flag or not, as an ordinary read.
  const memberHistory = await isHistoryVisibleMember(tx, scope.userId, groupId, narrowed);
  // Otherwise full history is never implied by being an admin: it is the same explicit opt-in the dashboard requires.
  const adminHistory =
    !memberHistory &&
    input.include_group_history === true &&
    (await isGroupAdmin(tx, scope.userId, groupId, narrowed));
  if (input.include_group_history === true && !adminHistory && !memberHistory)
    throw new AgentDropError('FORBIDDEN', 'only an owner or admin may export a group history');
  const mine = and(inArray(deliveries.hId, visibleHIds), isNull(deliveryGrants.revokedAt))!;
  const rows = await tx
    .selectDistinct({ id: drops.id, createdAt: drops.createdAt })
    .from(drops)
    .innerJoin(deliveries, eq(deliveries.dropId, drops.id))
    .innerJoin(deliveryGrants, eq(deliveryGrants.deliveryId, deliveries.id))
    .where(
      and(
        liveInRange(since, until),
        eq(deliveryGrants.kind, 'group'),
        eq(deliveryGrants.groupId, groupId),
        ...(adminHistory || memberHistory ? [] : [mine]),
      ),
    )
    .orderBy(asc(drops.createdAt), asc(drops.id))
    .limit(LIMITS.EXPORT_MAX_DROPS + 1);
  return { ids: rows.map((r) => ({ id: r.id })), slug: group.slug, adminHistory, memberHistory };
}

/**
 * Phase one. Resolves the id set, enforces the ceiling, and commits one audit row that already knows the count.
 * Must run inside a short transaction of its own and be committed before any byte of the body is written.
 */
export async function planExport(tx: Tx, scope: MailboxScope, input: ExportInput): Promise<ExportPlan> {
  const { since, until } = parseRange(input);
  const visibility = await visibleEndpointIds(tx, scope, input.endpoint_scope);
  const includeBody = input.include_body === true;

  let ids: Array<{ id: string }>;
  let peerHandle: string | null = null;
  let slug: string | null = null;
  let adminHistory = false;
  let memberHistory = false;
  if (input.scope === 'peer') {
    const planned = await planPeer(tx, input, visibility.hIds, since, until);
    ids = planned.ids;
    peerHandle = planned.peerHandle;
  } else {
    const planned = await planGroup(tx, scope, input, visibility, since, until);
    ids = planned.ids;
    slug = planned.slug;
    adminHistory = planned.adminHistory;
    memberHistory = planned.memberHistory;
  }

  if (ids.length > LIMITS.EXPORT_MAX_DROPS)
    throw new AgentDropError('VALIDATION_FAILED', 'too many drops in this range; export a shorter period', {
      limit: LIMITS.EXPORT_MAX_DROPS,
      field: 'until',
    });

  await recordAudit(tx, {
    actorUserId: scope.userId,
    hId: scope.hId,
    /*
     * Reading a group's history as an admin is a distinct disclosure, exactly as it is for a single read
     * (`drop.read.group_admin`), so it gets its own action rather than hiding inside the ordinary one.
     * `include_body` is recorded because a metadata-only export and a full-body export are not the same act.
     */
    action: adminHistory ? 'drop.export.group_admin' : 'drop.export',
    targetId: input.scope === 'peer' ? (input.peer_user_id ?? null) : (input.group_id ?? null),
    result: 'ok',
    meta: {
      scope: input.scope,
      count: ids.length,
      since: since.toISOString(),
      until: until.toISOString(),
      include_body: includeBody,
      endpoint_scope: visibility.endpointScope,
      ...(memberHistory ? { group_history: true } : {}),
    },
  });

  return {
    header: {
      scope: input.scope,
      peer_user_id: input.scope === 'peer' ? (input.peer_user_id ?? null) : null,
      peer_handle: peerHandle,
      group_id: input.scope === 'group' ? (input.group_id ?? null) : null,
      group_slug: slug,
      since: since.toISOString(),
      until: until.toISOString(),
      count: ids.length,
      include_body: includeBody,
      include_group_history: adminHistory || memberHistory,
      endpoint_scope: visibility.endpointScope,
      notes: {
        ordered_by: 'drop.created_at,drop.id',
        range: '[since, until)',
        excludes_revoked: true,
        excludes_expired: true,
        excludes_group_traffic: input.scope === 'peer',
      },
    },
    dropIds: ids.map((r) => r.id),
    visibleHIds: visibility.hIds,
    adminHistory,
    memberHistory,
  };
}

/**
 * Phase two. Reads one chunk of the planned ids with no transaction open, so the connection goes back to the
 * pool between chunks. Never reports anything derived from the other side's endpoints.
 */
export async function readExportChunk(
  db: Database,
  scope: MailboxScope,
  plan: ExportPlan,
  ids: string[],
  includeBody: boolean,
): Promise<ExportRecord[]> {
  if (ids.length === 0) return [];
  const tx = db.drizzle;
  /*
   * The plan fixed the id set, but the body streams for minutes afterwards. A drop revoked or expired in the
   * meantime, or one I lost access to (removed from the group, demoted as admin), is left out here rather than
   * sent anyway; the trailer reports how many were omitted so the file still verifies against its header.
   */
  const rows = await tx
    .select()
    .from(drops)
    .where(and(inArray(drops.id, ids), isNull(drops.revokedAt), notExpired()));
  const narrowed = plan.header.endpoint_scope === 'current' ? scope.hId : undefined;
  const stillAdmin =
    plan.adminHistory && plan.header.group_id
      ? await isGroupAdmin(tx, scope.userId, plan.header.group_id, narrowed)
      : false;
  // the owner may have closed the history, or the member left, while the file streams
  const stillMember =
    plan.memberHistory && plan.header.group_id
      ? await isHistoryVisibleMember(tx, scope.userId, plan.header.group_id, narrowed)
      : false;
  const byId = new Map(rows.map((d) => [d.id, d]));

  const grantRows = await tx
    .select({ dropId: deliveries.dropId, kind: deliveryGrants.kind, groupId: deliveryGrants.groupId })
    .from(deliveries)
    .innerJoin(deliveryGrants, eq(deliveryGrants.deliveryId, deliveries.id))
    .where(
      and(
        inArray(deliveries.dropId, ids),
        inArray(deliveries.hId, plan.visibleHIds),
        isNull(deliveryGrants.revokedAt),
      ),
    );

  const atts = await tx
    .select({ dropId: dropAttachments.dropId, a: attachments })
    .from(dropAttachments)
    .innerJoin(attachments, eq(attachments.id, dropAttachments.attachmentId))
    .where(inArray(dropAttachments.dropId, ids));

  const card = await authorCards(
    tx,
    scope.userId,
    rows.map((d) => ({
      authorUserId: d.authorUserId,
      snapshot: d.authorSnapshot as AuthorSnapshot,
    })),
  );

  return ids.flatMap((id) => {
    const d = byId.get(id);
    if (!d) return [];
    const mine = grantRows.filter((g) => g.dropId === id);
    const sources: ExportRecord['sources'] = [];
    if (mine.some((g) => g.kind === 'direct')) sources.push('direct');
    if (mine.some((g) => g.kind === 'group')) sources.push('group');
    if (plan.visibleHIds.includes(d.originHId)) sources.push('sender');
    // A member or admin reading pre-membership history has no delivery of their own; say so rather than leaving
    // it blank.
    if (sources.length === 0 && stillMember) sources.push('group_history');
    if (sources.length === 0 && stillAdmin) sources.push('group_admin');
    if (sources.length === 0) return [];
    const content = openDropForList(d);
    return [
      {
        record: 'drop' as const,
        drop_id: d.id,
        created_at: d.createdAt.toISOString(),
        direction: d.authorUserId === scope.userId ? ('out' as const) : ('in' as const),
        // a member or admin exporting history they never received does not get the author's email from it
        // (ADR 0012) unless the author is otherwise visible to them as a person
        author: card(
          d.authorUserId,
          d.authorSnapshot as AuthorSnapshot,
          sources.includes('direct') || sources.includes('group'),
        ),
        title: content.title,
        ...(includeBody ? { body: content.body } : {}),
        preview: preview(content.body),
        body_chars: d.bodyChars,
        sources,
        group_ids: [...new Set(mine.map((g) => g.groupId).filter((g): g is string => g !== null))],
        attachments: atts.filter((x) => x.dropId === id).map((x) => toAttachmentMeta(x.a)),
      },
    ];
  });
}

export const EXPORT_CHUNK = CHUNK;
