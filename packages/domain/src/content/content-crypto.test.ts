import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { ContentCipher, ContentCryptoError, type FieldRef, type RowRef } from './cipher.js';
import { generateKeyring, KeyringError, kidFor, loadKeyring, parseKeyring } from './keyring.js';
import {
  ciphertextSize,
  decryptStream,
  encryptStream,
  HEADER_BYTES,
  looksEncrypted,
  SEGMENT,
} from './stream.js';

/** Deterministic "random" bytes for known-answer tests. */
function counterRandom(seed = 1): (n: number) => Buffer {
  let next = seed;
  return (n) => Buffer.from(Array.from({ length: n }, () => next++ % 256));
}

const keyringText = generateKeyring(counterRandom(7));
const keyring = parseKeyring(keyringText);
const row: RowRef = { table: 'drops', id: '0B8F6A2E-1C2D-4E5F-8A9B-0C1D2E3F4A5B' };
const title: FieldRef = { ...row, field: 'title' };

describe('keyring', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdrop-keyring-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('names keys by fingerprint and rejects a key that does not match its id', () => {
    const k = keyring.keys.get(keyring.active);
    expect(k && kidFor('k', k)).toBe(keyring.active);
    expect(keyring.active).toMatch(/^k-[0-9a-f]{8}$/);
    expect(keyring.hmacActive).toMatch(/^h-[0-9a-f]{8}$/);
    const raw = JSON.parse(keyringText);
    const other = randomBytes(32).toString('base64');
    raw.keys[raw.active] = other;
    expect(() => parseKeyring(JSON.stringify(raw))).toThrow(/does not match/);
  });

  it('rejects wrong lengths, a missing active key, and never echoes the input on bad JSON', () => {
    const raw = JSON.parse(keyringText);
    expect(() => parseKeyring(JSON.stringify({ ...raw, active: 'k-00000000' }))).toThrow(KeyringError);
    const short = Buffer.alloc(16, 1);
    expect(() =>
      parseKeyring(JSON.stringify({ ...raw, keys: { [kidFor('k', short)]: short.toString('base64') } })),
    ).toThrow(/32 bytes/);
    const secret = 'c2VjcmV0LWtleS1tYXRlcmlhbA==';
    try {
      parseKeyring(`{"keys": "${secret}`);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('loads only a private file owned by this user; inline keys only in tests', () => {
    const file = join(dir, 'keys.json');
    writeFileSync(file, keyringText);
    chmodSync(file, 0o644);
    expect(() => loadKeyring({ file, allowInline: false })).toThrow(/group or others/);
    chmodSync(file, 0o400);
    expect(loadKeyring({ file, allowInline: false })?.active).toBe(keyring.active);
    expect(loadKeyring({ allowInline: false })).toBeNull();
    expect(() => loadKeyring({ inline: keyringText, allowInline: false })).toThrow(/only accepted in tests/);
    expect(loadKeyring({ inline: keyringText, allowInline: true })?.active).toBe(keyring.active);
  });
});

describe('field encryption', () => {
  const cipher = new ContentCipher(keyring);

  it('round-trips and is bound to its row and field, also when the data key comes from the cache', () => {
    const dek = cipher.newDek();
    const wrapped = cipher.wrapDek(dek, row);
    const sealed = cipher.seal(cipher.unwrapDek(wrapped, row), title, '实验结果 ready');
    expect(cipher.openText(cipher.unwrapDek(wrapped, row), title, sealed)).toBe('实验结果 ready');
    // same row in lower case (as the database returns it) is the same binding
    expect(cipher.openText(dek, { ...title, id: row.id.toLowerCase() }, sealed)).toBe('实验结果 ready');
    const otherRow: RowRef = { table: 'drops', id: '11111111-1111-4111-8111-111111111111' };
    expect(() => cipher.unwrapDek(wrapped, otherRow)).toThrow(ContentCryptoError); // wrapped key copied to another row
    expect(() => cipher.unwrapDek(wrapped, { ...row, table: 'approvals' })).toThrow(ContentCryptoError);
    expect(() => cipher.open(dek, { ...title, field: 'body' }, sealed)).toThrow(ContentCryptoError);
    expect(() => cipher.open(dek, { ...title, ...otherRow }, sealed)).toThrow(ContentCryptoError);
  });

  it('detects any flipped byte', () => {
    const dek = cipher.newDek();
    const sealed = cipher.seal(dek, title, 'hello');
    for (let i = 0; i < sealed.length; i++) {
      const bad = Buffer.from(sealed);
      bad[i] = (bad[i] ?? 0) ^ 0x01;
      expect(() => cipher.open(dek, title, bad)).toThrow(ContentCryptoError);
    }
    const wrapped = cipher.wrapDek(dek, row);
    const bad = Buffer.from(wrapped);
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0x01;
    expect(() => new ContentCipher(keyring).unwrapDek(bad, row)).toThrow(ContentCryptoError);
  });

  it('keeps the stored format stable (known answer)', () => {
    const fixed = new ContentCipher(keyring, { random: counterRandom(100) });
    const dek = Buffer.alloc(32, 0x42);
    const sealed = fixed.seal(dek, title, 'known answer');
    expect(sealed.toString('hex')).toBe(KNOWN_FIELD_HEX);
    const wrapped = fixed.wrapDek(dek, row);
    expect(wrapped.toString('hex')).toBe(KNOWN_WRAPPED_HEX);
  });

  it('reads keys wrapped by an older master key after rotation', () => {
    const dek = cipher.newDek();
    const oldWrapped = cipher.wrapDek(dek, row);
    const next = parseKeyring(generateKeyring());
    const rotated = new ContentCipher({
      ...keyring,
      active: next.active,
      keys: new Map([...keyring.keys, ...next.keys]),
    });
    expect(rotated.unwrapDek(oldWrapped, row).equals(dek)).toBe(true);
    expect(ContentCipher.wrappedKid(rotated.wrapDek(dek, row))).toBe(next.active);
    // a keyring without the old key cannot read it
    expect(() => new ContentCipher(next).unwrapDek(oldWrapped, row)).toThrow(/not in the keyring/);
  });

  it('upgrades v1 hashes to keyed v2 in place and compares either version', () => {
    const v1 = 'a'.repeat(64);
    const v2 = cipher.contentHmac(v1);
    expect(v2).toMatch(new RegExp(`^${keyring.hmacActive}:[0-9a-f]{64}$`));
    expect(cipher.contentHmac(v1)).toBe(v2);
    expect(cipher.matchesStoredHash(v1, v2, 2)).toBe(true);
    expect(cipher.matchesStoredHash(v1, v1, 1)).toBe(true);
    expect(cipher.matchesStoredHash('b'.repeat(64), v2, 2)).toBe(false);
    expect(new ContentCipher(parseKeyring(generateKeyring())).matchesStoredHash(v1, v2, 2)).toBe(false);
  });

  it('verifies key check rows only with the same key', () => {
    const check = cipher.keyCheck(keyring.active);
    expect(cipher.verifyKeyCheck(keyring.active, check)).toBe(true);
    const impostor = parseKeyring(generateKeyring());
    // a different key under the same id (hand-edited file) fails the check
    const swapped = new ContentCipher({
      ...impostor,
      active: keyring.active,
      keys: new Map([[keyring.active, impostor.keys.get(impostor.active) ?? Buffer.alloc(32)]]),
    });
    expect(swapped.verifyKeyCheck(keyring.active, check)).toBe(false);
  });
});

async function encrypt(plain: Buffer, id: string, dek: Buffer, chunk = 7919): Promise<Buffer> {
  const out: Buffer[] = [];
  const parts = Array.from({ length: Math.ceil(plain.length / chunk) || 1 }, (_, i) =>
    plain.subarray(i * chunk, (i + 1) * chunk),
  );
  await pipeline(
    Readable.from(plain.length ? parts : []),
    encryptStream(dek, id),
    new Writable({
      write(c, _e, done) {
        out.push(c);
        done();
      },
    }),
  );
  return Buffer.concat(out);
}

async function decrypt(
  stored: Buffer,
  id: string,
  dek: Buffer,
): Promise<{ out: Buffer; error: Error | null }> {
  const out: Buffer[] = [];
  let error: Error | null = null;
  try {
    await pipeline(
      Readable.from([stored.subarray(0, 1000), stored.subarray(1000)].filter((b) => b.length)),
      decryptStream(dek, id),
      new Writable({
        write(c, _e, done) {
          out.push(c);
          done();
        },
      }),
    );
  } catch (err) {
    error = err as Error;
  }
  return { out: Buffer.concat(out), error };
}

describe('attachment streams', () => {
  const dek = randomBytes(32);
  const id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

  it.each([0, 1, SEGMENT - 1, SEGMENT, SEGMENT + 1, 3 * SEGMENT, 3 * SEGMENT + 5])(
    'round-trips %i bytes with the predicted stored size',
    async (n) => {
      const plain = randomBytes(n);
      const stored = await encrypt(plain, id, dek);
      expect(stored.length).toBe(ciphertextSize(n));
      expect(looksEncrypted(stored)).toBe(true);
      const { out, error } = await decrypt(stored, id, dek);
      expect(error).toBeNull();
      expect(out.equals(plain)).toBe(true);
    },
  );

  it('refuses truncation, reordering, appending, a changed header and another attachment id', async () => {
    const plain = randomBytes(3 * SEGMENT + 10);
    const stored = await encrypt(plain, id, dek);
    const seg = SEGMENT + 16;
    const s = (i: number) => stored.subarray(HEADER_BYTES + i * seg, HEADER_BYTES + (i + 1) * seg);
    const header = stored.subarray(0, HEADER_BYTES);
    const lastStart = HEADER_BYTES + 3 * seg;
    const cases: Record<string, Buffer> = {
      'drop last segment': stored.subarray(0, lastStart),
      'cut inside last segment': stored.subarray(0, stored.length - 3),
      'swap first two': Buffer.concat([header, s(1), s(0), stored.subarray(HEADER_BYTES + 2 * seg)]),
      'append a copy of a segment': Buffer.concat([stored, s(0)]),
      'header only': header,
      'changed header': Buffer.concat([
        Buffer.from('ADE1\u0001', 'latin1'),
        Buffer.alloc(7),
        stored.subarray(HEADER_BYTES),
      ]),
    };
    for (const [name, bad] of Object.entries(cases)) {
      const { error } = await decrypt(bad, id, dek);
      expect(error, name).toBeInstanceOf(ContentCryptoError);
    }
    expect((await decrypt(stored, 'ffffffff-ffff-4fff-8fff-ffffffffffff', dek)).error).toBeInstanceOf(
      ContentCryptoError,
    );
  });

  it('releases no byte of a tampered segment', async () => {
    const plain = randomBytes(3 * SEGMENT);
    const stored = Buffer.from(await encrypt(plain, id, dek));
    const seg = SEGMENT + 16;
    stored[HEADER_BYTES + seg + 100] = (stored[HEADER_BYTES + seg + 100] ?? 0) ^ 0xff; // inside segment 2
    const { out, error } = await decrypt(stored, id, dek);
    expect(error).toBeInstanceOf(ContentCryptoError);
    expect(out.length).toBe(SEGMENT); // only segment 1, which verified
    expect(out.equals(plain.subarray(0, SEGMENT))).toBe(true);
  });
});

const KNOWN_FIELD_HEX = '016465666768696a6b6c6d6e6f304dd3afe20dec52d561e52a0bf0fbfece63ae8e7fdcbe91f57ce29e';
const KNOWN_WRAPPED_HEX =
  '010a6b2d6334396464303664707172737475767778797a7bf43a724691cfd2c490c3c39252b38a14a7b3b76382931c2eb152b7e3f8e029aebb38b69e104ea571035685224e7211c1';
