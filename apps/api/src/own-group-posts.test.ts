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

/**
 * ADR 0033: what a person posts to a group is not a message to them. The inbox (dashboard, H credential, search,
 * unread counts, "mark all as read") leaves out drops they authored that reached their agents only through a group;
 * Sent, the group's timeline, Starred, Archived and a read by id still have them.
 */
describe.skipIf(!TEST_DATABASE_URL)('own group posts stay out of the inbox', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let aliceH: PairedEndpoint;
  let aliceH2: PairedEndpoint;
  let bobH: PairedEndpoint;
  let groupId: string;

  type Listed = {
    drops: Array<{ drop_id: string; title: string; state_version: number }>;
    unread_count: number;
    next_cursor: string | null;
    muted_unread_count?: number;
  };

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
  const send = async (ep: PairedEndpoint, targets: unknown[], title: string) => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(ep.credential),
      payload: {
        request_id: `r-${randomUUID()}`,
        targets,
        payload: { payload_version: 1, kind: 'text', title, body: `body of ${title}` },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe('delivered');
    return (res.json() as { drop_id: string }).drop_id;
  };
  const list = async (ep: PairedEndpoint, query: string): Promise<Listed> => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops?limit=50&${query}`,
      headers: hHeaders(ep.credential),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Listed;
  };
  const titles = (l: Listed) => l.drops.map((d) => d.title).sort();
  const webList = async (user: BrowserUser, hId: string, query: string): Promise<Listed> => {
    const res = await web(user, 'GET', `/v1/me/endpoints/${hId}/drops?limit=50&${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Listed;
  };
  const read = async (ep: PairedEndpoint, dropId: string) =>
    t.app.inject({ method: 'GET', url: `/v1/h/drops/${dropId}`, headers: hHeaders(ep.credential) });
  const setState = async (ep: PairedEndpoint, dropId: string, change: Record<string, boolean>) => {
    const version = (await read(ep, dropId)).json().drop.state_version as number;
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${dropId}/state`,
      headers: hHeaders(ep.credential),
      payload: { expected_version: version, ...change },
    });
    expect(res.statusCode, res.body).toBe(200);
  };
  const pendingUnread = async (ep: PairedEndpoint) =>
    (await t.app.inject({ method: 'GET', url: '/v1/h/identity', headers: hHeaders(ep.credential) })).json()
      .viewer.pending.unread as number;
  const befriend = async (a: BrowserUser, b: BrowserUser) => {
    await web(a, 'POST', '/v1/me/contacts/invite', { handle: b.handle });
    await web(b, 'POST', `/v1/me/contacts/${a.userId}/accept`, {});
  };
  const toGroup = () => ({ type: 'group', group_id: groupId });

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
    aliceH2 = await pair(t, alice, { harness: 'claude-code' });
    bobH = await pair(t, bob, { harness: 'codex' });
    await befriend(alice, bob);
    const g = await web(alice, 'POST', '/v1/me/groups', {
      slug: 'lab',
      display_name: 'Lab',
      invite_handles: ['bob'],
    });
    expect(g.statusCode, g.body).toBe(200);
    groupId = (g.json() as { group_id: string }).group_id;
    expect((await web(bob, 'POST', `/v1/me/groups/${groupId}/accept`, {})).statusCode).toBe(200);
  });

  it('leaves my own group post out of every inbox list, but keeps it in Sent, the group and a read by id', async () => {
    const theirs = await send(bobH, [toGroup()], 'ablation results from Bob');
    const mine = await send(aliceH, [toGroup()], 'ablation plan from Alice');

    // the inbox of every agent of mine, account-wide and narrowed to one agent
    for (const ep of [aliceH, aliceH2]) {
      expect(titles(await list(ep, 'view=inbox'))).toEqual(['ablation results from Bob']);
      expect(titles(await list(ep, 'view=inbox&endpoint_scope=current'))).toEqual([
        'ablation results from Bob',
      ]);
    }
    // the dashboard's inbox is the same list
    expect(titles(await webList(alice, aliceH.hId, 'view=inbox'))).toEqual(['ablation results from Bob']);
    // search in the inbox (H credential and dashboard): only what others sent me
    expect(titles(await list(aliceH, `view=inbox&query=${encodeURIComponent('ablation')}`))).toEqual([
      'ablation results from Bob',
    ]);
    expect(titles(await list(aliceH, `view=inbox&query=${encodeURIComponent('plan from Alice')}`))).toEqual(
      [],
    );
    expect(titles(await webList(alice, aliceH.hId, 'view=inbox&query=ablation'))).toEqual([
      'ablation results from Bob',
    ]);

    // Sent and a search of Sent have it
    expect(titles(await list(aliceH, 'view=sent'))).toEqual(['ablation plan from Alice']);
    expect(titles(await list(aliceH, 'view=sent&query=plan'))).toEqual(['ablation plan from Alice']);
    // the group's timeline lists both, in the dashboard and through the agent
    expect(titles(await list(aliceH, `view=inbox&group_id=${groupId}`))).toEqual([
      'ablation plan from Alice',
      'ablation results from Bob',
    ]);
    expect(titles(await webList(alice, aliceH.hId, `view=inbox&group_id=${groupId}`))).toEqual([
      'ablation plan from Alice',
      'ablation results from Bob',
    ]);
    // authorization is unchanged: readable by id from every agent of mine
    for (const ep of [aliceH, aliceH2]) {
      const res = await read(ep, mine);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().drop.title).toBe('ablation plan from Alice');
    }
    // someone else's group post is in my inbox, and mine is in theirs
    expect(titles(await list(bobH, 'view=inbox'))).toEqual(['ablation plan from Alice']);
    expect(theirs).toBeTruthy();
  });

  it('never counts my own group post as unread, even marked unread; mark all as read follows what each list shows', async () => {
    const mine = await send(aliceH, [toGroup()], 'my post');
    const theirs = await send(bobH, [toGroup()], 'their post');
    expect((await list(aliceH, 'view=inbox&unread_only=true')).unread_count).toBe(1);

    // the person marks their own post unread on purpose: the group shows it so, the inbox still does not count it
    await setState(aliceH, mine, { read: false });
    const unreadInbox = await list(aliceH, 'view=inbox&unread_only=true');
    expect(titles(unreadInbox)).toEqual(['their post']);
    expect(unreadInbox.unread_count).toBe(1);
    expect(unreadInbox.muted_unread_count).toBe(0);
    expect(await pendingUnread(aliceH)).toBe(1);
    expect(await pendingUnread(aliceH2)).toBe(1);
    expect(titles(await list(aliceH, `view=inbox&group_id=${groupId}&unread_only=true`))).toEqual([
      'my post',
      'their post',
    ]);

    // "Mark all as read" in the inbox marks what the inbox showed, and not my own post
    const all = await web(alice, 'POST', `/v1/me/endpoints/${aliceH.hId}/drops/mark-read`, {});
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json()).toMatchObject({ marked: 1, remaining: 0, unread_count: 0 });
    expect(titles(await list(aliceH, `view=inbox&group_id=${groupId}&unread_only=true`))).toEqual([
      'my post',
    ]);
    // "Mark this group read" covers everything the group's view showed, my post included
    const group = await web(alice, 'POST', `/v1/me/endpoints/${aliceH.hId}/drops/mark-read`, {
      group_id: groupId,
    });
    expect(group.json()).toMatchObject({ marked: 1, remaining: 0, unread_count: 0 });
    expect(titles(await list(aliceH, `view=inbox&group_id=${groupId}&unread_only=true`))).toEqual([]);
    expect(theirs).toBeTruthy();
  });

  it('keeps what I starred or archived in Starred and Archived', async () => {
    const mine = await send(aliceH, [toGroup()], 'kept post');
    await setState(aliceH, mine, { starred: true });
    expect(titles(await list(aliceH, 'view=starred'))).toEqual(['kept post']);
    expect(titles(await list(aliceH2, 'view=starred&endpoint_scope=current'))).toEqual(['kept post']);
    await setState(aliceH, mine, { archived: true });
    expect(titles(await list(aliceH, 'view=archived'))).toEqual(['kept post']);
    expect(titles(await list(aliceH, 'view=inbox'))).toEqual([]);
  });

  it('keeps a drop I also addressed to myself directly, and leaves My space as it was', async () => {
    // a group post that is also a handoff to me (ADR 0015): it reached my agents directly, so it is a message to me
    await send(aliceH, [toGroup(), { type: 'user', user_id: alice.userId }], 'post and handoff');
    const inbox = await list(aliceH2, 'view=inbox');
    expect(titles(inbox)).toEqual(['post and handoff']);
    expect(inbox.unread_count).toBe(1);

    // My space (ADR 0030): never in the inbox, listed in view space as before
    await send(aliceH, [{ type: 'self' }], 'note to self');
    expect(titles(await list(aliceH, 'view=inbox'))).toEqual(['post and handoff']);
    expect(titles(await list(aliceH, 'view=space'))).toEqual(['note to self']);
  });

  it('applies when account-wide reads are off', async () => {
    const off = await web(alice, 'PATCH', '/v1/me/mailbox-settings', { cross_h_mailbox_enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    await send(aliceH, [toGroup()], 'mine again');
    await send(bobH, [toGroup()], 'bob again');
    expect(titles(await list(aliceH2, 'view=inbox'))).toEqual(['bob again']);
    expect((await list(aliceH2, 'view=inbox')).unread_count).toBe(1);
  });
});
