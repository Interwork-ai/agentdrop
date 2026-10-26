import { AgentDropError, LIMITS, type MarkAllReadInput, type SetDropStateInput } from '@agentdrop/contracts';
import { deliveries, deliveryGrants, drops, harnessEndpoints, type Tx } from '@agentdrop/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { MailboxScope } from '../principals.js';
import { hasValidGrant, loadAuthorizedDrop, visibleEndpointIds } from './authorization.js';
import { notExpired, notOwnGroupPost, notSelfDrop, unreadCountForEndpoints } from './read.js';
import { bumpMailboxes, type MailboxEventInput, sentChangedEvents } from './revision.js';

/*
 * The person's read, starred and archived state (ADR 0007: one state per person, on every delivery of a drop to
 * any of their agents). Reading never changes it; these explicit mutations do: a toggle (setDropState), "mark all as
 * read" (ADR 0018), and the catching-up a person's own send implies (ADR 0016, markReadForPerson).
 */

/** Shared read/starred/archived flags of this H. Optimistic concurrency via state_version. */
/**
 * Read, starred and archived are one state per person, not per agent (ADR 0007): all agents of an account are
 * treated as the same reader. The flags change together on every delivery of this drop to any of the account's
 * agents, from whichever agent asks — provided it may see the drop at all. `expected_version` is compared with
 * the highest version among those deliveries, and every one of them ends on the same new version.
 */
export async function setDropState(
  tx: Tx,
  scope: MailboxScope,
  input: SetDropStateInput,
): Promise<{ drop_id: string; read: boolean; starred: boolean; archived: boolean; state_version: number }> {
  // Visibility follows the account's mailbox preference, exactly as for reading the drop.
  const auth = await loadAuthorizedDrop(tx, scope, input.drop_id);
  // Reading it only as the group's history or as an admin gives no state (ADR 0022), even when another of the
  // person's agents received it: with account-wide reads off, this agent cannot see that delivery, so it may not
  // change it either. A delivery or the person's own send (ADR 0007: state is the person's) is what gives state.
  if (!auth.sources.some((s) => s === 'direct' || s === 'group' || s === 'sender'))
    throw new AgentDropError(
      'NOT_FOUND',
      'this drop is not in the mailbox of any of your agents (sent only, or readable only as group history)',
    );
  const rows = await tx
    .select({ d: deliveries })
    .from(deliveries)
    .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, deliveries.hId))
    .where(
      and(
        eq(deliveries.dropId, input.drop_id),
        eq(harnessEndpoints.userId, scope.userId),
        // Only deliveries that still authorize a read carry state: one whose grant was revoked (left the group,
        // changed the receiving agent) is gone from the mailbox, and a drop readable only as the group's history
        // or by an admin is read-only (ADR 0022).
        hasValidGrant(deliveries.id),
      ),
    )
    .orderBy(deliveries.id)
    .for('update', { of: deliveries });
  const mine = rows.map((r) => r.d);
  if (mine.length === 0)
    throw new AgentDropError(
      'NOT_FOUND',
      'this drop is not in the mailbox of any of your agents (sent only, or readable only as group history)',
    );
  const version = Math.max(...mine.map((d) => d.stateVersion));
  if (version !== input.expected_version) {
    throw new AgentDropError('VERSION_CONFLICT', 'state changed by another session', {
      current_version: version,
    });
  }
  const now = new Date();
  // Start from the union: any delivery already read/starred/archived counts, so older, diverged rows converge.
  const earliest = (pick: (d: (typeof mine)[number]) => Date | null) =>
    mine.map(pick).reduce<Date | null>((a, b) => (b && (!a || b < a) ? b : a), null);
  const flag = (wanted: boolean | undefined, current: Date | null) =>
    wanted === undefined ? current : wanted ? (current ?? now) : null;
  const patch = {
    stateVersion: version + 1,
    readAt: flag(
      input.read,
      earliest((d) => d.readAt),
    ),
    starredAt: flag(
      input.starred,
      earliest((d) => d.starredAt),
    ),
    archivedAt: flag(
      input.archived,
      earliest((d) => d.archivedAt),
    ),
  };
  await tx
    .update(deliveries)
    .set(patch)
    .where(
      inArray(
        deliveries.id,
        mine.map((d) => d.id),
      ),
    );
  // The author's receipt follows the earliest open or read of this person's copies (receiptsForDrops): when that
  // moves, the author's streams hear of it as `sent.changed`. Starring and archiving are this person's own business
  // and announce nothing to the author.
  const receiptMoved =
    receiptOf(mine) !== receiptOf(mine.map((d) => ({ openedAt: d.openedAt, readAt: patch.readAt })));
  await bumpMailboxes(tx, [
    ...mine.map((d) => ({ hId: d.hId, type: 'delivery.state' as const, dropId: d.dropId, deliveryId: d.id })),
    ...(receiptMoved ? await sentChangedEvents(tx, [input.drop_id]) : []),
  ]);
  return {
    drop_id: input.drop_id,
    read: patch.readAt !== null,
    starred: patch.starredAt !== null,
    archived: patch.archivedAt !== null,
    state_version: patch.stateVersion,
  };
}

/** What the author's receipt shows for one person's copies of a drop: the earliest open or read, as epoch ms. */
function receiptOf(copies: Array<{ openedAt: Date | null; readAt: Date | null }>): number | null {
  const times = copies.flatMap((d) => [d.openedAt, d.readAt]).filter((t): t is Date => t !== null);
  return times.length ? Math.min(...times.map((t) => t.getTime())) : null;
}

