import { AgentDropError } from '@agentdrop/contracts';
import { attachments, deliveries, dropAttachments, drops, type Tx } from '@agentdrop/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { MailboxScope } from '../principals.js';
import { loadAuthorizedDrop } from './authorization.js';
import { enqueueOutbox } from './outbox.js';
import { bumpMailboxes, type MailboxEventInput } from './revision.js';

/*
 * My own space (ADR 0030): drops a person sends to the `self` target to move files and notes between their own
 * machines. They reach every agent of the account, are read on arrival and are listed only with view `space`
 * (read.ts listSpace); the inbox, sent view and unread counts leave them out.
 */

/**
 * Deletes one item of the person's own space: the drop is revoked (the authorization predicate hides revoked drops
 * from every list, read and download) and its files are deleted, freeing the uploading agent's quota. Only the
 * author's own `self` drops qualify; anything else, someone else's included, is NOT_FOUND and never says why.
 * A file belongs to one drop only (drop_attachments_attachment_uq), so nobody else's copy is touched.
 */
export async function deleteSpaceItem(
  tx: Tx,
  scope: MailboxScope,
  dropId: string,
): Promise<{ drop_id: string; deleted: true; freed_bytes: number }> {
  // the one predicate first: an agent that may not see the drop learns nothing about it
  const auth = await loadAuthorizedDrop(tx, scope, dropId);
  const snapshot = auth.drop.targetSnapshot as { self?: unknown } | null;
  if (auth.drop.authorUserId !== scope.userId || snapshot?.self !== true)
    throw new AgentDropError('NOT_FOUND', 'drop not found');
  const [revoked] = await tx
    .update(drops)
    .set({ revokedAt: new Date() })
    .where(and(eq(drops.id, dropId), isNull(drops.revokedAt)))
    .returning({ id: drops.id });
  // a concurrent delete got there first
  if (!revoked) throw new AgentDropError('NOT_FOUND', 'drop not found');

  const linked = await tx
    .select({ id: dropAttachments.attachmentId })
    .from(dropAttachments)
    .where(eq(dropAttachments.dropId, dropId));
  let freed = 0;
  const deleted: string[] = [];
  if (linked.length > 0) {
    const rows = await tx
      .select()
      .from(attachments)
      .where(
        and(
          inArray(
            attachments.id,
            linked.map((l) => l.id),
          ),
          eq(attachments.status, 'ready'),
        ),
      )
      .orderBy(attachments.id)
      .for('update', { of: attachments });
    const now = new Date();
    for (const row of rows) {
      await tx
        .update(attachments)
        .set({ status: 'deleted', byteSize: 0, deletedAt: now })
        .where(and(eq(attachments.id, row.id), eq(attachments.status, 'ready')));
      await enqueueOutbox(tx, 'attachment.cleanup', row.id, { storage_key: row.storageKey });
      freed += row.byteSize;
      deleted.push(row.id);
    }
  }
  // every agent holding it (and the sending one) refreshes: the item is gone from their space
  const holders = await tx
    .select({ id: deliveries.id, hId: deliveries.hId })
    .from(deliveries)
    .where(eq(deliveries.dropId, dropId));
  const own: MailboxEventInput[] = holders.map((d) => ({
    hId: d.hId,
    type: 'drop.revoked',
    dropId,
    deliveryId: d.id,
  }));
  if (!own.some((e) => e.hId === auth.drop.originHId))
    own.push({ hId: auth.drop.originHId, type: 'drop.revoked', dropId });
  await bumpMailboxes(tx, own);
  await recordAudit(tx, {
    actorUserId: scope.userId,
    hId: scope.hId,
    action: 'space.delete',
    targetId: dropId,
    result: 'ok',
    meta: { files: deleted.length, bytes: freed },
  });
  return { drop_id: dropId, deleted: true, freed_bytes: freed };
}
