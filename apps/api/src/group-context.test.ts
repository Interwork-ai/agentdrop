import { randomUUID } from 'node:crypto';
import { defaultGroupName } from '@agentdrop/domain';
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
  console.warn('[group-context.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

it('names a group after its creator and how many were invited, within the length cap', () => {
  expect(defaultGroupName('Alice', 0)).toBe('Alice');
  expect(defaultGroupName('Alice', 2)).toBe('Alice +2');
  expect(defaultGroupName('王同学', 1)).toBe('王同学 +1');
  // a very long nickname is shortened; the count is always kept
  const long = defaultGroupName('一'.repeat(40), 12);
  expect(long).toBe(`${'一'.repeat(27)}… +12`);
  expect(Array.from(long).length).toBe(32);
  expect(Array.from(defaultGroupName('x'.repeat(40), 0)).length).toBe(32);
});

describeDb('group context for people and agents', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let carol: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;
  let carolH: PairedEndpoint;

  const get = (url: string, user: BrowserUser) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: user.cookie } });
  const post = (url: string, user: BrowserUser, payload?: unknown) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: user.cookie, origin: t.origin },
      ...(payload ? { payload } : {}),
    });
  const hGet = (url: string, h: PairedEndpoint, userAgent?: string) =>
    t.app.inject({
      method: 'GET',
      url,
      headers: { ...hHeaders(h.credential), ...(userAgent ? { 'user-agent': userAgent } : {}) },
    });
  async function befriend(a: BrowserUser, b: BrowserUser) {
    expect((await post('/v1/me/contacts/invite', a, { handle: b.handle })).statusCode).toBe(200);
    expect((await post(`/v1/me/contacts/${a.userId}/accept`, b)).statusCode).toBe(200);
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
    bob = await signUp(t, 'bob', '王同学');
    carol = await signUp(t, 'carol', 'Carol');
    aliceH = await pair(t, alice, { harness: 'codex' });
    bobH = await pair(t, bob, { harness: 'codex' });
    carolH = await pair(t, carol, { harness: 'codex' });
    await befriend(alice, bob);
    await befriend(alice, carol);
  });

  it('a group created without a name or slug is named after its creator, from the dashboard and from an agent', async () => {
    const web = await post('/v1/me/groups', alice, { invite_handles: ['bob', 'carol'] });
    expect(web.statusCode, web.body).toBe(200);
    // invitees are counted, never named: they have not agreed to be in it
    expect(web.json()).toMatchObject({ display_name: 'Alice +2', slug: 'alice' });
    expect(web.json().display_name).not.toContain('王同学');
    // the creator's handle again: the slug stays readable and gets a suffix
    const again = await post('/v1/me/groups', alice, { invite_handles: ['bob', 'carol'] });
    expect(again.json().slug).toMatch(/^alice-[0-9a-f]{6}$/);

    const agent = await t.app.inject({
      method: 'POST',
      url: '/v1/h/groups',
      headers: hHeaders(aliceH.credential),
      payload: { invite_handles: ['bob'] },
    });
    expect(agent.statusCode, agent.body).toBe(200);
    expect(agent.json()).toMatchObject({ display_name: 'Alice +1' });
    expect(agent.json().slug).toMatch(/^alice-[0-9a-f]{6}$/);
    const alone = await post('/v1/me/groups', bob, {});
    expect(alone.json()).toMatchObject({ display_name: '王同学', slug: 'bob' });

    // the name does not follow later joins
    expect(
      (await post(`/v1/me/groups/${web.json().group_id}/accept`, bob, { h_ids: [bobH.hId] })).statusCode,
    ).toBe(200);
    expect((await get(`/v1/me/groups/${web.json().group_id}`, alice)).json().display_name).toBe('Alice +2');

    // a name the user chose is kept as given
    const named = await post('/v1/me/groups', alice, { slug: 'paper', display_name: '论文讨论组' });
    expect(named.json()).toMatchObject({ display_name: '论文讨论组', slug: 'paper' });
  });

  it('concurrent creation of one slug never fails as an internal error', async () => {
    const explicit = await Promise.all(
      [alice, carol].map((u) => post('/v1/me/groups', u, { slug: 'race', display_name: 'Race' })),
    );
    expect(explicit.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    const loser = explicit.find((r) => r.statusCode === 400);
    expect(loser?.json()).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'slug' } });

    const derived = await Promise.all([1, 2, 3].map(() => post('/v1/me/groups', alice, {})));
    expect(derived.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(new Set(derived.map((r) => r.json().slug)).size).toBe(3);
  });

  it('owners and admins change the slug; members cannot, and a taken or invalid slug is refused', async () => {
    const created = await post('/v1/me/groups', alice, {
      slug: 'core',
      display_name: 'Core',
      invite_handles: ['bob'],
    });
    const groupId = created.json().group_id;
    expect((await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobH.hId] })).statusCode).toBe(200);
    await post('/v1/me/groups', carol, { slug: 'taken', display_name: 'Taken' });
    const rename = (user: BrowserUser, payload: Record<string, unknown>) =>
      t.app.inject({
        method: 'PATCH',
        url: `/v1/me/groups/${groupId}`,
        headers: { cookie: user.cookie, origin: t.origin },
        payload,
      });

    const bobRevision = (await get('/v1/me', bob)).json().directory_revision;
    const ok = await rename(alice, { slug: 'Core-Team' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().slug).toBe('core-team');
    expect((await get('/v1/me', bob)).json().directory_revision).toBeGreaterThan(bobRevision);
    const card = (await hGet('/v1/h/directory?kind=group', bobH)).json().entries[0];
    expect(card.slug).toBe('core-team');

    const byMember = await rename(bob, { slug: 'mine' });
    expect(byMember.statusCode).toBe(403);
    const taken = await rename(alice, { slug: 'taken' });
    expect(taken.statusCode).toBe(400);
    expect(taken.json()).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'slug' } });
    const invalid = await rename(alice, { slug: '-no spaces' });
    expect(invalid.json()).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'slug' } });
    // keeping its own slug is not a clash
    expect((await rename(alice, { slug: 'core-team', display_name: 'Core team' })).statusCode).toBe(200);
  });

  it('agents see who is in a group and which group a drop came through', async () => {
    const created = await post('/v1/me/groups', alice, {
      slug: 'core',
      display_name: 'Core team',
      invite_handles: ['bob', 'carol'],
    });
    const groupId = created.json().group_id;
    expect((await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobH.hId] })).statusCode).toBe(200);

    // bob (active) sees the roster; carol (still invited) does not see the group at all
    const dir = (await hGet('/v1/h/directory?kind=group', bobH)).json();
    const card = dir.entries.find((e: { kind: string; slug?: string }) => e.slug === 'core');
    expect(card.active_members).toEqual([
      expect.objectContaining({ handle: 'alice', display_label: 'Alice', role: 'owner' }),
      expect.objectContaining({ handle: 'bob', display_label: '王同学', role: 'member' }),
    ]);
    expect((await hGet('/v1/h/directory?kind=group', carolH)).json().entries).toEqual([]);

    const send = (targets: unknown[], title: string) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/h/drops',
        headers: hHeaders(aliceH.credential),
        payload: {
          request_id: `req-${randomUUID()}`,
          targets,
          payload: { payload_version: 1, kind: 'text', title, body: 'x', attachment_ids: [], extensions: {} },
        },
      });
    expect((await send([{ type: 'group', group_id: groupId }], 'to the group')).statusCode).toBe(200);
    expect((await send([{ type: 'user', user_id: bob.userId }], 'to bob')).statusCode).toBe(200);

    const inbox = (await hGet('/v1/h/drops', bobH)).json().drops as Array<{
      title: string;
      sources: string[];
      group_labels: unknown[];
    }>;
    const viaGroup = inbox.find((d) => d.title === 'to the group');
    expect(viaGroup?.sources).toEqual(['group']);
    expect(viaGroup?.group_labels).toEqual([{ group_id: groupId, display_name: 'Core team', slug: 'core' }]);
    const direct = inbox.find((d) => d.title === 'to bob');
    expect(direct?.sources).toEqual(['direct']);
    expect(direct?.group_labels).toEqual([]);
    const dropId = (viaGroup as unknown as { drop_id: string }).drop_id;
    expect((await hGet(`/v1/h/drops/${dropId}`, bobH)).json().drop.group_labels).toEqual([
      { group_id: groupId, display_name: 'Core team', slug: 'core' },
    ]);
    // the dashboard reads the same fields
    const web = await get(`/v1/me/endpoints/${bobH.hId}/drops`, bob);
    expect(web.json().drops.some((d: { group_labels?: unknown[] }) => d.group_labels?.length === 1)).toBe(
      true,
    );

    // bridges before 0.4.11 would hand these fields to a strict client that rejects them
    const old = 'agentdrop-bridge/0.4.10 (test)';
    expect((await hGet('/v1/h/drops', bobH, old)).body).not.toContain('group_labels');
    expect((await hGet('/v1/h/directory?kind=group', bobH, old)).body).not.toContain('active_members');
  });
  it('a group drop can call on members by @handle; only they are told, and only members can be named', async () => {
    const created = await post('/v1/me/groups', alice, { slug: 'core', invite_handles: ['bob', 'carol'] });
    const groupId = created.json().group_id;
    for (const [u, h] of [
      [bob, bobH],
      [carol, carolH],
    ] as const)
      expect((await post(`/v1/me/groups/${groupId}/accept`, u, { h_ids: [h.hId] })).statusCode).toBe(200);
    const send = (targets: unknown[], mentions: string[]) =>
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
            title: 'please review',
            body: 'x',
            attachment_ids: [],
            extensions: {},
            mentions,
          },
        },
      });
    const group = [{ type: 'group', group_id: groupId }];
    const ok = await send(group, ['@Bob']);
    expect(ok.statusCode, ok.body).toBe(200);

    const bobInbox = (await hGet('/v1/h/drops', bobH)).json().drops;
    expect(bobInbox[0]).toMatchObject({
      mentioned_me: true,
      mentions: [{ handle: 'bob', display_label: '王同学' }],
    });
    const carolInbox = (await hGet('/v1/h/drops', carolH)).json().drops;
    expect(carolInbox[0]).toMatchObject({ mentioned_me: false, mentions: [{ handle: 'bob' }] });
    // the author sees whom they called on too
    const sent = (await hGet('/v1/h/drops?view=sent', aliceH)).json().drops;
    expect(sent[0].mentions).toEqual([{ handle: 'bob', display_label: '王同学' }]);

    // a stranger to the group, or a mention without any group target, is refused and nothing is sent
    const dave = await signUp(t, 'dave', 'Dave');
    await pair(t, dave, { harness: 'codex' });
    const outsider = await send(group, ['dave']);
    expect(outsider.statusCode).toBe(400);
    expect(outsider.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'mentions', handle: 'dave' },
    });
    const direct = await send([{ type: 'user', user_id: bob.userId }], ['bob']);
    expect(direct.json()).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'mentions' } });
    // beside another target the mentions would reach people outside the group: refused, nothing sent
    const mixed = await send([...group, { type: 'user', user_id: bob.userId }], ['bob']);
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json()).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'mentions' } });
    expect((await hGet('/v1/h/drops', bobH)).json().drops).toHaveLength(1);
    // older bridges never see the new fields
    expect((await hGet('/v1/h/drops', bobH, 'agentdrop-bridge/0.4.10 (test)')).body).not.toMatch(/mention/);
  });
});
