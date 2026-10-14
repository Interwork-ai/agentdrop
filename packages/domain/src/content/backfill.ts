import { createHash, randomUUID } from 'node:crypto';
import { type Readable, Transform } from 'node:stream';
import {
  approvals,
  attachments,
  auditEvents,
  contentState,
  type Database,
  drops,
  outboxEvents,
  sendRequests,
  type Tx,
  withTx,
} from '@agentdrop/db';
import { and, count, eq, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { enqueueOutbox } from '../mailbox/outbox.js';
import {
  attachmentDek,
  newAttachmentKey,
  openApproval,
  openAttachmentMeta,
  openDrop,
  sealApproval,
  sealAttachmentMeta,
  sealDrop,
} from './codec.js';
import { contentCipher, writesEncrypted } from './state.js';
import { ciphertextSize, encryptStream } from './stream.js';

/*
 * Encrypts what was written before the switch went on (docs/plan/CONTENT_ENCRYPTION.md §13.1). One outbox event
 * does one small batch and queues the next, so no run comes near the handler timeout; every step is idempotent,
 * rows are claimed with SKIP LOCKED or re-checked under a row lock, so a crash, a retry or a second worker only
 * repeats harmless work. Whether more is needed is always recomputed from the data, never from a stored flag, so
 * switching off and on again picks up whatever was written in between.
 */

export const BACKFILL_EVENT = 'content.backfill';
const ROW_BATCH = 100;
const HASH_BATCH = 500;
const ATTACHMENT_BATCH = 5;
/** Replaced plaintext objects are deleted this much later, after any download still reading them. */
const CLEANUP_DELAY_MS = 10 * 60 * 1000;
/** While uploads that began before the switch are still in flight, look again this much later. */
export const BACKFILL_WAIT_MS = 60 * 1000;

export interface BackfillStorage {
  newKey(prefix: 'staging' | 'attachments'): string;
  get(key: string): Promise<Readable>;
  put(key: string, body: Readable, maxBytes: number): Promise<{ bytes: number; sha256: string }>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

interface BackfillState {
  done?: boolean;
  at?: string;
  /** Attachments that could not be encrypted (missing or altered object); they stay counted as plaintext. */
  skipped?: string[];
}

async function state(tx: Tx): Promise<BackfillState> {
  const [row] = await tx.select().from(contentState).where(eq(contentState.id, 1));
  return (row?.backfill as BackfillState | undefined) ?? {};
}

async function saveState(tx: Tx, next: BackfillState): Promise<void> {
  await tx
    .insert(contentState)
    .values({ id: 1, backfill: next })
    .onConflictDoUpdate({ target: contentState.id, set: { backfill: next, updatedAt: new Date() } });
}

/** An attachment whose metadata or stored bytes are still plaintext, once its upload has finished. */
const attachmentPending = (skipped: string[]) =>
  and(
    ne(attachments.status, 'staging'),
    or(isNull(attachments.dek), and(eq(attachments.status, 'ready'), eq(attachments.blobFormat, 0))),
    ...(skipped.length ? [notInArray(attachments.id, skipped)] : []),
  );

async function exists(tx: Tx, query: ReturnType<typeof sql>): Promise<boolean> {
  const result = await tx.execute<{ yes: boolean }>(sql`select exists (${query}) as yes`);
  return result.rows[0]?.yes === true;
}

/** Whether anything is left for the backfill: plaintext rows or objects, unkeyed hashes, old titles or reasons. */
export async function backfillNeeded(tx: Tx): Promise<boolean> {
  const skipped = (await state(tx)).skipped ?? [];
  const checks = [
    sql`select 1 from ${drops} where ${drops.dek} is null or ${drops.hashVersion} = 1`,
    sql`select 1 from ${approvals} where ${approvals.dek} is null or ${approvals.hashVersion} = 1`,
    sql`select 1 from ${sendRequests} where ${sendRequests.hashVersion} = 1`,
    sql`select 1 from ${attachments} where ${attachmentPending(skipped)}`,
    sql`select 1 from ${attachments} where ${attachments.status} = 'staging' and ${attachments.dek} is null`,
    sql`select 1 from ${outboxEvents} where ${outboxEvents.type} = 'drop.delivered' and ${outboxEvents.payload} ? 'title'`,
    sql`select 1 from ${auditEvents} where ${auditEvents.action} = 'drop.send' and ${auditEvents.meta} ? 'reasons'`,
    sql`select 1 from ${drops} where ${staleWrap(drops.dek)}`,
    sql`select 1 from ${approvals} where ${staleWrap(approvals.dek)}`,
    sql`select 1 from ${attachments} where ${staleWrap(attachments.dek)}`,
  ];
  for (const check of checks) if (await exists(tx, check)) return true;
  return false;
}

/** Queues a batch unless nothing is left or one is already queued (other than `excludeEventId`, the caller). */
export async function requestBackfill(
  tx: Tx,
  opts: { excludeEventId?: string; delayMs?: number } = {},
): Promise<boolean> {
  if (!(await backfillNeeded(tx))) return false;
  const [pending] = await tx
    .select({ n: count() })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.type, BACKFILL_EVENT),
        isNull(outboxEvents.deliveredAt),
        isNull(outboxEvents.deadAt),
        ...(opts.excludeEventId ? [ne(outboxEvents.id, opts.excludeEventId)] : []),
      ),
    );
  if ((pending?.n ?? 0) > 0) return false;
  await enqueueOutbox(
    tx,
    'content.backfill',
    randomUUID(),
    {},
    opts.delayMs ? new Date(Date.now() + opts.delayMs) : undefined,
  );
  return true;
}

