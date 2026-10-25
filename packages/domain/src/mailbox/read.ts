import {
  AgentDropError,
  type AttachmentMeta,
  type DropDelivery,
  type DropDetail,
  type DropSummary,
  type GroupLabel,
  LIMITS,
  type ListDropsInput,
  type ReadDropInput,
  type RecipientStatus,
  type RepliesInfo,
  type ReplyRef,
  resolvedRecipientSchema,
} from '@agentdrop/contracts';
import {
  appUsers,
  attachments,
  deliveries,
  deliveryGrants,
  dropAttachments,
  drops,
  groupMemberships,
  groups,
  harnessEndpoints,
  sendRequests,
  type Tx,
} from '@agentdrop/db';
import { and, desc, eq, inArray, isNotNull, isNull, or, type SQLWrapper, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { profileVisibility, remarksFor } from '../contacts/directory.js';
import { openAttachmentMeta, openDrop, openDropForList } from '../content/codec.js';
import { sha256Hex } from '../crypto.js';
import type { MailboxScope } from '../principals.js';
import {
  type HistoryViewer,
  hasValidGrant,
  historyViewer,
  isGroupAdmin,
  isHistoryVisibleMember,
  loadAuthorizedDrop,
  readableDropIds,
  readableThrough,
  visibleEndpointIds,
} from './authorization.js';
import { privateRecipientsMany } from './recipient-privacy.js';

interface Cursor {
  t: string;
  id: string;
  /** Binds the cursor to (H, view, filters): reusing it elsewhere is RESYNC_REQUIRED, never a silent skip. */
  k: string;
}

function cursorScope(scope: MailboxScope, input: ListDropsInput, memberHistory = false): string {
  return sha256Hex(
    JSON.stringify([
      scope.hId,
      input.endpoint_scope ?? '',
      input.view,
      input.query?.trim() ?? '',
      !!input.unread_only,
      input.group_id ?? '',
      !!input.include_group_history,
      // A group timeline that turned into the whole history (or back) is ordered differently: an old cursor must
      // not be carried across. Appended only when on, so every other cursor keeps its value.
      ...(memberHistory ? ['group_history'] : []),
    ]),
  ).slice(0, 16);
}
function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}
function decodeCursor(raw: string | undefined, expectedScope: string): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (
      typeof c.t !== 'string' ||
      typeof c.id !== 'string' ||
      typeof c.k !== 'string' ||
      Number.isNaN(Date.parse(c.t)) ||
      !/^[0-9a-f-]{36}$/.test(c.id)
    )
      throw new Error('bad');
    if (c.k !== expectedScope) throw new Error('scope');
    return { t: c.t, id: c.id, k: c.k };
  } catch {
    throw new AgentDropError('RESYNC_REQUIRED', 'cursor does not belong to this mailbox view');
  }
}

export function preview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > LIMITS.PREVIEW_CHARS ? `${flat.slice(0, LIMITS.PREVIEW_CHARS - 1)}…` : flat;
}

export type AuthorSnapshot = {
  user_id: string;
  handle: string;
  display_name: string;
  public_name: string | null;
};

/**
 * Author cards for a page of drops. The author's live public email (ADR 0012) is shown only where the author is
 * already visible to the viewer as a person: the viewer is the author, actually received this drop (a live direct
 * or group grant; `received`), or is currently an accepted contact or an active co-member of the author. Reading a
 * group's history as its owner/admin is none of these. A block in either direction hides it in every case.
 */
export async function authorCards(
  tx: Tx,
  viewerUserId: string,
  rows: Array<{ authorUserId: string; snapshot: AuthorSnapshot }>,
) {
  const ids = [...new Set(rows.map((r) => r.authorUserId))];
  const remarks = await remarksFor(tx, viewerUserId, ids);
  const current = ids.length
    ? await tx
        .select({
          id: appUsers.id,
          handle: appUsers.handle,
          displayName: appUsers.displayName,
          publicEmail: appUsers.publicEmail,
        })
        .from(appUsers)
        .where(inArray(appUsers.id, ids))
    : [];
  const { related, blocked } = await profileVisibility(tx, viewerUserId, ids);
  const byId = new Map(current.map((u) => [u.id, u]));
  /** `received`: the viewer holds a delivery of this drop with a live direct or group grant. */
  return (authorUserId: string, snapshot: AuthorSnapshot, received: boolean) => {
    const now = byId.get(authorUserId);
    const handle = now?.handle ?? snapshot.handle;
    const nickname = now?.displayName ?? snapshot.display_name;
    const mayShowEmail =
      authorUserId === viewerUserId ||
      (!blocked.has(authorUserId) && (received || related.has(authorUserId)));
    return {
      user_id: authorUserId,
      handle,
      display_label: remarks.get(authorUserId) ?? nickname ?? `@${handle}`,
      // a per-agent signature would tell other people which of the author's agents wrote it (ADR 0013)
      public_name: authorUserId === viewerUserId ? (snapshot.public_name ?? null) : null,
      // always the live profile, never the send-time snapshot: withdrawing it (or closing the account) hides it
      // on old drops too (ADR 0012)
      public_email: mayShowEmail ? (now?.publicEmail ?? null) : null,
    };
  };
}

