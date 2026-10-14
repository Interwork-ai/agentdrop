import { randomUUID } from 'node:crypto';
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

// "Mark all as read" (ADR 0018): the person's explicit act, through the dashboard (or an H credential).
describe.skipIf(!TEST_DATABASE_URL)('mark all as read', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let carol: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;
  let bobH2: PairedEndpoint;
  let carolH: PairedEndpoint;
  let groupId: string;

  const web = (
    user: BrowserUser,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: user.cookie, origin: t.origin },
      ...(payload === undefined ? {} : { payload }),
    });
  const send = (ep: PairedEndpoint, targets: unknown[], title: string) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(ep.credential),
      payload: {
        request_id: `r-${randomUUID()}`,
        targets,
        payload: {
          payload_version: 1,
          kind: 'text',
          title,
          body: `body ${title}`,
          attachment_ids: [],
          extensions: {},
        },
      },
    });
  const unread = async (ep: PairedEndpoint) => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?view=inbox&unread_only=true&limit=50',
      headers: hHeaders(ep.credential),
    });
    const body = res.json() as { drops: Array<{ title: string }>; unread_count: number };
    return { titles: body.drops.map((d) => d.title).sort(), count: body.unread_count };
  };
  const markAllWeb = (user: BrowserUser, hId: string, body: Record<string, unknown> = {}) =>
    web(user, 'POST', `/v1/me/endpoints/${hId}/drops/mark-read`, body);
  const toBob = { type: 'user', user_id: '' };
  const sendId = async (ep: PairedEndpoint, targets: unknown[], title: string) => {
    const res = await send(ep, targets, title);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { drop_id: string }).drop_id;
  };
  const befriend = async (a: BrowserUser, b: BrowserUser) => {
    await web(a, 'POST', '/v1/me/contacts/invite', { handle: b.handle });
    await web(b, 'POST', `/v1/me/contacts/${a.userId}/accept`, {});
  };

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
    aliceH = await pair(t, alice, { harness: 'codex' });
    bobH = await pair(t, bob, { harness: 'claude-code' });
    bobH2 = await pair(t, bob, { harness: 'codex' });
    carolH = await pair(t, carol, { harness: 'codex' });
    await befriend(alice, bob);
    await befriend(carol, bob);
    await befriend(bob, alice);
    toBob.user_id = bob.userId;
    const g = await web(alice, 'POST', '/v1/me/groups', {
      slug: 'team',
      display_name: 'Team',
      invite_handles: ['bob'],
    });
    groupId = (g.json() as { group_id: string }).group_id;
    await web(bob, 'POST', `/v1/me/groups/${groupId}/accept`, {});
  });

  it("marks every unread inbox drop read for the person, on all of their agents, up to the list's moment", async () => {
    await sendId(aliceH, [toBob], 'a1');
    await sendId(aliceH, [toBob], 'a2');
    await sendId(carolH, [toBob], 'c1');
    await sendId(aliceH, [{ type: 'group', group_id: groupId }], 'g1');
    const fromBob = await sendId(bobH, [{ type: 'user', user_id: alice.userId }], 'b1');
    expect((await unread(bobH)).count).toBe(4);
    const shownAt = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    await sendId(aliceH, [toBob], 'late');

    const res = await markAllWeb(bob, bobH.hId, { up_to: shownAt });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ marked: 4, remaining: 0, unread_count: 1 });
    // one state per person: the other agent sees the same, only what arrived after the list was shown is unread
    expect(await unread(bobH2)).toEqual({ titles: ['late'], count: 1 });
    // nobody else's state moves
    expect((await unread(aliceH)).titles).toEqual(['b1']);
    expect(fromBob).toBeTruthy();
  });

  it("includes the newest drop the list showed when up_to is that drop's own received_at", async () => {
    await sendId(aliceH, [toBob], 'older');
    await sendId(aliceH, [toBob], 'newest');
    const listed = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?view=inbox&limit=50',
      headers: hHeaders(bobH.credential),
    });
    const newest = (listed.json() as { drops: Array<{ title: string; received_at: string }> }).drops[0];
    expect(newest?.title).toBe('newest');
    const res = await markAllWeb(bob, bobH.hId, { up_to: newest?.received_at });
    expect(res.json()).toMatchObject({ marked: 2, remaining: 0, unread_count: 0 });
  });

  it('group_id limits it to drops that reached the person through that group', async () => {
    await sendId(aliceH, [toBob], 'direct');
    await sendId(aliceH, [{ type: 'group', group_id: groupId }], 'group');
    const res = await markAllWeb(bob, bobH.hId, { group_id: groupId });
    expect(res.json()).toMatchObject({ marked: 1, remaining: 0, unread_count: 1 });
    expect((await unread(bobH)).titles).toEqual(['direct']);
  });

  it('leaves archived drops as they are', async () => {
    const id = await sendId(aliceH, [toBob], 'kept for later');
    const detail = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${id}`,
      headers: hHeaders(bobH.credential),
    });
    const version = (detail.json() as { drop: { deliveries: Array<{ state_version: number }> } }).drop
      .deliveries[0]?.state_version;
    const archive = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${id}/state`,
      headers: hHeaders(bobH.credential),
      payload: { expected_version: version, archived: true },
    });
    expect(archive.statusCode, archive.body).toBe(200);
    expect((await markAllWeb(bob, bobH.hId)).json()).toMatchObject({ marked: 0 });
    const after = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${id}`,
      headers: hHeaders(bobH.credential),
    });
    expect(
      (after.json() as { drop: { deliveries: Array<{ read: boolean }> } }).drop.deliveries[0]?.read,
    ).toBe(false);
  });

  it('works with an H credential, changes nothing the second time, and moves the state version', async () => {
    const id = await sendId(aliceH, [toBob], 'once');
    const before = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${id}`,
      headers: hHeaders(bobH.credential),
    });
    const version = (before.json() as { drop: { deliveries: Array<{ state_version: number }> } }).drop
      .deliveries[0]?.state_version;
    const first = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops/mark-read',
      headers: hHeaders(bobH2.credential),
      payload: {},
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ marked: 1, remaining: 0, unread_count: 0 });
    const again = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops/mark-read',
      headers: hHeaders(bobH2.credential),
      payload: {},
    });
    expect(again.json()).toMatchObject({ marked: 0, remaining: 0 });
    // a toggle from a page that still has the old version is refused, as for any concurrent change
    const stale = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${id}/state`,
      headers: hHeaders(bobH.credential),
      payload: { expected_version: version, starred: true },
    });
    expect(stale.json().code).toBe('VERSION_CONFLICT');
  });

  it("refuses another person's endpoint and unknown fields", async () => {
    expect((await markAllWeb(alice, bobH.hId)).statusCode).toBe(404);
    expect((await markAllWeb(bob, bobH.hId, { everything: true })).statusCode).toBe(400);
  });
});
