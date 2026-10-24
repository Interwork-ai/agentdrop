import { harnessEndpoints, mailboxEvents, mailboxHeads, type Tx } from '@agentdrop/db';
import { eq, inArray, sql } from 'drizzle-orm';

/** PostgreSQL channel that wakes event-stream readers (ADR 0040); the payload is the affected person's user id. */
export const EVENTS_CHANNEL = 'agentdrop_events';

export interface MailboxEventInput {
  hId: string;
  type: 'delivery.created' | 'delivery.state' | 'grant.revoked' | 'drop.revoked' | 'attachment.removed';
  dropId?: string | null;
  deliveryId?: string | null;
  payload?: Record<string, unknown>;
}

/** Rows per multi-row insert: 6 parameters each keeps a statement far below PostgreSQL's 65,535. */
const INSERT_CHUNK = 1000;

/**
 * Increments the per-H mailbox revision and appends events inside the caller's transaction.
 * Heads are locked in ascending h_id order so concurrent fan-outs cannot deadlock.
 *
 * Events are written in input order, each taking the next revision of its own agent, so one agent's ids still grow
 * with its revision (the event stream's prefix property) while the copies of one person-level change, which callers
 * list together (ADR 0007), get adjacent ids and coalesce within one page of the stream.
 */
export async function bumpMailboxes(tx: Tx, events: MailboxEventInput[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (events.length === 0) return result;
  const hIds = [...new Set(events.map((e) => e.hId))].sort();
  await tx
    .insert(mailboxHeads)
    .values(hIds.map((hId) => ({ hId })))
    .onConflictDoNothing();
  const heads = await tx
    .select()
    .from(mailboxHeads)
    .where(inArray(mailboxHeads.hId, hIds))
    .orderBy(mailboxHeads.hId)
    .for('update');
  for (const h of heads) result.set(h.hId, h.revision);
  const rows = events.map((e) => {
    const revision = (result.get(e.hId) ?? 0) + 1;
    result.set(e.hId, revision);
    return {
      hId: e.hId,
      revision,
      type: e.type,
      dropId: e.dropId ?? null,
      deliveryId: e.deliveryId ?? null,
      payload: e.payload ?? {},
    };
  });
  // A multi-row insert numbers its rows in order, and later statements of this transaction get higher ids.
  for (let i = 0; i < rows.length; i += INSERT_CHUNK)
    await tx.insert(mailboxEvents).values(rows.slice(i, i + INSERT_CHUNK));
  const revisions = sql.join(
    hIds.map((hId) => sql`(${hId}::uuid, ${result.get(hId) ?? 0}::bigint)`),
    sql`, `,
  );
  await tx.execute(sql`
    update ${mailboxHeads} set revision = v.revision, updated_at = now()
    from (values ${revisions}) as v(h_id, revision)
    where ${mailboxHeads.hId} = v.h_id`);
  // Wake each affected person's stream once; PostgreSQL delivers a notification only if this transaction commits.
  await tx.execute(sql`
    select pg_notify(${EVENTS_CHANNEL}, p.user_id::text) from (
      select distinct ${harnessEndpoints.userId} as user_id from ${harnessEndpoints}
      where ${inArray(harnessEndpoints.id, hIds)}) p`);
  return result;
}

/**
 * Wakes these people's event streams (ADR 0040), in one statement. PostgreSQL delivers the notifications only if
 * this transaction commits, and folds repeats of one person within it into one. A bulk update that moves many
 * people's `directory_revision` notifies from its own `returning` set instead (see system-assistant.ts).
 */
export async function notifyEventStreams(tx: Tx, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const ids = sql.join(
    [...new Set(userIds)].map((id) => sql`(${id}::uuid)`),
    sql`, `,
  );
  await tx.execute(sql`select pg_notify(${EVENTS_CHANNEL}, u.id::text) from (values ${ids}) as u(id)`);
}

export async function getMailboxRevision(tx: Tx, hId: string): Promise<number> {
  const rows = await tx
    .select({ revision: mailboxHeads.revision })
    .from(mailboxHeads)
    .where(eq(mailboxHeads.hId, hId));
  return rows[0]?.revision ?? 0;
}

export const revisionSql = sql;
