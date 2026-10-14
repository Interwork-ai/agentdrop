import { finished, type Readable, Transform } from 'node:stream';
import { AgentDropError, z } from '@agentdrop/contracts';
import { harnessEndpoints, withTx } from '@agentdrop/db';
import {
  authorizedAttachment,
  ciphertextSize,
  decryptStream,
  deleteUnlinkedAttachment,
  encryptStream,
  failAttachment,
  finalizeAttachment,
  type MailboxScope,
  stageAttachment,
} from '@agentdrop/domain';
import {
  contentTypeFor,
  reviewHintsFromBytes,
  safeDownloadContentType,
  safeFilename,
} from '@agentdrop/security';
import { meter, StorageLimitError } from '@agentdrop/storage';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { requireH, requireUser, userPrincipalOf } from '../plugins/principals.js';
import { parse } from '../plugins/validate.js';

type ScopeResolver = (req: FastifyRequest) => Promise<MailboxScope>;

/** Streaming upload/download. Bodies never sit in memory; downloads are proxied through the API with a live check. */
export async function hAttachmentRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', requireH(ctx));
  registerAttachmentRoutes(app, ctx, '/v1/h', async (req) => {
    const a = req.hAuth;
    if (!a) throw new AgentDropError('UNAUTHORIZED');
    return { userId: a.user.userId, hId: a.endpoint.hId, via: 'h_credential' };
  });
}

export async function webAttachmentRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', requireUser(ctx));
  registerAttachmentRoutes(app, ctx, '/v1/me/endpoints/:h_id', async (req) => {
    const p = userPrincipalOf(req);
    const { h_id } = parse(z.object({ h_id: z.uuid() }), req.params);
    const h = await ctx.db.drizzle.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, h_id) });
    if (!h || h.userId !== p.userId) throw new AgentDropError('NOT_FOUND', 'endpoint not found');
    return { userId: p.userId, hId: h.id, via: 'user_session' };
  });
}

function registerAttachmentRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  prefix: string,
  resolve: ScopeResolver,
): void {
  // Raw octet-stream bodies are passed through as streams (no buffering, no body limit from the JSON parser).
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.post(`${prefix}/attachments`, async (req, reply) => {
    const scope = await resolve(req);
    const rawName = header(req, 'x-agentdrop-filename') ?? 'attachment';
    const safeName = safeFilename(decodeFilename(rawName));
    const declared = header(req, 'content-length');
    const declaredBytes = declared && /^\d+$/.test(declared) ? Number(declared) : null;
    const hintsHeader = header(req, 'x-agentdrop-review-hints');
    const reviewHints = hintsHeader ? safeHints(hintsHeader) : [];
    const binaryHint = header(req, 'x-agentdrop-binary') === '1';
    const contentType = header(req, 'x-agentdrop-content-type') ?? contentTypeFor(safeName, binaryHint);
    const limits = {
      maxFileBytes: ctx.config.MAX_FILE_BYTES,
      maxDropFileBytes: ctx.config.MAX_DROP_FILE_BYTES,
      quotaBytes: ctx.config.H_STORAGE_QUOTA_BYTES,
    };
    if (declaredBytes !== null && declaredBytes > limits.maxFileBytes) {
      throw new AgentDropError('FILE_TOO_LARGE', undefined, { limit: limits.maxFileBytes });
    }
    // Persist the only object key before writing any bytes. Staging is a database state, not a second object:
    // if finalization fails or the API dies, the existing sweep can still find and remove the completed upload.
    const objectKey = ctx.storage.newKey('attachments');
    const { attachmentId, dek } = await withTx(ctx.db, (tx) =>
      stageAttachment(tx, scope, { safeName, contentType, declaredBytes, storageKey: objectKey }, limits),
    );
    const body = req.body as Readable | undefined;
    if (!body || typeof (body as Readable).pipe !== 'function') {
      await withTx(ctx.db, (tx) => failAttachment(tx, attachmentId, 'no body'));
      throw new AgentDropError('VALIDATION_FAILED', 'send the file as application/octet-stream');
    }
    // The server classifies the bytes it actually receives; client-supplied hints are merged, never trusted alone.
    const sniff = sniffer();
    // Storage attaches to this stream only after its own setup (mkdir, S3 client), so a client abort in between
    // would destroy it with nobody listening — an uncaught 'error' that crashes the process. The stream keeps its
    // errored state, so storage still sees the failure when it attaches and the upload is marked failed below.
    sniff.stream.on('error', () => {});
    /*
     * Encrypted uploads (docs/plan/CONTENT_ENCRYPTION.md §7.2): the plaintext is measured and hashed, then sealed,
     * and storage only ever sees ciphertext. pipe() does not forward errors, so each stage passes its failure on
     * (a size limit, a client abort) to the one storage reads from, which keeps the errored state until it attaches.
     */
    const plain = dek ? meter(limits.maxFileBytes) : null;
    let source: Readable = sniff.stream;
    if (dek && plain) {
      const sealed = encryptStream(dek, attachmentId);
      for (const s of [plain.stream, sealed]) s.on('error', () => {});
      sniff.stream.on('error', (err) => plain.stream.destroy(err));
      plain.stream.on('error', (err) => sealed.destroy(err));
      source = sniff.stream.pipe(plain.stream).pipe(sealed);
    }
    let put: { bytes: number; sha256: string };
    try {
      // pipe() alone never forwards a client abort or socket error, so storage would wait forever on a half-written
      // object while the quota reservation stays held. The body is not destroyed on our own errors (e.g. size limit)
      // because that would reset the socket before the 413 is written.
      finished(body, (err) => {
        if (err) sniff.stream.destroy(err);
      });
      body.pipe(sniff.stream);
      put = await ctx.storage.put(
        objectKey,
        source,
        dek ? ciphertextSize(limits.maxFileBytes) : limits.maxFileBytes,
      );
      if (plain) {
        // what the sender sent: size and hash of the plaintext, checked against what storage wrote
        const stored = put.bytes;
        put = plain.result();
        if (stored !== ciphertextSize(put.bytes)) throw new Error('encrypted upload has an unexpected size');
      }
    } catch (err) {
      await withTx(ctx.db, (tx) => failAttachment(tx, attachmentId, 'upload aborted'));
      if (err instanceof StorageLimitError)
        throw new AgentDropError('FILE_TOO_LARGE', undefined, { limit: limits.maxFileBytes });
      throw err;
    }
    if (declaredBytes !== null && declaredBytes !== put.bytes) {
      await ctx.storage.delete(objectKey).catch(() => undefined);
      await withTx(ctx.db, (tx) => failAttachment(tx, attachmentId, 'size mismatch'));
      throw new AgentDropError('VALIDATION_FAILED', 'declared size does not match the uploaded bytes');
    }
    const serverHints = reviewHintsFromBytes(sniff.head(), put.bytes, safeName);
    const mergedHints = [...new Set([...serverHints, ...reviewHints])];
    const meta = await withTx(ctx.db, (tx) =>
      finalizeAttachment(tx, scope, attachmentId, {
        bytes: put.bytes,
        sha256: put.sha256,
        storageKey: objectKey,
        reviewHints: mergedHints,
      }),
    );
    return reply.status(201).send({ ...meta, status: 'ready', review_hints: mergedHints });
  });

  app.delete(`${prefix}/attachments/:attachment_id`, async (req) => {
    const scope = await resolve(req);
    const { attachment_id } = parse(z.object({ attachment_id: z.uuid() }), req.params);
    await withTx(ctx.db, (tx) => deleteUnlinkedAttachment(tx, scope, attachment_id));
    return { ok: true };
  });

  app.get(`${prefix}/drops/:drop_id/attachments/:attachment_id`, async (req, reply) => {
    const scope = await resolve(req);
    const { drop_id, attachment_id } = parse(
      z.object({ drop_id: z.uuid(), attachment_id: z.uuid() }),
      req.params,
    );
    const { meta, storageKey, dek } = await withTx(ctx.db, (tx) =>
      authorizedAttachment(tx, scope, drop_id, attachment_id),
    );
    const stored = await ctx.storage.get(storageKey);
    let stream: Readable = stored;
    if (dek) {
      // every segment is authenticated before it is sent; a failure cuts the response short, it never sends bad bytes
      const plain = decryptStream(dek, attachment_id);
      stored.on('error', (err) => plain.destroy(err));
      plain.on('error', (err) =>
        req.log.error({ attachment_id, err: err.name }, 'attachment decryption failed'),
      );
      stream = stored.pipe(plain);
    }
    reply.header('Content-Type', safeDownloadContentType(meta.content_type));
    reply.header('Content-Length', String(meta.byte_size));
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(meta.safe_name)}`);
    reply.header('X-Agentdrop-Sha256', meta.sha256);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(stream);
  });
}

/** Captures the first 64 KiB of a stream while passing everything through unchanged. */
function sniffer() {
  const chunks: Buffer[] = [];
  let captured = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (captured < 64 * 1024) {
        const take = chunk.subarray(0, 64 * 1024 - captured);
        chunks.push(Buffer.from(take));
        captured += take.length;
      }
      cb(null, chunk);
    },
  });
  return { stream, head: () => Buffer.concat(chunks) };
}

/** Clients percent-encode the name; a malformed escape is a client error, not a server crash. */
function decodeFilename(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new AgentDropError('VALIDATION_FAILED', 'x-agentdrop-filename must be percent-encoded UTF-8', {
      field: 'x-agentdrop-filename',
    });
  }
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function safeHints(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((h): h is string => typeof h === 'string')
      .map((h) => h.slice(0, 160))
      .slice(0, 10);
  } catch {
    return [];
  }
}