/** Non-destructive listing for the effective endpoint scope. Delivery state remains per H. */
export async function listDrops(
  tx: Tx,
  scope: MailboxScope,
  input: ListDropsInput,
): Promise<{
  drops: DropSummary[];
  nextCursor: string | null;
  unreadCount: number;
  /** Only for the unread inbox: how many of `unreadCount` stay quiet (muted groups, not calling on the person). */
  mutedUnreadCount?: number;
}> {
  const limit = Math.min(input.limit ?? LIMITS.LIST_LIMIT_DEFAULT, LIMITS.LIST_LIMIT_MAX);
  const visibility = await visibleEndpointIds(tx, scope, input.endpoint_scope);
  const scopedInput = { ...input, endpoint_scope: visibility.endpointScope };
  const narrowed = visibility.endpointScope === 'current' ? scope.hId : undefined;
  /*
   * A group's own history in place of the per-delivery timeline: for every active member when the owner made
   * earlier messages visible (ADR 0022, ordinary access), else for an owner/admin who explicitly asked for it
   * (audited). Starred, archived and unread are delivery state; a drop I never received has none, so those views
   * stay the ordinary per-delivery list instead of silently turning into the whole history.
   */
  const historyEligible = !!input.group_id && (input.view ?? 'inbox') === 'inbox' && !input.unread_only;
  const memberHistory =
    historyEligible && (await isHistoryVisibleMember(tx, scope.userId, input.group_id as string, narrowed));
  const adminHistory =
    historyEligible &&
    !memberHistory &&
    !!input.include_group_history &&
    (await isGroupAdmin(tx, scope.userId, input.group_id as string, narrowed));
  const k = cursorScope(scope, scopedInput, memberHistory);
  const cursor = decodeCursor(input.cursor, k);
  const q = input.query?.trim();
  const viewer = historyViewer(scope, visibility.endpointScope);

  if (input.view === 'space') return listSpace(tx, scope, input, { limit, cursor, k, q, visibility, viewer });

  if (input.view === 'sent') {
    const sentKeys = (after: ScanPosition | null, n: number) =>
      tx
        .select({ id: drops.id, t: usec(drops.createdAt) })
        .from(drops)
        .where(
          and(
            inArray(drops.originHId, visibility.hIds),
            isNull(drops.revokedAt),
            notExpired(),
            // what I kept for myself is not something I sent anyone (ADR 0030): listed only in view `space`
            notSelfDrop(),
            ...(after ? [before(drops.createdAt, drops.id, after)] : []),
          ),
        )
        .orderBy(desc(drops.createdAt), desc(drops.id))
        .limit(n);
    const start = cursor ? { t: cursor.t, id: cursor.id } : null;
    const found = q
      ? await scanForQuery(tx, q, limit, start, sentKeys)
      : await firstPage(limit, start, sentKeys);
    const rows = await dropRowsInOrder(
      tx,
      found.keys.map((key) => key.id),
    );
    const card = await authorCards(
      tx,
      scope.userId,
      rows.map((r) => ({ authorUserId: r.d.authorUserId, snapshot: r.d.authorSnapshot as AuthorSnapshot })),
    );
    const presentations = await presentationsForDrops(
      tx,
      scope,
      rows.map((r) => r.d),
      visibility.hIds,
      viewer,
    );
    return {
      drops: rows.map(({ d, attachmentCount }) =>
        summary(d, attachmentCount, card, presentationFor(presentations, d.id), ['sender'], []),
      ),
      nextCursor: found.next ? encodeCursor({ t: found.next.t, id: found.next.id, k }) : null,
      unreadCount: await unreadCountForEndpoints(tx, visibility.hIds),
    };
  }

  /*
   * A group's own history. Authorization comes from the group's setting or the viewer's role rather than from a
   * delivery, so this is the one list that returns drops the viewer never received. Read-only: drops with no
   * delivery of mine carry no read/star/archive state and cannot be mutated (setDropState needs a delivery).
   */
  if (input.group_id && (memberHistory || adminHistory)) {
    return listGroupHistory(tx, scope, input.group_id, {
      limit,
      cursor,
      k,
      q,
      hIds: visibility.hIds,
      viewer,
      as: memberHistory ? 'member' : 'admin',
    });
  }

  const conds = [
    inArray(deliveries.hId, visibility.hIds),
    isNull(drops.revokedAt),
    hasValidGrant(deliveries.id),
    notExpired(),
  ];
  // My own space is not a message from anyone (ADR 0030): it never shows in the inbox, only in view `space`.
  // Starred and archived follow the person's explicit flags, so an item they starred or archived still shows there.
  if ((input.view ?? 'inbox') === 'inbox') conds.push(notSelfDrop());
  // What I posted to a group is not a message to me (ADR 0033): the inbox leaves out copies that reached my agents
  // only through a group I posted to. The group's own timeline (`group_id`) still lists them, as do Sent, Starred,
  // Archived and a read by id; this is a view filter, not authorization.
  if ((input.view ?? 'inbox') === 'inbox' && !input.group_id) conds.push(notOwnGroupPost());
  if (visibility.endpointScope === 'current') {
    if (input.view === 'inbox') conds.push(isNull(deliveries.archivedAt));
    if (input.view === 'archived') conds.push(isNotNull(deliveries.archivedAt));
    if (input.view === 'starred') conds.push(isNotNull(deliveries.starredAt));
    if (input.unread_only) conds.push(isNull(deliveries.readAt));
  }
  const latestReceived = sql<Date>`max(${deliveries.receivedAt})`;
  // Keep every visible delivery in the aggregate. Filtering the outer rows by group would make account-wide
  // read/star/archive state disagree with the returned deliveries[] when another H received the same drop directly.
  const groupHaving = input.group_id
    ? sql<boolean>`bool_or(exists (select 1 from ${deliveryGrants} g where g.delivery_id = ${deliveries.id} and g.kind = 'group' and g.group_id = ${input.group_id} and g.revoked_at is null))`
    : undefined;
  const accountViewHaving =
    visibility.endpointScope === 'account'
      ? input.view === 'archived'
        ? sql<boolean>`bool_and(${deliveries.archivedAt} is not null)`
        : input.view === 'starred'
          ? sql<boolean>`bool_or(${deliveries.starredAt} is not null)`
          : sql<boolean>`bool_or(${deliveries.archivedAt} is null)`
      : undefined;
  const accountUnreadHaving =
    visibility.endpointScope === 'account' && input.unread_only
      ? sql<boolean>`bool_or(${deliveries.readAt} is null)`
      : undefined;
  const inboxKeys = async (after: ScanPosition | null, n: number) => {
    const cursorHaving = after ? before(latestReceived, deliveries.dropId, after) : undefined;
    let inboxQuery = tx
      .select({ id: deliveries.dropId, t: usec(latestReceived) })
      .from(deliveries)
      .innerJoin(drops, eq(drops.id, deliveries.dropId))
      .where(and(...conds))
      .groupBy(deliveries.dropId)
      .$dynamic();
    const combinedHaving = and(groupHaving, accountViewHaving, accountUnreadHaving, cursorHaving);
    if (combinedHaving) inboxQuery = inboxQuery.having(combinedHaving);
    const rows = await inboxQuery.orderBy(desc(latestReceived), desc(deliveries.dropId)).limit(n);
    return rows.map((row) => ({ id: row.id, t: row.t }));
  };
  const start = cursor ? { t: cursor.t, id: cursor.id } : null;
  const found = q
    ? await scanForQuery(tx, q, limit, start, inboxKeys)
    : await firstPage(limit, start, inboxKeys);
  const orderedRows = await dropRowsInOrder(
    tx,
    found.keys.map((key) => key.id),
  );
  const orderedDrops = orderedRows.map((row) => row.d);
  const presentations = await presentationsForDrops(tx, scope, orderedDrops, visibility.hIds, viewer);
  const card = await authorCards(
    tx,
    scope.userId,
    orderedDrops.map((d) => ({ authorUserId: d.authorUserId, snapshot: d.authorSnapshot as AuthorSnapshot })),
  );
  return {
    drops: orderedRows.map(({ d, attachmentCount }) => {
      const presentation = presentationFor(presentations, d.id);
      const sources = [...new Set(presentation.deliveries.flatMap((delivery) => delivery.sources))];
      if (presentation.originAgent && !sources.includes('sender')) sources.push('sender');
      const groupIds = [...new Set(presentation.deliveries.flatMap((delivery) => delivery.group_ids))];
      return summary(d, attachmentCount, card, presentation, sources, groupIds);
    }),
    nextCursor: found.next ? encodeCursor({ t: found.next.t, id: found.next.id, k }) : null,
    unreadCount: await unreadCountForEndpoints(tx, visibility.hIds),
    ...(input.unread_only && (input.view ?? 'inbox') === 'inbox' && !input.group_id
      ? { mutedUnreadCount: await mutedUnreadCountForEndpoints(tx, scope.userId, visibility.hIds) }
      : {}),
  };
}

