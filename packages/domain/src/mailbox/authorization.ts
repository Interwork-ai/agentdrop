import { AgentDropError } from '@agentdrop/contracts';
import {
  appUsers,
  deliveries,
  deliveryGrants,
  drops,
  groupBindings,
  groupMemberships,
  groups,
  harnessEndpoints,
  type Tx,
} from '@agentdrop/db';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { MailboxScope } from '../principals.js';

export interface AuthorizedDrop {
  drop: typeof drops.$inferSelect;
  /** Null when the H is only the sender (no mailbox entry), or when access comes from a group role or setting. */
  delivery: typeof deliveries.$inferSelect | null;
  isSender: boolean;
  sources: Array<'direct' | 'group' | 'sender' | 'group_admin' | 'group_history'>;
  groupIds: string[];
}

/**
 * Groups this user owns or administers that this drop was sent to. Grant revocation is ignored on purpose:
 * the point is the group's own history, including drops that predate the admin and drops whose recipients have
 * since left. Read-only — it produces no delivery, so nothing here can be marked read, starred or archived.
 */
export async function adminReadableGroups(
  tx: Tx,
  userId: string,
  dropId: string,
  /** Set when reads are narrowed to one H: the role then only reaches through an H that receives the group. */
  currentHId?: string,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ groupId: deliveryGrants.groupId })
    .from(deliveryGrants)
    .innerJoin(deliveries, eq(deliveries.id, deliveryGrants.deliveryId))
    .innerJoin(groupMemberships, eq(groupMemberships.groupId, deliveryGrants.groupId))
    .where(
      and(
        eq(deliveries.dropId, dropId),
        eq(deliveryGrants.kind, 'group'),
        eq(groupMemberships.userId, userId),
        eq(groupMemberships.status, 'active'),
        inArray(groupMemberships.role, ['owner', 'admin']),
        currentHId ? boundThrough(currentHId) : undefined,
      ),
    );
  return rows.map((r) => r.groupId).filter((id): id is string => id !== null);
}

/**
 * Admin history is an exception to the §3.4 history rules, not to per-H isolation (§1.1 #3): with account-wide
 * reads off, an H that does not itself receive the group must still see nothing of it.
 */
function boundThrough(hId: string) {
  return sql`exists (select 1 from ${groupBindings} b where b.membership_id = ${groupMemberships.id} and b.h_id = ${hId} and b.revoked_at is null)`;
}

/** Whether this user may read a group's whole history. */
export async function isGroupAdmin(
  tx: Tx,
  userId: string,
  groupId: string,
  currentHId?: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: groupMemberships.id })
    .from(groupMemberships)
    .where(
      and(
        eq(groupMemberships.groupId, groupId),
        eq(groupMemberships.userId, userId),
        eq(groupMemberships.status, 'active'),
        inArray(groupMemberships.role, ['owner', 'admin']),
        currentHId ? boundThrough(currentHId) : undefined,
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Groups whose owner made earlier messages visible to members (ADR 0022) that this user is an active member of
 * (any role) and that this drop was sent to. Like the admin rule: grant revocation is ignored, so the history
 * includes drops that predate the member and drops whose recipients have since left; the same per-H boundary
 * applies; and it is read-only, producing no delivery and no state.
 */
export async function historyReadableGroups(
  tx: Tx,
  userId: string,
  dropId: string,
  currentHId?: string,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ groupId: deliveryGrants.groupId })
    .from(deliveryGrants)
    .innerJoin(deliveries, eq(deliveries.id, deliveryGrants.deliveryId))
    .innerJoin(groups, eq(groups.id, deliveryGrants.groupId))
    .innerJoin(groupMemberships, eq(groupMemberships.groupId, deliveryGrants.groupId))
    .where(
      and(
        eq(deliveries.dropId, dropId),
        eq(deliveryGrants.kind, 'group'),
        eq(groups.historyVisible, true),
        eq(groupMemberships.userId, userId),
        eq(groupMemberships.status, 'active'),
        currentHId ? boundThrough(currentHId) : undefined,
      ),
    );
  return rows.map((r) => r.groupId).filter((id): id is string => id !== null);
}

