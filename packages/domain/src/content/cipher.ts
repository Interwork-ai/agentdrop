import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { Keyring } from './keyring.js';

/*
 * Envelope encryption for message content (docs/plan/CONTENT_ENCRYPTION.md §5). Every drop, attachment and
 * pending approval has its own random data key (DEK), wrapped by the active master key (KEK). Ciphertexts are bound
 * to their key id, table, row and field through associated data, so a value copied to another row or field does not
 * decrypt. AES-256-GCM throughout, from Node's own crypto.
 */

const FORMAT = 0x01;
const NONCE = 12;
const TAG = 16;
const DEK_BYTES = 32;

export class ContentCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentCryptoError';
  }
}

/** Which row a key or value belongs to. Ids are normalized to lower case, as the database returns them. */
export interface RowRef {
  table: 'drops' | 'attachments' | 'approvals' | 'content_key_checks';
  id: string;
}

export interface FieldRef extends RowRef {
  field: string;
}

function seal(key: Buffer, aad: Buffer, plaintext: Buffer, nonce: Buffer): Buffer {
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
  c.setAAD(aad);
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([body, c.getAuthTag()]);
}

function unseal(key: Buffer, aad: Buffer, nonce: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < TAG) throw new ContentCryptoError('ciphertext too short');
  const d = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
  d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - TAG));
  try {
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
  } catch {
    throw new ContentCryptoError('authentication failed');
  }
}

const dekAad = (kid: string, row: RowRef) =>
  Buffer.from(`agentdrop/dek/v1|${kid}|${row.table}|${row.id.toLowerCase()}`, 'utf8');
const fieldAad = (ref: FieldRef) =>
  Buffer.concat([
    Buffer.from(`agentdrop/field/v1|${ref.table}|${ref.id.toLowerCase()}|${ref.field}|`, 'utf8'),
    Buffer.from([FORMAT]),
  ]);

interface CacheEntry {
  dek: Buffer;
  at: number;
}

export interface CipherOptions {
  /** Test hook: deterministic nonces and keys. */
  random?: (n: number) => Buffer;
  cacheSize?: number;
  cacheTtlMs?: number;
  now?: () => number;
}