/**
 * Where a list stands: the ordering timestamp and id of the last row examined. The timestamp is kept as
 * PostgreSQL's microsecond text: a JS Date would cut it to milliseconds, and rows sharing that millisecond with the
 * boundary row would be skipped.
 */
interface ScanPosition {
  t: string;
  id: string;
}

function usec(column: SQLWrapper) {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Rows after `after` in (timestamp desc, id desc) order. */
function before(column: SQLWrapper, idColumn: SQLWrapper, after: ScanPosition) {
  return or(
    sql`${column} < ${after.t}::timestamptz`,
    and(sql`${column} = ${after.t}::timestamptz`, sql`${idColumn} < ${after.id}`),
  )!;
}
type KeyPage = (after: ScanPosition | null, n: number) => Promise<ScanPosition[]>;

/** Rows per database round trip while searching, and the most one request examines (plan §9). */
export const SEARCH_BATCH = 200;
export const SEARCH_SCAN_LIMIT = 2000;
const SEARCH_TIME_BUDGET_MS = 1500;

async function firstPage(limit: number, start: ScanPosition | null, keysAfter: KeyPage) {
  const rows = await keysAfter(start, limit + 1);
  const keys = rows.slice(0, limit);
  const last = keys.at(-1);
  return { keys, next: rows.length > limit && last ? last : null };
}

/**
 * Search without SQL on the content, which may be encrypted (docs/plan/CONTENT_ENCRYPTION.md §9): walk the list in
 * its own order, decrypt, and match case-insensitive substrings of title or body, until a page is full, the scan
 * budget (SEARCH_SCAN_LIMIT rows or SEARCH_TIME_BUDGET_MS) is spent, or the list ends. `next` is the last row
 * examined, so a short or even empty page with a cursor means "not searched to the end yet", never "no more".
 */
async function scanForQuery(
  tx: Tx,
  query: string,
  limit: number,
  start: ScanPosition | null,
  keysAfter: KeyPage,
  now: () => number = Date.now,
): Promise<{ keys: ScanPosition[]; next: ScanPosition | null }> {
  const needle = query.toLocaleLowerCase();
  const began = now();
  const matched: ScanPosition[] = [];
  let position = start;
  let examined = 0;
  for (;;) {
    const batch = await keysAfter(position, Math.min(SEARCH_BATCH, SEARCH_SCAN_LIMIT - examined));
    if (batch.length === 0) return { keys: matched, next: null };
    const content = await tx
      .select({
        id: drops.id,
        title: drops.title,
        body: drops.body,
        extensions: drops.extensions,
        dek: drops.dek,
        titleEnc: drops.titleEnc,
        bodyEnc: drops.bodyEnc,
        extensionsEnc: drops.extensionsEnc,
      })
      .from(drops)
      .where(
        inArray(
          drops.id,
          batch.map((key) => key.id),
        ),
      );
    const byId = new Map(content.map((row) => [row.id, row]));
    for (const key of batch) {
      examined++;
      position = key;
      const row = byId.get(key.id);
      if (row) {
        const c = openDropForList(row);
        if (
          !c.unreadable &&
          (c.title.toLocaleLowerCase().includes(needle) || c.body.toLocaleLowerCase().includes(needle))
        )
          matched.push(key);
      }
      if (matched.length === limit) {
        const more = key !== batch.at(-1) || (await keysAfter(key, 1)).length > 0;
        return { keys: matched, next: more ? key : null };
      }
    }
    const listEnded = batch.length < Math.min(SEARCH_BATCH, SEARCH_SCAN_LIMIT - (examined - batch.length));
    if (listEnded) return { keys: matched, next: null };
    if (examined >= SEARCH_SCAN_LIMIT || now() - began > SEARCH_TIME_BUDGET_MS) {
      const more = position ? (await keysAfter(position, 1)).length > 0 : false;
      return { keys: matched, next: more ? position : null };
    }
  }
}

/** Full rows for a page of ids, in the page's order. */
async function dropRowsInOrder(tx: Tx, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ d: drops, attachmentCount: attachmentCountSql() })
    .from(drops)
    .where(inArray(drops.id, ids));
  const byId = new Map(rows.map((row) => [row.d.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

function attachmentCountSql() {
  return sql<number>`(select count(*)::int from ${dropAttachments} da where da.drop_id = ${drops.id})`;
}
export function notExpired() {
  return or(isNull(drops.expiresAt), sql`${drops.expiresAt} > now()`)!;
}

/** SQL condition on `drops`: kept in its author's own space (ADR 0030), `target_snapshot.self = true`. */
export function selfDrop() {
  return sql<boolean>`${drops.targetSnapshot} @> '{"self":true}'::jsonb`;
}
/** SQL condition on `drops`: anything but an item of an own space; such items are not messages to anyone. */
export function notSelfDrop() {
  return sql<boolean>`not (${drops.targetSnapshot} @> '{"self":true}'::jsonb)`;
}

/**
 * SQL condition on a `deliveries` row joined with `drops`: this copy is not one of the person's own group posts
 * (ADR 0033), i.e. not (the drop's author owns the receiving agent AND none of the author's agents holds a live
 * direct grant of it). A drop the author also addressed to themselves (a handoff to an agent of theirs, ADR 0015)
 * is a message to them and stays on every agent, as it stays unread on every agent (ADR 0007). Used by the inbox,
 * its unread counts and "mark all as read"; never by a group's timeline, Sent, Starred, Archived or authorization.
 */
export function notOwnGroupPost() {
  return sql<boolean>`(not (
    ${drops.authorUserId} = (select h.user_id from ${harnessEndpoints} h where h.id = ${deliveries.hId})
    and not exists (select 1 from ${deliveries} d2
      join ${deliveryGrants} g on g.delivery_id = d2.id
      join ${harnessEndpoints} h2 on h2.id = d2.h_id
      where d2.drop_id = ${drops.id} and h2.user_id = ${drops.authorUserId}
        and g.revoked_at is null and g.kind <> 'group')
  ))`;
}

/**
 * The person's own space (ADR 0030): drops they sent to a `self` target, newest first. Authorized like every list,
 * through the one predicate (`readableThrough`: live, and sent from or validly delivered to a visible agent). Each
 * agent of the account at send time holds its own delivery, so every one of them lists the item even with
 * account-wide reads off. Read/archived flags do not filter it (items are read on arrival); `unread_only` keeps only
 * items the person marked unread, and a group filter matches nothing.
 */
async function listSpace(
  tx: Tx,
  scope: MailboxScope,
  input: ListDropsInput,
  opts: {
    limit: number;
    cursor: Cursor | null;
    k: string;
    q: string | undefined;
    visibility: { endpointScope: 'account' | 'current'; hIds: string[] };
    viewer: HistoryViewer;
  },
): Promise<{ drops: DropSummary[]; nextCursor: string | null; unreadCount: number }> {
  const { limit, cursor, k, q, visibility, viewer } = opts;
  const unread = input.unread_only
    ? sql`exists (select 1 from ${deliveries} d where d.drop_id = ${drops.id} and d.read_at is null and ${inArray(
        sql`d.h_id`,
        visibility.hIds,
      )})`
    : undefined;
  const spaceKeys = async (after: ScanPosition | null, n: number) => {
    if (input.group_id) return [];
    return tx
      .select({ id: drops.id, t: usec(drops.createdAt) })
      .from(drops)
      .where(
        and(
          eq(drops.authorUserId, scope.userId),
          selfDrop(),
          readableThrough(visibility.hIds, viewer),
          unread,
          ...(after ? [before(drops.createdAt, drops.id, after)] : []),
        ),
      )
      .orderBy(desc(drops.createdAt), desc(drops.id))
      .limit(n);
  };
  const start = cursor ? { t: cursor.t, id: cursor.id } : null;
  const found = q
    ? await scanForQuery(tx, q, limit, start, spaceKeys)
    : await firstPage(limit, start, spaceKeys);
  const rows = await dropRowsInOrder(
    tx,
    found.keys.map((key) => key.id),
  );
  const card = await authorCards(
    tx,
    scope.userId,
    rows.map((r) => ({ authorUserId: r.d.authorUserId, snapshot: r.d.authorSnapshot as AuthorSnapshot })),
  );
  const presentations = await presentationsForDrops(
    tx,
    scope,
    rows.map((r) => r.d),
    visibility.hIds,
    viewer,
  );
  return {
    drops: rows.map(({ d, attachmentCount }) => {
      const presentation = presentationFor(presentations, d.id);
      const sources = [...new Set(presentation.deliveries.flatMap((delivery) => delivery.sources))];
      if (presentation.originAgent && !sources.includes('sender')) sources.push('sender');
      return summary(d, attachmentCount, card, presentation, sources, []);
    }),
    nextCursor: found.next ? encodeCursor({ t: found.next.t, id: found.next.id, k }) : null,
    unreadCount: await unreadCountForEndpoints(tx, visibility.hIds),
  };
}

async function listGroupHistory(
  tx: Tx,
  scope: MailboxScope,
  groupId: string,
  opts: {
    limit: number;
    cursor: Cursor | null;
    k: string;
    q: string | undefined;
    hIds: string[];
    viewer: HistoryViewer;
    /** `member`: the group's history is visible to members (ADR 0022). `admin`: an owner/admin's explicit request. */
    as: 'member' | 'admin';
  },
): Promise<{ drops: DropSummary[]; nextCursor: string | null; unreadCount: number }> {
  const { limit, cursor, k, q, hIds, viewer } = opts;
  const roleSource = opts.as === 'member' ? ('group_history' as const) : ('group_admin' as const);
  const conds = [
    eq(deliveryGrants.kind, 'group'),
    eq(deliveryGrants.groupId, groupId),
    isNull(drops.revokedAt),
    notExpired(),
  ];
  // Ordered by when the drop was written, not by when it reached me: most of these never reached me at all.
  const historyKeys = async (after: ScanPosition | null, n: number) => {
    const rows = await tx
      .selectDistinct({ id: drops.id, createdAt: drops.createdAt, t: usec(drops.createdAt) })
      .from(drops)
      .innerJoin(deliveries, eq(deliveries.dropId, drops.id))
      .innerJoin(deliveryGrants, eq(deliveryGrants.deliveryId, deliveries.id))
      .where(and(...conds, ...(after ? [before(drops.createdAt, drops.id, after)] : [])))
      .orderBy(desc(drops.createdAt), desc(drops.id))
      .limit(n);
    return rows.map((row) => ({ id: row.id, t: row.t }));
  };
  const start = cursor ? { t: cursor.t, id: cursor.id } : null;
  const found = q
    ? await scanForQuery(tx, q, limit, start, historyKeys)
    : await firstPage(limit, start, historyKeys);
  const orderedRows = await dropRowsInOrder(
    tx,
    found.keys.map((key) => key.id),
  );
  const orderedDrops = orderedRows.map((row) => row.d);
  const presentations = await presentationsForDrops(tx, scope, orderedDrops, hIds, viewer);
  const card = await authorCards(
    tx,
    scope.userId,
    orderedDrops.map((d) => ({ authorUserId: d.authorUserId, snapshot: d.authorSnapshot as AuthorSnapshot })),
  );
  // Titles and previews of drops I never received are a disclosure too, not only the full reads. A member of a
  // group whose history the owner opened to members reads it as ordinary access (ADR 0022): nothing to audit.
  if (opts.as === 'admin')
    await recordAudit(tx, {
      actorUserId: scope.userId,
      hId: scope.hId,
      action: 'drop.list.group_admin',
      targetId: groupId,
      result: 'ok',
      meta: { count: orderedRows.length },
    });
  return {
    drops: orderedRows.map(({ d, attachmentCount }) => {
      const presentation = presentationFor(presentations, d.id);
      const sources = [...new Set(presentation.deliveries.flatMap((delivery) => delivery.sources))];
      if (presentation.originAgent && !sources.includes('sender')) sources.push('sender');
      if (sources.length === 0) sources.push(roleSource);
      return summary(d, attachmentCount, card, presentation, sources, [groupId]);
    }),
    nextCursor: found.next ? encodeCursor({ t: found.next.t, id: found.next.id, k }) : null,
    unreadCount: await unreadCountForEndpoints(tx, hIds),
  };
}

interface DropPresentation {
  originAgent: DropSummary['origin_agent'];
  stateVersion: number;
  deliveries: DropDelivery[];
  recipients: DropSummary['recipients'];
  /** Author only; undefined for everyone else. */
  recipientStatus?: RecipientStatus[] | undefined;
  /** The drop this one answers, when the viewer may read it. */
  replyTo: ReplyRef | null;
  /** Author only: readable replies. Undefined for drops the viewer did not write. */
  replies?: RepliesInfo | undefined;
}

function presentationFor(presentations: Map<string, DropPresentation>, dropId: string): DropPresentation {
  const presentation = presentations.get(dropId);
  if (!presentation) throw new AgentDropError('INTERNAL', 'drop presentation missing');
  return presentation;
}

async function presentationsForDrops(
  tx: Tx,
  scope: MailboxScope,
  dropRows: Array<typeof drops.$inferSelect>,
  visibleHIds: string[],
  viewer: HistoryViewer,
): Promise<Map<string, DropPresentation>> {
  const result = new Map<string, DropPresentation>();
  if (dropRows.length === 0) return result;
  const dropIds = dropRows.map((drop) => drop.id);
  // State is per person even when the mailbox view is restricted to one H. Match setDropState's
  // exact delivery scope so a legacy version difference cannot cause conflicts after every refresh.
  const versions = await tx
    .select({ dropId: deliveries.dropId, version: sql<number>`max(${deliveries.stateVersion})::int` })
    .from(deliveries)
    .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, deliveries.hId))
    .where(
      and(
        inArray(deliveries.dropId, dropIds),
        eq(harnessEndpoints.userId, scope.userId),
        hasValidGrant(deliveries.id),
      ),
    )
    .groupBy(deliveries.dropId);
  const versionByDrop = new Map(versions.map((row) => [row.dropId, row.version]));
  const deliveryRows = await tx
    .select({ delivery: deliveries, endpoint: harnessEndpoints })
    .from(deliveries)
    .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, deliveries.hId))
    .where(and(inArray(deliveries.dropId, dropIds), inArray(deliveries.hId, visibleHIds)));
  const grants = deliveryRows.length
    ? await tx
        .select({
          deliveryId: deliveryGrants.deliveryId,
          kind: deliveryGrants.kind,
          groupId: deliveryGrants.groupId,
        })
        .from(deliveryGrants)
        .where(
          and(
            inArray(
              deliveryGrants.deliveryId,
              deliveryRows.map((row) => row.delivery.id),
            ),
            isNull(deliveryGrants.revokedAt),
          ),
        )
    : [];
  const originIds = [...new Set(dropRows.map((drop) => drop.originHId))];
  const ownOrigins = await tx
    .select()
    .from(harnessEndpoints)
    .where(and(inArray(harnessEndpoints.id, originIds), eq(harnessEndpoints.userId, scope.userId)));
  const originById = new Map(ownOrigins.map((origin) => [origin.id, origin]));
  const receipts = await receiptsForDrops(tx, scope.userId, dropRows);
  const replyRefs = await replyRefsForDrops(tx, dropRows, visibleHIds, viewer);
  const replies = await repliesForDrops(tx, scope.userId, dropRows, visibleHIds, viewer);
  // the author's own drops list who they went to, rendered for the whole page at once
  const authored = dropRows.filter((drop) => drop.authorUserId === scope.userId);
  const rendered = await privateRecipientsMany(
    tx,
    scope.userId,
    authored.map((drop) => ({
      raw: (drop.targetSnapshot as { recipients?: unknown } | null)?.recipients,
      snapshot: drop.targetSnapshot,
      dropId: drop.id,
    })),
  );
  const recipientsOf = new Map(authored.map((drop, i) => [drop.id, rendered[i] ?? []]));

  for (const drop of dropRows) {
    const ownOrigin = originById.get(drop.originHId);
    const validDeliveries = deliveryRows.flatMap(({ delivery, endpoint }) => {
      if (delivery.dropId !== drop.id) return [];
      const mine = grants.filter((grant) => grant.deliveryId === delivery.id);
      if (mine.length === 0) return [];
      const sources: DropDelivery['sources'] = [];
      if (mine.some((grant) => grant.kind === 'direct')) sources.push('direct');
      if (mine.some((grant) => grant.kind === 'group')) sources.push('group');
      if (drop.originHId === delivery.hId) sources.push('sender');
      return [
        {
          h_id: delivery.hId,
          agent_name: endpoint.label,
          harness_key: endpoint.harnessKey,
          received_at: delivery.receivedAt.toISOString(),
          read: delivery.readAt !== null,
          starred: delivery.starredAt !== null,
          archived: delivery.archivedAt !== null,
          state_version: delivery.stateVersion,
          sources,
          group_ids: [
            ...new Set(mine.map((grant) => grant.groupId).filter((id): id is string => id !== null)),
          ],
          current: delivery.hId === scope.hId,
        } satisfies DropDelivery,
      ];
    });
    validDeliveries.sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        b.received_at.localeCompare(a.received_at) ||
        a.h_id.localeCompare(b.h_id),
    );
    result.set(drop.id, {
      stateVersion: validDeliveries.length > 0 || ownOrigin ? (versionByDrop.get(drop.id) ?? 0) : 0,
      originAgent: ownOrigin
        ? { h_id: ownOrigin.id, agent_name: ownOrigin.label, harness_key: ownOrigin.harnessKey }
        : null,
      deliveries: validDeliveries,
      recipients: recipientsOf.get(drop.id) ?? [],
      recipientStatus: receipts.get(drop.id),
      replyTo: (drop.replyToDropId && replyRefs.get(drop.replyToDropId)) || null,
      replies: replies.get(drop.id),
    });
  }
  return result;
}

