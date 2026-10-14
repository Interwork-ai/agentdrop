import { randomUUID } from 'node:crypto';
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
  console.warn('[groups.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

function payload(title: string) {
  return {
    payload_version: 1,
    kind: 'text',
    title,
    body: `body of ${title}`,
    attachment_ids: [],
    extensions: {},
  };
}

describeDb('PR-06 groups, receiving bindings and authorization generations', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let carol: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobCc: PairedEndpoint;
  let bobCodex: PairedEndpoint;
  let carolH: PairedEndpoint;
  let groupId: string;

  const post = (url: string, user: BrowserUser, payload?: unknown) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: user.cookie, origin: t.origin },
      ...(payload ? { payload } : {}),
    });
  const get = (url: string, user: BrowserUser) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: user.cookie } });

  async function befriend(a: BrowserUser, b: BrowserUser) {
    await post('/v1/me/contacts/invite', a, { handle: b.handle });
    await post(`/v1/me/contacts/${a.userId}/accept`, b);
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

  async function send(ep: PairedEndpoint, targets: unknown[], title: string, rid = `req-${randomUUID()}`) {
    return t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(ep.credential),
      payload: { request_id: rid, targets, payload: payload(title) },
    });
  }
  const list = (ep: PairedEndpoint, q = '') =>
    t.app.inject({ method: 'GET', url: `/v1/h/drops${q}`, headers: hHeaders(ep.credential) });
  const read = (ep: PairedEndpoint, dropId: string) =>
    t.app.inject({ method: 'GET', url: `/v1/h/drops/${dropId}`, headers: hHeaders(ep.credential) });

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice', 'Alice');
    bob = await signUp(t, 'bob', '王同学');
    carol = await signUp(t, 'carol', '李同学');
    aliceH = await pair(t, alice, { harness: 'codex', endpointLabel: '小码' });
    bobCc = await pair(t, bob, { harness: 'claude-code', endpointLabel: '科研助手' });
    bobCodex = await pair(t, bob, { harness: 'codex', endpointLabel: '阅读助手' });
    carolH = await pair(t, carol, { harness: 'codex' });
    await befriend(alice, bob);
    await befriend(alice, carol);
    const created = await post('/v1/me/groups', alice, {
      slug: 'research',
      display_name: '论文讨论组',
      binding_h_ids: [aliceH.hId],
    });
    expect(created.statusCode, created.body).toBe(200);
    groupId = created.json().group_id;
  });

  it('members choose their receiving H; one send creates one independent delivery per bound H, including the sender', async () => {
    const inv = await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    expect(inv.statusCode, inv.body).toBe(200);
    // bob sees the invitation and must pick an H (his claude-code one)
    const mine = await get('/v1/me/groups', bob);
    expect(mine.json().groups[0].status).toBe('invited');
    const acc = await post(`/v1/me/groups/${groupId}/accept`, bob, {
      h_ids: [bobCc.hId],
      nickname: '王同学·RL',
    });
    expect(acc.statusCode, acc.body).toBe(200);
    expect(acc.json().my_membership.binding_h_ids).toEqual([bobCc.hId]);
    // the admin cannot see bob's endpoints, only whether he needs repair
    const detail = await get(`/v1/me/groups/${groupId}`, alice);
    expect(JSON.stringify(detail.json())).not.toContain(bobCc.hId);
    expect(detail.json().members.find((m: { handle: string }) => m.handle === 'bob').display_label).toBe(
      '王同学·RL',
    );

    const res = await send(aliceH, [{ type: 'group', group_id: groupId }], '实验日志');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().recipients).toEqual([
      {
        type: 'group',
        label: '#research',
        endpoint_count: 1,
        address: null,
        endpoint_label: null,
        harness_key: null,
      },
    ]);
    const dropId = res.json().drop_id;
    const bobInbox = await list(bobCc, `?group_id=${groupId}`);
    expect(bobInbox.json().drops.map((d: { drop_id: string }) => d.drop_id)).toEqual([dropId]);
    expect(bobInbox.json().drops[0].sources).toEqual(['group']);
    expect(bobInbox.json().drops[0].group_ids).toEqual([groupId]);
    const bobOther = await list(bobCodex);
    expect(bobOther.json().drops).toHaveLength(1);
    expect(bobOther.json().drops[0].deliveries).toEqual([
      expect.objectContaining({ h_id: bobCc.hId, current: false, sources: ['group'] }),
    ]);
    expect((await read(bobCodex, dropId)).statusCode).toBe(200);
    const bobOtherCurrent = await list(bobCodex, '?endpoint_scope=current');
    expect(bobOtherCurrent.json().drops).toHaveLength(0);
    // the sender's own bound H got a mailbox entry (sources group + sender), listed in the group's view and not in
    // the sender's inbox (ADR 0033)
    expect((await list(aliceH)).json().drops).toEqual([]);
    const aliceInbox = await list(aliceH, `?group_id=${groupId}`);
    expect(aliceInbox.json().drops[0].sources).toEqual(['group', 'sender']);
    // each H has its own read state
    await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${dropId}/state`,
      headers: hHeaders(bobCc.credential),
      payload: { expected_version: 0, read: true },
    });
    // the sender's own copy was read on arrival (ADR 0015): nobody is told about their own group send
    expect((await list(aliceH, `?group_id=${groupId}`)).json().drops[0].read).toBe(true);

    // sharing a group is not a contact: carol (a member, not bob's contact) learns nothing about bob's agents
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'carol' });
    const carolIn = await post(`/v1/me/groups/${groupId}/accept`, carol, { h_ids: [carolH.hId] });
    expect(carolIn.statusCode, carolIn.body).toBe(200);
    const seen = await t.app.inject({
      method: 'GET',
      url: '/v1/h/directory?query=bob',
      headers: { authorization: `Bearer ${carolH.credential}` },
    });
    expect(seen.json().entries[0].contact_status).toBe('group_only');
    expect(seen.json().entries[0].alternatives).toEqual([]);
    expect(seen.json().entries[0].default_endpoint).toBeNull();
  });

  it('group filtering keeps all owned deliveries in the shared account-wide state', async () => {
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId] });
    const named = await post('/v1/me/routes', bob, { alias: 'work', label: 'Work', h_id: bobCodex.hId });
    const codexTarget = { type: 'route', route_id: named.json().route_id };
    const sent = await send(aliceH, [{ type: 'group', group_id: groupId }, codexTarget], 'group and direct');
    expect(sent.statusCode, sent.body).toBe(200);
    const dropId = sent.json().drop_id;
    const groupState = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${dropId}/state`,
      headers: hHeaders(bobCc.credential),
      payload: { expected_version: 0, read: true, archived: true },
    });
    expect(groupState.statusCode, groupState.body).toBe(200);
    // State is per person (ADR 0007): the group delivery's change already moved the direct delivery too, so the
    // other H must continue from the shared version.
    const staleDirect = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${dropId}/state`,
      headers: hHeaders(bobCodex.credential),
      payload: { expected_version: 0, starred: true },
    });
    expect(staleDirect.statusCode).toBe(409);
    expect(staleDirect.json().details.current_version).toBe(1);
    const directState = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${dropId}/state`,
      headers: hHeaders(bobCodex.credential),
      payload: { expected_version: 1, starred: true },
    });
    expect(directState.statusCode, directState.body).toBe(200);
    expect(directState.json()).toMatchObject({ read: true, starred: true, archived: true, state_version: 2 });

    // The group filter still aggregates over every owned delivery, including the direct-only one.
    const starred = await list(bobCodex, `?view=starred&group_id=${groupId}`);
    expect(starred.json().drops).toHaveLength(1);
    expect(starred.json().drops[0]).toMatchObject({
      read: true,
      starred: true,
      archived: true,
      state_version: 2,
    });
    expect(starred.json().drops[0].deliveries).toHaveLength(2);
    expect(
      starred
        .json()
        .drops[0].deliveries.map(
          (d: {
            h_id: string;
            read: boolean;
            starred: boolean;
            archived: boolean;
            state_version: number;
          }) => [d.h_id, d.read, d.starred, d.archived, d.state_version],
        )
        .sort(),
    ).toEqual(
      [
        [bobCc.hId, true, true, true, 2],
        [bobCodex.hId, true, true, true, 2],
      ].sort(),
    );
    expect((await list(bobCodex, `?view=archived&group_id=${groupId}`)).json().drops).toHaveLength(1);
    expect(
      (await list(bobCodex, `?view=inbox&group_id=${groupId}&unread_only=true`)).json().drops,
    ).toHaveLength(0);
  });

  it('no history for new members; leaving revokes group grants but not direct ones; re-joining is a new generation', async () => {
    // this test is about one H holding both a direct and a group grant, so bob pins single-agent receiving
    // (ADR 0008 default is all agents; reaching bobCodex too would also exceed the test cap of 3 group endpoints)
    const single = await post('/v1/me/default-endpoint', bob, { h_id: bobCc.hId });
    expect(single.statusCode, single.body).toBe(200);
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId] });
    const before = (await send(aliceH, [{ type: 'group', group_id: groupId }], 'before carol')).json()
      .drop_id;
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'carol' });
    await post(`/v1/me/groups/${groupId}/accept`, carol, { h_ids: [carolH.hId] });
    expect((await read(carolH, before)).statusCode).toBe(404);
    const after = (await send(aliceH, [{ type: 'group', group_id: groupId }], 'after carol')).json().drop_id;
    expect((await read(carolH, after)).statusCode).toBe(200);

    // the same drop sent privately AND via the group to bob's H: one delivery, two grants
    const both = await send(
      aliceH,
      [
        { type: 'user', user_id: bob.userId },
        { type: 'group', group_id: groupId },
      ],
      'both',
    );
    expect(both.statusCode, both.body).toBe(200);
    const bothId = both.json().drop_id;
    const bobList = await list(bobCc);
    const row = bobList.json().drops.find((d: { drop_id: string }) => d.drop_id === bothId);
    expect(row.sources.sort()).toEqual(['direct', 'group']);

    // bob leaves: group-only drops vanish for new reads; the privately granted one stays
    const leave = await post(`/v1/me/groups/${groupId}/leave`, bob);
    expect(leave.statusCode, leave.body).toBe(200);
    expect((await read(bobCc, before)).statusCode).toBe(404);
    expect((await read(bobCc, after)).statusCode).toBe(404);
    const stillMine = await read(bobCc, bothId);
    expect(stillMine.statusCode).toBe(200);
    expect(stillMine.json().drop.sources).toEqual(['direct']);
    expect((await list(bobCc, `?group_id=${groupId}`)).json().drops).toHaveLength(0);
    // sending to bob directly still works (contact), but the group no longer reaches him
    const later = (await send(aliceH, [{ type: 'group', group_id: groupId }], 'after leave')).json().drop_id;
    expect((await read(bobCc, later)).statusCode).toBe(404);

    // re-join: new membership id, old drops stay invisible, new ones arrive
    const reinvite = await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    expect(reinvite.statusCode, reinvite.body).toBe(200);
    const rejoin = await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId] });
    expect(rejoin.statusCode, rejoin.body).toBe(200);
    const memberships = await t.db.drizzle.query.groupMemberships.findMany();
    expect(memberships.filter((m) => m.userId === bob.userId)).toHaveLength(2);
    expect((await read(bobCc, before)).statusCode).toBe(404);
    expect((await read(bobCc, later)).statusCode).toBe(404);
    const fresh = (await send(aliceH, [{ type: 'group', group_id: groupId }], 'after rejoin')).json().drop_id;
    expect((await read(bobCc, fresh)).statusCode).toBe(200);
  });

  it('an active member without a usable endpoint blocks the whole send (GROUP_RECIPIENT_UNAVAILABLE); fixing bindings unblocks it', async () => {
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId] });
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'carol' });
    await post(`/v1/me/groups/${groupId}/accept`, carol, { h_ids: [carolH.hId] });
    // a binding that stops being usable without the agent being revoked (a race ADR 0015 cannot close)
    await t.db.drizzle.execute(
      sql`update group_bindings set revoked_at = now() where h_id = ${bobCc.hId} and revoked_at is null`,
    );
    const blocked = await send(aliceH, [{ type: 'group', group_id: groupId }], 'blocked');
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe('GROUP_RECIPIENT_UNAVAILABLE');
    expect(blocked.json().details.member_handle).toBe('bob');
    expect((await list(carolH)).json().drops).toHaveLength(0);
    const detail = await get(`/v1/me/groups/${groupId}`, alice);
    expect(detail.json().members_needing_repair).toBe(1);
    // bob rebinds to his other endpoint → sends flow again, only to that H
    const fix = await t.app.inject({
      method: 'PUT',
      url: `/v1/me/groups/${groupId}/bindings`,
      headers: { cookie: bob.cookie, origin: t.origin },
      payload: { h_ids: [bobCodex.hId] },
    });
    expect(fix.statusCode, fix.body).toBe(200);
    const ok = await send(aliceH, [{ type: 'group', group_id: groupId }], 'fixed');
    expect(ok.json().outcome).toBe('delivered');
    expect((await list(bobCodex)).json().drops).toHaveLength(1);
  });

  it('unbinding removes that delivery while account-wide reads and shared state remain available through another endpoint', async () => {
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId, bobCodex.hId] });
    const both = (await send(aliceH, [{ type: 'group', group_id: groupId }], 'two endpoints')).json();
    expect(both.recipients[0].endpoint_count).toBe(1);
    expect((await read(bobCc, both.drop_id)).statusCode).toBe(200);
    expect((await read(bobCodex, both.drop_id)).statusCode).toBe(200);
    await t.app.inject({
      method: 'PUT',
      url: `/v1/me/groups/${groupId}/bindings`,
      headers: { cookie: bob.cookie, origin: t.origin },
      payload: { h_ids: [bobCc.hId] },
    });
    const crossEndpointRead = await read(bobCodex, both.drop_id);
    expect(crossEndpointRead.statusCode).toBe(200);
    expect(crossEndpointRead.json().drop.deliveries).toEqual([
      expect.objectContaining({ h_id: bobCc.hId, current: false }),
    ]);
    expect((await read(bobCc, both.drop_id)).statusCode).toBe(200);
    const crossEndpointState = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${both.drop_id}/state`,
      headers: hHeaders(bobCodex.credential),
      payload: { expected_version: 0, read: true },
    });
    // The unbound H still flags the drop for the whole account; the remaining delivery carries the shared state.
    expect(crossEndpointState.statusCode, crossEndpointState.body).toBe(200);
    expect(crossEndpointState.json()).toMatchObject({ read: true, state_version: 1 });
    const viaBound = await read(bobCc, both.drop_id);
    expect(viaBound.json().drop).toMatchObject({ read: true, state_version: 1 });
    expect(viaBound.json().drop.deliveries).toEqual([
      expect.objectContaining({ h_id: bobCc.hId, current: true, read: true, state_version: 1 }),
    ]);
    const next = (await send(aliceH, [{ type: 'group', group_id: groupId }], 'one endpoint')).json();
    expect(next.recipients[0].endpoint_count).toBe(1);
    expect((await list(bobCodex, '?endpoint_scope=current')).json().drops).toHaveLength(0);
  });

  it('roles: members may invite, only admins remove, only the owner changes roles; nobody picks endpoints for others', async () => {
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId] });
    await befriend(bob, carol);
    // a new group defaults to `open`, so a plain member's invitation goes out directly
    expect((await post(`/v1/me/groups/${groupId}/invite`, bob, { handles: ['carol'] })).statusCode).toBe(200);
    expect((await post(`/v1/me/groups/${groupId}/members/${carol.userId}/remove`, bob)).statusCode).toBe(403);
    expect(
      (
        await t.app.inject({
          method: 'PATCH',
          url: `/v1/me/groups/${groupId}/members/${bob.userId}`,
          headers: { cookie: bob.cookie, origin: t.origin },
          payload: { role: 'admin' },
        })
      ).statusCode,
    ).toBe(403);
    const promote = await t.app.inject({
      method: 'PATCH',
      url: `/v1/me/groups/${groupId}/members/${bob.userId}`,
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { role: 'admin' },
    });
    expect(promote.statusCode).toBe(200);
    expect((await post(`/v1/me/groups/${groupId}/invite`, bob, { handle: 'carol' })).statusCode).toBe(200);
    expect((await get(`/v1/me/groups/${groupId}`, carol)).json().members).toEqual([]);
    // alice cannot bind bob's endpoint for him: bindings are per-membership of the caller only
    const forged = await t.app.inject({
      method: 'PUT',
      url: `/v1/me/groups/${groupId}/bindings`,
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { h_ids: [bobCc.hId] },
    });
    expect(forged.statusCode).toBe(404);
    // owner cannot leave; owner can transfer, then leave
    expect((await post(`/v1/me/groups/${groupId}/leave`, alice)).statusCode).toBe(400);
    await t.app.inject({
      method: 'PATCH',
      url: `/v1/me/groups/${groupId}/members/${bob.userId}`,
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { role: 'owner' },
    });
    expect((await post(`/v1/me/groups/${groupId}/leave`, alice)).statusCode).toBe(200);
    expect((await post(`/v1/me/groups/${groupId}/members/${carol.userId}/remove`, bob)).statusCode).toBe(200);
  });

  it('a concurrent leave and send never leaves a readable delivery behind for the leaver', async () => {
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId] });
    const results = await Promise.all([
      post(`/v1/me/groups/${groupId}/leave`, bob),
      send(aliceH, [{ type: 'group', group_id: groupId }], 'race 1'),
      send(aliceH, [{ type: 'group', group_id: groupId }], 'race 2'),
    ]);
    expect(results[0].statusCode).toBe(200);
    for (const r of results.slice(1)) {
      expect(r.statusCode).toBe(200);
      const dropId = r.json().drop_id;
      // either bob was still a member when the send committed (grant now revoked) or he was not (no delivery):
      // in both cases the drop must not be readable by bob now
      expect((await read(bobCc, dropId)).statusCode).toBe(404);
    }
  });

  it('creating a group invites several people at once, and one bad handle rolls the whole thing back', async () => {
    const created = await post('/v1/me/groups', alice, {
      slug: 'batch',
      display_name: '批量组',
      binding_h_ids: [aliceH.hId],
      invite_handles: ['bob', 'carol'],
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().invites).toEqual([
      { handle: 'bob', outcome: 'invited' },
      { handle: 'carol', outcome: 'invited' },
    ]);
    expect(created.json().member_slots_used).toBe(3);
    expect((await get('/v1/me/groups', bob)).json().groups).toContainEqual(
      expect.objectContaining({ slug: 'batch', status: 'invited' }),
    );

    const bad = await post('/v1/me/groups', alice, {
      slug: 'never-created',
      display_name: '不该存在',
      binding_h_ids: [aliceH.hId],
      invite_handles: ['bob', 'nobody-here'],
    });
    expect(bad.statusCode).toBe(404);
    expect(bad.json().details.handles).toEqual(['nobody-here']);
    expect((await get('/v1/me/groups', alice)).json().groups).not.toContainEqual(
      expect.objectContaining({ slug: 'never-created' }),
    );
  });

  it('the member limit counts members and unanswered invitations together', async () => {
    // the test config caps MAX_GROUP_MEMBERS at 4: alice + 3 invitations fills it
    const dave = await signUp(t, 'dave');
    const erin = await signUp(t, 'erin');
    expect(
      (await post(`/v1/me/groups/${groupId}/invite`, alice, { handles: ['bob', 'carol', dave.handle] }))
        .statusCode,
    ).toBe(200);
    const full = await post(`/v1/me/groups/${groupId}/invite`, alice, { handles: [erin.handle] });
    expect(full.statusCode).toBe(400);
    expect(full.json().details).toMatchObject({ member_limit: 4, member_slots_used: 4 });
    // declining frees the slot again
    await post(`/v1/me/groups/${groupId}/decline`, carol);
    expect(
      (await post(`/v1/me/groups/${groupId}/invite`, alice, { handles: [erin.handle] })).statusCode,
    ).toBe(200);
  });

  it('admin_approval turns a member invitation into a request only an admin can decide', async () => {
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId] });
    const policy = await t.app.inject({
      method: 'PATCH',
      url: `/v1/me/groups/${groupId}/policy`,
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { member_invite_policy: 'admin_approval' },
    });
    expect(policy.statusCode, policy.body).toBe(200);
    expect(policy.json().invite_policy).toBe('admin_approval');
    // a plain member cannot change it back
    expect(
      (
        await t.app.inject({
          method: 'PATCH',
          url: `/v1/me/groups/${groupId}/policy`,
          headers: { cookie: bob.cookie, origin: t.origin },
          payload: { member_invite_policy: 'open' },
        })
      ).statusCode,
    ).toBe(403);

    const proposed = await post(`/v1/me/groups/${groupId}/invite`, bob, { handles: ['carol'] });
    expect(proposed.statusCode, proposed.body).toBe(200);
    expect(proposed.json().invites).toEqual([{ handle: 'carol', outcome: 'requested' }]);
    // carol learns nothing until an admin approves
    expect((await get('/v1/me/groups', carol)).json().groups).toEqual([]);
    expect((await get(`/v1/me/groups/${groupId}`, carol)).statusCode).toBe(404);
    expect((await get(`/v1/me/groups/${groupId}/requests`, alice)).json().join_requests).toEqual([
      expect.objectContaining({ invitee_handle: 'carol', invited_by_handle: 'bob' }),
    ]);
    // and a member cannot approve it either
    expect(
      (await post(`/v1/me/groups/${groupId}/requests/${carol.userId}/decide`, bob, { decision: 'approve' }))
        .statusCode,
    ).toBe(403);

    const approved = await post(`/v1/me/groups/${groupId}/requests/${carol.userId}/decide`, alice, {
      decision: 'approve',
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().join_requests).toEqual([]);
    expect((await get('/v1/me/groups', carol)).json().groups).toContainEqual(
      expect.objectContaining({ group_id: groupId, status: 'invited' }),
    );
    expect((await post(`/v1/me/groups/${groupId}/accept`, carol, { h_ids: [carolH.hId] })).statusCode).toBe(
      200,
    );
    // the same decision cannot be replayed
    expect(
      (await post(`/v1/me/groups/${groupId}/requests/${carol.userId}/decide`, alice, { decision: 'approve' }))
        .statusCode,
    ).toBe(404);
  });

  it('rejecting a join request admits nobody, and a direct admin invite supersedes a waiting request', async () => {
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId] });
    await t.app.inject({
      method: 'PATCH',
      url: `/v1/me/groups/${groupId}/policy`,
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { member_invite_policy: 'admin_approval' },
    });
    await post(`/v1/me/groups/${groupId}/invite`, bob, { handles: ['carol'] });
    await post(`/v1/me/groups/${groupId}/requests/${carol.userId}/decide`, alice, { decision: 'reject' });
    expect((await get('/v1/me/groups', carol)).json().groups).toEqual([]);
    expect((await get(`/v1/me/groups/${groupId}/requests`, alice)).json().join_requests).toEqual([]);

    // bob proposes again; alice invites carol directly instead, which cancels the request
    await post(`/v1/me/groups/${groupId}/invite`, bob, { handles: ['carol'] });
    expect((await get(`/v1/me/groups/${groupId}/requests`, alice)).json().join_requests).toHaveLength(1);
    expect((await post(`/v1/me/groups/${groupId}/invite`, alice, { handles: ['carol'] })).statusCode).toBe(
      200,
    );
    expect((await get(`/v1/me/groups/${groupId}/requests`, alice)).json().join_requests).toEqual([]);
    expect((await get('/v1/me/groups', carol)).json().groups).toContainEqual(
      expect.objectContaining({ group_id: groupId, status: 'invited' }),
    );
  });

  it('nobody can be put into a group with someone either side has blocked', async () => {
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId] });
    await post(`/v1/me/contacts/${carol.userId}/block`, bob, { blocked: true });
    const res = await post(`/v1/me/groups/${groupId}/invite`, alice, { handles: ['carol'] });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('BLOCKED');
    expect((await get('/v1/me/groups', carol)).json().groups).toEqual([]);
  });

  it('an owner reads the group history that predates them; a plain member never does, and neither can mutate it', async () => {
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId] });
    const early = (await send(aliceH, [{ type: 'group', group_id: groupId }], 'before carol')).json();

    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'carol' });
    await post(`/v1/me/groups/${groupId}/accept`, carol, { h_ids: [carolH.hId] });
    // carol joined late: the ordinary timeline still hides what came before her
    expect((await list(carolH, `?group_id=${groupId}`)).json().drops).toHaveLength(0);
    expect((await list(carolH, `?group_id=${groupId}&include_group_history=true`)).json().drops).toHaveLength(
      0,
    );
    expect((await read(carolH, early.drop_id)).statusCode).toBe(404);

    // promote carol: the same request now returns the whole history, marked as an admin view with no delivery
    await t.app.inject({
      method: 'PATCH',
      url: `/v1/me/groups/${groupId}/members/${carol.userId}`,
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { role: 'admin' },
    });
    const history = (await list(carolH, `?group_id=${groupId}&include_group_history=true`)).json();
    expect(history.drops.map((d: { drop_id: string }) => d.drop_id)).toContain(early.drop_id);
    const seen = history.drops.find((d: { drop_id: string }) => d.drop_id === early.drop_id);
    expect(seen.sources).toEqual(['group_admin']);
    expect(seen.deliveries).toEqual([]);
    expect((await read(carolH, early.drop_id)).statusCode).toBe(200);
    // read-only: there is no delivery of hers to mark read
    const mutate = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${early.drop_id}/state`,
      headers: hHeaders(carolH.credential),
      payload: { expected_version: 0, read: true },
    });
    expect(mutate.statusCode).toBe(404);
    // and it stays out of the ordinary inbox
    expect((await list(carolH, `?group_id=${groupId}`)).json().drops).toHaveLength(0);
  });

  it('handles are matched case-insensitively, so one person typed twice is one invitation', async () => {
    const res = await post(`/v1/me/groups/${groupId}/invite`, alice, { handles: ['Bob', 'bob', '@BOB'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().invites).toEqual([{ handle: 'bob', outcome: 'invited' }]);
    expect((await get(`/v1/me/groups/${groupId}`, alice)).json().member_slots_used).toBe(2);
  });

  it('blocks are enforced between invitees, against pending invitations, and again at accept time', async () => {
    const dave = await signUp(t, 'dave');
    await post(`/v1/me/contacts/${carol.userId}/block`, bob, { blocked: true });
    // two people who blocked each other, invited in one batch
    const batch = await post('/v1/me/groups', alice, {
      slug: 'batch-block',
      display_name: '批量',
      binding_h_ids: [aliceH.hId],
      invite_handles: ['bob', 'carol'],
    });
    expect(batch.statusCode).toBe(422);
    expect(batch.json().code).toBe('BLOCKED');
    // bob is only invited (not yet active); carol still cannot be added next to him
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    const second = await post(`/v1/me/groups/${groupId}/invite`, alice, { handles: ['carol'] });
    expect(second.json().code).toBe('BLOCKED');
    // a block placed while an invitation waits stops the accept
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handles: [dave.handle] });
    const daveH = await pair(t, dave, { harness: 'codex' });
    await post(`/v1/me/contacts/${dave.userId}/block`, bob, { blocked: true });
    // whoever accepts first gets in; the other one is then refused
    expect((await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId] })).statusCode).toBe(200);
    const acc = await post(`/v1/me/groups/${groupId}/accept`, dave, { h_ids: [daveH.hId] });
    expect(acc.json().code).toBe('BLOCKED');
  });

  it('two people creating groups that invite each other at the same time both succeed', async () => {
    const results = await Promise.all([
      post('/v1/me/groups', alice, {
        slug: 'cross-a',
        display_name: 'A',
        binding_h_ids: [aliceH.hId],
        invite_handles: ['bob', 'carol'],
      }),
      post('/v1/me/groups', bob, {
        slug: 'cross-b',
        display_name: 'B',
        binding_h_ids: [bobCc.hId],
        invite_handles: ['alice'],
      }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
  });

  it('a join request dies with the member who filed it', async () => {
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId] });
    await t.app.inject({
      method: 'PATCH',
      url: `/v1/me/groups/${groupId}/policy`,
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { member_invite_policy: 'admin_approval' },
    });
    await post(`/v1/me/groups/${groupId}/invite`, bob, { handles: ['carol'] });
    expect((await get(`/v1/me/groups/${groupId}/requests`, alice)).json().join_requests).toHaveLength(1);
    await post(`/v1/me/groups/${groupId}/leave`, bob);
    expect((await get(`/v1/me/groups/${groupId}/requests`, alice)).json().join_requests).toEqual([]);
  });

  it('a revoked endpoint is not reported as receiving, so the binding editor can still save', async () => {
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId] });
    await post(`/v1/me/endpoints/${bobCc.hId}/revoke`, bob);
    const detail = (await get(`/v1/me/groups/${groupId}`, bob)).json();
    // his only chosen agent is gone, so he receives with all of his agents again (ADR 0015)
    expect(detail.my_membership).toMatchObject({ receive_all: true, binding_h_ids: [bobCodex.hId] });
    const fixed = await t.app.inject({
      method: 'PUT',
      url: `/v1/me/groups/${groupId}/bindings`,
      headers: { cookie: bob.cookie, origin: t.origin },
      payload: { h_ids: [...detail.my_membership.binding_h_ids] },
    });
    expect(fixed.statusCode, fixed.body).toBe(200);
  });

  it('with account-wide reads off, admin history reaches only through an endpoint that receives the group', async () => {
    const aliceCc = await pair(t, alice, { harness: 'claude-code' });
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId] });
    const sent = (await send(bobCc, [{ type: 'group', group_id: groupId }], 'group only')).json();
    await t.app.inject({
      method: 'PATCH',
      url: '/v1/me/mailbox-settings',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { cross_h_mailbox_enabled: false },
    });
    expect((await read(aliceCc, sent.drop_id)).statusCode).toBe(404);
    expect(
      (await list(aliceCc, `?group_id=${groupId}&include_group_history=true`)).json().drops ?? [],
    ).toHaveLength(0);
    expect((await read(aliceH, sent.drop_id)).statusCode).toBe(200);
  });

  it('group sends above the endpoint limit are refused as a whole', async () => {
    // the test config caps MAX_GROUP_RECIPIENTS at 3: alice(1) + bob(2) + carol(1) = 4 > 3
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' });
    await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobCc.hId, bobCodex.hId] });
    await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'carol' });
    await post(`/v1/me/groups/${groupId}/accept`, carol, { h_ids: [carolH.hId] });
    const res = await send(aliceH, [{ type: 'group', group_id: groupId }], 'too many');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('TOO_MANY_RECIPIENTS');
    expect((await list(carolH)).json().drops).toHaveLength(0);
  });

  it('receives with all agents by default, including an agent paired after joining', async () => {
    // Created without choosing agents: the whole account receives.
    const created = await post('/v1/me/groups', bob, { slug: 'all-agents', display_name: '全员接收' });
    expect(created.statusCode, created.body).toBe(200);
    const gid = created.json().group_id;
    expect(created.json().my_membership.receive_all).toBe(true);
    expect(new Set(created.json().my_membership.binding_h_ids)).toEqual(new Set([bobCc.hId, bobCodex.hId]));
    // Accepting without choosing agents: the same.
    expect((await post(`/v1/me/groups/${gid}/invite`, bob, { handles: ['alice'] })).statusCode).toBe(200);
    const accepted = await post(`/v1/me/groups/${gid}/accept`, alice, {});
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().my_membership.receive_all).toBe(true);
    expect(accepted.json().my_membership.binding_h_ids).toEqual([aliceH.hId]);
    // This test app caps a send at 3 agents; Alice leaves so Bob's three agents fit.
    expect((await post(`/v1/me/groups/${gid}/leave`, alice)).statusCode).toBe(200);
    // A third agent Bob pairs later joins by itself and receives the next group drop.
    const bobLater = await pair(t, bob, { harness: 'opencode', endpointLabel: '新电脑' });
    const detail = await get(`/v1/me/groups/${gid}?h_id=${bobLater.hId}`, bob);
    expect(detail.json().my_membership.binding_h_ids).toContain(bobLater.hId);
    expect(detail.json().current_h_receives).toBe(true);
    const sent = await send(bobCc, [{ type: 'group', group_id: gid }], 'to everyone');
    expect(sent.statusCode, sent.body).toBe(200);
    // every agent holds a copy; as Bob's own post it shows in the group's view, not in his inbox (ADR 0033)
    for (const ep of [bobCodex, bobLater]) {
      const inGroup = (await list(ep, `?endpoint_scope=current&group_id=${gid}`)).json().drops;
      expect(inGroup.map((d: { title: string }) => d.title)).toContain('to everyone');
      const inbox = (await list(ep, '?endpoint_scope=current')).json().drops;
      expect(inbox.map((d: { title: string }) => d.title)).not.toContain('to everyone');
    }
  });

  it('switching to selected agents stops following new agents; switching back binds all again', async () => {
    const created = await post('/v1/me/groups', bob, { slug: 'pick-mode', display_name: '挑选接收' });
    const gid = created.json().group_id;
    const picked = await t.app.inject({
      method: 'PUT',
      url: `/v1/me/groups/${gid}/bindings`,
      headers: { cookie: bob.cookie, origin: t.origin },
      payload: { h_ids: [bobCc.hId] },
    });
    expect(picked.statusCode, picked.body).toBe(200);
    expect(picked.json().my_membership.receive_all).toBe(false);
    expect(picked.json().my_membership.binding_h_ids).toEqual([bobCc.hId]);
    const bobLater = await pair(t, bob, { harness: 'opencode' });
    expect((await get(`/v1/me/groups/${gid}`, bob)).json().my_membership.binding_h_ids).toEqual([bobCc.hId]);
    const all = await t.app.inject({
      method: 'PUT',
      url: `/v1/me/groups/${gid}/bindings`,
      headers: { cookie: bob.cookie, origin: t.origin },
      payload: { receive_all: true, h_ids: [] },
    });
    expect(all.statusCode, all.body).toBe(200);
    expect(new Set(all.json().my_membership.binding_h_ids)).toEqual(
      new Set([bobCc.hId, bobCodex.hId, bobLater.hId]),
    );
  });

  it('an agent that creates or joins a group over MCP makes the whole account receive', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/groups',
      headers: hHeaders(bobCodex.credential),
      payload: { slug: 'from-agent', display_name: 'Agent 建群' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const gid = res.json().group_id;
    const detail = await get(`/v1/me/groups/${gid}`, bob);
    expect(detail.json().my_membership.receive_all).toBe(true);
    expect(new Set(detail.json().my_membership.binding_h_ids)).toEqual(new Set([bobCc.hId, bobCodex.hId]));
  });
});
