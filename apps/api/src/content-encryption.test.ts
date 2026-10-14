import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { attachments, auditEvents, drops, outboxEvents, withTx } from '@agentdrop/db';
import {
  backfillStep,
  ContentCipher,
  configureContentEncryption,
  generateKeyring,
  initContentEncryption,
  parseKeyring,
  plaintextRemaining,
  requestBackfill,
  reviewHintApprovalPolicy,
  SEARCH_SCAN_LIMIT,
  sealDrop,
  stageAttachment,
} from '@agentdrop/domain';
import type { StorageProvider } from '@agentdrop/storage';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type BrowserUser,
  createTestApp,
  hHeaders,
  type PairedEndpoint,
  pair,
  signUp,
  TEST_DATABASE_URL,
  type TestApp,
} from './testing/harness.js';

/*
 * Content encryption at rest (docs/plan/CONTENT_ENCRYPTION.md §15): nothing a person wrote reaches the database or
 * the attachment store in the clear, everything still reads back the same, search finds content past its per-request
 * budget, the switch can move both ways, and startup fails closed. Runs with encryption on in both test modes.
 */
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
/** The same fixed keyring as tests/setup/content-encryption.ts. */
const TEST_KEYRING = generateKeyring((n) => Buffer.alloc(n, 0x5a));
const cipher = new ContentCipher(parseKeyring(TEST_KEYRING));
const MARK = 'ZEBRA-7f3c-秘密';