function summary(
  d: typeof drops.$inferSelect,
  attachmentCount: number,
  card: (authorUserId: string, snapshot: AuthorSnapshot, received: boolean) => DropSummary['author'],
  presentation: DropPresentation,
  sources: DropSummary['sources'],
  groupIds: string[],
): DropSummary {
  const content = openDropForList(d);
  const current = presentation.deliveries.find((delivery) => delivery.current);
  const latest = presentation.deliveries.reduce<DropDelivery | undefined>(
    (best, delivery) => (!best || delivery.received_at > best.received_at ? delivery : best),
    undefined,
  );
  return {
    drop_id: d.id,
    kind: d.kind as DropSummary['kind'],
    title: content.title,
    preview: preview(content.body),
    author: card(
      d.authorUserId,
      d.authorSnapshot as AuthorSnapshot,
      // every listed delivery holds a live grant; `sender` alone is my own copy, not something I received
      presentation.deliveries.some((delivery) =>
        delivery.sources.some((s) => s === 'direct' || s === 'group'),
      ),
    ),
    attachment_count: attachmentCount,
    received_at: current?.received_at ?? latest?.received_at ?? null,
    created_at: d.createdAt.toISOString(),
    sources,
    group_ids: groupIds,
    read: presentation.deliveries.every((delivery) => delivery.read),
    starred: presentation.deliveries.some((delivery) => delivery.starred),
    archived:
      presentation.deliveries.length > 0 && presentation.deliveries.every((delivery) => delivery.archived),
    // The person's state (ADR 0007): the version setDropState compares with, whichever agent is viewing.
    state_version: presentation.stateVersion,
    origin_agent: presentation.originAgent,
    deliveries: presentation.deliveries,
    recipients: presentation.recipients,
    ...(presentation.recipientStatus ? { recipient_status: presentation.recipientStatus } : {}),
    reply_to: presentation.replyTo,
    ...(presentation.replies ? { replies: presentation.replies } : {}),
    ...(d.progress ? { progress: d.progress } : {}),
  };
}

