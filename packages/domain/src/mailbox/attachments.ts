import type { Readable } from 'node:stream';
import { AgentDropError, type AttachmentMeta, type SendEnvelope } from '@agentdrop/contracts';
import { approvals, attachments, dropAttachments, harnessEndpoints, type Tx } from '@agentdrop/db';
import { and, eq, gt, inArray, isNull, lt, notExists, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import {
  attachmentDek,
  newAttachmentKey,
  newRowId,
  openApproval,
  openAttachmentMeta,
  sealAttachmentMeta,
} from '../content/codec.js';
import type { MailboxScope } from '../principals.js';
import { loadAuthorizedDrop } from './authorization.js';
import { enqueueOutbox } from './outbox.js';
import { toAttachmentMeta } from './read.js';

export interface StorageLike {
  newKey(prefix: 'staging' | 'attachments'): string;
  put(key: string, body: Readable, maxBytes: number): Promise<{ bytes: number; sha256: string }>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  promote(fromKey: string, toKey: string): Promise<void>;
}

export interface AttachmentLimits {
  maxFileBytes: number;
  maxDropFileBytes: number;
  quotaBytes: number;
}

/** Bytes currently reserved by this H (staging + ready attachments not yet deleted). */
export async function usedBytes(tx: Tx, hId: string): Promise<number> {
  const rows = await tx
    .select({ sum: sql<number>`coalesce(sum(${attachments.byteSize}), 0)::bigint` })
    .from(attachments)
    .where(and(eq(attachments.uploadedByHId, hId), inArray(attachments.status, ['staging', 'ready'])));
  return Number(rows[0]?.sum ?? 0);
}

/**
 * Reserves quota for an upload of `declaredBytes` (or the per-file limit when unknown) and creates the staging row.
 * The caller then streams into storage and calls finalize/fail. Staging rows older than 24h are swept by the worker.
 */
export async function stageAttachment(
  tx: Tx,
  scope: MailboxScope,
  input: { safeName: string; contentType: string; declaredBytes: number | null; storageKey: string },
  limits: AttachmentLimits,
): Promise<{ attachmentId: string; dek: Buffer | null }> {
  const reserve = input.declaredBytes ?? limits.maxFileBytes;
  if (reserve > limits.maxFileBytes)
    throw new AgentDropError('FILE_TOO_LARGE', undefined, { limit: limits.maxFileBytes });
  // serialize quota reservations per H (the endpoint row acts as the quota lock)
  await tx
    .select({ id: harnessEndpoints.id })
    .from(harnessEndpoints)
    .where(eq(harnessEndpoints.id, scope.hId))
    .for('update');
  const used = await usedBytes(tx, scope.hId);
  if (used + reserve > limits.quotaBytes) {
    throw new AgentDropError('QUOTA_EXCEEDED', undefined, { used, limit: limits.quotaBytes });
  }
  // Encrypted uploads get their id and data key before any byte arrives: the bytes are sealed while streaming.
  const id = newRowId();
  const key = newAttachmentKey(id);
  const [row] = await tx
    .insert(attachments)
    .values({
      id,
      uploadedByHId: scope.hId,
      storageKey: input.storageKey,
      ...sealAttachmentMeta(
        { id, dek: key?.wrapped ?? null },
        { safeName: input.safeName, contentType: input.contentType, sha256: null },
      ),
      dek: key?.wrapped ?? null,
      blobFormat: key ? 1 : 0,
      byteSize: reserve,
      status: 'staging',
    })
    .returning({ id: attachments.id });
  if (!row) throw new AgentDropError('INTERNAL');
  return { attachmentId: row.id, dek: key?.dek ?? null };
}

export async function finalizeAttachment(
  tx: Tx,
  scope: MailboxScope,
  attachmentId: string,
  actual: { bytes: number; sha256: string; storageKey: string; reviewHints: string[] },
): Promise<AttachmentMeta> {
  // locked: the content backfill must not seal this row between this read and the update below
  const [staged] = await tx.select().from(attachments).where(eq(attachments.id, attachmentId)).for('update');
  if (!staged) throw new AgentDropError('NOT_FOUND', 'staging attachment not found');
  const [row] = await tx
    .update(attachments)
    .set({
      byteSize: actual.bytes,
      ...sealAttachmentMeta(staged, { ...openAttachmentMeta(staged), sha256: actual.sha256 }),
      storageKey: actual.storageKey,
      status: 'ready',
      reviewHints: actual.reviewHints,
      finalizedAt: new Date(),
    })
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.uploadedByHId, scope.hId),
        eq(attachments.status, 'staging'),
      ),
    )
    .returning();
  if (!row) throw new AgentDropError('NOT_FOUND', 'staging attachment not found');
  await recordAudit(tx, {
    actorUserId: scope.userId,
    hId: scope.hId,
    action: 'attachment.upload',
    targetId: row.id,
    result: 'ok',
    meta: { bytes: actual.bytes, hints: actual.reviewHints.length },
  });
  return toAttachmentMeta(row);
}