const upgradeHash = (hash: string, version: number) =>
  version === 1 ? { hash: contentCipher().contentHmac(hash), version: 2 } : { hash, version };

async function drops_(tx: Tx): Promise<number> {
  const rows = await tx
    .select()
    .from(drops)
    .where(or(isNull(drops.dek), eq(drops.hashVersion, 1)))
    .limit(ROW_BATCH)
    .for('update', { skipLocked: true });
  for (const d of rows) {
    const h = upgradeHash(d.contentHash, d.hashVersion);
    await tx
      .update(drops)
      .set({ ...(d.dek ? {} : sealDrop(d.id, openDrop(d))), contentHash: h.hash, hashVersion: h.version })
      .where(eq(drops.id, d.id));
  }
  return rows.length;
}

async function approvals_(tx: Tx): Promise<number> {
  const rows = await tx
    .select()
    .from(approvals)
    .where(or(isNull(approvals.dek), eq(approvals.hashVersion, 1)))
    .limit(ROW_BATCH)
    .for('update', { skipLocked: true });
  for (const a of rows) {
    const h = upgradeHash(a.contentHash, a.hashVersion);
    await tx
      .update(approvals)
      .set({
        ...(a.dek ? {} : sealApproval(a.id, openApproval(a))),
        contentHash: h.hash,
        hashVersion: h.version,
      })
      .where(eq(approvals.id, a.id));
  }
  return rows.length;
}

/** Idempotency hashes upgrade in place: v2 is an HMAC over the stored v1 value. */
async function requestHashes(tx: Tx): Promise<number> {
  const rows = await tx
    .select({ id: sendRequests.id, hash: sendRequests.requestHash })
    .from(sendRequests)
    .where(eq(sendRequests.hashVersion, 1))
    .limit(HASH_BATCH)
    .for('update', { skipLocked: true });
  for (const r of rows)
    await tx
      .update(sendRequests)
      .set({ requestHash: contentCipher().contentHmac(r.hash), hashVersion: 2 })
      .where(and(eq(sendRequests.id, r.id), eq(sendRequests.hashVersion, 1)));
  return rows.length;
}

/** Counts and hashes the plaintext on its way to encryption, so a re-encrypted object is checked against its row. */
function plaintextMeter(limit: number) {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (bytes > limit) return done(new Error('stored object is larger than its record'));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  return { stream, result: () => ({ bytes, sha256: hash.digest('hex') }) };
}

type AttachmentRow = typeof attachments.$inferSelect;