/**
 * Title and id of each drop these answer, and whether the viewing person wrote it (`mine`), only where the viewer
 * may read the original (same predicate as reading it, through a delivery, as its sender, or as a member of a group
 * whose history is visible to members). Anything else, including an expired or revoked original, stays absent and
 * the reference reads as null: it never says whether the original exists.
 */
async function replyRefsForDrops(
  tx: Tx,
  dropRows: Array<typeof drops.$inferSelect>,
  visibleHIds: string[],
  viewer: HistoryViewer,
): Promise<Map<string, ReplyRef>> {
  const result = new Map<string, ReplyRef>();
  const refIds = [...new Set(dropRows.map((d) => d.replyToDropId).filter((id): id is string => id !== null))];
  const readable = [...(await readableDropIds(tx, visibleHIds, refIds, viewer))];
  if (readable.length === 0) return result;
  const rows = await tx.select().from(drops).where(inArray(drops.id, readable));
  for (const row of rows) {
    const content = openDropForList(row);
    if (!content.unreadable)
      result.set(row.id, {
        drop_id: row.id,
        title: content.title,
        mine: row.authorUserId === viewer.userId,
      });
  }
  return result;
}

/**
 * For the drops the viewer wrote: how many readable drops answer each, the latest of them and who wrote them (labels
 * follow the viewer, most recent first). Drops of other authors get nothing.
 */
