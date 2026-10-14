/** Regression tests for findings of an external code review (2026-09). */
import { randomUUID } from 'node:crypto';
import { approvals, attachments, drops } from '@agentdrop/db';
import { reviewHintApprovalPolicy } from '@agentdrop/domain';
import { eq } from 'drizzle-orm';
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

function payload(title: string, extra: Record<string, unknown> = {}) {
  return {
    payload_version: 1,
    kind: 'text',
    title,
    body: `body ${title}`,
    attachment_ids: [],
    extensions: {},
    ...extra,
  };
}

describeDb('review fixes', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;
  let bobH2: PairedEndpoint;

  const post = (url: string, user: BrowserUser, payload?: unknown) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: user.cookie, origin: t.origin },
      ...(payload ? { payload } : {}),
    });
  const send = (
    ep: PairedEndpoint,
    targets: unknown[],
    title: string,
    extra: Record<string, unknown> = {},
    rid = `r-${randomUUID()}`,
  ) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(ep.credential),
      payload: { request_id: rid, targets, payload: payload(title, extra) },
    });
  const list = (ep: PairedEndpoint, q: string) =>
    t.app.inject({ method: 'GET', url: `/v1/h/drops${q}`, headers: hHeaders(ep.credential) });

  async function befriend(a: BrowserUser, b: BrowserUser, autoApprove = true) {
    await post('/v1/me/contacts/invite', a, { handle: b.handle });
    await post(`/v1/me/contacts/${a.userId}/accept`, b);
    if (autoApprove) {
      for (const [o, p] of [
        [a, b],
        [b, a],
      ] as const) {
        await t.app.inject({
          method: 'PATCH',
          url: `/v1/me/contacts/${p.userId}`,
          headers: { cookie: o.cookie, origin: t.origin },
          payload: { auto_approve: true },
        });
      }
    }
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
    bobH2 = await pair(t, bob, { harness: 'codex' });
  });

  it('P0-1 expired drops disappear from every surface, including the sender’s sent list', async () => {
    await befriend(alice, bob);
    const later = new Date(Date.now() + 60_000).toISOString();
    const res = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'ephemeral', {
      expires_at: later,
    });
    expect(res.statusCode, res.body).toBe(200);
    const id = res.json().drop_id;
    expect((await list(aliceH, '?view=sent')).json().drops).toHaveLength(1);
    // Let it expire without racing the clock: a timer of a second loses on a busy machine.
    await t.db.drizzle
      .update(drops)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(drops.id, id));
    expect((await list(aliceH, '?view=sent')).json().drops).toHaveLength(0);
    expect((await list(aliceH, '?view=sent&query=ephemeral')).json().drops).toHaveLength(0);
    expect((await list(bobH, '?view=inbox')).json().drops).toHaveLength(0);
    expect((await list(bobH, '?view=inbox')).json().unread_count).toBe(0);
    expect(
      (await t.app.inject({ method: 'GET', url: `/v1/h/drops/${id}`, headers: hHeaders(aliceH.credential) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await t.app.inject({ method: 'GET', url: `/v1/h/drops/${id}`, headers: hHeaders(bobH.credential) }))
        .statusCode,
    ).toBe(404);
  });

  it('P0-2 approval goes stale when a member’s bound endpoint is revoked, even though no version changed', async () => {
    await befriend(alice, bob);
    const g = await post('/v1/me/groups', alice, {
      slug: 'grp',
      display_name: 'G',
      binding_h_ids: [aliceH.hId],
    });
    const groupId = g.json().group_id;
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobH.hId, bobH2.hId] });
    // risky attachment (server-side classified) forces approval
    const up = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceH.credential),
        'content-type': 'application/octet-stream',
        'content-length': '20',
        'x-agentdrop-filename': 'k.txt',
      },
      payload: Buffer.from('AKIAABCDEFGHIJKLMNOP'),
    });
    expect(up.json().review_hints[0]).toMatch(/AWS/);
    const res = await send(aliceH, [{ type: 'group', group_id: groupId }], 'risky', {
      attachment_ids: [up.json().attachment_id],
    });
    expect(res.statusCode, res.body).toBe(202);
    const approvalId = (
      await t.app.inject({
        method: 'GET',
        url: '/v1/me/approvals?status=pending',
        headers: { cookie: alice.cookie },
      })
    ).json().approvals[0].approval_id;
    // bob loses one endpoint after the preview; the group version is untouched
    await post(`/v1/me/endpoints/${bobH2.hId}/revoke`, bob);
    const stale = await post(`/v1/me/approvals/${approvalId}/decide`, alice, { decision: 'approve' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('STALE_APPROVAL');
    expect((await list(bobH, '?view=inbox')).json().drops).toHaveLength(0);
    const ok = await post(`/v1/me/approvals/${approvalId}/decide`, alice, { decision: 'approve' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await list(bobH, '?view=inbox')).json().drops).toHaveLength(1);
    // approved from the browser but originally sent by the bridge: provenance is preserved
    const drop = await t.db.drizzle.query.drops.findFirst();
    expect(drop?.originKind).toBe('mcp');
  });

  it('P0-4 pairing approval has a single winner: two users approving the same code create one endpoint', async () => {
    const start = await t.app.inject({
      method: 'POST',
      url: '/v1/pairing/start',
      payload: {
        installation_id: randomUUID(),
        device_label: 'Shared Box',
        harness_key: 'codex',
        profile_key: 'codex',
        endpoint_label: 'Agent',
        bridge_version: 't',
        platform: 'test',
      },
    });
    const { device_code, user_code } = start.json();
    const [a, b] = await Promise.all([
      post('/v1/me/pairing/decide', alice, { user_code, decision: 'approve' }),
      post('/v1/me/pairing/decide', bob, { user_code, decision: 'approve' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 404]);
    const winner = a.statusCode === 200 ? alice : bob;
    const poll = await t.app.inject({ method: 'POST', url: '/v1/pairing/poll', payload: { device_code } });
    expect(poll.json().status).toBe('approved');
    expect(poll.json().user_id).toBe(winner.userId);
    const endpoints = await t.db.drizzle.query.harnessEndpoints.findMany();
    expect(endpoints.filter((e) => e.label === 'Agent')).toHaveLength(1);
    // control characters in labels are rejected at the contract boundary
    const bad = await t.app.inject({
      method: 'POST',
      url: '/v1/pairing/start',
      payload: {
        installation_id: randomUUID(),
        device_label: 'x\u001b[31mred',
        harness_key: 'codex',
        profile_key: 'codex',
        endpoint_label: 'Agent',
        bridge_version: 't',
        platform: 'test',
      },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('P1-6 an expired approval is persisted as expired / not_sent even though the decision fails', async () => {
    await befriend(alice, bob);
    const secret = Buffer.from('AKIAABCDEFGHIJKLMNOP');
    const uploaded = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceH.credential),
        'content-type': 'application/octet-stream',
        'content-length': String(secret.length),
        'x-agentdrop-filename': 'credentials.txt',
        'x-agentdrop-content-type': 'text/plain',
      },
      payload: secret,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const extra = { attachment_ids: [uploaded.json().attachment_id] };
    const rid = `exp-${randomUUID()}`;
    await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'late', extra, rid);
    const [row] = await t.db.drizzle.select().from(approvals);
    if (!row) throw new Error('no approval');
    await t.db.drizzle
      .update(approvals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(approvals.id, row.id));
    const first = await post(`/v1/me/approvals/${row.id}/decide`, alice, { decision: 'approve' });
    expect(first.statusCode).toBe(410);
    const again = await post(`/v1/me/approvals/${row.id}/decide`, alice, { decision: 'approve' });
    expect(again.statusCode).toBe(410);
    const status = await t.app.inject({
      method: 'GET',
      url: `/v1/h/send-requests/${rid}`,
      headers: hHeaders(aliceH.credential),
    });
    expect(status.json().outcome).toBe('not_sent');
    const retry = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'late', extra, rid);
    expect(retry.json().outcome).toBe('not_sent');
  });

  it('P1-8 the server classifies uploaded bytes itself: a secret uploaded from the web with no hints still needs approval', async () => {
    await befriend(alice, bob);
    const up = await t.app.inject({
      method: 'POST',
      url: `/v1/me/endpoints/${aliceH.hId}/attachments`,
      headers: {
        cookie: alice.cookie,
        origin: t.origin,
        'content-type': 'application/octet-stream',
        'content-length': '45',
        'x-agentdrop-filename': 'notes.txt',
      },
      payload: Buffer.from('-----BEGIN RSA PRIVATE KEY-----\nabcdefghijkl\n'),
    });
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json().review_hints).toEqual([expect.stringMatching(/private key/)]);
    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/me/endpoints/${aliceH.hId}/drops`,
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: {
        request_id: `w-${randomUUID()}`,
        targets: [{ type: 'user', user_id: bob.userId }],
        payload: payload('key', { attachment_ids: [up.json().attachment_id] }),
      },
    });
    expect(res.statusCode).toBe(202);
  });

  it('P1-10 pending invitations expose nothing in the directory; P1-17 unlinked uploads can be deleted', async () => {
    await post('/v1/me/contacts/invite', alice, { handle: 'bob' });
    const dir = await t.app.inject({
      method: 'GET',
      url: '/v1/h/directory?query=bob',
      headers: hHeaders(aliceH.credential),
    });
    expect(dir.json().entries).toHaveLength(0);
    const dirBob = await t.app.inject({
      method: 'GET',
      url: '/v1/h/directory',
      headers: hHeaders(bobH.credential),
    });
    // only the built-in @agentdrop assistant, never the pending inviter
    expect(dirBob.json().entries.map((e: { handle: string }) => e.handle)).toEqual(['agentdrop']);

    const up = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceH.credential),
        'content-type': 'application/octet-stream',
        'content-length': '3',
        'x-agentdrop-filename': 'a.txt',
      },
      payload: Buffer.from('abc'),
    });
    const id = up.json().attachment_id;
    const foreign = await t.app.inject({
      method: 'DELETE',
      url: `/v1/h/attachments/${id}`,
      headers: hHeaders(bobH.credential),
    });
    expect(foreign.statusCode).toBe(404);
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/v1/h/attachments/${id}`,
      headers: hHeaders(aliceH.credential),
    });
    expect(del.statusCode).toBe(200);
    const row = await t.db.drizzle.query.attachments.findFirst({ where: eq(attachments.id, id) });
    expect(row?.status).toBe('deleted');
    expect(row?.byteSize).toBe(0);
  });

  it('P1-13 a cursor is bound to its mailbox view: reusing it for another view or H is RESYNC_REQUIRED', async () => {
    await befriend(alice, bob);
    for (let i = 0; i < 3; i++) await send(aliceH, [{ type: 'user', user_id: bob.userId }], `n${i}`);
    const p1 = await list(bobH, '?view=inbox&limit=2');
    const cursor = p1.json().next_cursor as string;
    expect(cursor).toBeTruthy();
    expect((await list(bobH, `?view=inbox&limit=2&cursor=${cursor}`)).statusCode).toBe(200);
    expect((await list(bobH, `?view=starred&limit=2&cursor=${cursor}`)).json().code).toBe('RESYNC_REQUIRED');
    expect((await list(bobH, `?view=inbox&unread_only=true&limit=2&cursor=${cursor}`)).json().code).toBe(
      'RESYNC_REQUIRED',
    );
    expect((await list(bobH2, `?view=inbox&limit=2&cursor=${cursor}`)).json().code).toBe('RESYNC_REQUIRED');
  });

  it('P2-21 cookie-authenticated mutations without Origin or same-origin fetch metadata are rejected', async () => {
    const noHeaders = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { cookie: alice.cookie },
      payload: { display_name: 'X' },
    });
    expect(noHeaders.statusCode).toBe(403);
    const fetchMeta = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { cookie: alice.cookie, 'sec-fetch-site': 'same-origin' },
      payload: { display_name: 'X' },
    });
    expect(fetchMeta.statusCode).toBe(200);
  });

  it('P2-18 the group limit applies to distinct endpoints across all groups of one send', async () => {
    await befriend(alice, bob);
    // MAX_GROUP_RECIPIENTS=3 in tests: alice + bob(2) = 3 endpoints → ok; same endpoints via two groups still 3
    for (const slug of ['g1', 'g2']) {
      const g = await post('/v1/me/groups', alice, { slug, display_name: slug, binding_h_ids: [aliceH.hId] });
      await post(`/v1/me/groups/${g.json().group_id}/invite`, alice, { handle: 'bob' });
      await post(`/v1/me/groups/${g.json().group_id}/accept`, bob, { h_ids: [bobH.hId, bobH2.hId] });
    }
    const groups = (
      await t.app.inject({ method: 'GET', url: '/v1/me/groups', headers: { cookie: alice.cookie } })
    ).json().groups;
    const res = await send(
      aliceH,
      groups.map((g: { group_id: string }) => ({ type: 'group', group_id: g.group_id })),
      'two groups',
    );
    expect(res.statusCode, res.body).toBe(200);
    expect((await list(bobH, '?view=inbox')).json().drops).toHaveLength(1);
    // a third recipient endpoint pushes the aggregate over the limit
    const carol = await signUp(t, 'carol');
    await pair(t, carol);
    await befriend(alice, carol);
    const res2 = await send(
      aliceH,
      [
        { type: 'group', group_id: groups[0].group_id },
        { type: 'user', user_id: carol.userId },
      ],
      'over',
    );
    expect(res2.json().code).toBe('TOO_MANY_RECIPIENTS');
  });
});