export class ContentCipher {
  private readonly random: (n: number) => Buffer;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheSize: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly keyring: Keyring,
    options: CipherOptions = {},
  ) {
    this.random = options.random ?? randomBytes;
    this.cacheSize = options.cacheSize ?? 5000;
    this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  get activeKid(): string {
    return this.keyring.active;
  }

  get kids(): string[] {
    return [...this.keyring.keys.keys()];
  }

  newDek(): Buffer {
    return this.random(DEK_BYTES);
  }

  /** `0x01 | len(kid) | kid | nonce | wrapped key | tag`, bound to the kid and the row. */
  wrapDek(dek: Buffer, row: RowRef, kid = this.keyring.active): Buffer {
    const kek = this.keyring.keys.get(kid);
    if (!kek) throw new ContentCryptoError(`unknown key id ${kid}`);
    if (dek.length !== DEK_BYTES) throw new ContentCryptoError('data key must be 32 bytes');
    const kidBytes = Buffer.from(kid, 'utf8');
    const nonce = this.random(NONCE);
    return Buffer.concat([
      Buffer.from([FORMAT, kidBytes.length]),
      kidBytes,
      nonce,
      seal(kek, dekAad(kid, row), dek, nonce),
    ]);
  }

  /** The kid a wrapped key was made with (for rewrapping and status), without unwrapping it. */
  static wrappedKid(blob: Buffer): string {
    if (blob.length < 2 || blob[0] !== FORMAT) throw new ContentCryptoError('unknown data key format');
    return blob.subarray(2, 2 + (blob[1] ?? 0)).toString('utf8');
  }

  unwrapDek(blob: Buffer, row: RowRef): Buffer {
    const kid = ContentCipher.wrappedKid(blob);
    const aad = dekAad(kid, row);
    // keyed by blob AND binding, so a cache hit can never skip the row check
    const cacheKey = createHash('sha256').update(blob).update(aad).digest('base64');
    const hit = this.cache.get(cacheKey);
    if (hit && this.now() - hit.at < this.cacheTtlMs) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, hit);
      return hit.dek;
    }
    const kek = this.keyring.keys.get(kid);
    if (!kek)
      throw new ContentCryptoError(`data key was wrapped with key ${kid}, which is not in the keyring`);
    const start = 2 + (blob[1] ?? 0);
    const nonce = blob.subarray(start, start + NONCE);
    const dek = unseal(kek, aad, nonce, blob.subarray(start + NONCE));
    if (dek.length !== DEK_BYTES) throw new ContentCryptoError('data key has the wrong length');
    this.cache.set(cacheKey, { dek, at: this.now() });
    if (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return dek;
  }

  /** `0x01 | nonce | ciphertext | tag` */
  seal(dek: Buffer, ref: FieldRef, plaintext: Buffer | string): Buffer {
    const nonce = this.random(NONCE);
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    return Buffer.concat([Buffer.from([FORMAT]), nonce, seal(dek, fieldAad(ref), data, nonce)]);
  }

  open(dek: Buffer, ref: FieldRef, blob: Buffer): Buffer {
    if (blob.length < 1 + NONCE + TAG || blob[0] !== FORMAT)
      throw new ContentCryptoError('unknown ciphertext format');
    return unseal(dek, fieldAad(ref), blob.subarray(1, 1 + NONCE), blob.subarray(1 + NONCE));
  }

  openText(dek: Buffer, ref: FieldRef, blob: Buffer): string {
    return this.open(dek, ref, blob).toString('utf8');
  }

  /**
   * Content hash v2 (§10): an HMAC over the v1 SHA-256 hex, so v1 values stored before encryption upgrade in place.
   * Stored as `<hmac kid>:<hex>`.
   */
  contentHmac(v1hex: string, kid = this.keyring.hmacActive): string {
    const key = this.keyring.hmacKeys.get(kid);
    if (!key) throw new ContentCryptoError(`unknown hmac key id ${kid}`);
    const mac = createHmac('sha256', key).update(`agentdrop/content-hash/v2|${v1hex}`).digest('hex');
    return `${kid}:${mac}`;
  }

  /** Compares a v1 hash with a stored value of either version. */
  matchesStoredHash(v1hex: string, stored: string, version: number): boolean {
    if (version === 1) return stored === v1hex;
    const kid = stored.slice(0, stored.indexOf(':'));
    if (!this.keyring.hmacKeys.has(kid)) return false;
    return this.contentHmac(v1hex, kid) === stored;
  }

  /** Key check for an HMAC key: its MAC over a fixed text. */
  hmacCheck(kid: string): Buffer {
    const key = this.keyring.hmacKeys.get(kid);
    if (!key) throw new ContentCryptoError(`unknown hmac key id ${kid}`);
    return createHmac('sha256', key).update(KEY_CHECK_TEXT).digest();
  }

  get hmacKids(): string[] {
    return [...this.keyring.hmacKeys.keys()];
  }

  /** Key check rows (§5.1): a known plaintext sealed under a kid, verified at startup. */
  keyCheck(kid: string): Buffer {
    const dek = this.newDek();
    const row: RowRef = { table: 'content_key_checks', id: kid };
    const wrapped = this.wrapDek(dek, row, kid);
    const sealed = this.seal(dek, { ...row, field: 'check' }, KEY_CHECK_TEXT);
    return Buffer.concat([Buffer.from([wrapped.length]), wrapped, sealed]);
  }

  verifyKeyCheck(kid: string, blob: Buffer): boolean {
    try {
      const len = blob[0] ?? 0;
      const row: RowRef = { table: 'content_key_checks', id: kid };
      const dek = this.unwrapDek(blob.subarray(1, 1 + len), row);
      return this.openText(dek, { ...row, field: 'check' }, blob.subarray(1 + len)) === KEY_CHECK_TEXT;
    } catch {
      return false;
    }
  }
}

const KEY_CHECK_TEXT = 'agentdrop content key check v1';