/** Seals one attachment: its metadata if still plaintext, and its stored bytes if still plaintext. */
async function encryptAttachment(db: Database, storage: BackfillStorage, a: AttachmentRow): Promise<void> {
  const key = a.dek
    ? { dek: attachmentDek(a) as Buffer, wrapped: a.dek }
    : (newAttachmentKey(a.id) as { dek: Buffer; wrapped: Buffer });
  const meta = openAttachmentMeta(a);
  let newStorageKey: string | null = null;
  if (a.status === 'ready' && a.blobFormat === 0 && (await storage.exists(a.storageKey))) {
    newStorageKey = storage.newKey('attachments');
    const source = await storage.get(a.storageKey);
    const plain = plaintextMeter(a.byteSize);
    const sealed = encryptStream(key.dek, a.id);
    source.on('error', (err) => plain.stream.destroy(err));
    plain.stream.on('error', (err) => sealed.destroy(err));
    try {
      const put = await storage.put(
        newStorageKey,
        source.pipe(plain.stream).pipe(sealed),
        ciphertextSize(a.byteSize),
      );
      const measured = plain.result();
      if (
        measured.bytes !== a.byteSize ||
        put.bytes !== ciphertextSize(a.byteSize) ||
        (meta.sha256 !== null && measured.sha256 !== meta.sha256)
      )
        throw new Error('stored object does not match its record');
    } catch (err) {
      await storage.delete(newStorageKey).catch(() => undefined);
      throw err;
    }
  }
  const switched = await withTx(db, async (tx) => {
    // re-read under a lock: an upload finishing or another worker may have changed the row since it was picked
    const [row] = await tx.select().from(attachments).where(eq(attachments.id, a.id)).for('update');
    if (!row || row.status !== a.status || row.storageKey !== a.storageKey || (row.dek && !a.dek))
      return false;
    await tx
      .update(attachments)
      .set({
        ...(a.dek ? {} : { dek: key.wrapped, ...sealAttachmentMeta({ id: a.id, dek: key.wrapped }, meta) }),
        ...(newStorageKey
          ? { storageKey: newStorageKey, legacyStorageKey: a.storageKey, blobFormat: 1 }
          : {}),
      })
      .where(eq(attachments.id, a.id));
    if (newStorageKey)
      await enqueueOutbox(
        tx,
        'attachment.cleanup',
        a.id,
        { storage_key: a.storageKey },
        new Date(Date.now() + CLEANUP_DELAY_MS),
      );
    return true;
  });
  if (!switched && newStorageKey) await storage.delete(newStorageKey).catch(() => undefined);
}

async function attachments_(
  db: Database,
  storage: BackfillStorage,
): Promise<{ rows: number; skipped: string[] }> {
  const skipped = (await state(db.drizzle)).skipped ?? [];
  const rows = await db.drizzle
    .select()
    .from(attachments)
    .where(attachmentPending(skipped))
    .limit(ATTACHMENT_BATCH);
  const failed: string[] = [];
  for (const a of rows) {
    try {
      await encryptAttachment(db, storage, a);
    } catch {
      // one broken object must not stall the rest; it stays counted as plaintext and is reported
      failed.push(a.id);
    }
  }
  if (failed.length)
    await withTx(db, async (tx) => {
      const s = await state(tx);
      await saveState(tx, { ...s, skipped: [...new Set([...(s.skipped ?? []), ...failed])] });
    });
  return { rows: rows.length, skipped: failed };
}

/** Data keys still wrapped by a master key that is no longer the active one (after a key rotation). */
const staleWrap = (column: typeof drops.dek | typeof approvals.dek | typeof attachments.dek) =>
  sql`${column} is not null and substring(${column} from 3 for get_byte(${column}, 1)) <> convert_to(${contentCipher().activeKid}, 'UTF8')`;

/**
 * Key rotation (plan §14): re-wraps each row's data key with the active master key. Only the ~60-byte wrapped key
 * changes; content stays as it is. Once nothing uses an old key it can leave the online keyring.
 */
