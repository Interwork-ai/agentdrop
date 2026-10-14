import { randomUUID } from 'node:crypto';
import { assertActiveOrigin, reviewHintApprovalPolicy, revokeDevice, sendDrop } from '@agentdrop/domain';
import { sql } from 'drizzle-orm';
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
  console.warn('[delivery.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

function payload(title: string, body = 'hello') {
  return { payload_version: 1, kind: 'text', title, body, attachment_ids: [], extensions: {} };
}

describeDb('PR-02 text delivery and isolation', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let aliceMac: PairedEndpoint;
  let bobDefault: PairedEndpoint;
  let bobOther: PairedEndpoint;

  const get = (url: string, user: BrowserUser) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: user.cookie } });
  const post = (url: string, user: BrowserUser, payload?: unknown) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: user.cookie, origin: t.origin },
      ...(payload ? { payload } : {}),
    });

  async function befriend(a: BrowserUser, b: BrowserUser) {
    const inv = await post('/v1/me/contacts/invite', a, { handle: b.handle });
    expect(inv.statusCode, inv.body).toBe(200);
    const acc = await post(`/v1/me/contacts/${a.userId}/accept`, b);
    expect(acc.statusCode, acc.body).toBe(200);
    expect(acc.json().status).toBe('accepted');
  }

  async function send(
    from: PairedEndpoint,
    targets: unknown[],
    title: string,
    requestId = `req-${randomUUID()}`,
  ) {
    return t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(from.credential),
      payload: { request_id: requestId, targets, payload: payload(title) },
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
    bob = await signUp(t, 'bob', '王同学');
    aliceMac = await pair(t, alice, { harness: 'codex', endpointLabel: '小码' });
    bobDefault = await pair(t, bob, { harness: 'codex', endpointLabel: '科研助手' });
    bobOther = await pair(t, bob, { harness: 'claude-code', endpointLabel: '阅读助手' });
  });

  it('automatic addresses remain usable by their owner and invisible to other people', async () => {
    await befriend(alice, bob);
    const mine = await t.app.inject({ method: 'GET', url: '/v1/me/routes', headers: { cookie: bob.cookie } });
    const autos = mine.json().routes.filter((r: { auto: boolean }) => r.auto);
    expect(autos.map((r: { alias: string; label: string }) => [r.alias, r.label])).toEqual([
      ['codex', '科研助手'],
      ['claude', '阅读助手'],
    ]);
    // manual entries cannot take an automatic alias; a second codex agent skips every live alias (manual ones too)
    const taken = await post('/v1/me/routes', bob, { alias: 'codex', label: '抢占', h_id: bobOther.hId });
    expect(taken.statusCode).toBe(400);
    const manual = await post('/v1/me/routes', bob, { alias: 'codex-2', label: '手动', h_id: bobOther.hId });
    expect(manual.statusCode, manual.body).toBe(200);
    const bobLaptop = await pair(t, bob, { harness: 'codex', endpointLabel: '笔记本 Codex' });
    const routesOf = async () =>
      (await t.app.inject({ method: 'GET', url: '/v1/me/routes', headers: { cookie: bob.cookie } })).json()
        .routes as Array<{ alias: string; auto: boolean; destination_h_id: string }>;
    const laptopRoute = (await routesOf()).find((r) => r.destination_h_id === bobLaptop.hId);
    expect(laptopRoute?.alias).toBe('codex-3');
    // re-approving a pairing for the same H keeps the one address (no duplicate)
    await pair(t, bob, {
      harness: 'codex',
      endpointLabel: '笔记本 Codex',
      installationId: bobLaptop.installationId,
    });
    expect((await routesOf()).filter((r) => r.auto && r.destination_h_id === bobLaptop.hId)).toHaveLength(1);
    // Renaming remains visible to the owner only.
    const renamed = await t.app.inject({
      method: 'PATCH',
      url: `/v1/me/endpoints/${bobOther.hId}`,
      headers: { cookie: bob.cookie, origin: t.origin },
      payload: { label: '读书助手' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const dir = await t.app.inject({
      method: 'GET',
      url: '/v1/h/directory?query=bob',
      headers: hHeaders(aliceMac.credential),
    });
    expect(dir.json().entries[0].alternatives).toEqual([
      expect.objectContaining({ alias: 'codex-2', harness_key: 'other', auto: false }),
    ]);
    expect(dir.body).not.toContain('读书助手');
    const claude = autos.find((r: { alias: string }) => r.alias === 'claude');
    const target = { type: 'route', route_id: claude.route_id };
    const denied = await send(aliceMac, [target], 'private agent');
    expect(denied.json().code).toBe('ROUTE_UNAVAILABLE');
    const res = await send(bobDefault, [target], '给读书助手');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().recipients[0]).toMatchObject({
      label: '@bob/claude',
      address: '@bob/claude',
      endpoint_label: '读书助手',
      harness_key: 'claude-code',
    });
    const inbox = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(bobOther.credential),
    });
    expect(inbox.json().drops.map((d: { title: string }) => d.title)).toEqual(['给读书助手']);
    // automatic addresses cannot be revoked by hand (they go away with the agent)
    const deny = await post(`/v1/me/routes/${claude.route_id}/revoke`, bob);
    expect(deny.statusCode).toBe(400);
    // bridges published before these fields existed get exactly the shape they advertised
    const legacy = await t.app.inject({
      method: 'GET',
      url: '/v1/h/directory?query=bob',
      headers: { ...hHeaders(aliceMac.credential), 'user-agent': 'agentdrop-bridge/0.2.2' },
    });
    const card = legacy.json().entries[0];
    expect(card.default_endpoint).toBeUndefined();
    expect(Object.keys(card.alternatives[0]).sort()).toEqual(['alias', 'label', 'route_id', 'target']);
    const legacySend = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: { ...hHeaders(aliceMac.credential), 'user-agent': 'agentdrop-bridge/0.2.2' },
      payload: {
        request_id: 'legacy-1234',
        targets: [{ type: 'user', user_id: bob.userId }],
        payload: { payload_version: 1, title: '旧版桥', body: 'x' },
      },
    });
    // ADR 0008: a plain send reaches all three of bob's agents; old bridges still get only the legacy keys
    expect(legacySend.json().recipients[0]).toEqual({ type: 'user', label: '@bob', endpoint_count: 1 });
  });

  it('defaults to account-wide history while preserving delivery attribution and sharing state across own agents', async () => {
    // this test is about a sibling H seeing another H's delivery via account-wide history, so bob pins
    // single-agent receiving (ADR 0008 default is all agents)
    const single = await post('/v1/me/default-endpoint', bob, { h_id: bobDefault.hId });
    expect(single.statusCode, single.body).toBe(200);
    const denied = await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'before contact');
    expect(denied.statusCode).toBe(422);
    expect(denied.json().code).toBe('NOT_A_CONTACT');

    await befriend(alice, bob);
    const res = await send(aliceMac, [{ type: 'user', user_id: bob.userId }], '训练不稳定排查结论');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe('delivered');
    // The sender sees the person; only the recipient sees delivery endpoints.
    expect(res.json().recipients).toEqual([
      {
        type: 'user',
        label: '@bob',
        endpoint_count: 1,
        address: '@bob',
        endpoint_label: null,
        harness_key: null,
      },
    ]);
    expect(res.json().viewer.agent_name).toBe('小码');
    const dropId = res.json().drop_id;

    const inbox = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?view=inbox',
      headers: hHeaders(bobDefault.credential),
    });
    expect(inbox.json().drops).toHaveLength(1);
    expect(inbox.json().drops[0].drop_id).toBe(dropId);
    expect(inbox.json().drops[0].author.handle).toBe('alice');
    expect(inbox.json().drops[0].read).toBe(false);
    expect(inbox.json().drops[0].origin_agent).toBeNull();
    expect(inbox.json().drops[0].recipients).toEqual([]);
    expect(inbox.json().drops[0].deliveries).toEqual([
      expect.objectContaining({
        h_id: bobDefault.hId,
        agent_name: '科研助手',
        harness_key: 'codex',
        read: false,
        current: true,
        sources: ['direct'],
      }),
    ]);
    expect(inbox.json().unread_count).toBe(1);
    expect(inbox.json().viewer.mailbox_revision).toBe(1);

    // A different H of the same account sees the history with the delivery attributed to the H that received it.
    const other = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?view=inbox',
      headers: hHeaders(bobOther.credential),
    });
    expect(other.json().drops).toHaveLength(1);
    expect(other.json().drops[0]).toMatchObject({
      drop_id: dropId,
      received_at: expect.any(String),
      read: false,
      starred: false,
      archived: false,
      state_version: 0,
    });
    expect(other.json().drops[0].deliveries).toEqual([
      expect.objectContaining({ h_id: bobDefault.hId, current: false, read: false }),
    ]);
    // Interactive account-wide views count unread drops across the visible agents.
    expect(other.json().unread_count).toBe(1);
    const probe = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}`,
      headers: hHeaders(bobOther.credential),
    });
    expect(probe.statusCode).toBe(200);
    const state = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${dropId}/state`,
      headers: hHeaders(bobOther.credential),
      payload: { expected_version: 0, read: true },
    });
    // All agents of an account are one reader (ADR 0007): the other H may flag the drop, and the flag lands on the
    // delivery of the H that actually received it.
    expect(state.statusCode, state.body).toBe(200);
    expect(state.json()).toMatchObject({ drop_id: dropId, read: true, state_version: 1 });
    const receiver = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?view=inbox',
      headers: hHeaders(bobDefault.credential),
    });
    expect(receiver.json().drops[0]).toMatchObject({ drop_id: dropId, read: true, state_version: 1 });
    expect(receiver.json().drops[0].deliveries).toEqual([
      expect.objectContaining({ h_id: bobDefault.hId, current: true, read: true, state_version: 1 }),
    ]);
    expect(receiver.json().unread_count).toBe(0);
    const stale = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${dropId}/state`,
      headers: hHeaders(bobDefault.credential),
      payload: { expected_version: 0, starred: true },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details.current_version).toBe(1);

    // the sender sees it under "sent" and can read it, but has no mailbox entry to flag
    const sent = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?view=sent',
      headers: hHeaders(aliceMac.credential),
    });
    expect(sent.json().drops[0].drop_id).toBe(dropId);
    expect(sent.json().drops[0].sources).toEqual(['sender']);
    expect(sent.json().drops[0].origin_agent).toEqual({
      h_id: aliceMac.hId,
      agent_name: '小码',
      harness_key: 'codex',
    });
    expect(sent.json().drops[0].recipients).toEqual(res.json().recipients);
    const senderRead = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}`,
      headers: hHeaders(aliceMac.credential),
    });
    expect(senderRead.statusCode).toBe(200);
  });

  it('can disable account-wide history and endpoint_scope=current always narrows the list', async () => {
    await befriend(alice, bob);
    // this test is about single-agent routing (ADR 0008 default is all agents)
    const single = await post('/v1/me/default-endpoint', bob, { h_id: bobDefault.hId });
    expect(single.statusCode, single.body).toBe(200);
    const { drop_id } = (
      await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'strict opt-out')
    ).json();

    const explicitlyCurrent = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?endpoint_scope=current',
      headers: hHeaders(bobOther.credential),
    });
    expect(explicitlyCurrent.statusCode, explicitlyCurrent.body).toBe(200);
    expect(explicitlyCurrent.json().drops).toEqual([]);

    const disabled = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me/mailbox-settings',
      headers: { cookie: bob.cookie, origin: t.origin },
      payload: { cross_h_mailbox_enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    const list = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?endpoint_scope=account',
      headers: hHeaders(bobOther.credential),
    });
    expect(list.json().drops).toEqual([]);
    const read = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${drop_id}`,
      headers: hHeaders(bobOther.credential),
    });
    expect(read.statusCode).toBe(404);
  });

  it('deduplicates a drop delivered to two own agents and shares one delivery state between them', async () => {
    await befriend(alice, bob);
    const targets = [{ type: 'user', user_id: bob.userId }];
    const sent = await send(aliceMac, targets, 'two agents');
    expect(sent.statusCode, sent.body).toBe(200);
    const dropId = sent.json().drop_id;

    const list = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(bobOther.credential),
    });
    expect(list.json().drops).toHaveLength(1);
    expect(list.json().drops[0].deliveries).toHaveLength(2);
    expect(
      list
        .json()
        .drops[0].deliveries.map((delivery: { h_id: string }) => delivery.h_id)
        .sort(),
    ).toEqual([bobDefault.hId, bobOther.hId].sort());
    expect(list.json().drops[0].read).toBe(false);

    const mark = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${dropId}/state`,
      headers: hHeaders(bobDefault.credential),
      payload: { expected_version: 0, read: true },
    });
    expect(mark.statusCode, mark.body).toBe(200);
    const after = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}`,
      headers: hHeaders(bobOther.credential),
    });
    expect(after.json().drop.read).toBe(true);
    expect(after.json().drop.state_version).toBe(1);
    expect(
      Object.fromEntries(
        after
          .json()
          .drop.deliveries.map((delivery: { h_id: string; read: boolean; state_version: number }) => [
            delivery.h_id,
            [delivery.read, delivery.state_version],
          ]),
      ),
    ).toEqual({ [bobDefault.hId]: [true, 1], [bobOther.hId]: [true, 1] });

    // The other agent continues from the shared version; a stale one conflicts instead of clobbering.
    const stale = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${dropId}/state`,
      headers: hHeaders(bobOther.credential),
      payload: { expected_version: 0, starred: true },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details.current_version).toBe(1);
    const star = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${dropId}/state`,
      headers: hHeaders(bobOther.credential),
      payload: { expected_version: 1, starred: true },
    });
    expect(star.statusCode, star.body).toBe(200);
    expect(star.json()).toMatchObject({ read: true, starred: true, state_version: 2 });
    const viaDefault = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}`,
      headers: hHeaders(bobDefault.credential),
    });
    expect(viaDefault.json().drop).toMatchObject({ read: true, starred: true, state_version: 2 });
    expect(
      viaDefault
        .json()
        .drop.deliveries.map((delivery: { starred: boolean; state_version: number }) => [
          delivery.starred,
          delivery.state_version,
        ]),
    ).toEqual([
      [true, 2],
      [true, 2],
    ]);
  });

  it('three connections (credentials) of one H share the mailbox and its read state; reads never mark read', async () => {
    await befriend(alice, bob);
    const c1 = bobDefault;
    const c2 = await pair(t, bob, { installationId: bobDefault.installationId, harness: 'codex' });
    const c3 = await pair(t, bob, { installationId: bobDefault.installationId, harness: 'codex' });
    expect(new Set([c1.hId, c2.hId, c3.hId]).size).toBe(1);
    const { drop_id } = (await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'shared')).json();

    for (const c of [c1, c2, c3]) {
      const r = await t.app.inject({
        method: 'GET',
        url: `/v1/h/drops/${drop_id}`,
        headers: hHeaders(c.credential),
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().drop.body_chunk).toBe('hello');
      expect(r.json().drop.read).toBe(false);
    }
    const mark = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${drop_id}/state`,
      headers: hHeaders(c2.credential),
      payload: { expected_version: 0, read: true, starred: true },
    });
    expect(mark.statusCode).toBe(200);
    expect(mark.json().state_version).toBe(1);
    const viaC3 = await t.app.inject({ method: 'GET', url: '/v1/h/drops', headers: hHeaders(c3.credential) });
    expect(viaC3.json().drops[0].read).toBe(true);
    expect(viaC3.json().drops[0].starred).toBe(true);
    expect(viaC3.json().unread_count).toBe(0);
    // stale version from c1 conflicts instead of clobbering
    const stale = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${drop_id}/state`,
      headers: hHeaders(c1.credential),
      payload: { expected_version: 0, archived: true },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('VERSION_CONFLICT');
    expect(stale.json().details.current_version).toBe(1);
  });

  it('same request_id + same content returns the first result; different content is a conflict; retries never re-route', async () => {
    await befriend(alice, bob);
    // this test is about single-agent routing (ADR 0008 default is all agents)
    const single = await post('/v1/me/default-endpoint', bob, { h_id: bobDefault.hId });
    expect(single.statusCode, single.body).toBe(200);
    const rid = `retry-${randomUUID()}`;
    const first = await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'once', rid);
    const again = await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'once', rid);
    expect(again.json().drop_id).toBe(first.json().drop_id);
    const conflict = await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'changed', rid);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('IDEMPOTENCY_CONFLICT');

    // bob changes his default H; a retry of the same request must NOT deliver to the new H
    await post('/v1/me/default-endpoint', bob, { h_id: bobOther.hId });
    const retry = await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'once', rid);
    expect(retry.json().drop_id).toBe(first.json().drop_id);
    const otherInbox = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?endpoint_scope=current',
      headers: hHeaders(bobOther.credential),
    });
    expect(otherInbox.json().drops).toHaveLength(0);
    // a genuinely new send goes to the new default
    const fresh = await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'new');
    expect(fresh.json().outcome).toBe('delivered');
    const otherInbox2 = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?endpoint_scope=current',
      headers: hHeaders(bobOther.credential),
    });
    expect(otherInbox2.json().drops).toHaveLength(1);
    const status = await t.app.inject({
      method: 'GET',
      url: `/v1/h/send-requests/${rid}`,
      headers: hHeaders(aliceMac.credential),
    });
    expect(status.json().outcome).toBe('delivered');
    expect(status.json().drop_id).toBe(first.json().drop_id);

    // concurrent retries of one request_id produce exactly one drop
    const rid2 = `burst-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'burst', rid2)),
    );
    const ids = new Set(results.map((r) => r.json().drop_id));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('unknown ids and other people’s drops are 404; the sender H list never leaks other H content', async () => {
    await befriend(alice, bob);
    const carol = await signUp(t, 'carol');
    const carolH = await pair(t, carol);
    const { drop_id } = (await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'private')).json();
    const r1 = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${drop_id}`,
      headers: hHeaders(carolH.credential),
    });
    expect(r1.statusCode).toBe(404);
    const r2 = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${randomUUID()}`,
      headers: hHeaders(bobDefault.credential),
    });
    expect(r2.statusCode).toBe(404);
    expect(r1.body).toBe(r2.body.replace(/"details":\{[^}]*\},?/, ''));
  });

  it('directory: remark > nickname > handle, published named entries, remembered preference and its failure mode', async () => {
    await befriend(alice, bob);
    // this test is about single-agent routing (ADR 0008 default is all agents)
    const single = await post('/v1/me/default-endpoint', bob, { h_id: bobDefault.hId });
    expect(single.statusCode, single.body).toBe(200);
    // bob publishes a named entry to his claude-code H
    const route = await post('/v1/me/routes', bob, {
      alias: 'research',
      label: '科研入口',
      h_id: bobOther.hId,
    });
    expect(route.statusCode, route.body).toBe(200);
    const routeId = route.json().route_id;

    let dir = await t.app.inject({
      method: 'GET',
      url: '/v1/h/directory?query=王',
      headers: hHeaders(aliceMac.credential),
    });
    expect(dir.json().entries[0].display_label).toBe('王同学');
    // Only the deliberately published entry appears, without its destination metadata.
    expect(dir.json().entries[0].alternatives).toEqual([
      {
        route_id: routeId,
        alias: 'research',
        label: '科研入口',
        harness_key: 'other',
        auto: false,
        target: { type: 'route', route_id: routeId },
      },
    ]);
    expect(dir.json().entries[0].default_target).toEqual({ type: 'user', user_id: bob.userId });
    expect(dir.json().entries[0].default_endpoint).toBeNull();

    // alice adds a private remark and remembers the named entry
    const patch = await t.app.inject({
      method: 'PATCH',
      url: `/v1/me/contacts/${bob.userId}`,
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { remark: '老王·实验合作', preferred_route_id: routeId },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    dir = await t.app.inject({
      method: 'GET',
      url: '/v1/h/directory?query=老王',
      headers: hHeaders(aliceMac.credential),
    });
    expect(dir.json().entries[0].display_label).toBe('老王·实验合作');
    expect(dir.json().entries[0].preference_applied).toBe(true);
    // the remark is invisible to bob
    const bobDir = await t.app.inject({
      method: 'GET',
      url: '/v1/h/directory',
      headers: hHeaders(bobDefault.credential),
    });
    expect(JSON.stringify(bobDir.json())).not.toContain('老王');

    // sending to "bob" now follows the preference → claude-code H
    const viaPref = await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'via preference');
    expect(viaPref.json().recipients[0].label).toBe('@bob/research');
    expect(viaPref.json().recipients[0].address).toBe('@bob/research');
    expect(viaPref.json().recipients[0].endpoint_label).toBeNull();
    const otherInbox = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(bobOther.credential),
    });
    expect(otherInbox.json().drops).toHaveLength(1);
    expect(otherInbox.json().drops[0].author.display_label).toBe('Alice');

    // bob revokes the entry: alice's preference fails loudly, nothing is rerouted
    await post(`/v1/me/routes/${routeId}/revoke`, bob);
    const failed = await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'after revoke');
    expect(failed.statusCode).toBe(422);
    expect(failed.json().code).toBe('PREFERRED_ROUTE_UNAVAILABLE');
    dir = await t.app.inject({
      method: 'GET',
      url: '/v1/h/directory?query=老王',
      headers: hHeaders(aliceMac.credential),
    });
    expect(dir.json().entries[0].preference_problem).toBe('PREFERRED_ROUTE_UNAVAILABLE');
    // explicit route target to a revoked entry is also refused
    const explicit = await send(aliceMac, [{ type: 'route', route_id: routeId }], 'explicit');
    expect(explicit.json().code).toBe('ROUTE_UNAVAILABLE');
    const defaultInbox = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?endpoint_scope=current',
      headers: hHeaders(bobDefault.credential),
    });
    expect(defaultInbox.json().drops).toHaveLength(0);
  });

  it('same-label candidates are flagged ambiguous; strangers are never listed', async () => {
    const wang1 = await signUp(t, 'wang1', '王同学');
    const wang2 = await signUp(t, 'wang2', '王同学');
    await signUp(t, 'stranger', '王同学');
    await pair(t, wang1);
    await pair(t, wang2);
    await befriend(alice, wang1);
    await befriend(alice, wang2);
    const dir = await t.app.inject({
      method: 'GET',
      url: '/v1/h/directory?query=王同学',
      headers: hHeaders(aliceMac.credential),
    });
    expect(dir.json().ambiguous).toBe(true);
    expect(dir.json().entries).toHaveLength(2);
    expect(
      dir
        .json()
        .entries.map((e: { handle: string }) => e.handle)
        .sort(),
    ).toEqual(['wang1', 'wang2']);
  });

  it('recipient without a default endpoint → NO_DELIVERY_ROUTE; blocked → BLOCKED; nothing partially sent', async () => {
    const dave = await signUp(t, 'dave');
    // contacts need an agent (AGENT_REQUIRED); dave then loses his only one
    const daveH = await pair(t, dave);
    await befriend(alice, dave);
    expect((await post(`/v1/me/endpoints/${daveH.hId}/revoke`, dave)).statusCode).toBe(200);
    await befriend(alice, bob);
    const none = await send(
      aliceMac,
      [
        { type: 'user', user_id: dave.userId },
        { type: 'user', user_id: bob.userId },
      ],
      'multi',
    );
    expect(none.statusCode).toBe(422);
    expect(none.json().code).toBe('NO_DELIVERY_ROUTE');
    const bobInbox = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(bobDefault.credential),
    });
    expect(bobInbox.json().drops).toHaveLength(0);
    await post(`/v1/me/contacts/${alice.userId}/block`, bob, { blocked: true });
    const blocked = await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'blocked');
    expect(blocked.json().code).toBe('BLOCKED');
  });

  it('web session can view only its own endpoints’ mailboxes; drops sent from the web are origin_kind=web', async () => {
    await befriend(alice, bob);
    const web = await t.app.inject({
      method: 'POST',
      url: `/v1/me/endpoints/${aliceMac.hId}/drops`,
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: {
        request_id: `web-${randomUUID()}`,
        targets: [{ type: 'user', user_id: bob.userId }],
        payload: payload('from web'),
      },
    });
    expect(web.statusCode, web.body).toBe(200);
    const bobView = await t.app.inject({
      method: 'GET',
      url: `/v1/me/endpoints/${bobDefault.hId}/drops`,
      headers: { cookie: bob.cookie },
    });
    expect(bobView.json().drops).toHaveLength(1);
    const foreign = await t.app.inject({
      method: 'GET',
      url: `/v1/me/endpoints/${bobDefault.hId}/drops`,
      headers: { cookie: alice.cookie },
    });
    expect(foreign.statusCode).toBe(404);
    const row = await t.db.drizzle.query.drops.findFirst();
    expect(row?.originKind).toBe('web');
  });

  it.each(['endpoint', 'device'] as const)(
    'revoking the sender %s blocks new web sends while preserving historical reads',
    async (kind) => {
      await befriend(alice, bob);
      const first = await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'before revoke');
      expect(first.statusCode, first.body).toBe(200);
      const endpoints = await t.app.inject({
        method: 'GET',
        url: '/v1/me/endpoints',
        headers: { cookie: alice.cookie },
      });
      const endpoint = endpoints.json().endpoints.find((e: { h_id: string }) => e.h_id === aliceMac.hId);
      const revoke = await post(
        kind === 'endpoint'
          ? `/v1/me/endpoints/${aliceMac.hId}/revoke`
          : `/v1/me/devices/${endpoint.device.device_id}/revoke`,
        alice,
      );
      expect(revoke.statusCode, revoke.body).toBe(200);
      const denied = await post(`/v1/me/endpoints/${aliceMac.hId}/drops`, alice, {
        request_id: `revoked-${randomUUID()}`,
        targets: [{ type: 'user', user_id: bob.userId }],
        payload: payload('must not deliver'),
      });
      expect(denied.statusCode, denied.body).toBe(401);
      expect(denied.json().code).toBe('ENDPOINT_REVOKED');
      const history = await t.app.inject({
        method: 'GET',
        url: `/v1/me/endpoints/${aliceMac.hId}/drops/${first.json().drop_id}`,
        headers: { cookie: alice.cookie },
      });
      expect(history.statusCode, history.body).toBe(200);
      expect(await t.db.drizzle.query.drops.findMany()).toHaveLength(1);
    },
  );

  it('revoking an origin prevents approval of its old draft without consuming it', async () => {
    await post('/v1/me/contacts/invite', alice, { handle: bob.handle });
    await post(`/v1/me/contacts/${alice.userId}/accept`, bob);
    const secret = Buffer.from('AKIAABCDEFGHIJKLMNOP');
    const uploaded = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceMac.credential),
        'content-type': 'application/octet-stream',
        'content-length': String(secret.length),
        'x-agentdrop-filename': 'credentials.txt',
        'x-agentdrop-content-type': 'text/plain',
      },
      payload: secret,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const pending = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(aliceMac.credential),
      payload: {
        request_id: `pending-${randomUUID()}`,
        targets: [{ type: 'user', user_id: bob.userId }],
        payload: {
          ...payload('pending', 'review attachment'),
          kind: 'file',
          attachment_ids: [uploaded.json().attachment_id],
        },
      },
    });
    expect(pending.statusCode, pending.body).toBe(202);
    const list = await t.app.inject({
      method: 'GET',
      url: '/v1/me/approvals?status=pending',
      headers: { cookie: alice.cookie },
    });
    const approvalId = list.json().approvals[0].approval_id;
    const revoke = await post(`/v1/me/endpoints/${aliceMac.hId}/revoke`, alice);
    expect(revoke.statusCode, revoke.body).toBe(200);
    const denied = await post(`/v1/me/approvals/${approvalId}/decide`, alice, { decision: 'approve' });
    expect(denied.statusCode, denied.body).toBe(401);
    expect(denied.json().code).toBe('ENDPOINT_REVOKED');
    expect(await t.db.drizzle.query.drops.findMany()).toHaveLength(0);
    expect((await t.db.drizzle.query.approvals.findFirst())?.status).toBe('pending');
    // A revoked origin does not stop its owner from dismissing obsolete approval drafts.
    const rejected = await post(`/v1/me/approvals/${approvalId}/decide`, alice, { decision: 'reject' });
    expect(rejected.statusCode, rejected.body).toBe(200);
  });

  it('device revocation and sends between its endpoints serialize without deadlocking', async () => {
    const other = await pair(t, alice, {
      installationId: aliceMac.installationId,
      harness: 'claude-code',
    });
    const endpoints = await t.app.inject({
      method: 'GET',
      url: '/v1/me/endpoints',
      headers: { cookie: alice.cookie },
    });
    const endpoint = endpoints.json().endpoints.find((e: { h_id: string }) => e.h_id === aliceMac.hId);
    const [sent, revoked] = await Promise.all([
      post(`/v1/me/endpoints/${other.hId}/drops`, alice, {
        request_id: `racing-${randomUUID()}`,
        targets: [{ type: 'user', user_id: alice.userId }],
        payload: payload('same device'),
      }),
      post(`/v1/me/devices/${endpoint.device.device_id}/revoke`, alice),
    ]);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect([200, 401, 422], sent.body).toContain(sent.statusCode);
    if (sent.statusCode !== 200) {
      expect(['ENDPOINT_REVOKED', 'NO_DELIVERY_ROUTE']).toContain(sent.json().code);
    }
    expect(await t.db.drizzle.query.drops.findMany()).toHaveLength(sent.statusCode === 200 ? 1 : 0);
  });

  it('device prelocks allow delivery foreign keys while waiting for an active sender', async () => {
    const other = await pair(t, alice, {
      installationId: aliceMac.installationId,
      harness: 'claude-code',
    });
    const [destination, origin] = [aliceMac, other].sort((a, b) => a.hId.localeCompare(b.hId));
    if (!destination || !origin) throw new Error('two endpoints required');
    const h = await t.db.drizzle.query.harnessEndpoints.findFirst({
      where: (table, { eq }) => eq(table.id, origin.hId),
    });
    const route = await t.db.drizzle.query.recipientRoutes.findFirst({
      where: (table, { and, eq }) => and(eq(table.destinationHId, destination.hId), eq(table.auto, true)),
    });
    if (!h || !route) throw new Error('paired identity missing');
    let revokeResult: Promise<{ error?: unknown }> | undefined;
    const sent = await t.db.drizzle
      .transaction(async (tx) => {
        const scope = { userId: alice.userId, hId: origin.hId, via: 'user_session' as const };
        await assertActiveOrigin(tx, scope);
        const sender = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        const senderPid = sender.rows[0]?.pid;
        if (!senderPid) throw new Error('sender backend missing');
        let reportPid: (pid: number) => void = () => {};
        const revokerPid = new Promise<number>((resolve) => {
          reportPid = resolve;
        });
        revokeResult = t.db.drizzle
          .transaction(async (revokeTx) => {
            const process = await revokeTx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
            const processPid = process.rows[0]?.pid;
            if (!processPid) throw new Error('revoker backend missing');
            reportPid(processPid);
            await revokeDevice(revokeTx, alice.userId, h.deviceId);
          })
          .then(
            () => ({}),
            (error: unknown) => ({ error }),
          );
        const pid = await revokerPid;
        // Do not rely on timing: wait until revocation has locked the lower H and is blocked by our higher H.
        let blocked = false;
        for (let attempt = 0; attempt < 500; attempt++) {
          const state = await t.db.pool.query<{ blocked: boolean }>(
            'select $1::int = any(pg_blocking_pids($2::int)) as blocked',
            [senderPid, pid],
          );
          if (state.rows[0]?.blocked) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        return sendDrop(
          tx,
          scope,
          {
            request_id: `fk-lock-${randomUUID()}`,
            targets: [{ type: 'route', route_id: route.id }],
            payload: payload('delivery while revocation waits'),
          },
          { originKind: 'web', maxGroupRecipients: 50 },
        );
      })
      .finally(async () => {
        // Finish both transactions before the next test resets the database, including on regression failures.
        await revokeResult;
      });
    expect(await revokeResult).toEqual({});
    expect(sent.outcome).toBe('delivered');
    expect(await t.db.drizzle.query.drops.findMany()).toHaveLength(1);
  });

  it('pagination uses keyset cursors and rejects garbage cursors with RESYNC_REQUIRED', async () => {
    await befriend(alice, bob);
    for (let i = 0; i < 5; i++) await send(aliceMac, [{ type: 'user', user_id: bob.userId }], `n${i}`);
    const p1 = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?limit=2',
      headers: hHeaders(bobDefault.credential),
    });
    expect(p1.json().drops).toHaveLength(2);
    expect(p1.json().next_cursor).toBeTruthy();
    const p2 = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops?limit=2&cursor=${p1.json().next_cursor}`,
      headers: hHeaders(bobDefault.credential),
    });
    const p3 = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops?limit=2&cursor=${p2.json().next_cursor}`,
      headers: hHeaders(bobDefault.credential),
    });
    const titles = [...p1.json().drops, ...p2.json().drops, ...p3.json().drops].map(
      (d: { title: string }) => d.title,
    );
    expect(titles).toEqual(['n4', 'n3', 'n2', 'n1', 'n0']);
    expect(p3.json().next_cursor).toBeNull();
    const bad = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?cursor=zzz',
      headers: hHeaders(bobDefault.credential),
    });
    expect(bad.statusCode).toBe(410);
    expect(bad.json().code).toBe('RESYNC_REQUIRED');
  });

  it('read_drop pages long bodies and rejects oversize payloads', async () => {
    await befriend(alice, bob);
    const body = 'x'.repeat(10_000);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(aliceMac.credential),
      payload: {
        request_id: `long-${randomUUID()}`,
        targets: [{ type: 'user', user_id: bob.userId }],
        payload: payload('long', body),
      },
    });
    const id = res.json().drop_id;
    const r1 = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${id}?max_chars=8192`,
      headers: hHeaders(bobDefault.credential),
    });
    expect(r1.json().drop.body_chunk).toHaveLength(8192);
    expect(r1.json().drop.next_offset).toBe(8192);
    const r2 = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${id}?offset=8192`,
      headers: hHeaders(bobDefault.credential),
    });
    expect(r2.json().drop.body_chunk).toHaveLength(10_000 - 8192);
    expect(r2.json().drop.next_offset).toBeNull();
    const tooBig = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(aliceMac.credential),
      payload: {
        request_id: `big-${randomUUID()}`,
        targets: [{ type: 'user', user_id: bob.userId }],
        payload: payload('big', 'y'.repeat(70_000)),
      },
    });
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json().code).toBe('VALIDATION_FAILED');
  });

  it('a plain send to a person reaches all of their agents until they pick one default receiver (ADR 0008)', async () => {
    await befriend(alice, bob);
    const mine = (ep: PairedEndpoint) =>
      t.app
        .inject({
          method: 'GET',
          url: '/v1/h/drops?view=inbox&endpoint_scope=current',
          headers: hHeaders(ep.credential),
        })
        .then((r) => r.json().drops.map((d: { title: string }) => d.title));
    const card = async () =>
      (
        await t.app.inject({
          method: 'GET',
          url: '/v1/h/directory?query=bob',
          headers: hHeaders(aliceMac.credential),
        })
      )
        .json()
        .entries.find((e: { kind: string }) => e.kind === 'person');
    expect((await card()).receives_on_all_agents).toBeUndefined();
    const toAll = await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'to all of bob');
    expect(toAll.statusCode, toAll.body).toBe(200);
    expect(toAll.json().recipients[0]).toMatchObject({ address: '@bob', endpoint_count: 1 });
    expect(await mine(bobDefault)).toContain('to all of bob');
    expect(await mine(bobOther)).toContain('to all of bob');
    // Choosing one default receiver narrows plain sends to it.
    const pick = await post('/v1/me/default-endpoint', bob, { h_id: bobOther.hId });
    expect(pick.statusCode, pick.body).toBe(200);
    expect((await get('/v1/me', bob)).json().direct_receive_all).toBe(false);
    expect((await card()).receives_on_all_agents).toBeUndefined();
    await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'to one of bob');
    expect(await mine(bobOther)).toContain('to one of bob');
    expect(await mine(bobDefault)).not.toContain('to one of bob');
    // And back to all.
    expect((await post('/v1/me/default-endpoint', bob, { all: true })).statusCode).toBe(200);
    expect((await get('/v1/me', bob)).json().direct_receive_all).toBe(true);
    await send(aliceMac, [{ type: 'user', user_id: bob.userId }], 'all again');
    expect(await mine(bobDefault)).toContain('all again');
    expect(await mine(bobOther)).toContain('all again');
  });
});
