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
  console.warn('[agent-lifecycle.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

/** ADR 0015: losing agents never leaves a person unreachable or a group unable to send. */
describeDb('when agents are removed', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let carol: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;
  let carolH: PairedEndpoint;

  const get = (url: string, u: BrowserUser) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: u.cookie } });
  const call = (method: 'POST' | 'PUT' | 'PATCH', url: string, u: BrowserUser, payload?: unknown) =>
    t.app.inject({ method, url, headers: { cookie: u.cookie, origin: t.origin }, payload: payload ?? {} });
  const post = (url: string, u: BrowserUser, payload?: unknown) => call('POST', url, u, payload);
  const send = (from: PairedEndpoint, targets: unknown[], title: string) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(from.credential),
      payload: {
        request_id: `req-${randomUUID()}`,
        targets,
        payload: { payload_version: 1, kind: 'text', title, body: 'x', attachment_ids: [], extensions: {} },
      },
    });
  const inbox = async (h: PairedEndpoint, query = '') =>
    (
      await t.app.inject({ method: 'GET', url: `/v1/h/drops${query}`, headers: hHeaders(h.credential) })
    ).json();
  async function befriend(a: BrowserUser, b: BrowserUser) {
    expect((await post('/v1/me/contacts/invite', a, { handle: b.handle })).statusCode).toBe(200);
    expect((await post(`/v1/me/contacts/${a.userId}/accept`, b)).statusCode).toBe(200);
  }
  async function groupOf(owner: BrowserUser, members: Array<[BrowserUser, PairedEndpoint]>) {
    const created = await post('/v1/me/groups', owner, {
      slug: `g${randomUUID().slice(0, 8)}`,
      display_name: 'Core',
      invite_handles: members.map(([u]) => u.handle),
    });
    expect(created.statusCode, created.body).toBe(200);
    const groupId = created.json().group_id as string;
    for (const [u] of members)
      expect((await post(`/v1/me/groups/${groupId}/accept`, u, {})).statusCode).toBe(200);
    return groupId;
  }

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
    carol = await signUp(t, 'carol', 'Carol');
    aliceH = await pair(t, alice);
    bobH = await pair(t, bob);
    carolH = await pair(t, carol);
    await befriend(alice, bob);
    await befriend(alice, carol);
  });

  it('an owner who removes their last agent leaves their groups; ownership passes on and the group keeps working', async () => {
    const groupId = await groupOf(alice, [
      [bob, bobH],
      [carol, carolH],
    ]);
    // carol is an admin, so she is next in line ahead of bob
    expect(
      (await call('PATCH', `/v1/me/groups/${groupId}/members/${carol.userId}`, alice, { role: 'admin' }))
        .statusCode,
    ).toBe(200);
    expect((await post(`/v1/me/endpoints/${aliceH.hId}/revoke`, alice)).statusCode).toBe(200);

    const detail = (await get(`/v1/me/groups/${groupId}`, carol)).json();
    expect(detail.owner_user_id).toBe(carol.userId);
    expect(detail.members.map((m: { handle: string; role: string }) => [m.handle, m.role])).toEqual(
      expect.arrayContaining([
        ['carol', 'owner'],
        ['bob', 'member'],
      ]),
    );
    expect(detail.members.some((m: { handle: string }) => m.handle === 'alice')).toBe(false);
    // nobody is left who cannot receive, so the group still sends
    const res = await send(bobH, [{ type: 'group', group_id: groupId }], 'still works');
    expect(res.statusCode, res.body).toBe(200);
    // alice is out of the group: not in her group list any more
    expect(
      (await get('/v1/me/groups', alice))
        .json()
        .groups.some((g: { group_id: string }) => g.group_id === groupId),
    ).toBe(false);
  });

  it('a sole owner who removes their last agent leaves a group with nobody in it, and nobody can be let in', async () => {
    const solo = await post('/v1/me/groups', alice, {
      slug: 'solo',
      display_name: 'Solo',
      invite_handles: ['bob'],
    });
    expect(solo.statusCode).toBe(200);
    expect((await post(`/v1/me/endpoints/${aliceH.hId}/revoke`, alice)).statusCode).toBe(200);
    expect((await get('/v1/me/groups', alice)).json().groups).toEqual([]);
    // the open invitation went with the last person able to run the group
    expect((await get('/v1/me/groups', bob)).json().groups).toEqual([]);
  });

  it("an operator removing someone's last agent has the same effect as the person doing it", async () => {
    const groupId = await groupOf(alice, [[bob, bobH]]);
    await t.db.drizzle.execute(sql`update app_users set is_admin = true where id = ${carol.userId}`);
    expect((await post(`/v1/admin/endpoints/${aliceH.hId}/revoke`, carol)).statusCode).toBe(200);
    expect((await get(`/v1/me/groups/${groupId}`, bob)).json().owner_user_id).toBe(bob.userId);
    expect((await send(bobH, [{ type: 'group', group_id: groupId }], 'still works')).statusCode).toBe(200);
  });

  it('a member whose chosen agents are all gone receives with all of their agents again', async () => {
    const bobLaptop = await pair(t, bob, { harness: 'claude-code', makeDefault: false });
    const groupId = await groupOf(alice, [[carol, carolH]]);
    expect((await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: 'bob' })).statusCode).toBe(200);
    expect(
      (await post(`/v1/me/groups/${groupId}/accept`, bob, { receive_all: false, h_ids: [bobH.hId] }))
        .statusCode,
    ).toBe(200);
    // an explicit empty selection is refused: it would stop every group send
    const empty = await call('PUT', `/v1/me/groups/${groupId}/bindings`, bob, { h_ids: [] });
    expect(empty.statusCode).toBe(400);

    expect((await post(`/v1/me/endpoints/${bobH.hId}/revoke`, bob)).statusCode).toBe(200);
    const mine = (await get(`/v1/me/groups/${groupId}`, bob)).json().my_membership;
    expect(mine).toMatchObject({ receive_all: true, binding_h_ids: [bobLaptop.hId] });
    expect(
      (await send(aliceH, [{ type: 'group', group_id: groupId }], 'reaches the laptop')).statusCode,
    ).toBe(200);
    expect((await inbox(bobLaptop)).drops.map((d: { title: string }) => d.title)).toContain(
      'reaches the laptop',
    );
  });

  it('removing the one agent chosen for plain sends makes plain sends reach the remaining agents', async () => {
    const bobLaptop = await pair(t, bob, { harness: 'claude-code', makeDefault: false });
    expect((await post('/v1/me/default-endpoint', bob, { h_id: bobH.hId })).statusCode).toBe(200);
    expect((await get('/v1/me', bob)).json().direct_receive_all).toBe(false);
    expect((await post(`/v1/me/endpoints/${bobH.hId}/revoke`, bob)).statusCode).toBe(200);
    expect((await get('/v1/me', bob)).json().direct_receive_all).toBe(true);
    const res = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'to bob');
    expect(res.statusCode, res.body).toBe(200);
    expect((await inbox(bobLaptop)).drops.map((d: { title: string }) => d.title)).toEqual(['to bob']);
  });

  it('my own copy of a group drop is already read; a drop to myself stays unread; muted groups are marked', async () => {
    const groupId = await groupOf(alice, [[bob, bobH]]);
    expect((await send(aliceH, [{ type: 'group', group_id: groupId }], 'mine')).statusCode).toBe(200);
    const own = await inbox(aliceH);
    expect(own.unread_count).toBe(0);
    // what I posted is not in my inbox (ADR 0033); the group's own view has it, already read
    expect(own.drops).toEqual([]);
    expect((await inbox(aliceH, `?group_id=${groupId}`)).drops[0]).toMatchObject({
      title: 'mine',
      read: true,
    });
    // a handoff to another agent of mine is meant to be picked up
    const aliceLaptop = await pair(t, alice, { harness: 'claude-code', makeDefault: false });
    expect((await send(aliceH, [{ type: 'user', user_id: alice.userId }], 'note to self')).statusCode).toBe(
      200,
    );
    expect(
      (await inbox(aliceLaptop, '?unread_only=true')).drops.map((d: { title: string }) => d.title),
    ).toEqual(['note to self']);

    expect((await call('PATCH', `/v1/me/groups/${groupId}/me`, bob, { muted: true })).statusCode).toBe(200);
    expect((await send(aliceH, [{ type: 'group', group_id: groupId }], 'quiet')).statusCode).toBe(200);
    expect((await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'direct')).statusCode).toBe(200);
    const bobs = (await inbox(bobH)).drops as Array<{ title: string; muted?: boolean; read: boolean }>;
    expect(bobs.find((d) => d.title === 'quiet')).toMatchObject({ muted: true, read: false });
    expect(bobs.find((d) => d.title === 'direct')?.muted).toBe(false);
  });

  it('the unread inbox says how many of its unread drops stay quiet: muted groups that do not mention the person', async () => {
    const quietGroup = await groupOf(alice, [[bob, bobH]]);
    const loudGroup = await groupOf(alice, [[bob, bobH]]);
    expect((await call('PATCH', `/v1/me/groups/${quietGroup}/me`, bob, { muted: true })).statusCode).toBe(
      200,
    );
    const sendWith = (targets: unknown[], title: string, mentions?: string[]) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/h/drops',
        headers: hHeaders(aliceH.credential),
        payload: {
          request_id: `req-${randomUUID()}`,
          targets,
          payload: {
            payload_version: 1,
            kind: 'text',
            title,
            body: 'x',
            attachment_ids: [],
            extensions: {},
            ...(mentions ? { mentions } : {}),
          },
        },
      });
    for (const [targets, title, mentions] of [
      [[{ type: 'group', group_id: quietGroup }], 'quiet 1'],
      [[{ type: 'group', group_id: quietGroup }], 'quiet 2'],
      [[{ type: 'group', group_id: quietGroup }], 'calls on bob', [bob.handle]],
      [[{ type: 'group', group_id: loudGroup }], 'loud group'],
      [[{ type: 'user', user_id: bob.userId }], 'direct'],
      // sent to the muted group and to him directly: the direct copy is not quiet
      [
        [
          { type: 'group', group_id: quietGroup },
          { type: 'user', user_id: bob.userId },
        ],
        'both',
      ],
    ] as Array<[unknown[], string, string[]?]>) {
      const res = await sendWith(targets, title, mentions);
      expect(res.statusCode, res.body).toBe(200);
    }
    const unread = await inbox(bobH, '?unread_only=true');
    expect(unread.unread_count).toBe(6);
    expect(unread.muted_unread_count).toBe(2);
    // the same rule as the per-drop `muted` and `mentioned_me` flags
    const quietByFlags = (unread.drops as Array<{ muted?: boolean; mentioned_me?: boolean }>).filter(
      (d) => d.muted === true && d.mentioned_me !== true,
    ).length;
    expect(quietByFlags).toBe(2);
    // once read, a quiet drop no longer counts
    const quiet1 = (unread.drops as Array<{ drop_id: string; title: string; state_version: number }>).find(
      (d) => d.title === 'quiet 1',
    );
    const marked = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${quiet1?.drop_id}/state`,
      headers: hHeaders(bobH.credential),
      payload: { expected_version: quiet1?.state_version ?? 0, read: true },
    });
    expect(marked.statusCode, marked.body).toBe(200);
    expect((await inbox(bobH, '?unread_only=true')).muted_unread_count).toBe(1);
    // only the unread inbox carries it
    expect((await inbox(bobH)).muted_unread_count).toBeUndefined();
    expect(
      (await inbox(bobH, `?unread_only=true&group_id=${quietGroup}`)).muted_unread_count,
    ).toBeUndefined();
  });
});
