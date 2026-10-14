import { randomUUID } from 'node:crypto';
import { outboxEvents } from '@agentdrop/db';
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

describeDb('agent-side management and notifications', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;
  let bobOther: PairedEndpoint;

  const h = (ep: PairedEndpoint, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    t.app.inject({ method, url, headers: hHeaders(ep.credential), ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    t = await createTestApp();
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

  it('request → pending counts in every viewer → respond; only accepted contacts can send', async () => {
    const req = await h(aliceH, 'POST', '/v1/h/contacts/request', { handle: '@bob' });
    expect(req.statusCode, req.body).toBe(200);
    expect(req.json().status).toBe('invited');
    // bob's agent notices through the viewer block of any call
    const id = await h(bobH, 'GET', '/v1/h/identity');
    expect(id.json().viewer.pending.contact_requests).toBe(1);
    const pending = await h(bobH, 'GET', '/v1/h/requests');
    expect(pending.json().contact_requests_received[0].handle).toBe('alice');
    expect((await h(aliceH, 'GET', '/v1/h/requests')).json().contact_requests_sent[0].handle).toBe('bob');
    // a stranger cannot respond to a request that is not theirs
    const carol = await signUp(t, 'carol');
    const carolH = await pair(t, carol);
    expect(
      (await h(carolH, 'POST', '/v1/h/contacts/respond', { user_id: alice.userId, decision: 'accept' }))
        .statusCode,
    ).toBe(404);
    const acc = await h(bobH, 'POST', '/v1/h/contacts/respond', {
      user_id: alice.userId,
      decision: 'accept',
    });
    expect(acc.json().status).toBe('accepted');
    expect((await h(bobH, 'GET', '/v1/h/identity')).json().viewer.pending.contact_requests).toBe(0);
    // outbox carries the notification events without content
    const events = await t.db.drizzle.select().from(outboxEvents);
    const types = events.map((e) => e.type).sort();
    expect(types).toEqual(['contact.accepted', 'contact.requested']);
    expect(events.every((e) => !JSON.stringify(e.payload).includes('body'))).toBe(true);
  });

  it('asking again while a request waits notifies nobody a second time', async () => {
    for (let i = 0; i < 3; i++)
      expect((await h(aliceH, 'POST', '/v1/h/contacts/request', { handle: '@bob' })).json().status).toBe(
        'invited',
      );
    const events = await t.db.drizzle.select().from(outboxEvents);
    expect(events.filter((e) => e.type === 'contact.requested')).toHaveLength(1);
  });

  it('group via agents: creator and invitee receive with all of their agents (ADR 0006)', async () => {
    await h(aliceH, 'POST', '/v1/h/contacts/request', { handle: 'bob' });
    await h(bobH, 'POST', '/v1/h/contacts/respond', { user_id: alice.userId, decision: 'accept' });
    const g = await h(aliceH, 'POST', '/v1/h/groups', { slug: 'lab', display_name: '实验组' });
    expect(g.statusCode, g.body).toBe(200);
    expect(g.json().current_h_receives).toBe(true);
    const groupId = g.json().group_id;
    const inv = await h(aliceH, 'POST', '/v1/h/groups/invite', { group_id: groupId, handle: 'bob' });
    expect(
      inv
        .json()
        .members.map((m: { handle: string; status: string }) => `${m.handle}:${m.status}`)
        .sort(),
    ).toEqual(['alice:active', 'bob:invited']);
    expect((await h(bobOther, 'GET', '/v1/h/identity')).json().viewer.pending.group_invitations).toBe(1);
    // bob's claude-code agent accepts: every agent of bob's account is bound, his codex agent included
    const joined = await h(bobH, 'POST', '/v1/h/groups/respond', { group_id: groupId, decision: 'accept' });
    expect(joined.json().my_status).toBe('active');
    const detail = await t.app.inject({
      method: 'GET',
      url: `/v1/me/groups/${groupId}`,
      headers: { cookie: bob.cookie },
    });
    expect(detail.json().my_membership.receive_all).toBe(true);
    expect(new Set(detail.json().my_membership.binding_h_ids)).toEqual(new Set([bobH.hId, bobOther.hId]));
    const sent = await h(aliceH, 'POST', '/v1/h/drops', {
      request_id: `g-${randomUUID()}`,
      targets: [{ type: 'group', group_id: groupId }],
      payload: {
        payload_version: 1,
        kind: 'text',
        title: 'hi',
        body: 'x',
        attachment_ids: [],
        extensions: {},
      },
    });
    expect(sent.json().outcome).toBe('delivered');
    expect((await h(bobH, 'GET', `/v1/h/drops?group_id=${groupId}`)).json().drops).toHaveLength(1);
    expect((await h(bobOther, 'GET', `/v1/h/drops?group_id=${groupId}`)).json().drops).toHaveLength(1);
    // bob's other agent now has its own delivery, not just the account-wide view of bobH's
    expect(
      (await h(bobOther, 'GET', `/v1/h/drops?group_id=${groupId}&endpoint_scope=current`)).json().drops,
    ).toHaveLength(1);
    // a non-member cannot leave; a plain member may invite, and does not need the invitee to be a contact
    const carol = await signUp(t, 'carol');
    const carolH = await pair(t, carol);
    expect((await h(carolH, 'POST', '/v1/h/groups/leave', { group_id: groupId })).statusCode).toBe(404);
    const invited = await h(bobH, 'POST', '/v1/h/groups/invite', {
      group_id: groupId,
      handles: ['carol'],
    });
    expect(invited.statusCode).toBe(200);
    expect(invited.json().invites).toEqual([{ handle: 'carol', outcome: 'invited' }]);
    // but the agent surface still cannot decide a join request: that route only exists on a browser session
    expect((await h(bobH, 'POST', '/v1/h/groups/requests/decide', { group_id: groupId })).statusCode).toBe(
      404,
    );
    const left = await h(bobH, 'POST', '/v1/h/groups/leave', { group_id: groupId });
    expect(left.json().my_status).toBe('left');
  });

  it('a credential without the manage scope is refused by manage routes', async () => {
    await t.db.drizzle.execute(`update h_credentials set scopes = '{mailbox}'`);
    const res = await h(aliceH, 'POST', '/v1/h/contacts/request', { handle: 'bob' });
    expect(res.statusCode).toBe(403);
    expect((await h(aliceH, 'GET', '/v1/h/drops')).statusCode).toBe(200);
  });

  it('webhook settings accept https only and appear in /v1/me', async () => {
    const bad = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me/notifications',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { webhook_url: 'http://hooks.example/x' },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me/notifications',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { webhook_url: 'https://hooks.example/x' },
    });
    expect(ok.statusCode).toBe(200);
    expect(
      (await t.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: alice.cookie } })).json()
        .notification_webhook_url,
    ).toBe('https://hooks.example/x');
  });
});

