import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const CREDENTIAL_PREFIX = 'adh_';

/** High-entropy opaque credential bound to one H. Only its hash is stored. */
export function generateCredential(): string {
  return CREDENTIAL_PREFIX + randomBytes(32).toString('base64url');
}

export function generateDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

/** Crockford-like alphabet without ambiguous characters; 8 chars ≈ 40 bits. Displayed as XXXX-XXXX. */
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export function generateUserCode(): string {
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
    if (i === 3) out += '-';
  }
  return out;
}

export function normalizeUserCode(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Canonical JSON (sorted keys) for content hashes used by idempotency and approvals. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