export async function failAttachment(tx: Tx, attachmentId: string, reason: string): Promise<void> {
  await tx
    .update(attachments)
    .set({ status: 'failed', byteSize: 0, reviewHints: [reason], finalizedAt: new Date() })
    .where(and(eq(attachments.id, attachmentId), eq(attachments.status, 'staging')));
}

/** Total bytes of the attachments referenced by a send; checked against the per-drop limit. */
export async function attachmentsTotalBytes(tx: Tx, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx
    .select({ sum: sql<number>`coalesce(sum(${attachments.byteSize}), 0)::bigint` })
    .from(attachments)
    .where(inArray(attachments.id, ids));
  return Number(rows[0]?.sum ?? 0);
}

/** Hold uploads until the send or held approval commits, excluding concurrent deletion and cleanup. */
export async function assertReadyAttachments(
  tx: Tx,
  scope: MailboxScope,
  ids: string[],
  maxBytes?: number,
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx
    .select()
    .from(attachments)
    .where(inArray(attachments.id, ids))
    .orderBy(attachments.id)
    .for('update');
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new AgentDropError('ATTACHMENT_NOT_READY', 'unknown attachment', { attachment_id: id });
    if (row.uploadedByHId !== scope.hId)
      throw new AgentDropError('ATTACHMENT_NOT_OWNED', undefined, { attachment_id: id });
    if (row.status !== 'ready')
      throw new AgentDropError('ATTACHMENT_NOT_READY', undefined, { attachment_id: id });
  }
  const total = rows.reduce((n, row) => n + row.byteSize, 0);
  if (maxBytes !== undefined && total > maxBytes)
    throw new AgentDropError('FILE_TOO_LARGE', 'attachments exceed the per-drop limit', {
      total,
      limit: maxBytes,
    });
}

/** Read after locking uploads: a concurrent send must finish reserving its approval before this snapshot. */
async function pendingApprovalAttachments(tx: Tx, hIds: string[]): Promise<Set<string>> {
  if (hIds.length === 0) return new Set();
  const pending = await tx
    .select()
    .from(approvals)
    .where(
      and(
        inArray(approvals.originHId, [...new Set(hIds)]),
        eq(approvals.status, 'pending'),
        gt(approvals.expiresAt, new Date()),
      ),
    );
  // The envelope may be encrypted; inspecting its JSON column alone would silently lose those reservations.
  return new Set(pending.flatMap((row) => openApproval<SendEnvelope>(row).envelope.payload.attachment_ids));
}

export async function attachmentsReviewHints(tx: Tx, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(attachments).where(inArray(attachments.id, ids));
  return rows.flatMap((r) => {
    const name = openAttachmentMeta(r).safeName;
    return (r.reviewHints as string[]).map((h) => `${name}: ${h}`);
  });
}

/**
 * Attachment download authorization: through the drop, never by attachment id alone. The effective read scope must
 * authorize the drop *now* (revoked grants stop new downloads) and the attachment must belong to that drop.
 */