describeDb('approvals through the endpoint credential (terminal approve)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ approvalPolicy: reviewHintApprovalPolicy });
  });
  afterAll(async () => {
    await t.close();
  });

  it('lists my pending approvals, refuses other people’s, and delivers on approve', async () => {
    await t.reset();
    const alice = await signUp(t, 'alice');
    const bob = await signUp(t, 'bob');
    const aliceH = await pair(t, alice, { harness: 'codex' });
    const bobH = await pair(t, bob, { harness: 'claude-code' });
    const h = (ep: PairedEndpoint, method: 'GET' | 'POST', url: string, payload?: unknown) =>
      t.app.inject({ method, url, headers: hHeaders(ep.credential), ...(payload ? { payload } : {}) });
    await h(aliceH, 'POST', '/v1/h/contacts/request', { handle: 'bob' });
    await h(bobH, 'POST', '/v1/h/contacts/respond', { user_id: alice.userId, decision: 'accept' });
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
    const sent = await h(aliceH, 'POST', '/v1/h/drops', {
      request_id: `t-${randomUUID()}`,
      targets: [{ type: 'user', user_id: bob.userId }],
      payload: {
        payload_version: 1,
        kind: 'file',
        title: 'risky attachment',
        body: 'review before sending',
        attachment_ids: [uploaded.json().attachment_id],
        extensions: {},
      },
    });
    expect(sent.statusCode).toBe(202);
    const mine = await h(aliceH, 'GET', '/v1/h/approvals');
    expect(mine.json().approvals).toHaveLength(1);
    const id = mine.json().approvals[0].approval_id;
    expect((await h(bobH, 'GET', '/v1/h/approvals')).json().approvals).toHaveLength(0);
    expect((await h(bobH, 'POST', `/v1/h/approvals/${id}/decide`, { decision: 'approve' })).statusCode).toBe(
      404,
    );
    const ok = await h(aliceH, 'POST', `/v1/h/approvals/${id}/decide`, { decision: 'approve' });
    expect(ok.json().status).toBe('delivered');
    expect((await h(bobH, 'GET', '/v1/h/drops')).json().drops).toHaveLength(1);
  });
});
