import { createHash, randomUUID } from 'node:crypto';
import { reviewHintApprovalPolicy } from '@agentdrop/domain';
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

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL)
  console.warn('[files.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

function payload(title: string, attachmentIds: string[] = []) {
  return {
    payload_version: 1,
    kind: 'file',
    title,
    body: 'see attachment',
    attachment_ids: attachmentIds,
    extensions: {},
  };
}

describeDb('PR-04 files and human approval', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;
  let bobOther: PairedEndpoint;

  const post = (url: string, user: BrowserUser, payload?: unknown) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: user.cookie, origin: t.origin },
      ...(payload ? { payload } : {}),
    });

  async function befriend(a: BrowserUser, b: BrowserUser) {
    await post('/v1/me/contacts/invite', a, { handle: b.handle });
    await post(`/v1/me/contacts/${a.userId}/accept`, b);
  }

  async function upload(
    ep: PairedEndpoint,
    name: string,
    bytes: Buffer,
    extraHeaders: Record<string, string> = {},
  ) {
    return t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(ep.credential),
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'x-agentdrop-filename': encodeURIComponent(name),
        ...extraHeaders,
      },
      payload: bytes,
    });
  }

  async function send(
    ep: PairedEndpoint,
    targets: unknown[],
    title: string,
    attachmentIds: string[] = [],
    rid = `req-${randomUUID()}`,
  ) {
    return t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(ep.credential),
      payload: { request_id: rid, targets, payload: payload(title, attachmentIds) },
    });
  }

  beforeAll(async () => {
    t = await createTestApp({ approvalPolicy: reviewHintApprovalPolicy });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice', 'Alice');
    bob = await signUp(t, 'bob', 'Bob');
    aliceH = await pair(t, alice, { harness: 'codex' });
    bobH = await pair(t, bob, { harness: 'claude-code' });
    bobOther = await pair(t, bob, { harness: 'codex' });
  });

  it('binary round-trip: upload → send → recipient and same-account H download identical bytes/hash', async () => {
    await befriend(alice, bob);
    const bytes = Buffer.alloc(200_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    const sha = createHash('sha256').update(bytes).digest('hex');
    const up = await upload(aliceH, '实验 结果.bin', bytes, { 'x-agentdrop-binary': '1' });
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json().sha256).toBe(sha);
    expect(up.json().byte_size).toBe(bytes.length);
    expect(up.json().safe_name).toBe('实验 结果.bin');
    const attachmentId = up.json().attachment_id;

    // the server classified the bytes itself (NUL bytes → binary hint), so this attachment still needs a human
    const res = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'binary', [attachmentId]);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().outcome).toBe('needs_approval');
    expect(up.json().review_hints[0]).toMatch(/binary/);
    const pending = (
      await t.app.inject({
        method: 'GET',
        url: '/v1/me/approvals?status=pending',
        headers: { cookie: alice.cookie },
      })
    ).json().approvals;
    const ok = await post(`/v1/me/approvals/${pending[0].approval_id}/decide`, alice, {
      decision: 'approve',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const dropId = ok.json().drop_id;

    const read = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}`,
      headers: hHeaders(bobH.credential),
    });
    expect(read.json().drop.attachments).toEqual([
      {
        attachment_id: attachmentId,
        safe_name: '实验 结果.bin',
        content_type: 'application/octet-stream',
        byte_size: bytes.length,
        sha256: sha,
      },
    ]);
    const dl = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}/attachments/${attachmentId}`,
      headers: hHeaders(bobH.credential),
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toContain(
      "filename*=UTF-8''%E5%AE%9E%E9%AA%8C%20%E7%BB%93%E6%9E%9C.bin",
    );
    expect(dl.headers['x-agentdrop-sha256']).toBe(sha);
    expect(Buffer.compare(dl.rawPayload, bytes)).toBe(0);

    // ADR 0008: the plain send reached both of bob's agents, so bobOther downloads through its own delivery
    const sibling = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}/attachments/${attachmentId}`,
      headers: hHeaders(bobOther.credential),
    });
    expect(sibling.statusCode).toBe(200);
    expect(Buffer.compare(sibling.rawPayload, bytes)).toBe(0);
    // an agent paired after the send has no delivery of its own: it downloads only through account-wide history
    const bobLater = await pair(t, bob, { harness: 'codex' });
    const foreign = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}/attachments/${attachmentId}`,
      headers: hHeaders(bobLater.credential),
    });
    expect(foreign.statusCode).toBe(200);
    expect(Buffer.compare(foreign.rawPayload, bytes)).toBe(0);
    const disabled = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me/mailbox-settings',
      headers: { cookie: bob.cookie, origin: t.origin },
      payload: { cross_h_mailbox_enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    const strict = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}/attachments/${attachmentId}`,
      headers: hHeaders(bobLater.credential),
    });
    expect(strict.statusCode).toBe(404);
    const ownDelivery = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}/attachments/${attachmentId}`,
      headers: hHeaders(bobOther.credential),
    });
    expect(ownDelivery.statusCode).toBe(200);
    // sender can download its own attachment through its drop
    const own = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}/attachments/${attachmentId}`,
      headers: hHeaders(aliceH.credential),
    });
    expect(own.statusCode).toBe(200);
  });

  it('over-limit uploads abort and release the reservation; declared-size mismatch fails; not-ready/foreign attachments are refused', async () => {
    await befriend(alice, bob);
    const limit = 52_428_800;
    const big = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceH.credential),
        'content-type': 'application/octet-stream',
        'content-length': String(limit + 1),
        'x-agentdrop-filename': 'big',
      },
      payload: Buffer.alloc(10),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().code).toBe('FILE_TOO_LARGE');

    const mismatch = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceH.credential),
        'content-type': 'application/octet-stream',
        'content-length': '10',
        'x-agentdrop-filename': 'x',
      },
      payload: Buffer.alloc(5),
    });
    // fastify rejects bodies shorter than content-length at the HTTP layer, or our size check catches it
    expect([400, 413]).toContain(mismatch.statusCode);

    const rows = await t.db.drizzle.query.attachments.findMany();
    expect(rows.every((r) => r.status !== 'staging')).toBe(true);
    expect(rows.filter((r) => r.status === 'ready')).toHaveLength(0);

    const bobUp = await upload(bobH, 'theirs.txt', Buffer.from('hello'));
    const theirs = bobUp.json().attachment_id;
    const stolen = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'stolen', [theirs]);
    expect(stolen.statusCode).toBe(403);
    expect(stolen.json().code).toBe('ATTACHMENT_NOT_OWNED');
    const unknown = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'unknown', [randomUUID()]);
    expect(unknown.json().code).toBe('ATTACHMENT_NOT_READY');
  });

  it('an accepted contact can receive the first ordinary Drop autonomously', async () => {
    await befriend(alice, bob);
    const rid = `direct-${randomUUID()}`;
    const res = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'first direct', [], rid);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe('delivered');
    expect(res.json().drop_id).toEqual(expect.any(String));
    const inbox = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(bobH.credential),
    });
    expect(inbox.json().drops).toHaveLength(1);
    expect(inbox.json().drops[0].title).toBe('first direct');

    // An idempotent retry returns the same delivery and does not create an approval or a duplicate Drop.
    const again = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'first direct', [], rid);
    expect(again.json().outcome).toBe('delivered');
    expect(again.json().drop_id).toBe(res.json().drop_id);
    const list = await t.app.inject({
      method: 'GET',
      url: '/v1/me/approvals?status=pending',
      headers: { cookie: alice.cookie },
    });
    expect(list.json().approvals).toHaveLength(0);
    const status = await t.app.inject({
      method: 'GET',
      url: `/v1/h/send-requests/${rid}`,
      headers: hHeaders(aliceH.credential),
    });
    expect(status.json().outcome).toBe('delivered');
    expect(status.json().drop_id).toBe(res.json().drop_id);

    const second = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'second');
    expect(second.json().outcome).toBe('delivered');
  });

  it('a risky attachment still forces approval; STALE_APPROVAL when the route changed', async () => {
    await befriend(alice, bob);
    const up = await upload(aliceH, 'leak.txt', Buffer.from('AKIAABCDEFGHIJKLMNOP'), {
      'x-agentdrop-review-hints': JSON.stringify(['contains what looks like an AWS access key id']),
    });
    const res = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'risky', [
      up.json().attachment_id,
    ]);
    expect(res.statusCode).toBe(202);
    const approvalId = (
      await t.app.inject({
        method: 'GET',
        url: '/v1/me/approvals?status=pending',
        headers: { cookie: alice.cookie },
      })
    ).json().approvals[0].approval_id;
    // bob moves his default endpoint before alice approves → stale, must re-preview, then approve again succeeds
    await post('/v1/me/default-endpoint', bob, { h_id: bobOther.hId });
    const stale = await post(`/v1/me/approvals/${approvalId}/decide`, alice, { decision: 'approve' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('STALE_APPROVAL');
    const bobInbox = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(bobH.credential),
    });
    expect(bobInbox.json().drops).toHaveLength(0);
    const ok = await post(`/v1/me/approvals/${approvalId}/decide`, alice, { decision: 'approve' });
    expect(ok.statusCode, ok.body).toBe(200);
    const otherInbox = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(bobOther.credential),
    });
    expect(otherInbox.json().drops).toHaveLength(1);
    const twice = await post(`/v1/me/approvals/${approvalId}/decide`, alice, { decision: 'approve' });
    expect(twice.statusCode).toBe(410);
  });

  it('the web session can download through its own endpoint view only', async () => {
    await befriend(alice, bob);
    const up = await upload(aliceH, 'a.txt', Buffer.from('abc'));
    const res = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'web', [up.json().attachment_id]);
    const dropId = res.json().drop_id;
    const mine = await t.app.inject({
      method: 'GET',
      url: `/v1/me/endpoints/${bobH.hId}/drops/${dropId}/attachments/${up.json().attachment_id}`,
      headers: { cookie: bob.cookie },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.body).toBe('abc');
    const notMine = await t.app.inject({
      method: 'GET',
      url: `/v1/me/endpoints/${bobH.hId}/drops/${dropId}/attachments/${up.json().attachment_id}`,
      headers: { cookie: alice.cookie },
    });
    expect(notMine.statusCode).toBe(404);
  });
});