/** Whether this user, as an active member, may read the group's whole history because its owner allowed it. */
export async function isHistoryVisibleMember(
  tx: Tx,
  userId: string,
  groupId: string,
  currentHId?: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: groupMemberships.id })
    .from(groupMemberships)
    .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
    .where(
      and(
        eq(groupMemberships.groupId, groupId),
        eq(groupMemberships.userId, userId),
        eq(groupMemberships.status, 'active'),
        eq(groups.historyVisible, true),
        currentHId ? boundThrough(currentHId) : undefined,
      ),
    )
    .limit(1);
  return !!row;
}

export type EndpointScope = 'account' | 'current';

/** Account-wide access is a user preference, but callers may always narrow a request to the current H. */
export async function effectiveEndpointScope(
  tx: Tx,
  scope: MailboxScope,
  requested?: EndpointScope,
): Promise<EndpointScope> {
  if (requested === 'current') return 'current';
  const user = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, scope.userId) });
  return user?.crossHMailboxEnabled ? 'account' : 'current';
}

export async function visibleEndpointIds(
  tx: Tx,
  scope: MailboxScope,
  requested?: EndpointScope,
): Promise<{ endpointScope: EndpointScope; hIds: string[] }> {
  const endpointScope = await effectiveEndpointScope(tx, scope, requested);
  if (endpointScope === 'current') return { endpointScope, hIds: [scope.hId] };
  const rows = await tx
    .select({ id: harnessEndpoints.id })
    .from(harnessEndpoints)
    .where(eq(harnessEndpoints.userId, scope.userId));
  return { endpointScope, hIds: rows.map((row) => row.id) };
}

/** SQL fragment: a delivery has at least one still-valid grant. */
export function hasValidGrant(deliveryId: typeof deliveries.id) {
  return sql`exists (select 1 from ${deliveryGrants} g where g.delivery_id = ${deliveryId} and g.revoked_at is null)`;
}

/**
 * THE authorization predicate for reading a drop from an H credential or owned web H view:
 *   drop exists and is not revoked/expired
 *   AND (the effective endpoint scope contains the sending H OR a delivery in that scope has ≥1 valid grant)
 * Account scope is enabled by the owner preference; callers may narrow to the current H but never widen a disabled
 * account. State mutations always request current scope separately.
 * Every reader (list, detail, attachments, state, search) must go through here or use `hasValidGrant`.
 */
export async function loadAuthorizedDrop(
  tx: Tx,
  scope: MailboxScope,
  dropId: string,
  requested?: EndpointScope,
): Promise<AuthorizedDrop> {
  const drop = await tx.query.drops.findFirst({ where: eq(drops.id, dropId) });
  if (!drop || drop.revokedAt || (drop.expiresAt && drop.expiresAt.getTime() <= Date.now())) {
    throw new AgentDropError('NOT_FOUND', 'drop not found');
  }
  const { endpointScope, hIds } = await visibleEndpointIds(tx, scope, requested);
  const deliveryRows = await tx
    .select({ delivery: deliveries })
    .from(deliveries)
    .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, deliveries.hId))
    .where(and(eq(deliveries.dropId, dropId), inArray(deliveries.hId, hIds)));
  const sources: AuthorizedDrop['sources'] = [];
  const groupIds: string[] = [];
  let authorizedDelivery: typeof deliveries.$inferSelect | null = null;
  let currentDelivery: typeof deliveries.$inferSelect | null = null;
  for (const { delivery } of deliveryRows) {
    const grants = await tx
      .select()
      .from(deliveryGrants)
      .where(and(eq(deliveryGrants.deliveryId, delivery.id), isNull(deliveryGrants.revokedAt)));
    if (grants.length === 0) continue;
    authorizedDelivery ??= delivery;
    if (delivery.hId === scope.hId) currentDelivery = delivery;
    for (const g of grants) {
      if (g.kind === 'direct' && !sources.includes('direct')) sources.push('direct');
      if (g.kind === 'group') {
        if (!sources.includes('group')) sources.push('group');
        if (g.groupId && !groupIds.includes(g.groupId)) groupIds.push(g.groupId);
      }
    }
  }
  const origin = await tx.query.harnessEndpoints.findFirst({
    where: eq(harnessEndpoints.id, drop.originHId),
  });
  const isSender =
    drop.originHId === scope.hId || (endpointScope === 'account' && origin?.userId === scope.userId);
  if (isSender) sources.push('sender');
  if (!isSender && sources.length === 0) {
    // Last resorts, kept after the delivery checks so ordinary reads never pay for them. First a group whose
    // history is visible to every member (ADR 0022): an ordinary read, not audited as an admin act. Only when that
    // does not apply, a group I own or administer (explicit, audited).
    const narrowed = endpointScope === 'current' ? scope.hId : undefined;
    for (const id of await historyReadableGroups(tx, scope.userId, dropId, narrowed)) {
      if (!sources.includes('group_history')) sources.push('group_history');
      if (!groupIds.includes(id)) groupIds.push(id);
    }
    if (sources.length === 0) {
      for (const id of await adminReadableGroups(tx, scope.userId, dropId, narrowed)) {
        if (!sources.includes('group_admin')) sources.push('group_admin');
        if (!groupIds.includes(id)) groupIds.push(id);
      }
    }
  }
  if (!isSender && sources.length === 0) throw new AgentDropError('NOT_FOUND', 'drop not found');
  return {
    drop,
    delivery: currentDelivery ?? (endpointScope === 'current' ? authorizedDelivery : null),
    isSender,
    sources,
    groupIds,
  };
}

