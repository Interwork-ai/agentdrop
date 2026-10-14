import { mailboxEvents, mailboxHeads, type Tx } from '@agentdrop/db';
import { eq, inArray, sql } from 'drizzle-orm';

export interface MailboxEventInput {
  hId: string;
  type: 'delivery.created' | 'delivery.state' | 'grant.revoked' | 'drop.revoked' | 'attachment.removed';
  dropId?: string | null;
  deliveryId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Increments the per-H mailbox revision and appends events inside the caller's transaction.
 * Heads are locked in ascending h_id order so concurrent fan-outs cannot deadlock.
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
  const current = new Map(heads.map((h) => [h.hId, h.revision]));
  for (const hId of hIds) {
    let rev = current.get(hId) ?? 0;
    const mine = events.filter((e) => e.hId === hId);
    for (const e of mine) {
      rev += 1;
      await tx.insert(mailboxEvents).values({
        hId,
        revision: rev,
        type: e.type,
        dropId: e.dropId ?? null,
        deliveryId: e.deliveryId ?? null,
        payload: e.payload ?? {},
      });
    }
    await tx
      .update(mailboxHeads)
      .set({ revision: rev, updatedAt: new Date() })
      .where(eq(mailboxHeads.hId, hId));
    result.set(hId, rev);
  }
  return result;
}

export async function getMailboxRevision(tx: Tx, hId: string): Promise<number> {
  const rows = await tx
    .select({ revision: mailboxHeads.revision })
    .from(mailboxHeads)
    .where(eq(mailboxHeads.hId, hId));
  return rows[0]?.revision ?? 0;
}

export const revisionSql = sql;
