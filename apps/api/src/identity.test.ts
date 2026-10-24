import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, hHeaders, pair, signUp, TEST_DATABASE_URL, type TestApp } from './testing/harness.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL)
  console.warn('[identity.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

describeDb('PR-01 identity: users, devices, endpoints, credentials', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  it('sign-up creates a profile with a unique handle; duplicate handles are rejected before an auth user exists', async () => {
    const alice = await signUp(t, 'alice', '爱丽丝');
    expect(alice.userId).toMatch(/[0-9a-f-]{36}/);
    const dup = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      headers: { origin: t.origin },
      payload: {
        email: 'other@example.test',
        password: 'correct-horse-battery-staple',
        handle: 'Alice',
        display_name: 'x',
      },
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().code).toBe('VALIDATION_FAILED');
    const me = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: alice.cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().handle).toBe('alice');
    expect(me.json().display_name).toBe('爱丽丝');
    expect(me.json().cross_h_mailbox_enabled).toBe(true);
  });

  it('cross-Agent mailbox visibility defaults on and only the owning browser session can toggle it', async () => {
    const alice = await signUp(t, 'alice');
    const bob = await signUp(t, 'bob');
    const aliceH = await pair(t, alice);

    const disabled = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me/mailbox-settings',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { cross_h_mailbox_enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toEqual({ cross_h_mailbox_enabled: false });

    const [aliceMe, bobMe] = await Promise.all([
      t.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: alice.cookie } }),
      t.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: bob.cookie } }),
    ]);
    expect(aliceMe.json().cross_h_mailbox_enabled).toBe(false);
    expect(bobMe.json().cross_h_mailbox_enabled).toBe(true);

    const viaAgentCredential = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me/mailbox-settings',
      headers: { ...hHeaders(aliceH.credential), origin: t.origin },
      payload: { cross_h_mailbox_enabled: true },
    });
    expect(viaAgentCredential.statusCode).toBe(401);

    const anonymous = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me/mailbox-settings',
      headers: { origin: t.origin },
      payload: { cross_h_mailbox_enabled: true },
    });
    expect(anonymous.statusCode).toBe(401);

    const cannotSelectAnotherOwner = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me/mailbox-settings',
      headers: { cookie: bob.cookie, origin: t.origin },
      payload: { cross_h_mailbox_enabled: false, user_id: alice.userId },
    });
    expect(cannotSelectAnotherOwner.statusCode).toBe(400);
    const unchanged = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: alice.cookie } });
    expect(unchanged.json().cross_h_mailbox_enabled).toBe(false);
  });

  it('different device or harness → different H; same profile re-paired keeps the same H', async () => {
    const alice = await signUp(t, 'alice');
    const inst1 = randomUUID();
    const h1 = await pair(t, alice, { installationId: inst1, harness: 'codex', profile: 'codex' });
    const h2 = await pair(t, alice, { installationId: inst1, harness: 'claude-code', profile: 'cc' });
    const h3 = await pair(t, alice, { installationId: randomUUID(), harness: 'codex', profile: 'codex' });
    const again = await pair(t, alice, { installationId: inst1, harness: 'codex', profile: 'codex' });
    expect(new Set([h1.hId, h2.hId, h3.hId]).size).toBe(3);
    expect(again.hId).toBe(h1.hId);
    expect(again.credential).not.toBe(h1.credential);

    const endpoints = (
      await t.app.inject({ method: 'GET', url: '/v1/me/endpoints', headers: { cookie: alice.cookie } })
    ).json().endpoints;
    expect(endpoints).toHaveLength(3);
    const devices = (
      await t.app.inject({ method: 'GET', url: '/v1/me/devices', headers: { cookie: alice.cookie } })
    ).json().devices;
    expect(devices).toHaveLength(2);
    // first pairing became the default receiver; later ones did not steal it
    expect(
      endpoints
        .filter((e: { is_default_receiver: boolean }) => e.is_default_receiver)
        .map((e: { h_id: string }) => e.h_id),
    ).toEqual([h1.hId]);
  });

  it('Cursor and opencode keep distinct stable identities and addresses alongside legacy other', async () => {
    const alice = await signUp(t, 'alice');
    const installationId = randomUUID();
    const legacy = await pair(t, alice, { installationId, harness: 'other' });
    const cursor = await pair(t, alice, { installationId, harness: 'cursor' });
    const opencode = await pair(t, alice, { installationId, harness: 'opencode' });
    expect(new Set([legacy.hId, cursor.hId, opencode.hId]).size).toBe(3);

    for (const [harness, endpoint] of [
      ['other', legacy],
      ['cursor', cursor],
      ['opencode', opencode],
    ] as const) {
      const again = await pair(t, alice, { installationId, harness });
      expect(again.hId).toBe(endpoint.hId);
      const identity = await t.app.inject({
        method: 'GET',
        url: '/v1/h/identity',
        headers: hHeaders(endpoint.credential),
      });
      expect(identity.statusCode).toBe(200);
      expect(identity.json()).toMatchObject({ harness_key: harness, viewer: { h_id: endpoint.hId } });
    }
    const routesResponse = await t.app.inject({
      method: 'GET',
      url: '/v1/me/routes',
      headers: { cookie: alice.cookie },
    });
    expect(routesResponse.statusCode).toBe(200);
    const routes = routesResponse.json().routes.filter((route: { auto: boolean }) => route.auto);
    expect(routes).toHaveLength(3);
    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ destination_h_id: legacy.hId, alias: 'agent', harness_key: 'other' }),
        expect.objectContaining({ destination_h_id: cursor.hId, alias: 'cursor', harness_key: 'cursor' }),
        expect.objectContaining({
          destination_h_id: opencode.hId,
          alias: 'opencode',
          harness_key: 'opencode',
        }),
      ]),
    );
  });

  it('omp is its own identity with its own address; clients before 0.5.9 see it as other', async () => {
    const alice = await signUp(t, 'alice');
    const omp = await pair(t, alice, { harness: 'omp' });
    const again = await pair(t, alice, { installationId: omp.installationId, harness: 'omp' });
    expect(again.hId).toBe(omp.hId);
    const identity = (ua: string) =>
      t.app.inject({
        method: 'GET',
        url: '/v1/h/identity',
        headers: { ...hHeaders(omp.credential), 'user-agent': ua },
      });
    expect((await identity('agentdrop-bridge/0.5.9')).json()).toMatchObject({ harness_key: 'omp' });
    expect((await identity('agentdrop-bridge/0.5.8')).json()).toMatchObject({ harness_key: 'other' });
    const routes = await t.app.inject({
      method: 'GET',
      url: '/v1/me/routes',
      headers: { cookie: alice.cookie },
    });
    expect(routes.json().routes.filter((route: { auto: boolean }) => route.auto)).toEqual([
      expect.objectContaining({ destination_h_id: omp.hId, alias: 'omp', harness_key: 'omp' }),
    ]);
  });

  it('workbuddy is its own identity with its own address; clients before 0.5.9 see it as other', async () => {
    const alice = await signUp(t, 'alice');
    const wb = await pair(t, alice, { harness: 'workbuddy' });
    const identity = (ua: string) =>
      t.app.inject({
        method: 'GET',
        url: '/v1/h/identity',
        headers: { ...hHeaders(wb.credential), 'user-agent': ua },
      });
    expect((await identity('agentdrop-bridge/0.5.18')).json()).toMatchObject({ harness_key: 'workbuddy' });
    expect((await identity('agentdrop-bridge/0.5.8')).json()).toMatchObject({ harness_key: 'other' });
    const routes = await t.app.inject({
      method: 'GET',
      url: '/v1/me/routes',
      headers: { cookie: alice.cookie },
    });
    expect(routes.json().routes.filter((route: { auto: boolean }) => route.auto)).toEqual([
      expect.objectContaining({ destination_h_id: wb.hId, alias: 'workbuddy', harness_key: 'workbuddy' }),
    ]);
  });

  it('clients before 0.5.9 never see omp in any /v1/h result: sends, drops, directory, export', async () => {
    const alice = await signUp(t, 'alice');
    const bob = await signUp(t, 'bob');
    const omp = await pair(t, alice, { harness: 'omp' });
    const codex = await pair(t, alice, { harness: 'codex' });
    const bobH = await pair(t, bob, { harness: 'codex' });
    const web = (method: 'POST', url: string, user: typeof alice, payload: object) =>
      t.app.inject({ method, url, headers: { cookie: user.cookie, origin: t.origin }, payload });
    const created = await web('POST', '/v1/me/groups', alice, {
      slug: 'lab',
      display_name: 'Lab',
      binding_h_ids: [omp.hId],
      invite_handles: ['bob'],
    });
    expect(created.statusCode, created.body).toBe(200);
    const groupId = created.json().group_id as string;
    expect(
      (await web('POST', `/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobH.hId] })).statusCode,
    ).toBe(200);

    const as = (ua: string) => ({ ...hHeaders(omp.credential), 'user-agent': ua });
    const send = (ua: string, targets: unknown[], requestId: string) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/h/drops',
        headers: as(ua),
        payload: {
          request_id: requestId,
          targets,
          payload: { payload_version: 1, kind: 'text', title: 'from omp', body: 'b' },
        },
      });
    // her omp agent's automatic address, a route of her own: a send there names the agent it reached
    const routes = await t.app.inject({
      method: 'GET',
      url: '/v1/me/routes',
      headers: { cookie: alice.cookie },
    });
    const ompRoute = routes
      .json()
      .routes.find((r: { alias: string; auto: boolean }) => r.auto && r.alias === 'omp');
    expect(ompRoute, routes.body).toBeTruthy();
    const toSelf = [{ type: 'route', route_id: ompRoute.route_id }];
    const fresh = await send('agentdrop-bridge/0.5.9', toSelf, 'req-self');
    expect(fresh.statusCode, fresh.body).toBe(200);
    const dropId = fresh.json().drop_id as string;
    await send('agentdrop-bridge/0.5.9', [{ type: 'group', group_id: groupId }], 'req-group');
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const until = new Date(Date.now() + 86_400_000).toISOString();

    const results: Array<[string, (ua: string) => Promise<{ statusCode: number; body: string }>]> = [
      ['send replay', (ua) => send(ua, toSelf, 'req-self')],
      ['list', (ua) => t.app.inject({ method: 'GET', url: '/v1/h/drops', headers: as(ua) })],
      ['detail', (ua) => t.app.inject({ method: 'GET', url: `/v1/h/drops/${dropId}`, headers: as(ua) })],
      [
        'directory',
        (ua) => t.app.inject({ method: 'GET', url: '/v1/h/directory?query=alice', headers: as(ua) }),
      ],
      [
        'send request',
        (ua) => t.app.inject({ method: 'GET', url: '/v1/h/send-requests/req-self', headers: as(ua) }),
      ],
      ['identity', (ua) => t.app.inject({ method: 'GET', url: '/v1/h/identity', headers: as(ua) })],
      [
        'export',
        (ua) =>
          t.app.inject({
            method: 'GET',
            url: `/v1/h/export?${new URLSearchParams({ scope: 'group', group_id: groupId, since, until })}`,
            headers: as(ua),
          }),
      ],
    ];
    const ompKey = /"harness_key":"omp"/;
    for (const [what, call] of results) {
      const current = await call('agentdrop-bridge/0.5.9');
      expect(current.statusCode, `${what}: ${current.body}`).toBe(200);
      for (const ua of ['agentdrop-bridge/0.5.8', 'agentdrop-cli/0.5.8']) {
        const old = await call(ua);
        expect(old.statusCode, `${what} ${ua}: ${old.body}`).toBe(200);
        expect(old.body, `${what} ${ua}`).not.toMatch(ompKey);
      }
    }
    // the check means something: current clients do get the key where an agent of hers is named
    // (the directory names no agent of anyone else, and never lists the viewer: it is checked above only)
    for (const what of ['send replay', 'list', 'detail', 'identity']) {
      const call = results.find(([name]) => name === what)?.[1];
      expect((await call?.('agentdrop-bridge/0.5.9'))?.body, what).toMatch(ompKey);
    }
    // her other agent's view of the same drop names the omp agent the same way
    const fromCodex = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}`,
      headers: { ...hHeaders(codex.credential), 'user-agent': 'agentdrop-bridge/0.5.8' },
    });
    expect(fromCodex.json().drop.origin_agent).toMatchObject({ h_id: omp.hId, harness_key: 'other' });
  });

  it('identity is fixed by the credential; both credentials of one H see the same H', async () => {
    const alice = await signUp(t, 'alice');
    const inst = randomUUID();
    const first = await pair(t, alice, { installationId: inst });
    const second = await pair(t, alice, { installationId: inst });
    const a = await t.app.inject({
      method: 'GET',
      url: '/v1/h/identity',
      headers: hHeaders(first.credential),
    });
    const b = await t.app.inject({
      method: 'GET',
      url: '/v1/h/identity',
      headers: hHeaders(second.credential),
    });
    expect(a.statusCode).toBe(200);
    expect(a.json().viewer.h_id).toBe(first.hId);
    expect(b.json().viewer.h_id).toBe(first.hId);
    expect(a.json().viewer.handle).toBe('alice');
    expect(JSON.stringify(a.json())).not.toContain(first.credential);
  });

  it('the credential is issued exactly once per pairing; unknown or reused device codes yield expired', async () => {
    const alice = await signUp(t, 'alice');
    const start = await t.app.inject({
      method: 'POST',
      url: '/v1/pairing/start',
      payload: {
        installation_id: randomUUID(),
        device_label: 'Mac',
        harness_key: 'codex',
        profile_key: 'codex',
        endpoint_label: 'Agent',
        bridge_version: 't',
        platform: 'test',
      },
    });
    const { device_code, user_code } = start.json();
    const pending = await t.app.inject({ method: 'POST', url: '/v1/pairing/poll', payload: { device_code } });
    expect(pending.json().status).toBe('pending');

    // Another user cannot see the pairing by guessing? They can look it up by code (the code is the secret shown to
    // the CLI user); but a wrong code is NOT_FOUND without revealing anything.
    const bad = await t.app.inject({
      method: 'GET',
      url: '/v1/me/pairing/ZZZZ-ZZZZ',
      headers: { cookie: alice.cookie },
    });
    expect(bad.statusCode).toBe(404);

    const look = await t.app.inject({
      method: 'GET',
      url: `/v1/me/pairing/${user_code}`,
      headers: { cookie: alice.cookie },
    });
    expect(look.statusCode).toBe(200);
    expect(look.json().existing_endpoint).toBe(false);

    await t.app.inject({
      method: 'POST',
      url: '/v1/me/pairing/decide',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { user_code, decision: 'approve' },
    });
    await new Promise((r) => setTimeout(r, 2100)); // respect the poll interval
    const approved = await t.app.inject({
      method: 'POST',
      url: '/v1/pairing/poll',
      payload: { device_code },
    });
    expect(approved.json().status).toBe('approved');
    await new Promise((r) => setTimeout(r, 2100));
    const again = await t.app.inject({ method: 'POST', url: '/v1/pairing/poll', payload: { device_code } });
    expect(again.json().status).toBe('expired');
    const unknown = await t.app.inject({
      method: 'POST',
      url: '/v1/pairing/poll',
      payload: { device_code: 'x'.repeat(40) },
    });
    expect(unknown.json().status).toBe('expired');
  });

  it('denied pairing never issues a credential', async () => {
    const alice = await signUp(t, 'alice');
    const start = await t.app.inject({
      method: 'POST',
      url: '/v1/pairing/start',
      payload: {
        installation_id: randomUUID(),
        device_label: 'Mac',
        harness_key: 'codex',
        profile_key: 'codex',
        endpoint_label: 'Agent',
        bridge_version: 't',
        platform: 'test',
      },
    });
    const { device_code, user_code } = start.json();
    await t.app.inject({
      method: 'POST',
      url: '/v1/me/pairing/decide',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { user_code, decision: 'deny' },
    });
    const poll = await t.app.inject({ method: 'POST', url: '/v1/pairing/poll', payload: { device_code } });
    expect(poll.json().status).toBe('denied');
    expect(poll.body).not.toContain('credential');
  });

  it('revoking credentials or the endpoint makes every new request fail; content is not deleted', async () => {
    const alice = await signUp(t, 'alice');
    const h = await pair(t, alice);
    const ok = await t.app.inject({ method: 'GET', url: '/v1/h/identity', headers: hHeaders(h.credential) });
    expect(ok.statusCode).toBe(200);
    const rev = await t.app.inject({
      method: 'POST',
      url: `/v1/me/endpoints/${h.hId}/credentials/revoke`,
      headers: { cookie: alice.cookie, origin: t.origin },
    });
    expect(rev.json().revoked).toBe(1);
    const denied = await t.app.inject({
      method: 'GET',
      url: '/v1/h/identity',
      headers: hHeaders(h.credential),
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().code).toBe('UNAUTHORIZED');

    const h2 = await pair(t, alice, { installationId: h.installationId });
    expect(h2.hId).toBe(h.hId);
    await t.app.inject({
      method: 'POST',
      url: `/v1/me/endpoints/${h.hId}/revoke`,
      headers: { cookie: alice.cookie, origin: t.origin },
    });
    const gone = await t.app.inject({
      method: 'GET',
      url: '/v1/h/identity',
      headers: hHeaders(h2.credential),
    });
    expect(gone.statusCode).toBe(401);
    const list = (
      await t.app.inject({ method: 'GET', url: '/v1/me/endpoints', headers: { cookie: alice.cookie } })
    ).json();
    expect(list.endpoints[0].revoked_at).not.toBeNull();
  });

  it('the two principals do not cross: H credentials cannot use account routes and sessions cannot use H routes', async () => {
    const alice = await signUp(t, 'alice');
    const h = await pair(t, alice);
    const viaH = await t.app.inject({
      method: 'GET',
      url: '/v1/me/endpoints',
      headers: hHeaders(h.credential),
    });
    expect(viaH.statusCode).toBe(401);
    const viaCookie = await t.app.inject({
      method: 'GET',
      url: '/v1/h/identity',
      headers: { cookie: alice.cookie },
    });
    expect(viaCookie.statusCode).toBe(401);
    // a mutating account request without a trusted origin is rejected (CSRF)
    const csrf = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { cookie: alice.cookie, origin: 'http://evil.test' },
      payload: { display_name: 'Mallory' },
    });
    expect(csrf.statusCode).toBe(403);
  });

  it('another user cannot rename, revoke or default-route my endpoints', async () => {
    const alice = await signUp(t, 'alice');
    const bob = await signUp(t, 'bob');
    const h = await pair(t, alice);
    for (const [method, url, payload] of [
      ['PATCH', `/v1/me/endpoints/${h.hId}`, { label: 'stolen' }],
      ['POST', `/v1/me/endpoints/${h.hId}/revoke`, undefined],
      ['POST', '/v1/me/default-endpoint', { h_id: h.hId }],
    ] as const) {
      const res = await t.app.inject({
        method,
        url,
        headers: { cookie: bob.cookie, origin: t.origin },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    const still = await t.app.inject({
      method: 'GET',
      url: '/v1/h/identity',
      headers: hHeaders(h.credential),
    });
    expect(still.json().viewer.agent_name).toBe('Test Agent');
  });

  it('renaming the agent changes the viewer label but not the H id or the credential', async () => {
    const alice = await signUp(t, 'alice');
    const h = await pair(t, alice);
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/v1/me/endpoints/${h.hId}`,
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { label: '小码', public_name: '科研助手' },
    });
    expect(res.statusCode).toBe(200);
    const id = await t.app.inject({ method: 'GET', url: '/v1/h/identity', headers: hHeaders(h.credential) });
    expect(id.json().viewer.h_id).toBe(h.hId);
    expect(id.json().viewer.agent_name).toBe('小码');
  });

  it('bridge connections are registered per H and heartbeat is rejected for a foreign connection id', async () => {
    const alice = await signUp(t, 'alice');
    const h1 = await pair(t, alice, { harness: 'codex' });
    const h2 = await pair(t, alice, { harness: 'claude-code' });
    const open = await t.app.inject({
      method: 'POST',
      url: '/v1/h/connections',
      headers: hHeaders(h1.credential),
      payload: {
        client_name: 'codex',
        client_version: '1',
        capabilities: {},
        bridge_version: 't',
        toolset: 'core',
      },
    });
    expect(open.statusCode).toBe(200);
    const cid = open.json().connection_id;
    const foreign = await t.app.inject({
      method: 'POST',
      url: '/v1/h/connections/heartbeat',
      headers: hHeaders(h2.credential),
      payload: { connection_id: cid },
    });
    expect(foreign.statusCode).toBe(404);
    const mine = await t.app.inject({
      method: 'POST',
      url: '/v1/h/connections/heartbeat',
      headers: hHeaders(h1.credential),
      payload: { connection_id: cid, last_tool: 'list_drops' },
    });
    expect(mine.statusCode).toBe(200);
    const list = await t.app.inject({
      method: 'GET',
      url: '/v1/me/connections',
      headers: { cookie: alice.cookie },
    });
    expect(list.json().connections).toHaveLength(1);
    expect(list.json().connections[0].status).toBe('live');
    expect(list.json().native_sessions.status).toBe('not_connected');
  });
});