async function repliesForDrops(
  tx: Tx,
  viewerUserId: string,
  dropRows: Array<typeof drops.$inferSelect>,
  visibleHIds: string[],
  viewer: HistoryViewer,
): Promise<Map<string, RepliesInfo>> {
  const result = new Map<string, RepliesInfo>();
  const authored = dropRows.filter((d) => d.authorUserId === viewerUserId).map((d) => d.id);
  if (authored.length === 0) return result;
  const rows =
    visibleHIds.length > 0
      ? await tx
          .select({
            replyTo: drops.replyToDropId,
            authorUserId: drops.authorUserId,
            createdAt: drops.createdAt,
            progress: drops.progress,
          })
          .from(drops)
          .where(and(inArray(drops.replyToDropId, authored), readableThrough(visibleHIds, viewer)))
          .orderBy(desc(drops.createdAt), desc(drops.id))
      : [];
  const people = [...new Set(rows.map((r) => r.authorUserId))];
  const [users, remarks] = await Promise.all([
    people.length
      ? tx
          .select({ id: appUsers.id, handle: appUsers.handle, displayName: appUsers.displayName })
          .from(appUsers)
          .where(inArray(appUsers.id, people))
      : Promise.resolve([]),
    remarksFor(tx, viewerUserId, people),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  for (const id of authored) {
    const mine = rows.filter((r) => r.replyTo === id);
    const authors: NonNullable<RepliesInfo['authors']> = [];
    for (const r of mine) {
      const u = userById.get(r.authorUserId);
      if (!u || authors.some((a) => a.handle === u.handle)) continue;
      // newest first, so the first reply of theirs that says where the work stands is the latest word (ADR 0038)
      const progress = mine.find((m) => m.authorUserId === r.authorUserId && m.progress)?.progress;
      authors.push({
        handle: u.handle,
        display_label: remarks.get(u.id) ?? u.displayName ?? `@${u.handle}`,
        ...(progress ? { progress } : {}),
      });
    }
    result.set(id, {
      count: mine.length,
      latest_at: mine[0] ? mine[0].createdAt.toISOString() : null,
      authors,
    });
  }
  return result;
}

/**
 * Read receipts for the drops the viewer wrote, one entry per frozen recipient. A person counts as having read a
 * drop once any of their deliveries was opened (`opened_at`) or marked read (`read_at`). Everything is aggregated
 * per person: the author learns who read it, never which agent or device of theirs did.
 * One query for the whole page plus one for the people involved.
 */
async function receiptsForDrops(
  tx: Tx,
  viewerUserId: string,
  dropRows: Array<typeof drops.$inferSelect>,
): Promise<Map<string, RecipientStatus[]>> {
  const result = new Map<string, RecipientStatus[]>();
  const authored = dropRows.filter((drop) => drop.authorUserId === viewerUserId);
  if (authored.length === 0) return result;
  const rows = await tx
    .select({
      dropId: deliveries.dropId,
      userId: harnessEndpoints.userId,
      // least() skips nulls, so this is the earliest of either signal across all of this person's deliveries
      readAt: sql<Date | null>`min(least(${deliveries.openedAt}, ${deliveries.readAt}))`.mapWith(
        deliveries.openedAt,
      ),
      // Every group this person received the drop through, including grants revoked since (they still got it)
      groupIds: sql<string>`coalesce(string_agg(distinct ${deliveryGrants.groupId}::text, ',') filter (where ${deliveryGrants.kind} = 'group'), '')`,
    })
    .from(deliveries)
    .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, deliveries.hId))
    .leftJoin(deliveryGrants, eq(deliveryGrants.deliveryId, deliveries.id))
    .where(
      inArray(
        deliveries.dropId,
        authored.map((drop) => drop.id),
      ),
    )
    .groupBy(deliveries.dropId, harnessEndpoints.userId);
  const people = [...new Set(rows.map((row) => row.userId))];
  const [users, remarks] = await Promise.all([
    people.length
      ? tx
          .select({ id: appUsers.id, handle: appUsers.handle, displayName: appUsers.displayName })
          .from(appUsers)
          .where(inArray(appUsers.id, people))
      : Promise.resolve([]),
    remarksFor(tx, viewerUserId, people),
  ]);
  const userById = new Map(users.map((user) => [user.id, user]));
  const iso = (date: Date | null) => (date ? new Date(date).toISOString() : null);

  const rendered = await privateRecipientsMany(
    tx,
    viewerUserId,
    authored.map((drop) => ({
      raw: (drop.targetSnapshot as { recipients?: unknown } | null)?.recipients,
      snapshot: drop.targetSnapshot,
      dropId: drop.id,
    })),
  );
  for (const [i, drop] of authored.entries()) {
    const snapshot = drop.targetSnapshot as { recipients?: unknown; group_ids?: unknown } | null;
    if (!resolvedRecipientSchema.array().safeParse(snapshot?.recipients).success) continue;
    const groupIds = Array.isArray(snapshot?.group_ids)
      ? snapshot.group_ids.filter((id): id is string => typeof id === 'string')
      : [];
    const perPerson = rows
      .filter((row) => row.dropId === drop.id)
      .map((row) => ({ ...row, user: userById.get(row.userId), groups: row.groupIds.split(',') }));
    let groupIndex = 0;
    const visibleRecipients = rendered[i] ?? [];
    const statuses: RecipientStatus[] = visibleRecipients.map((recipient) => {
      if (recipient.type === 'group') {
        // Group recipients and `group_ids` are appended together at send time, in the same order.
        const groupId = groupIds[groupIndex++];
        const members = perPerson.filter(
          (person) =>
            groupId !== undefined && person.userId !== drop.authorUserId && person.groups.includes(groupId),
        );
        const readers = members
          .filter((person) => person.readAt !== null)
          .map((person) => ({
            display_label:
              remarks.get(person.userId) ??
              person.user?.displayName ??
              (person.user ? `@${person.user.handle}` : ''),
            handle: person.user?.handle ?? '',
            read_at: iso(person.readAt) as string,
          }))
          .sort((a, b) => a.read_at.localeCompare(b.read_at) || a.handle.localeCompare(b.handle));
        return {
          type: 'group',
          label: recipient.label,
          member_count: members.length,
          read_count: readers.length,
          readers,
        };
      }
      // Person and entry labels always start with the recipient's @handle, and handles never change.
      const handle = /^@([^/\s]+)/.exec(recipient.label)?.[1]?.toLowerCase();
      const person = perPerson.find((p) => handle !== undefined && p.user?.handle.toLowerCase() === handle);
      return {
        type: recipient.type,
        label: recipient.label,
        // Sends are all-or-nothing: a committed drop reached every person it names.
        delivered: true,
        read_at: iso(person?.readAt ?? null),
      };
    });
    result.set(drop.id, statuses);
  }
  return result;
}