/** Records every object the app stores, so the test can read the raw bytes afterwards. */
function recording(keys: Set<string>) {
  return (inner: StorageProvider): StorageProvider => ({
    kind: inner.kind,
    newKey: (prefix) => inner.newKey(prefix),
    put: (key, body, max) => {
      keys.add(key);
      return inner.put(key, body, max);
    },
    get: (key) => inner.get(key),
    delete: (key) => inner.delete(key),
    exists: (key) => inner.exists(key),
    promote: async (from, to) => {
      keys.add(to);
      await inner.promote(from, to);
    },
    ping: () => inner.ping(),
  });
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const CONTENT_TABLES = [
  'drops',
  'attachments',
  'approvals',
  'send_requests',
  'outbox_events',
  'audit_events',
  'mailbox_events',
];

describeDb('content encryption at rest', () => {
  let t: TestApp;
  let storage: StorageProvider;
  const stored = new Set<string>();
  let alice: BrowserUser;
  let bob: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;

  beforeAll(async () => {
    t = await createTestApp({
      approvalPolicy: reviewHintApprovalPolicy,
      wrapStorage: (inner) => {
        storage = recording(stored)(inner);
        return storage;
      },
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    configureContentEncryption({ cipher, mode: 'on' });
    await t.reset();
    stored.clear();
    alice = await signUp(t, 'alice', 'Alice');
    bob = await signUp(t, 'bob', 'Bob');
    aliceH = await pair(t, alice);
    bobH = await pair(t, bob);
    await t.app.inject({
      method: 'POST',
      url: '/v1/me/contacts/invite',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { handle: bob.handle },
    });
    await t.app.inject({
      method: 'POST',
      url: `/v1/me/contacts/${alice.userId}/accept`,
      headers: { cookie: bob.cookie, origin: t.origin },
    });
  });

  const send = (title: string, body: string, attachmentIds: string[] = [], requestId = randomUUID()) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(aliceH.credential),
      payload: {
        request_id: requestId,
        targets: [{ type: 'user', user_id: bob.userId }],
        payload: {
          payload_version: 1,
          kind: 'text',
          title,
          body,
          attachment_ids: attachmentIds,
          extensions: {},
        },
      },
    });

  it('stores no plaintext in any table or stored object, and reads everything back unchanged', async () => {
    // a binary attachment is held for approval under reviewHintApprovalPolicy, so the reasons name the file too
    const bytes = Buffer.concat([Buffer.from(`${MARK} inside the file `), Buffer.alloc(70_000, 0)]);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const up = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceH.credential),
        'content-type': 'application/octet-stream',
        'x-agentdrop-filename': encodeURIComponent(`${MARK}.bin`),
        'x-agentdrop-binary': '1',
      },
      payload: bytes,
    });
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json()).toMatchObject({ safe_name: `${MARK}.bin`, byte_size: bytes.length, sha256: sha });
    const held = await send(`${MARK} title`, `${MARK} body`, [up.json().attachment_id]);
    expect(held.json().outcome).toBe('needs_approval');
    const approvals = (
      await t.app.inject({ method: 'GET', url: '/v1/me/approvals', headers: { cookie: alice.cookie } })
    ).json().approvals;
    expect(approvals[0]).toMatchObject({ title: `${MARK} title`, body_preview: `${MARK} body` });
    expect(approvals[0].reasons.join()).toContain(`${MARK}.bin`);
    const approved = await t.app.inject({
      method: 'POST',
      url: `/v1/me/approvals/${approvals[0].approval_id}/decide`,
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { decision: 'approve' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const dropId = approved.json().drop_id;
    const direct = await send(`${MARK} second`, `${MARK} second body`);
    expect(direct.json().outcome).toBe('delivered');

    // at rest: every table that ever held content, as text (bytea shows as hex, so check the hex form too)
    const needles = [MARK, Buffer.from(MARK).toString('hex')];
    for (const table of [
      'drops',
      'attachments',
      'approvals',
      'send_requests',
      'outbox_events',
      'audit_events',
      'mailbox_events',
    ]) {
      const rows = await t.db.drizzle.execute<{ row: string }>(
        sql.raw(`select t::text as row from "${table}" t`),
      );
      for (const { row } of rows.rows)
        for (const n of needles) expect(row, `${table} holds plaintext`).not.toContain(n);
    }
    for (const key of stored) {
      if (!(await storage.exists(key))) continue;
      const raw = await readAll(await storage.get(key));
      expect(raw.includes(Buffer.from(MARK)), `object ${key} holds plaintext`).toBe(false);
    }

    // and back: the recipient reads and downloads exactly what was sent
    const read = (
      await t.app.inject({ method: 'GET', url: `/v1/h/drops/${dropId}`, headers: hHeaders(bobH.credential) })
    ).json().drop;
    expect(read).toMatchObject({ title: `${MARK} title`, body_chunk: `${MARK} body` });
    expect(read.attachments[0]).toMatchObject({ safe_name: `${MARK}.bin`, sha256: sha });
    const dl = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}/attachments/${up.json().attachment_id}`,
      headers: hHeaders(bobH.credential),
    });
    expect(dl.headers['x-agentdrop-sha256']).toBe(sha);
    expect(dl.rawPayload.equals(bytes)).toBe(true);
    const list = (
      await t.app.inject({ method: 'GET', url: '/v1/h/drops?view=inbox', headers: hHeaders(bobH.credential) })
    ).json();
    expect(list.drops.map((d: { title: string }) => d.title).sort()).toEqual([
      `${MARK} second`,
      `${MARK} title`,
    ]);
  });

  it(`searches decrypted content, continuing past ${SEARCH_SCAN_LIMIT} rows with the cursor`, async () => {
    const author = { user_id: alice.userId, handle: alice.handle, display_name: 'Alice' };
    const base = Date.now() - 10_000_000;
    // the only match is the oldest of SEARCH_SCAN_LIMIT + 100 sent drops
    const values = Array.from({ length: SEARCH_SCAN_LIMIT + 101 }, (_, i) => {
      const id = randomUUID();
      const title = i === 0 ? 'Quarterly Needle report' : `filler ${i}`;
      return {
        id,
        authorUserId: alice.userId,
        originHId: aliceH.hId,
        originKind: 'mcp' as const,
        kind: 'text',
        ...sealDrop(id, { title, body: 'nothing here', extensions: {} }),
        bodyChars: 12,
        authorSnapshot: author,
        targetSnapshot: { recipients: [], user_ids: [], group_ids: [] },
        contentHash: 'x',
        createdAt: new Date(base + i * 1000),
      };
    });
    for (let i = 0; i < values.length; i += 500)
      await t.db.drizzle.insert(drops).values(values.slice(i, i + 500));
    const search = (cursor?: string) =>
      t.app.inject({
        method: 'GET',
        url: `/v1/h/drops?view=sent&query=needle&limit=10${cursor ? `&cursor=${cursor}` : ''}`,
        headers: hHeaders(aliceH.credential),
      });
    const first = (await search()).json();
    expect(first.drops).toEqual([]);
    expect(first.next_cursor).toBeTruthy(); // not "no results": not searched to the end yet
    const second = (await search(first.next_cursor)).json();
    expect(second.drops.map((d: { title: string }) => d.title)).toEqual(['Quarterly Needle report']);
    expect(second.next_cursor).toBeNull();
    // a match within the budget is found in one request
    await send('another needle', 'recent');
    const recent = (await search()).json();
    expect(recent.drops.map((d: { title: string }) => d.title)).toEqual(['another needle']);
  });

  it('switches both ways: each side reads the other, and a retried request never conflicts across modes', async () => {
    configureContentEncryption({ cipher, mode: 'off' });
    const requestId = randomUUID();
    const plain = await send('written in plaintext', 'p', [], requestId);
    expect(plain.json().outcome).toBe('delivered');
    configureContentEncryption({ cipher, mode: 'on' });
    const retried = await send('written in plaintext', 'p', [], requestId);
    expect(retried.json().drop_id).toBe(plain.json().drop_id);
    const sealed = await send('written encrypted', 'e');
    configureContentEncryption({ cipher, mode: 'off' });
    const retriedSealed = await send('written encrypted', 'e', [], sealed.json().request_id);
    expect(retriedSealed.json().drop_id).toBe(sealed.json().drop_id);
    const titles = (
      await t.app.inject({ method: 'GET', url: '/v1/h/drops?view=inbox', headers: hHeaders(bobH.credential) })
    )
      .json()
      .drops.map((d: { title: string }) => d.title)
      .sort();
    expect(titles).toEqual(['written encrypted', 'written in plaintext']);
  });

  it('fails closed at startup: no keyring, or a keyring without any of the database keys', async () => {
    await send('sealed', 'x'); // encrypted content now exists
    const own = await initContentEncryption(t.db.drizzle, {
      source: { inline: TEST_KEYRING, allowInline: true },
      mode: 'on',
    });
    expect(own.kid).toBe(cipher.activeKid);
    await expect(
      initContentEncryption(t.db.drizzle, { source: { allowInline: true }, mode: 'off' }),
    ).rejects.toThrow(/holds encrypted content/);
    await expect(
      initContentEncryption(t.db.drizzle, {
        source: { inline: generateKeyring(), allowInline: true },
        mode: 'on',
      }),
    ).rejects.toThrow(/none of the keys/);
  });

  it('backfills content written before the switch, leaving no plaintext and nothing unreadable', async () => {
    configureContentEncryption({ cipher, mode: 'off' });
    const text = Buffer.from(`${MARK} old attachment text`);
    const up = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceH.credential),
        'content-type': 'application/octet-stream',
        'x-agentdrop-filename': encodeURIComponent(`${MARK}.txt`),
      },
      payload: text,
    });
    expect(up.statusCode, up.body).toBe(201);
    const requestId = randomUUID();
    const old = await send(`${MARK} old`, `${MARK} old body`, [up.json().attachment_id], requestId);
    expect(old.json().outcome).toBe('delivered');
    const binary = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceH.credential),
        'content-type': 'application/octet-stream',
        'x-agentdrop-filename': encodeURIComponent(`${MARK}.bin`),
        'x-agentdrop-binary': '1',
      },
      payload: Buffer.alloc(100, 0),
    });
    const held = await send(`${MARK} held`, 'waiting', [binary.json().attachment_id]);
    expect(held.json().outcome).toBe('needs_approval');
    // an audit record as older servers wrote it, naming the file
    await t.db.drizzle.insert(auditEvents).values({
      action: 'drop.send',
      result: 'ok',
      meta: { outcome: 'needs_approval', reasons: `attachment review: ${MARK}.bin: binary` },
    });
    expect((await plaintextRemaining(t.db.drizzle)).drops).toBeGreaterThan(0);

    configureContentEncryption({ cipher, mode: 'on' });
    let done = false;
    for (let i = 0; i < 50 && !done; i++) done = (await backfillStep(t.db, storage)).done;
    expect(done).toBe(true);
    expect(await plaintextRemaining(t.db.drizzle)).toEqual({ drops: 0, approvals: 0, attachments: 0 });
    // the worker's cleanup would delete the replaced plaintext objects; do it here
    const cleanups = await t.db.drizzle
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, 'attachment.cleanup'));
    for (const c of cleanups) await storage.delete((c.payload as { storage_key: string }).storage_key);

    const needles = [MARK, Buffer.from(MARK).toString('hex')];
    for (const table of CONTENT_TABLES) {
      const rows = await t.db.drizzle.execute<{ row: string }>(
        sql.raw(`select t::text as row from "${table}" t`),
      );
      for (const { row } of rows.rows)
        for (const n of needles) expect(row, `${table} holds plaintext`).not.toContain(n);
    }
    for (const key of stored) {
      if (!(await storage.exists(key))) continue;
      const raw = await readAll(await storage.get(key));
      expect(raw.includes(Buffer.from(MARK)), `object ${key} holds plaintext`).toBe(false);
    }

    // still readable, byte for byte; the old request retries without a conflict; the approval still decides
    const dropId = old.json().drop_id;
    const read = (
      await t.app.inject({ method: 'GET', url: `/v1/h/drops/${dropId}`, headers: hHeaders(bobH.credential) })
    ).json().drop;
    expect(read).toMatchObject({ title: `${MARK} old`, body_chunk: `${MARK} old body` });
    expect(read.attachments[0].safe_name).toBe(`${MARK}.txt`);
    const dl = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}/attachments/${up.json().attachment_id}`,
      headers: hHeaders(bobH.credential),
    });
    expect(dl.rawPayload.equals(text)).toBe(true);
    expect(
      (await send(`${MARK} old`, `${MARK} old body`, [up.json().attachment_id], requestId)).json().drop_id,
    ).toBe(dropId);
    const pending = (
      await t.app.inject({
        method: 'GET',
        url: '/v1/me/approvals?status=pending',
        headers: { cookie: alice.cookie },
      })
    ).json().approvals;
    expect(pending[0]).toMatchObject({ title: `${MARK} held` });
    expect(pending[0].reasons.join()).toContain(`${MARK}.bin`);
    const approved = await t.app.inject({
      method: 'POST',
      url: `/v1/me/approvals/${pending[0].approval_id}/decide`,
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { decision: 'approve' },
    });
    expect(approved.json().status).toBe('delivered');
  });

  const runBackfill = async () => {
    let last = await backfillStep(t.db, storage);
    for (let i = 0; i < 50 && !last.done && last.step !== 'waiting'; i++)
      last = await backfillStep(t.db, storage);
    return last;
  };

  it('backfills again after the switch went off and on, and seals approvals decided across the switch', async () => {
    configureContentEncryption({ cipher, mode: 'on' });
    expect((await runBackfill()).done).toBe(true);
    configureContentEncryption({ cipher, mode: 'off' });
    await send('written while off', 'p');
    configureContentEncryption({ cipher, mode: 'on' });
    expect(await withTx(t.db, (tx) => requestBackfill(tx))).toBe(true);
    expect((await runBackfill()).done).toBe(true);
    expect(await plaintextRemaining(t.db.drizzle)).toEqual({ drops: 0, approvals: 0, attachments: 0 });
    const v1 = await t.db.drizzle.execute<{ n: number }>(
      sql`select count(*)::int as n from drops where hash_version = 1`,
    );
    expect(v1.rows[0]?.n).toBe(0);
  });

  it('leaves uploads in flight alone and reports an object that no longer matches its record', async () => {
    configureContentEncryption({ cipher, mode: 'off' });
    const up = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceH.credential),
        'content-type': 'application/octet-stream',
        'x-agentdrop-filename': 'notes.txt',
      },
      payload: Buffer.from('original bytes'),
    });
    const [row] = await t.db.drizzle
      .select()
      .from(attachments)
      .where(eq(attachments.id, up.json().attachment_id));
    // the stored object was changed behind the server's back
    await storage.put(row?.storageKey ?? '', Readable.from([Buffer.from('tampered bytes')]), 1000);
    // an upload that began before the switch and has not finished
    const staging = await withTx(t.db, (tx) =>
      stageAttachment(
        tx,
        { userId: alice.userId, hId: aliceH.hId, via: 'h_credential' },
        {
          safeName: 'half.bin',
          contentType: 'application/octet-stream',
          declaredBytes: 10,
          storageKey: 'staging/x/y',
        },
        { maxFileBytes: 1000, maxDropFileBytes: 1000, quotaBytes: 100_000 },
      ),
    );
    configureContentEncryption({ cipher, mode: 'on' });
    const step = await runBackfill();
    expect(step.step).toBe('waiting');
    const [half] = await t.db.drizzle
      .select()
      .from(attachments)
      .where(eq(attachments.id, staging.attachmentId));
    expect(half?.dek).toBeNull(); // untouched while in flight
    const [tampered] = await t.db.drizzle
      .select()
      .from(attachments)
      .where(eq(attachments.id, row?.id ?? ''));
    expect(tampered?.blobFormat).toBe(0); // not sealed as if it were the original
    await t.db.drizzle
      .update(attachments)
      .set({ status: 'failed' })
      .where(eq(attachments.id, staging.attachmentId));
    expect((await runBackfill()).done).toBe(true);
    expect((await plaintextRemaining(t.db.drizzle)).attachments).toBeGreaterThan(0); // still reported
  });

  it('pages without skipping rows that share a millisecond', async () => {
    const author = { user_id: alice.userId, handle: alice.handle, display_name: 'Alice' };
    for (const micro of ['100', '200', '300']) {
      const id = randomUUID();
      await t.db.drizzle.insert(drops).values({
        id,
        authorUserId: alice.userId,
        originHId: aliceH.hId,
        originKind: 'mcp',
        kind: 'text',
        ...sealDrop(id, { title: `same ms ${micro}`, body: '', extensions: {} }),
        bodyChars: 0,
        authorSnapshot: author,
        targetSnapshot: { recipients: [], user_ids: [], group_ids: [] },
        contentHash: 'x',
        createdAt: sql`${`2026-01-01T00:00:00.000${micro}Z`}::timestamptz` as unknown as Date,
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page: { drops: { title: string }[]; next_cursor: string | null } = (
        await t.app.inject({
          method: 'GET',
          url: `/v1/h/drops?view=sent&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
          headers: hHeaders(aliceH.credential),
        })
      ).json();
      seen.push(...page.drops.map((d) => d.title));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(['same ms 300', 'same ms 200', 'same ms 100']);
  });

  it('reports hmac keys the database used that the keyring no longer holds', async () => {
    await initContentEncryption(t.db.drizzle, {
      source: { inline: TEST_KEYRING, allowInline: true },
      mode: 'on',
    });
    const withoutHmac = JSON.parse(TEST_KEYRING);
    withoutHmac.hmac = JSON.parse(generateKeyring()).hmac;
    const started = await initContentEncryption(t.db.drizzle, {
      source: { inline: JSON.stringify(withoutHmac), allowInline: true },
      mode: 'on',
    });
    expect(started.missing_keys).toEqual([cipher.hmacKids[0]]);
  });

  it('re-wraps every data key with a new master key after a rotation, and content still reads', async () => {
    const up = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceH.credential),
        'content-type': 'application/octet-stream',
        'x-agentdrop-filename': 'a.txt',
      },
      payload: Buffer.from('rotate me'),
    });
    const sent = await send('before rotation', 'body', [up.json().attachment_id]);
    const next = parseKeyring(generateKeyring());
    const old = parseKeyring(TEST_KEYRING);
    const rotated = new ContentCipher({
      ...old,
      active: next.active,
      keys: new Map([...old.keys, ...next.keys]),
    });
    configureContentEncryption({ cipher: rotated, mode: 'on' });
    let done = false;
    for (let i = 0; i < 20 && !done; i++) done = (await backfillStep(t.db, storage)).done;
    expect(done).toBe(true);
    const kids = await t.db.drizzle.execute<{ kid: string }>(
      sql`select distinct convert_from(substring(dek from 3 for get_byte(dek, 1)), 'UTF8') as kid from drops where dek is not null
          union select distinct convert_from(substring(dek from 3 for get_byte(dek, 1)), 'UTF8') from attachments where dek is not null`,
    );
    expect(kids.rows.map((r) => r.kid)).toEqual([next.active]);
    // readable with a keyring that no longer holds the old key at all
    configureContentEncryption({ cipher: new ContentCipher(next), mode: 'on' });
    const read = (
      await t.app.inject({
        method: 'GET',
        url: `/v1/h/drops/${sent.json().drop_id}`,
        headers: hHeaders(bobH.credential),
      })
    ).json().drop;
    expect(read.title).toBe('before rotation');
    const dl = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${sent.json().drop_id}/attachments/${up.json().attachment_id}`,
      headers: hHeaders(bobH.credential),
    });
    expect(dl.rawPayload.toString()).toBe('rotate me');
    configureContentEncryption({ cipher, mode: 'on' });
  });

  it('limits searches per person, not ordinary listing', async () => {
    const list = (query?: string) =>
      t.app.inject({
        method: 'GET',
        url: `/v1/h/drops?view=inbox${query ? `&query=${query}` : ''}`,
        headers: hHeaders(bobH.credential),
      });
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await list('x')).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
    expect((await list()).statusCode).toBe(200);
  });
});