async function rewrap(tx: Tx): Promise<number> {
  const cipher = contentCipher();
  let n = 0;
  for (const [table, name] of [
    [drops, 'drops'],
    [approvals, 'approvals'],
    [attachments, 'attachments'],
  ] as const) {
    const rows = await tx
      .select({ id: table.id, dek: table.dek })
      .from(table)
      .where(staleWrap(table.dek))
      .limit(HASH_BATCH)
      .for('update', { skipLocked: true });
    for (const r of rows) {
      if (!r.dek) continue;
      const row = { table: name, id: r.id } as const;
      await tx
        .update(table)
        .set({ dek: cipher.wrapDek(cipher.unwrapDek(r.dek, row), row) })
        .where(eq(table.id, r.id));
    }
    n += rows.length;
  }
  return n;
}

/** Leftovers from before: titles in old outbox events, file names in old audit reasons. */
async function leftovers(tx: Tx): Promise<number> {
  const outbox = await tx
    .update(outboxEvents)
    .set({ payload: sql`${outboxEvents.payload} - 'title'` })
    .where(and(eq(outboxEvents.type, 'drop.delivered'), sql`${outboxEvents.payload} ? 'title'`))
    .returning({ id: outboxEvents.id });
  const audit = await tx
    .update(auditEvents)
    .set({ meta: sql`(${auditEvents.meta} - 'reasons') || '{"reasons_removed": true}'::jsonb` })
    .where(and(eq(auditEvents.action, 'drop.send'), sql`${auditEvents.meta} ? 'reasons'`))
    .returning({ id: auditEvents.id });
  return outbox.length + audit.length;
}

export interface BackfillStepResult {
  done: boolean;
  step: 'off' | 'drops' | 'approvals' | 'request_hashes' | 'rewrap' | 'attachments' | 'waiting' | 'leftovers';
  rows: number;
  /** Attachments that could not be encrypted in this step. */
  skipped?: string[];
  /** Ask to be run again this much later instead of at once. */
  waitMs?: number;
}

/** One batch. `done` once nothing is left in plaintext. Does nothing while the switch is off. */
export async function backfillStep(db: Database, storage: BackfillStorage): Promise<BackfillStepResult> {
  if (!writesEncrypted()) return { done: false, step: 'off', rows: 0 };
  const d = await withTx(db, drops_);
  if (d > 0) return { done: false, step: 'drops', rows: d };
  const a = await withTx(db, approvals_);
  if (a > 0) return { done: false, step: 'approvals', rows: a };
  const h = await withTx(db, requestHashes);
  if (h > 0) return { done: false, step: 'request_hashes', rows: h };
  const w = await withTx(db, rewrap);
  if (w > 0) return { done: false, step: 'rewrap', rows: w };
  const f = await attachments_(db, storage);
  if (f.rows > 0) return { done: false, step: 'attachments', rows: f.rows, skipped: f.skipped };
  const l = await withTx(db, leftovers);
  // uploads that began before the switch finish (or expire) on their own; seal them afterwards
  if (
    await exists(
      db.drizzle,
      sql`select 1 from ${attachments} where ${attachments.status} = 'staging' and ${attachments.dek} is null`,
    )
  )
    return { done: false, step: 'waiting', rows: l, waitMs: BACKFILL_WAIT_MS };
  await withTx(db, async (tx) =>
    saveState(tx, { ...(await state(tx)), done: true, at: new Date().toISOString() }),
  );
  return { done: true, step: 'leftovers', rows: l };
}

/** What is still stored in plaintext (admin overview, plan §13.1); skipped attachments stay counted. */
export async function plaintextRemaining(
  tx: Tx,
): Promise<{ drops: number; approvals: number; attachments: number }> {
  const [d] = await tx.select({ n: count() }).from(drops).where(isNull(drops.dek));
  const [a] = await tx.select({ n: count() }).from(approvals).where(isNull(approvals.dek));
  const [f] = await tx
    .select({ n: count() })
    .from(attachments)
    .where(or(isNull(attachments.dek), and(eq(attachments.status, 'ready'), eq(attachments.blobFormat, 0))));
  return { drops: d?.n ?? 0, approvals: a?.n ?? 0, attachments: f?.n ?? 0 };
}
