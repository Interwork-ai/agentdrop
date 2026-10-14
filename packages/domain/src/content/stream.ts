import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { ContentCryptoError } from './cipher.js';

/*
 * Attachment bytes (docs/plan/CONTENT_ENCRYPTION.md §7): segmented streaming AEAD in the STREAM construction, with
 * the same nonce layout as Tink's streaming AEAD.
 *
 *   file    = header [ "ADE1" | 0x01 | nonce prefix (7) ] + segments
 *   segment = AES-256-GCM(dek, 64 KiB of plaintext; the last one 0..64 KiB) + 16-byte tag
 *   nonce   = prefix (7) | segment number (4, big-endian) | last flag (1)
 *   AAD     = "agentdrop/blob/v1|<attachment id>|" + header
 *
 * The counter stops reordering, the last flag stops truncation and appending, the header in the AAD stops swapping
 * or downgrading it, and the attachment id stops moving one object under another row. Decryption releases a
 * segment only after its tag verified, never unauthenticated bytes.
 */

export const SEGMENT = 64 * 1024;
const TAG = 16;
const MAGIC = Buffer.from('ADE1', 'ascii');
const VERSION = 0x01;
const PREFIX = 7;
export const HEADER_BYTES = MAGIC.length + 1 + PREFIX;
const MAX_SEGMENTS = 0xffffffff;

/** Stored size of a plaintext of `n` bytes. */
export function ciphertextSize(n: number): number {
  return HEADER_BYTES + n + TAG * Math.max(1, Math.ceil(n / SEGMENT));
}

/** Whether stored bytes start like an encrypted attachment (used by the storage inventory). */
export function looksEncrypted(head: Buffer): boolean {
  return head.length >= HEADER_BYTES && head.subarray(0, MAGIC.length).equals(MAGIC) && head[4] === VERSION;
}

function nonceFor(prefix: Buffer, counter: number, last: boolean): Buffer {
  if (counter > MAX_SEGMENTS) throw new ContentCryptoError('attachment too large to encrypt');
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(counter, PREFIX);
  n[11] = last ? 1 : 0;
  return n;
}

const aadFor = (attachmentId: string, header: Buffer) =>
  Buffer.concat([Buffer.from(`agentdrop/blob/v1|${attachmentId.toLowerCase()}|`, 'utf8'), header]);

export function encryptStream(
  dek: Buffer,
  attachmentId: string,
  random: (n: number) => Buffer = randomBytes,
): Transform {
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), random(PREFIX)]);
  const prefix = header.subarray(MAGIC.length + 1);
  const aad = aadFor(attachmentId, header);
  let pending: Buffer = Buffer.alloc(0);
  let counter = 0;
  let started = false;
  const segment = (plain: Buffer, last: boolean): Buffer => {
    const c = createCipheriv('aes-256-gcm', dek, nonceFor(prefix, counter++, last), { authTagLength: TAG });
    c.setAAD(aad);
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  };
  const start = (t: Transform) => {
    if (!started) {
      started = true;
      t.push(header);
    }
  };
  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      try {
        start(this);
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        // keep at least one full segment back: only at the end do we know which one is last
        while (pending.length > SEGMENT) {
          this.push(segment(pending.subarray(0, SEGMENT), false));
          pending = pending.subarray(SEGMENT);
        }
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    flush(done: TransformCallback) {
      try {
        start(this);
        this.push(segment(pending, true));
        done();
      } catch (err) {
        done(err as Error);
      }
    },
  });
}

export function decryptStream(dek: Buffer, attachmentId: string): Transform {
  let header: Buffer | null = null;
  let aad: Buffer | null = null;
  let prefix: Buffer | null = null;
  let pending: Buffer = Buffer.alloc(0);
  let counter = 0;
  const FULL = SEGMENT + TAG;
  const open = (sealed: Buffer, last: boolean): Buffer => {
    if (!prefix || !aad) throw new ContentCryptoError('attachment header missing');
    if (sealed.length < TAG) throw new ContentCryptoError('attachment truncated');
    const d = createDecipheriv('aes-256-gcm', dek, nonceFor(prefix, counter++, last), { authTagLength: TAG });
    d.setAAD(aad);
    d.setAuthTag(sealed.subarray(sealed.length - TAG));
    try {
      // update() already returns plaintext before the tag is checked: keep it until final() succeeds
      return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
    } catch {
      throw new ContentCryptoError('attachment failed authentication');
    }
  };
  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      try {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        if (!header) {
          if (pending.length < HEADER_BYTES) return done();
          header = Buffer.from(pending.subarray(0, HEADER_BYTES));
          if (!looksEncrypted(header)) throw new ContentCryptoError('not an encrypted attachment');
          prefix = header.subarray(MAGIC.length + 1);
          aad = aadFor(attachmentId, header);
          pending = pending.subarray(HEADER_BYTES);
        }
        // a full segment is only known not to be the last once more bytes follow it
        while (pending.length > FULL) {
          this.push(open(pending.subarray(0, FULL), false));
          pending = pending.subarray(FULL);
        }
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    flush(done: TransformCallback) {
      try {
        if (!header) throw new ContentCryptoError('attachment header missing');
        this.push(open(pending, true));
        done();
      } catch (err) {
        done(err as Error);
      }
    },
  });
}