export async function authorizedAttachment(
  tx: Tx,
  scope: MailboxScope,
  dropId: string,
  attachmentId: string,
): Promise<{ meta: AttachmentMeta; storageKey: string; dek: Buffer | null }> {
  await loadAuthorizedDrop(tx, scope, dropId);
  const rows = await tx
    .select({ a: attachments })
    .from(dropAttachments)
    .innerJoin(attachments, eq(attachments.id, dropAttachments.attachmentId))
    .where(and(eq(dropAttachments.dropId, dropId), eq(dropAttachments.attachmentId, attachmentId)));
  const a = rows[0]?.a;
  // linked to a drop this reader may open, but removed since (a group admin freed space, or the owner deleted it
  // from their own space): say so, rather than pretend it never existed
  if (a?.status === 'deleted')
    throw new AgentDropError('FILE_REMOVED', 'this file was removed after the drop was sent', {
      attachment_id: a.id,
    });
  if (a?.status !== 'ready') throw new AgentDropError('NOT_FOUND', 'attachment not found');
  await recordAudit(tx, {
    actorUserId: scope.userId,
    hId: scope.hId,
    action: 'attachment.download',
    targetId: a.id,
    result: 'ok',
    meta: { drop_id: dropId, bytes: a.byteSize },
  });
  return {
    meta: toAttachmentMeta(a),
    storageKey: a.storageKey,
    // encrypted bytes (blob_format 1) are decrypted on the way out with the attachment's own key
    dek: a.blobFormat === 1 ? attachmentDek(a) : null,
  };
}

/** Marks stale staging rows for cleanup; the worker deletes the objects. Returns the affected storage keys. */
export async function expireStagedAttachments(tx: Tx, olderThan: Date): Promise<string[]> {
  const rows = await tx
    .update(attachments)
    .set({ status: 'failed', byteSize: 0, finalizedAt: new Date(), reviewHints: ['staging expired'] })
    .where(and(eq(attachments.status, 'staging'), lt(attachments.createdAt, olderThan)))
    .returning({ id: attachments.id, key: attachments.storageKey });
  for (const r of rows) await enqueueOutbox(tx, 'attachment.cleanup', r.id, { storage_key: r.key });
  return rows.map((r) => r.key);
}

/** Deletes an uploaded attachment of this H that is not linked to any drop (draft removed, composer closed). */
export async function deleteUnlinkedAttachment(
  tx: Tx,
  scope: MailboxScope,
  attachmentId: string,
): Promise<void> {
  const [row] = await tx
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.uploadedByHId, scope.hId)))
    .for('update');
  if (!row || row.status === 'deleted') throw new AgentDropError('NOT_FOUND', 'attachment not found');
  const linked = await tx
    .select({ d: dropAttachments.dropId })
    .from(dropAttachments)
    .where(eq(dropAttachments.attachmentId, row.id))
    .limit(1);
  if (linked.length > 0) throw new AgentDropError('VALIDATION_FAILED', 'attachment is part of a sent drop');
  if ((await pendingApprovalAttachments(tx, [scope.hId])).has(row.id))
    throw new AgentDropError('VALIDATION_FAILED', 'attachment is part of a pending approval');
  await tx
    .update(attachments)
    .set({ status: 'deleted', byteSize: 0, deletedAt: new Date() })
    .where(eq(attachments.id, row.id));
  await enqueueOutbox(tx, 'attachment.cleanup', row.id, { storage_key: row.storageKey });
  await recordAudit(tx, {
    actorUserId: scope.userId,
    hId: scope.hId,
    action: 'attachment.delete',
    targetId: row.id,
    result: 'ok',
  });
}

/** Ready uploads never attached to a drop within `olderThan` are released (quota + object). */
export async function expireUnlinkedAttachments(tx: Tx, olderThan: Date): Promise<string[]> {
  const eligible = and(
    eq(attachments.status, 'ready'),
    lt(attachments.createdAt, olderThan),
    isNull(attachments.deletedAt),
    notExists(
      tx
        .select({ one: sql`1` })
        .from(dropAttachments)
        .where(eq(dropAttachments.attachmentId, attachments.id)),
    ),
  );
  const candidates = await tx
    .select({ id: attachments.id, hId: attachments.uploadedByHId })
    .from(attachments)
    .where(eligible)
    .orderBy(attachments.id)
    .for('update');
  const reserved = await pendingApprovalAttachments(
    tx,
    candidates.map((row) => row.hId),
  );
  const ids = candidates.filter((row) => !reserved.has(row.id)).map((row) => row.id);
  if (ids.length === 0) return [];
  const rows = await tx
    .update(attachments)
    .set({ status: 'deleted', byteSize: 0, deletedAt: new Date(), reviewHints: ['unused upload expired'] })
    // Recheck links in a fresh statement: a send may have committed while the candidate lock was waiting.
    .where(and(inArray(attachments.id, ids), eligible))
    .returning({ id: attachments.id, key: attachments.storageKey });
  for (const r of rows) await enqueueOutbox(tx, 'attachment.cleanup', r.id, { storage_key: r.key });
  return rows.map((r) => r.key);
}
