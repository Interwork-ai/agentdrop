import { appUsers, pushSubscriptions } from '@agentdrop/db';
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

describe.skipIf(!TEST_DATABASE_URL)('operator console', () => {
  let t: TestApp;
  let root: BrowserUser;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const as = (u: BrowserUser) => ({ cookie: u.cookie, origin: t.origin });
  const get = (url: string, u: BrowserUser) => t.app.inject({ method: 'GET', url, headers: as(u) });
  const post = (url: string, u: BrowserUser, payload?: unknown) =>
    t.app.inject({ method: 'POST', url, headers: as(u), payload: payload ?? {} });

  /** Sends and, when the first-contact policy holds it for review, approves it so it really lands. */
  async function sendAndDeliver(
    from: PairedEndpoint,
    sender: BrowserUser,
    toUserId: string,
    requestId: string,
    title: string,
    body: string,
  ) {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(from.credential),
      payload: {
        request_id: requestId,
        targets: [{ type: 'user', user_id: toUserId }],
        payload: { payload_version: 1, title, body },
      },
    });
    if (res.statusCode === 202) {
      const pending = await get('/v1/me/approvals?status=pending', sender);
      for (const a of pending.json().approvals)
        await post(`/v1/me/approvals/${a.approval_id}/decide`, sender, { decision: 'approve' });
    } else if (res.statusCode !== 200) {
      throw new Error(`send failed: ${res.statusCode} ${res.body}`);
    }
  }

  async function makeAdmin(u: BrowserUser) {
    await t.db.drizzle.update(appUsers).set({ isAdmin: true }).where(eq(appUsers.id, u.userId));
  }

  beforeEach(async () => {
    await t.reset();
    root = await signUp(t, 'root_op', '运营');
    alice = await signUp(t, 'alice', 'Alice');
    bob = await signUp(t, 'bob', 'Bob');
    await makeAdmin(root);
    aliceH = await pair(t, alice, { harness: 'codex', endpointLabel: '小码' });
    bobH = await pair(t, bob, { harness: 'claude-code', endpointLabel: '阅读助手' });
  });

  it('is reachable only with an admin browser session, never with an agent credential', async () => {
    // an ordinary signed-in user is refused
    const denied = await get('/v1/admin/overview', alice);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('FORBIDDEN');

    // no session at all
    const anon = await t.app.inject({ method: 'GET', url: '/v1/admin/overview' });
    expect(anon.statusCode).toBe(401);

    // an agent credential carries no admin ability even when its owner is an admin
    const rootH = await pair(t, root, { harness: 'codex', endpointLabel: '运营的 Agent' });
    const viaAgent = await t.app.inject({
      method: 'GET',
      url: '/v1/admin/overview',
      headers: hHeaders(rootH.credential),
    });
    expect(viaAgent.statusCode).toBe(401);

    // state-changing admin calls still require a same-origin browser request
    const crossSite = await t.app.inject({
      method: 'POST',
      url: `/v1/admin/users/${alice.userId}/suspend`,
      headers: { cookie: root.cookie, origin: 'http://evil.test' },
      payload: {},
    });
    expect(crossSite.statusCode).toBe(403);

    const ok = await get('/v1/admin/overview', root);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().users.total).toBe(3);
    // alice, bob and the agent paired for root above
    expect(ok.json().endpoints.active).toBe(3);
  });

  it('lists accounts with their agents and activity, and never exposes message content', async () => {
    await post('/v1/me/contacts/invite', alice, { handle: 'bob' });
    await post(`/v1/me/contacts/${alice.userId}/accept`, bob);
    await sendAndDeliver(aliceH, alice, bob.userId, 'admin-test-1', '机密标题', '机密正文');

    const list = await get('/v1/admin/users?query=alice', root);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().users).toHaveLength(1);
    const summary = list.json().users[0];
    expect(summary).toMatchObject({ handle: 'alice', status: 'active', endpoints: 1, drops_sent: 1 });
    expect(summary.email).toBe(alice.email);

    const detail = await get(`/v1/admin/users/${alice.userId}`, root);
    expect(detail.statusCode, detail.body).toBe(200);
    const d = detail.json();
    expect(d.endpoint_list).toHaveLength(1);
    expect(d.endpoint_list[0]).toMatchObject({
      label: '小码',
      harness_key: 'codex',
      address: '@alice/codex',
      is_default_receiver: true,
    });
    // every account also has the built-in @agentdrop assistant as a contact
    expect(d.contact_list.map((c: { handle: string }) => c.handle)).toEqual(['agentdrop', 'bob']);
    expect(d.recent_activity.length).toBeGreaterThan(0);

    // the whole console is metadata: no title, body or attachment name appears anywhere in it
    const everything = JSON.stringify([list.json(), d, (await get('/v1/admin/audit', root)).json()]);
    expect(everything).not.toContain('机密标题');
    expect(everything).not.toContain('机密正文');
  });

  it('suspending cuts off the dashboard and every agent of that account, and lifting restores both', async () => {
    const before = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(bobH.credential),
    });
    expect(before.statusCode).toBe(200);

    const susp = await post(`/v1/admin/users/${bob.userId}/suspend`, root, { reason: '滥用' });
    expect(susp.statusCode, susp.body).toBe(200);

    // the browser session is gone
    const web = await get('/v1/me', bob);
    expect(web.statusCode).toBe(401);
    // the agent credential is refused with a code that explains itself
    const agent = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(bobH.credential),
    });
    expect(agent.statusCode).toBe(403);
    expect(agent.json().code).toBe('ACCOUNT_SUSPENDED');
    expect(agent.json().message).toContain('滥用');

    const listed = await get('/v1/admin/users?status=suspended', root);
    expect(listed.json().users.map((u: { handle: string }) => u.handle)).toEqual(['bob']);

    await post(`/v1/admin/users/${bob.userId}/unsuspend`, root);
    const after = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(bobH.credential),
    });
    expect(after.statusCode).toBe(200);
  });

  it('closing an account erases its access and profile but keeps drops the recipient already received', async () => {
    await post('/v1/me/contacts/invite', alice, { handle: 'bob' });
    await post(`/v1/me/contacts/${alice.userId}/accept`, bob);
    const published = await t.app.inject({
      method: 'PUT',
      url: '/v1/me/public-email',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { public_email: 'alice@example.org' },
    });
    expect(published.statusCode, published.body).toBe(200);
    await sendAndDeliver(aliceH, alice, bob.userId, 'admin-test-2', 'закрытие', '已投递的内容不该消失');
    const push = await t.app.inject({
      method: 'POST',
      url: '/v1/me/push/subscriptions',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/admin-close',
        keys: { p256dh: 'Abcdefghijklmnop_123', auth: 'Zyxwvutsrqponmlk_456' },
        device_label: '即将注销的浏览器',
      },
    });
    expect(push.statusCode, push.body).toBe(200);

    // the handle has to be typed back, so a misclick cannot close the wrong account
    const wrong = await post(`/v1/admin/users/${alice.userId}/close`, root, { confirm_handle: 'bob' });
    expect(wrong.statusCode).toBe(400);

    const closed = await post(`/v1/admin/users/${alice.userId}/close`, root, { confirm_handle: '@alice' });
    expect(closed.statusCode, closed.body).toBe(200);

    // alice can no longer reach anything
    expect((await get('/v1/me', alice)).statusCode).toBe(401);
    const agent = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(aliceH.credential),
    });
    expect([401, 403]).toContain(agent.statusCode);

    // her profile is a tombstone: no handle, no nickname, no address to reach
    const detail = await get(`/v1/admin/users/${alice.userId}`, root);
    expect(detail.json()).toMatchObject({ status: 'deleted', display_name: '已注销账号', email: null });
    expect(detail.json().handle).not.toBe('alice');
    const storedPush = await t.db.drizzle.query.pushSubscriptions.findFirst({
      where: eq(pushSubscriptions.id, push.json().id),
    });
    expect(storedPush).toBeUndefined();

    // bob still has what he received; nothing was recalled from his mailbox
    const inbox = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(bobH.credential),
    });
    expect(inbox.json().drops.map((d: { title: string }) => d.title)).toEqual(['закрытие']);
    // ...but the author's published email went with the profile
    expect(inbox.json().drops[0].author.public_email).toBeNull();

    // the same address can be registered again only if the operator allows it: the old handle is retired, not recycled
    const reuse = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      headers: { origin: t.origin },
      payload: {
        email: 'alice2@example.test',
        password: 'correct-horse-battery-staple',
        handle: 'alice',
        display_name: '新的 Alice',
      },
    });
    expect(reuse.statusCode).toBe(201);
  });

  it('refuses to strand the server: no self-demotion, no closing yourself, no removing the last admin', async () => {
    expect((await post(`/v1/admin/users/${root.userId}/suspend`, root)).statusCode).toBe(403);
    expect(
      (await post(`/v1/admin/users/${root.userId}/close`, root, { confirm_handle: 'root_op' })).statusCode,
    ).toBe(403);
    expect((await post(`/v1/admin/users/${root.userId}/admin`, root, { is_admin: false })).statusCode).toBe(
      403,
    );

    // with a second admin the first one can be demoted by the other
    await post(`/v1/admin/users/${alice.userId}/admin`, root, { is_admin: true });
    const demote = await post(`/v1/admin/users/${root.userId}/admin`, alice, { is_admin: false });
    expect(demote.statusCode, demote.body).toBe(200);
    // alice is now the only admin, so she cannot give the role away and leave the server with none
    expect((await post(`/v1/admin/users/${alice.userId}/admin`, alice, { is_admin: false })).statusCode).toBe(
      403,
    );
    // the demoted account really lost the console
    expect((await get('/v1/admin/overview', root)).statusCode).toBe(403);
  });

  it('closes and reopens sign-up at runtime, and records who changed it', async () => {
    const patched = await t.app.inject({
      method: 'PATCH',
      url: '/v1/admin/settings',
      headers: as(root),
      payload: { signup_mode: 'closed' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ signup_mode: 'closed', updated_by_handle: 'root_op' });

    const policy = await t.app.inject({ method: 'GET', url: '/v1/auth/signup-policy' });
    expect(policy.json()).toEqual({ mode: 'closed', password_reset: 'admin', recovery: ['device', 'code'] });

    const blocked = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      headers: { origin: t.origin },
      payload: {
        email: 'nope@example.test',
        password: 'correct-horse-battery-staple',
        handle: 'nope',
        display_name: '不行',
      },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('SIGNUP_DISABLED');

    await t.app.inject({
      method: 'PATCH',
      url: '/v1/admin/settings',
      headers: as(root),
      payload: { signup_mode: 'open' },
    });
    const allowed = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      headers: { origin: t.origin },
      payload: {
        email: 'yes@example.test',
        password: 'correct-horse-battery-staple',
        handle: 'yes',
        display_name: '可以',
      },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('writes every operator action to the audit log with the admin who did it', async () => {
    await post(`/v1/admin/users/${bob.userId}/suspend`, root, { reason: 'spam' });
    await post(`/v1/admin/endpoints/${aliceH.hId}/revoke`, root);
    const audit = await get('/v1/admin/audit?action=admin.', root);
    const actions = audit.json().events.map((e: { action: string }) => e.action);
    expect(actions).toContain('admin.user.suspend');
    expect(actions).toContain('admin.endpoint.revoke');
    for (const e of audit.json().events) expect(e.actor_handle).toBe('root_op');
    // the reason itself is not copied into the log, only the fact that one was given
    expect(JSON.stringify(audit.json())).not.toContain('spam');

    // revoking someone's agent really does cut that agent off
    const agent = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(aliceH.credential),
    });
    expect(agent.statusCode).toBe(401);
  });
});