/**
 * The person's "mark all as read" (ADR 0018): every drop that is unread and not archived in their inbox, or only
 * those that reached them through `group_id`, received no later than `up_to` (what the list showed when they
 * clicked; anything newer stays unread). Visibility is the inbox's own (account-wide or this agent, per the
 * account's mailbox preference); the change itself is the person's state on every delivery of each drop to any of
 * their agents (ADR 0007), through markReadForPerson, so versions and mailbox events match setDropState.
 */
export async function markAllRead(
  tx: Tx,
  scope: MailboxScope,
  input: MarkAllReadInput,
): Promise<{ marked: number; remaining: number; unread_count: number }> {
  const visibility = await visibleEndpointIds(tx, scope);
  const now = new Date();
  const requested = input.up_to ? new Date(input.up_to) : now;
  const upTo = requested < now ? requested : now;
  const groupCond = input.group_id
    ? sql<boolean>`exists (select 1 from ${deliveryGrants} g where g.delivery_id = ${deliveries.id} and g.kind = 'group' and g.group_id = ${input.group_id} and g.revoked_at is null)`
    : undefined;
  const unreadInView = and(
    inArray(deliveries.hId, visibility.hIds),
    isNull(deliveries.readAt),
    isNull(deliveries.archivedAt),
    isNull(drops.revokedAt),
    hasValidGrant(deliveries.id),
    notExpired(),
    notSelfDrop(),
    // the inbox leaves out my own group posts (ADR 0033); a group's view lists them, and marking it read covers them
    input.group_id ? undefined : notOwnGroupPost(),
    // `up_to` comes from a list, whose timestamps are milliseconds; the column holds microseconds, so compare at the
    // list's precision or the newest drop shown would count as "later" and stay unread.
    sql`date_trunc('milliseconds', ${deliveries.receivedAt}) <= ${upTo.toISOString()}::timestamptz`,
    groupCond,
  );
  const max = LIMITS.MARK_ALL_READ_MAX;
  const candidates = await tx
    .selectDistinct({ id: deliveries.dropId })
    .from(deliveries)
    .innerJoin(drops, eq(drops.id, deliveries.dropId))
    .where(unreadInView)
    .orderBy(deliveries.dropId)
    .limit(max);
  const events = await markReadForPerson(
    tx,
    scope.userId,
    candidates.map((c) => c.id),
  );
  await bumpMailboxes(tx, events);
  const left = await tx
    .select({ n: sql<number>`count(distinct ${deliveries.dropId})::int` })
    .from(deliveries)
    .innerJoin(drops, eq(drops.id, deliveries.dropId))
    .where(unreadInView);
  return {
    marked: new Set(events.filter((e) => e.type === 'delivery.state').map((e) => e.dropId)).size,
    remaining: left[0]?.n ?? 0,
    unread_count: await unreadCountForEndpoints(tx, visibility.hIds),
  };
}

/**
 * Marks drops read for one person, as setDropState does (ADR 0007: one state per person, on every delivery of the
 * drop to any of their agents, all ending on the same new version), but without an expected version: it is applied
 * by the person's own send (ADR 0016), not a client's toggle. Drops already read everywhere are left alone, and only
 * deliveries with a valid grant change.
 * Returns the mailbox events for the caller to bump together with its own, so heads are locked once, in order:
 * `delivery.state` for the person's agents, and `sent.changed` for the author of each drop this person had neither
 * opened nor read before (their receipt now shows it read).
 */
export async function markReadForPerson(
  tx: Tx,
  userId: string,
  dropIds: string[],
): Promise<MailboxEventInput[]> {
  if (dropIds.length === 0) return [];
  const rows = await tx
    .select({ d: deliveries })
    .from(deliveries)
    .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, deliveries.hId))
    .where(
      and(
        inArray(deliveries.dropId, [...new Set(dropIds)]),
        eq(harnessEndpoints.userId, userId),
        // as setDropState: a delivery whose grant was revoked carries no state, so a drop the person can read only
        // as group history (ADR 0022) is never marked by answering it
        hasValidGrant(deliveries.id),
      ),
    )
    .orderBy(deliveries.id)
    .for('update', { of: deliveries });
  const byDrop = new Map<string, Array<typeof deliveries.$inferSelect>>();
  for (const { d } of rows) byDrop.set(d.dropId, [...(byDrop.get(d.dropId) ?? []), d]);
  const now = new Date();
  const events: MailboxEventInput[] = [];
  const firstRead: string[] = [];
  for (const [dropId, mine] of byDrop) {
    if (mine.every((d) => d.readAt !== null)) continue;
    if (receiptOf(mine) === null) firstRead.push(dropId);
    const readAt = mine
      .map((d) => d.readAt)
      .reduce<Date | null>((a, b) => (b && (!a || b < a) ? b : a), null);
    await tx
      .update(deliveries)
      .set({ readAt: readAt ?? now, stateVersion: Math.max(...mine.map((d) => d.stateVersion)) + 1 })
      .where(
        inArray(
          deliveries.id,
          mine.map((d) => d.id),
        ),
      );
    for (const d of mine) events.push({ hId: d.hId, type: 'delivery.state', dropId, deliveryId: d.id });
  }
  return [...events, ...(await sentChangedEvents(tx, firstRead))];
}