/**
 * Who is looking, for the history-visible clause of the side projections: the user, and the one H their reads are
 * narrowed to when account-wide reads are off (`endpointScope === 'current'`), exactly as `loadAuthorizedDrop`.
 */
export interface HistoryViewer {
  userId: string;
  /** Set when reads are narrowed to one H: membership then only counts through an H bound to the group. */
  boundHId?: string | undefined;
}

/** The viewer for `readableDropIds`/`readableThrough`, derived from a scope and its resolved visibility. */
export function historyViewer(scope: MailboxScope, endpointScope: EndpointScope): HistoryViewer {
  return { userId: scope.userId, boundHId: endpointScope === 'current' ? scope.hId : undefined };
}

/**
 * Which of `dropIds` the viewer may read through a delivery, as the sender, or (with `viewer`) as an active member
 * of a group whose history is visible to members (ADR 0022): the set form of the predicate above, as lists apply it
 * (sent: the origin is in the visible endpoints; received: a delivery in them with a valid grant). `visibleHIds`
 * must come from `visibleEndpointIds`. Used for side projections (which drop a drop answers, reply counts). The
 * group-admin role is left out on purpose: reading a group's history as its admin is an explicit, audited request,
 * never something a reference reveals. Member history is ordinary access, so a reference to a drop the member can
 * open anyway names it. Revoked and expired drops are never readable.
 */
export async function readableDropIds(
  tx: Tx,
  visibleHIds: string[],
  dropIds: string[],
  viewer?: HistoryViewer,
): Promise<Set<string>> {
  if (dropIds.length === 0 || visibleHIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: drops.id })
    .from(drops)
    .where(and(inArray(drops.id, [...new Set(dropIds)]), readableThrough(visibleHIds, viewer)));
  return new Set(rows.map((r) => r.id));
}

/**
 * SQL condition on `drops`: live, and sent from or validly delivered to one of `visibleHIds`, or (with `viewer`)
 * sent to a history-visible group the viewer is an active member of (bound through `boundHId` when narrowed).
 */
export function readableThrough(visibleHIds: string[], viewer?: HistoryViewer) {
  return and(
    isNull(drops.revokedAt),
    sql`(${drops.expiresAt} is null or ${drops.expiresAt} > now())`,
    or(
      inArray(drops.originHId, visibleHIds),
      sql`exists (select 1 from ${deliveries} d where d.drop_id = ${drops.id} and d.h_id in (${sql.join(
        visibleHIds.map((id) => sql`${id}`),
        sql`, `,
      )}) and exists (select 1 from ${deliveryGrants} g where g.delivery_id = d.id and g.revoked_at is null))`,
      viewer ? historyVisibleThrough(viewer) : undefined,
    ),
  )!;
}

/** SQL condition on `drops`: sent to a group with history visible to members, and the viewer is an active member. */
function historyVisibleThrough(viewer: HistoryViewer) {
  const bound = viewer.boundHId
    ? sql` and exists (select 1 from ${groupBindings} b where b.membership_id = m.id and b.h_id = ${viewer.boundHId} and b.revoked_at is null)`
    : sql``;
  return sql`exists (select 1 from ${deliveries} hd
    join ${deliveryGrants} hg on hg.delivery_id = hd.id and hg.kind = 'group'
    join ${groups} gr on gr.id = hg.group_id and gr.history_visible
    join ${groupMemberships} m on m.group_id = hg.group_id and m.user_id = ${viewer.userId} and m.status = 'active'
    where hd.drop_id = ${drops.id}${bound})`;
}
