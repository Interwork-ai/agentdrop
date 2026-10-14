import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/*
 * The content keyring (docs/plan/CONTENT_ENCRYPTION.md §5.1): master keys (KEKs) that wrap per-row data keys, and
 * HMAC keys for content hashes. It lives in a file outside the database, the deploy backups and any env file that a
 * deploy script copies. Key ids are fingerprints of the key, so two servers never share an id and a regenerated key
 * can never pass for an old one. Nothing here ever logs or returns key material.
 */

export const KEY_BYTES = 32;

export interface Keyring {
  /** kid used to wrap new data keys. */
  active: string;
  keys: ReadonlyMap<string, Buffer>;
  /** HMAC key id used for new content hashes. */
  hmacActive: string;
  hmacKeys: ReadonlyMap<string, Buffer>;
}

export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringError';
  }
}

/** `k-` (master key) or `h-` (HMAC key) plus the first 8 hex digits of a domain-separated SHA-256 of the key. */
export function kidFor(kind: 'k' | 'h', key: Buffer): string {
  const digest = createHash('sha256').update('agentdrop/kid|').update(key).digest('hex');
  return `${kind}-${digest.slice(0, 8)}`;
}

function decodeKey(kind: 'k' | 'h', kid: string, value: unknown): Buffer {
  if (typeof value !== 'string') throw new KeyringError(`key ${kid} is not a base64 string`);
  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== value.replace(/\s+/g, ''))
    throw new KeyringError(`key ${kid} must be exactly ${KEY_BYTES} bytes of base64`);
  if (kidFor(kind, key) !== kid)
    throw new KeyringError(`key id ${kid} does not match its key (expected ${kidFor(kind, key)})`);
  return key;
}

function decodeSet(
  kind: 'k' | 'h',
  raw: unknown,
  what: string,
): { active: string; keys: Map<string, Buffer> } {
  const obj = raw as { active?: unknown; keys?: unknown } | null;
  if (!obj || typeof obj !== 'object') throw new KeyringError(`${what} missing`);
  if (!obj.keys || typeof obj.keys !== 'object') throw new KeyringError(`${what}.keys missing`);
  const keys = new Map<string, Buffer>();
  for (const [kid, value] of Object.entries(obj.keys as Record<string, unknown>))
    keys.set(kid, decodeKey(kind, kid, value));
  if (typeof obj.active !== 'string' || !keys.has(obj.active))
    throw new KeyringError(`${what}.active must name one of its keys`);
  return { active: obj.active, keys };
}

export function parseKeyring(text: string): Keyring {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // never echo the parser message: it quotes the input, which holds keys
    throw new KeyringError('keyring is not valid JSON');
  }
  const obj = raw as { active?: unknown; keys?: unknown; hmac?: unknown } | null;
  if (!obj || typeof obj !== 'object') throw new KeyringError('keyring must be a JSON object');
  const master = decodeSet('k', { active: obj.active, keys: obj.keys }, 'keyring');
  const hmac = decodeSet('h', obj.hmac, 'keyring.hmac');
  return { active: master.active, keys: master.keys, hmacActive: hmac.active, hmacKeys: hmac.keys };
}

export interface KeyringSource {
  /** CONTENT_KEYS_FILE */
  file?: string | undefined;
  /** CONTENT_KEYS (the JSON inline); accepted only when `allowInline` (tests). */
  inline?: string | undefined;
  allowInline: boolean;
}

/**
 * Loads the keyring, or null when none is configured. A file must not be readable by group or others and must
 * belong to the user running the process, so a deploy that "fixes" access with chmod 644 fails loudly instead.
 */
export function loadKeyring(source: KeyringSource): Keyring | null {
  if (source.file) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(source.file);
    } catch {
      throw new KeyringError(`CONTENT_KEYS_FILE ${source.file} cannot be read`);
    }
    if ((st.mode & 0o077) !== 0)
      throw new KeyringError(`CONTENT_KEYS_FILE must not be accessible to group or others (chmod 400)`);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && st.uid !== uid)
      throw new KeyringError(`CONTENT_KEYS_FILE must belong to the user running AgentDrop (uid ${uid})`);
    return parseKeyring(readFileSync(source.file, 'utf8'));
  }
  if (source.inline) {
    if (!source.allowInline)
      throw new KeyringError('CONTENT_KEYS is only accepted in tests; use CONTENT_KEYS_FILE');
    return parseKeyring(source.inline);
  }
  return null;
}

/** A fresh keyring with one master key and one HMAC key (the keygen script prints this). */
export function generateKeyring(random: (n: number) => Buffer = randomBytes): string {
  const k = random(KEY_BYTES);
  const h = random(KEY_BYTES);
  return `${JSON.stringify(
    {
      active: kidFor('k', k),
      keys: { [kidFor('k', k)]: k.toString('base64') },
      hmac: { active: kidFor('h', h), keys: { [kidFor('h', h)]: h.toString('base64') } },
    },
    null,
    2,
  )}\n`;
}