export async function unreadCount(tx: Tx, hId: string): Promise<number> {
  return unreadCountForEndpoints(tx, [hId]);
}

export async function unreadCountForEndpoints(tx: Tx, hIds: string[]): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(distinct ${deliveries.dropId})::int` })
    .from(deliveries)
    .innerJoin(drops, eq(drops.id, deliveries.dropId))
    .where(
      and(
        inArray(deliveries.hId, hIds),
        isNull(deliveries.readAt),
        isNull(deliveries.archivedAt),
        isNull(drops.revokedAt),
        hasValidGrant(deliveries.id),
        notExpired(),
        // as the inbox: my own space never counts, even an item marked unread (ADR 0030)
        notSelfDrop(),
        // nor do my own group posts (ADR 0033), even one I marked unread
        notOwnGroupPost(),
      ),
    );
  return rows[0]?.n ?? 0;
}

/**
 * How many unread drops stay quiet for the person: those that reached them only through groups they muted (no
 * direct grant, every valid group grant for a muted group) and do not mention them. The same rule as `muted` and
 * `mentioned_me` in withDropContext, so a list that skips muted drops can say how many more are worth showing.
 */
async function mutedUnreadCountForEndpoints(tx: Tx, userId: string, hIds: string[]): Promise<number> {
  if (hIds.length === 0) return 0;
  const mutedGroups = sql`(select gm.group_id from ${groupMemberships} gm
    where gm.user_id = ${userId} and gm.status = 'active' and gm.muted = true)`;
  const rows = await tx
    .select({ n: sql<number>`count(distinct ${deliveries.dropId})::int` })
    .from(deliveries)
    .innerJoin(drops, eq(drops.id, deliveries.dropId))
    .where(
      and(
        inArray(deliveries.hId, hIds),
        isNull(deliveries.readAt),
        isNull(deliveries.archivedAt),
        isNull(drops.revokedAt),
        hasValidGrant(deliveries.id),
        notExpired(),
        notSelfDrop(),
        notOwnGroupPost(),
        // nothing reaches the person other than a muted group: no direct grant, no grant of a group they hear
        sql`not exists (select 1 from ${deliveries} d2 join ${deliveryGrants} g on g.delivery_id = d2.id
          where d2.drop_id = ${drops.id} and ${inArray(sql`d2.h_id`, hIds)} and g.revoked_at is null
          and (g.kind <> 'group' or g.group_id is null or g.group_id not in ${mutedGroups}))`,
        // a mention of the person is never quiet
        sql`not coalesce((${drops.targetSnapshot} -> 'mention_user_ids') @> to_jsonb(${userId}::text), false)`,
      ),
    );
  return rows[0]?.n ?? 0;
}

/**
 * Bounded read. Never marks read; the connection's fetch is an audit fact, not shared state. A recipient opening
 * the body is recorded once as `opened_at` on their deliveries, which is what the author sees as a read receipt.
 */
export async function readDrop(
  tx: Tx,
  scope: MailboxScope,
  input: ReadDropInput,
  connectionId?: string | null,
): Promise<DropDetail> {
  const visibility = await visibleEndpointIds(tx, scope);
  const auth = await loadAuthorizedDrop(tx, scope, input.drop_id, visibility.endpointScope);
  const content = openDrop(auth.drop);
  const offset = Math.min(input.offset ?? 0, content.body.length);
  const max = Math.min(input.max_chars ?? LIMITS.READ_DEFAULT_CHARS, LIMITS.READ_MAX_CHARS);
  const chunk = content.body.slice(offset, offset + max);
  const nextOffset = offset + chunk.length < content.body.length ? offset + chunk.length : null;
  const atts = await tx
    .select({ a: attachments, ordinal: dropAttachments.ordinal })
    .from(dropAttachments)
    .innerJoin(attachments, eq(attachments.id, dropAttachments.attachmentId))
    .where(eq(dropAttachments.dropId, auth.drop.id))
    .orderBy(dropAttachments.ordinal);
  const card = await authorCards(tx, scope.userId, [
    { authorUserId: auth.drop.authorUserId, snapshot: auth.drop.authorSnapshot as AuthorSnapshot },
  ]);
  if (auth.sources.includes('direct') || auth.sources.includes('group')) {
    await markOpened(tx, scope.userId, auth.drop.id);
  }
  await recordAudit(tx, {
    actorUserId: scope.userId,
    hId: scope.hId,
    // Reading a group's history as an admin is a distinct, auditable act: it is not a delivery of mine. A member
    // reading a history the owner opened to members (`group_history`, ADR 0022) is an ordinary read.
    action: auth.sources.includes('group_admin') ? 'drop.read.group_admin' : 'drop.read',
    targetId: auth.drop.id,
    result: 'ok',
    meta: { offset, chars: chunk.length, connection_id: connectionId ?? null },
  });
  const presentations = await presentationsForDrops(
    tx,
    scope,
    [auth.drop],
    visibility.hIds,
    historyViewer(scope, visibility.endpointScope),
  );
  const presentation = presentationFor(presentations, auth.drop.id);
  const sources = [...new Set(presentation.deliveries.flatMap((delivery) => delivery.sources))];
  if (auth.isSender && !sources.includes('sender')) sources.push('sender');
  // A member or admin reading a drop they never received has no delivery to derive this from; say why it is visible.
  for (const role of ['group_history', 'group_admin'] as const)
    if (auth.sources.includes(role) && !sources.includes(role)) sources.push(role);
  const groupIds = [
    ...new Set([...presentation.deliveries.flatMap((delivery) => delivery.group_ids), ...auth.groupIds]),
  ];
  const base = summary(auth.drop, atts.length, card, presentation, sources, groupIds);
  return {
    ...base,
    body_chunk: chunk,
    body_offset: offset,
    body_total_chars: content.body.length,
    next_offset: nextOffset,
    attachments: atts.map(({ a }) => toAttachmentMeta(a)),
    extensions: content.extensions,
    expires_at: auth.drop.expiresAt ? auth.drop.expiresAt.toISOString() : null,
  };
}

/**
 * First open by a recipient, account-wide: every delivery of this drop to any of the reader's agents. Only
 * `opened_at` changes — `read_at`, `state_version`, unread counts and mailbox revisions stay as they were, so
 * the reader's own mailbox still shows it unread until they mark it. Reading as the author or as a group admin
 * (no delivery-based source) never gets here.
 */
async function markOpened(tx: Tx, userId: string, dropId: string): Promise<void> {
  await tx
    .update(deliveries)
    .set({ openedAt: sql`now()` })
    .where(
      and(
        eq(deliveries.dropId, dropId),
        isNull(deliveries.openedAt),
        inArray(
          deliveries.hId,
          tx
            .select({ id: harnessEndpoints.id })
            .from(harnessEndpoints)
            .where(eq(harnessEndpoints.userId, userId)),
        ),
      ),
    );
}

export function toAttachmentMeta(a: typeof attachments.$inferSelect): AttachmentMeta {
  const meta = openAttachmentMeta(a);
  return {
    attachment_id: a.id,
    safe_name: meta.safeName,
    content_type: meta.contentType,
    byte_size: a.byteSize,
    sha256: meta.sha256 ?? '0'.repeat(64),
    // still listed on its drop, but no longer downloadable (FILE_REMOVED); absent for every other file
    ...(a.status === 'deleted' ? { removed: true } : {}),
  };
}

export async function sendRequestStatus(tx: Tx, scope: MailboxScope, requestId: string) {
  const row = await tx.query.sendRequests.findFirst({
    where: and(eq(sendRequests.originHId, scope.hId), eq(sendRequests.requestId, requestId)),
  });
  if (!row) return { request_id: requestId, outcome: null, drop_id: null, approval_url: null };
  const result = row.result as { approvalUrl?: string | null };
  return {
    request_id: requestId,
    outcome: row.outcome,
    drop_id: row.resultDropId,
    approval_url: result.approvalUrl ?? null,
  };
}

/**
 * Adds what a list needs to tell group traffic apart: `group_labels` (name and slug of each of `group_ids`, only
 * groups the viewer already reached the drop through) and, for group drops that called on people, `mentions`
 * (labels follow the viewer; only for the author and readers through that group) and `mentioned_me`.
 */
export async function withDropContext<T extends { drop_id: string; group_ids: string[]; sources: string[] }>(
  tx: Tx,
  viewerUserId: string,
  items: T[],
): Promise<
  Array<
    T & {
      group_labels: GroupLabel[];
      mentions: Array<{ handle: string; display_label: string }>;
      mentioned_me: boolean;
      muted: boolean;
    }
  >
> {
  const ids = [...new Set(items.flatMap((i) => i.group_ids))];
  const rows = ids.length
    ? await tx
        .select({ id: groups.id, displayName: groups.displayName, slug: groups.slug })
        .from(groups)
        .where(inArray(groups.id, ids))
    : [];
  const byId = new Map(
    rows.map((g) => [g.id, { group_id: g.id, display_name: g.displayName, slug: g.slug }]),
  );
  const snapshots = items.length
    ? await tx
        .select({ id: drops.id, authorUserId: drops.authorUserId, snapshot: drops.targetSnapshot })
        .from(drops)
        .where(
          inArray(
            drops.id,
            items.map((i) => i.drop_id),
          ),
        )
    : [];
  const strings = (raw: unknown) =>
    Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  const mentionIds = new Map(
    snapshots.map((r) => {
      const snapshot = r.snapshot as { mention_user_ids?: unknown } | null;
      return [r.id, strings(snapshot?.mention_user_ids)];
    }),
  );
  /*
   * Who the author called on is part of the group conversation: the author sees it, and so does whoever reached
   * the drop through that group (a member's delivery, or an owner/admin reading its history, both put the group
   * in `group_ids`). Anyone who got it some other way sees no mentions.
   */
  const mentionsVisible = new Map(
    snapshots.map((r) => {
      const groupIds = strings((r.snapshot as { group_ids?: unknown } | null)?.group_ids);
      const item = items.find((i) => i.drop_id === r.id);
      return [
        r.id,
        r.authorUserId === viewerUserId || (!!item && groupIds.some((id) => item.group_ids.includes(id))),
      ];
    }),
  );
  const people = [
    ...new Set(
      [...mentionIds.entries()].flatMap(([dropId, list]) => (mentionsVisible.get(dropId) ? list : [])),
    ),
  ];
  const users = people.length
    ? await tx
        .select({ id: appUsers.id, handle: appUsers.handle, displayName: appUsers.displayName })
        .from(appUsers)
        .where(inArray(appUsers.id, people))
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const remarks = await remarksFor(tx, viewerUserId, people);
  const mutedGroups = new Set(
    ids.length
      ? (
          await tx
            .select({ groupId: groupMemberships.groupId })
            .from(groupMemberships)
            .where(
              and(
                eq(groupMemberships.userId, viewerUserId),
                eq(groupMemberships.status, 'active'),
                eq(groupMemberships.muted, true),
                inArray(groupMemberships.groupId, ids),
              ),
            )
        ).map((r) => r.groupId)
      : [],
  );
  return items.map((i) => {
    const mentioned = mentionIds.get(i.drop_id) ?? [];
    return {
      ...i,
      // one stable order everywhere (by slug), so every surface names the same group first
      group_labels: i.group_ids
        .flatMap((id) => {
          const label = byId.get(id);
          return label ? [label] : [];
        })
        .sort((a, b) => a.slug.localeCompare(b.slug)),
      mentions: (mentionsVisible.get(i.drop_id) ? mentioned : []).flatMap((id) => {
        const u = userById.get(id);
        return u
          ? [{ handle: u.handle, display_label: remarks.get(id) ?? u.displayName ?? `@${u.handle}` }]
          : [];
      }),
      mentioned_me: mentioned.includes(viewerUserId),
      muted:
        !i.sources.includes('direct') &&
        i.group_ids.length > 0 &&
        i.group_ids.every((id) => mutedGroups.has(id)),
    };
  });
}
