import { randomUUID } from 'node:crypto';
import { auditEvents, deliveries, harnessEndpoints } from '@agentdrop/db';
import { and, eq, inArray } from 'drizzle-orm';
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
  console.warn('[group-history.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

interface Summary {
  drop_id: string;
  title: string;
  sources: string[];
  deliveries: unknown[];
  read: boolean;
  origin_agent: unknown;
  recipients: unknown[];
  reply_to: { drop_id: string; title: string; mine?: boolean } | null;
  author: { handle: string; public_name: string | null; public_email: string | null };
}

/**
 * ADR 0022: the owner decides whether members who join later can read the group's earlier messages. Off by
 * default; on, every active member reads the whole group history read-only through the one authorization
 * predicate (`group_history`), in lists, detail, attachments, search and export.
 */
describeDb('group history visible to members (ADR 0022)', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let carol: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;
  let carolH: PairedEndpoint;
  let groupId: string;

  const post = (url: string, user: BrowserUser, payload?: unknown) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: user.cookie, origin: t.origin },
      ...(payload ? { payload } : {}),
    });
  const patch = (url: string, user: BrowserUser, payload: object) =>
    t.app.inject({ method: 'PATCH', url, headers: { cookie: user.cookie, origin: t.origin }, payload });
  const get = (url: string, user: BrowserUser) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: user.cookie } });
  const setHistory = (user: BrowserUser, on: boolean, gid = groupId) =>
    patch(`/v1/me/groups/${gid}/policy`, user, { history_visible: on });
  const list = (ep: PairedEndpoint, q = '', headers: Record<string, string> = {}) =>
    t.app.inject({
      method: 'GET',
      url: `/v1/h/drops${q}`,
      headers: { ...hHeaders(ep.credential), ...headers },
    });
  const titles = async (ep: PairedEndpoint, q = '') =>
    (((await list(ep, q)).json().drops ?? []) as Summary[]).map((d) => d.title);
  const read = (ep: PairedEndpoint, dropId: string) =>
    t.app.inject({ method: 'GET', url: `/v1/h/drops/${dropId}`, headers: hHeaders(ep.credential) });
  const download = (ep: PairedEndpoint, dropId: string, attachmentId: string) =>
    t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}/attachments/${attachmentId}`,
      headers: hHeaders(ep.credential),
    });
  const exportGroup = (ep: PairedEndpoint, gid = groupId) =>
    t.app.inject({
      method: 'GET',
      url: `/v1/h/export?${new URLSearchParams({
        scope: 'group',
        group_id: gid,
        since: new Date(Date.now() - 86_400_000).toISOString(),
        until: new Date(Date.now() + 86_400_000).toISOString(),
        include_body: 'true',
      })}`,
      headers: hHeaders(ep.credential),
    });
  const exportLines = (body: string) =>
    body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  async function send(
    ep: PairedEndpoint,
    targets: unknown[],
    title: string,
    extra: { attachment_ids?: string[]; reply_to?: string } = {},
  ) {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(ep.credential),
      payload: {
        request_id: `req-${randomUUID()}`,
        targets,
        payload: {
          payload_version: 1,
          kind: 'text',
          title,
          body: `body of ${title}`,
          attachment_ids: extra.attachment_ids ?? [],
          extensions: {},
          ...(extra.reply_to ? { reply_to: extra.reply_to } : {}),
        },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().drop_id as string;
  }
  const toGroup = (gid = groupId) => [{ type: 'group', group_id: gid }];

  async function upload(ep: PairedEndpoint, name: string, bytes: Buffer) {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(ep.credential),
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'x-agentdrop-filename': encodeURIComponent(name),
      },
      payload: bytes,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().attachment_id as string;
  }

  async function join(user: BrowserUser, ep: PairedEndpoint, gid = groupId, inviter = alice) {
    expect((await post(`/v1/me/groups/${gid}/invite`, inviter, { handles: [user.handle] })).statusCode).toBe(
      200,
    );
    const acc = await post(`/v1/me/groups/${gid}/accept`, user, { h_ids: [ep.hId] });
    expect(acc.statusCode, acc.body).toBe(200);
  }

  async function auditActions(userId: string): Promise<string[]> {
    const rows = await t.db.drizzle
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, userId));
    return rows.map((r) => r.action);
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
    aliceH = await pair(t, alice, { harness: 'codex' });
    bobH = await pair(t, bob, { harness: 'codex' });
    carolH = await pair(t, carol, { harness: 'codex' });
    const created = await post('/v1/me/groups', alice, {
      slug: 'lab',
      display_name: 'Lab',
      binding_h_ids: [aliceH.hId],
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().history_visible).toBe(false);
    groupId = created.json().group_id;
    await join(bob, bobH);
  });

  it('is off by default: a late member cannot list, read, download or find what came before', async () => {
    const fileId = await upload(aliceH, 'notes.txt', Buffer.from('early notes'));
    const early = await send(aliceH, toGroup(), 'early plan', { attachment_ids: [fileId] });
    await join(carol, carolH);
    const after = await send(aliceH, toGroup(), 'after carol');

    expect((await get(`/v1/me/groups/${groupId}`, carol)).json().history_visible).toBe(false);
    expect(await titles(carolH, `?group_id=${groupId}`)).toEqual(['after carol']);
    expect(await titles(carolH, `?group_id=${groupId}&query=early`)).toEqual([]);
    expect(await titles(carolH, '?query=early')).toEqual([]);
    expect((await read(carolH, early)).statusCode).toBe(404);
    expect((await download(carolH, early, fileId)).statusCode).toBe(404);
    // a plain member cannot ask for the admin's view either
    expect(await titles(carolH, `?group_id=${groupId}&include_group_history=true`)).toEqual(['after carol']);
    const exported = exportLines((await exportGroup(carolH)).body);
    expect(exported[0]).toMatchObject({ include_group_history: false, count: 1 });
    expect(exported.filter((r) => r.record === 'drop').map((r) => r.drop_id)).toEqual([after]);
  });

  it('only the owner changes it; admins and members are refused and nothing changes', async () => {
    await join(carol, carolH);
    expect(
      (await patch(`/v1/me/groups/${groupId}/members/${bob.userId}`, alice, { role: 'admin' })).statusCode,
    ).toBe(200);
    for (const who of [bob, carol]) {
      const res = await setHistory(who, true);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('FORBIDDEN');
    }
    // an admin changing the invite policy together with it is refused as a whole
    const both = await patch(`/v1/me/groups/${groupId}/policy`, bob, {
      member_invite_policy: 'admin_approval',
      history_visible: true,
    });
    expect(both.statusCode).toBe(403);
    expect((await get(`/v1/me/groups/${groupId}`, alice)).json()).toMatchObject({
      history_visible: false,
      invite_policy: 'open',
    });
    // a stranger learns nothing about the group
    const dave = await signUp(t, 'dave');
    expect((await setHistory(dave, true)).statusCode).toBe(404);
    // an empty body is a validation error, not a no-op success
    expect((await patch(`/v1/me/groups/${groupId}/policy`, alice, {})).statusCode).toBe(400);

    const on = await setHistory(alice, true);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().history_visible).toBe(true);
    // every member sees the setting, read-only for them
    expect((await get(`/v1/me/groups/${groupId}`, carol)).json().history_visible).toBe(true);
    expect(await auditActions(alice.userId)).toContain('group.history_visible');
    // the invite policy still works on its own for an admin
    expect(
      (await patch(`/v1/me/groups/${groupId}/policy`, bob, { member_invite_policy: 'admin_approval' }))
        .statusCode,
    ).toBe(200);
  });

  it('on: a late member lists, reads, downloads, searches and exports earlier drops, read-only and never unread', async () => {
    const fileId = await upload(aliceH, 'notes.txt', Buffer.from('early notes'));
    const early = await send(aliceH, toGroup(), 'early plan', { attachment_ids: [fileId] });
    const direct = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'private to bob');
    await join(carol, carolH);
    const after = await send(bobH, toGroup(), 'after carol', { reply_to: early });
    expect((await setHistory(alice, true)).statusCode).toBe(200);

    const page = (await list(carolH, `?group_id=${groupId}`)).json();
    expect(page.drops.map((d: Summary) => d.title)).toEqual(['after carol', 'early plan']);
    const seen = page.drops.find((d: Summary) => d.drop_id === early) as Summary;
    expect(seen.sources).toEqual(['group_history']);
    expect(seen.deliveries).toEqual([]);
    // nothing about the other side's agents (ADR 0013)
    expect(seen.origin_agent).toBeNull();
    expect(seen.recipients).toEqual([]);
    expect(seen.author.public_name).toBeNull();
    // never unread: the count is only what was delivered to her
    expect(page.unread_count).toBe(1);
    expect(await titles(carolH, `?group_id=${groupId}&unread_only=true`)).toEqual(['after carol']);
    // it is not in her mailbox, only in the group's timeline
    expect(await titles(carolH)).toEqual(['after carol']);
    // the reply she received now names the original she can open (side projection follows the predicate)
    const replied = page.drops.find((d: Summary) => d.drop_id === after) as Summary;
    expect(replied.reply_to).toEqual({ drop_id: early, title: 'early plan', mine: false });

    const detail = await read(carolH, early);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().drop.sources).toEqual(['group_history']);
    expect(detail.json().drop.group_ids).toEqual([groupId]);
    const file = await download(carolH, early, fileId);
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('early notes');
    expect(await titles(carolH, `?group_id=${groupId}&query=early`)).toEqual(['early plan']);
    // drops that never went to the group stay out
    expect((await read(carolH, direct)).statusCode).toBe(404);

    // read-only: mutations still need a delivery of hers
    const mutate = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${early}/state`,
      headers: hHeaders(carolH.credential),
      payload: { expected_version: 0, read: true },
    });
    expect(mutate.statusCode).toBe(404);
    expect(mutate.json().code).toBe('NOT_FOUND');

    // her export of the group is the whole history, as an ordinary export
    const exported = exportLines((await exportGroup(carolH)).body);
    expect(exported[0]).toMatchObject({ include_group_history: true, count: 2 });
    const records = exported.filter((r) => r.record === 'drop');
    expect(records.find((r) => r.drop_id === early)?.sources).toEqual(['group_history']);
    expect(records.find((r) => r.drop_id === early)?.body).toBe('body of early plan');

    // an ordinary read: none of the admin-history audit entries
    const actions = await auditActions(carol.userId);
    expect(actions).toContain('drop.read');
    expect(actions).toContain('drop.export');
    expect(actions.filter((a) => a.endsWith('.group_admin'))).toEqual([]);

    // a bridge from before this source existed is told `group` instead of failing its schema
    const legacy = (
      await list(carolH, `?group_id=${groupId}`, { 'user-agent': 'agentdrop-bridge/0.5.8' })
    ).json();
    expect(legacy.drops.find((d: Summary) => d.drop_id === early).sources).toEqual(['group']);
    const current = (
      await list(carolH, `?group_id=${groupId}`, { 'user-agent': 'agentdrop-bridge/0.5.9' })
    ).json();
    expect(current.drops.find((d: Summary) => d.drop_id === early).sources).toEqual(['group_history']);
  });

  it('switching it off takes the earlier drops away again; what was delivered stays', async () => {
    const early = await send(aliceH, toGroup(), 'early plan');
    await join(carol, carolH);
    const after = await send(aliceH, toGroup(), 'after carol', { reply_to: early });
    await setHistory(alice, true);
    expect((await read(carolH, early)).statusCode).toBe(200);

    expect((await setHistory(alice, false)).statusCode).toBe(200);
    expect(await titles(carolH, `?group_id=${groupId}`)).toEqual(['after carol']);
    expect((await read(carolH, early)).statusCode).toBe(404);
    const kept = await read(carolH, after);
    expect(kept.statusCode).toBe(200);
    // the reference goes dark with the access
    expect(kept.json().drop.reply_to).toBeNull();
    // a cursor from the history view does not carry into the delivery view
    await setHistory(alice, true);
    const first = (await list(carolH, `?group_id=${groupId}&limit=1`)).json();
    expect(first.next_cursor).toBeTruthy();
    await setHistory(alice, false);
    const stale = await list(
      carolH,
      `?group_id=${groupId}&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
    );
    expect(stale.json().code).toBe('RESYNC_REQUIRED');
  });

  it('a member who left or was removed sees nothing of it', async () => {
    const early = await send(aliceH, toGroup(), 'early plan');
    await join(carol, carolH);
    await setHistory(alice, true);
    expect((await read(carolH, early)).statusCode).toBe(200);
    expect((await post(`/v1/me/groups/${groupId}/leave`, carol)).statusCode).toBe(200);
    expect(await titles(carolH, `?group_id=${groupId}`)).toEqual([]);
    expect((await read(carolH, early)).statusCode).toBe(404);
    expect((await exportGroup(carolH)).body).not.toContain('early plan');

    expect((await read(bobH, early)).statusCode).toBe(200);
    expect((await post(`/v1/me/groups/${groupId}/members/${bob.userId}/remove`, alice)).statusCode).toBe(200);
    // bob received it while a member: removal revokes the group grant, and the history no longer reaches him
    expect((await read(bobH, early)).statusCode).toBe(404);
    expect(await titles(bobH, `?group_id=${groupId}`)).toEqual([]);
  });

  it('never leaks another group, and with account-wide reads off reaches only through an agent that receives it', async () => {
    const carolCc = await pair(t, carol, { harness: 'claude-code' });
    const other = await post('/v1/me/groups', alice, {
      slug: 'other',
      display_name: 'Other',
      binding_h_ids: [aliceH.hId],
    });
    const otherId = other.json().group_id as string;
    const elsewhere = await send(aliceH, toGroup(otherId), 'other group only');
    const early = await send(aliceH, toGroup(), 'early plan');
    await join(carol, carolH);
    await setHistory(alice, true);

    expect((await read(carolH, elsewhere)).statusCode).toBe(404);
    expect(await titles(carolH, `?group_id=${otherId}`)).toEqual([]);
    expect(await titles(carolH, `?group_id=${groupId}`)).not.toContain('other group only');

    // account-wide (the default): her other agent reads it too
    expect((await read(carolCc, early)).statusCode).toBe(200);
    await t.app.inject({
      method: 'PATCH',
      url: '/v1/me/mailbox-settings',
      headers: { cookie: carol.cookie, origin: t.origin },
      payload: { cross_h_mailbox_enabled: false },
    });
    expect((await read(carolCc, early)).statusCode).toBe(404);
    expect(await titles(carolCc, `?group_id=${groupId}`)).toEqual([]);
    expect((await read(carolH, early)).statusCode).toBe(200);
    expect(await titles(carolH, `?group_id=${groupId}`)).toEqual(['early plan']);
  });

  it('shows earlier drops of an author the reader blocked, as group delivery does, with the author card hidden', async () => {
    const dave = await signUp(t, 'dave', 'Dave');
    const daveH = await pair(t, dave, { harness: 'codex', endpointLabel: 'dave-bot' });
    await t.app.inject({
      method: 'PUT',
      url: '/v1/me/public-email',
      headers: { cookie: dave.cookie, origin: t.origin },
      payload: { public_email: 'dave@example.org' },
    });
    await join(dave, daveH);
    const early = await send(daveH, toGroup(), 'from dave');
    expect((await post(`/v1/me/groups/${groupId}/leave`, dave)).statusCode).toBe(200);
    // carol blocked dave; he has left, so nothing stops her joining (only current members and invitees count)
    const blocked = await post(`/v1/me/contacts/${dave.userId}/block`, carol, { blocked: true });
    expect(blocked.statusCode, blocked.body).toBe(200);
    await join(carol, carolH);
    await setHistory(alice, true);

    const seen = ((await list(carolH, `?group_id=${groupId}`)).json().drops as Summary[]).find(
      (d) => d.drop_id === early,
    );
    expect(seen?.sources).toEqual(['group_history']);
    expect(seen?.author).toMatchObject({ handle: 'dave', public_name: null, public_email: null });
    const detail = await read(carolH, early);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().drop.author.public_email).toBeNull();
    expect(detail.body).not.toContain('dave-bot');
  });

  it('does not hand out the email of an author the reader never received from and does not otherwise know', async () => {
    const dave = await signUp(t, 'dave', 'Dave');
    const daveH = await pair(t, dave, { harness: 'codex', endpointLabel: 'dave-bot' });
    await t.app.inject({
      method: 'PUT',
      url: '/v1/me/public-email',
      headers: { cookie: dave.cookie, origin: t.origin },
      payload: { public_email: 'dave@example.org' },
    });
    await join(dave, daveH);
    const early = await send(daveH, toGroup(), 'from dave');
    expect((await post(`/v1/me/groups/${groupId}/leave`, dave)).statusCode).toBe(200);
    await join(carol, carolH);
    await setHistory(alice, true);

    const seen = ((await list(carolH, `?group_id=${groupId}`)).json().drops as Summary[]).find(
      (d) => d.drop_id === early,
    );
    expect(seen?.author.handle).toBe('dave');
    expect(seen?.author.public_email).toBeNull();
    expect(seen?.author.public_name).toBeNull();
    const detail = (await read(carolH, early)).json().drop;
    expect(detail.author.public_email).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('dave-bot');
    expect((await exportGroup(carolH)).body).not.toContain('dave@example.org');
    // bob received it as a member: he still sees the address
    expect((await read(bobH, early)).json().drop.author.public_email).toBe('dave@example.org');
  });

  it('leaves the admin history rule and its audit as they were, and members of an open group are not audited', async () => {
    const early = await send(aliceH, toGroup(), 'early plan');
    await join(carol, carolH);
    await patch(`/v1/me/groups/${groupId}/members/${carol.userId}`, alice, { role: 'admin' });

    // history off: the admin view is still explicit, marked group_admin and audited
    expect(await titles(carolH, `?group_id=${groupId}`)).toEqual([]);
    const admin = (await list(carolH, `?group_id=${groupId}&include_group_history=true`)).json();
    expect(admin.drops[0].sources).toEqual(['group_admin']);
    expect((await read(carolH, early)).json().drop.sources).toEqual(['group_admin']);
    let actions = await auditActions(carol.userId);
    expect(actions).toContain('drop.list.group_admin');
    expect(actions).toContain('drop.read.group_admin');

    // history on: the same admin reads it as any member does, without the admin audit
    await t.db.drizzle
      .delete(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, carol.userId),
          inArray(auditEvents.action, ['drop.list.group_admin', 'drop.read.group_admin']),
        ),
      );
    await setHistory(alice, true);
    const member = (await list(carolH, `?group_id=${groupId}`)).json();
    expect(member.drops[0].sources).toEqual(['group_history']);
    expect((await read(carolH, early)).json().drop.sources).toEqual(['group_history']);
    actions = await auditActions(carol.userId);
    expect(actions.filter((a) => a.endsWith('.group_admin'))).toEqual([]);
  });

  const setState = (ep: PairedEndpoint, dropId: string, payload: object) =>
    t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${dropId}/state`,
      headers: hHeaders(ep.credential),
      payload,
    });
  /** Read flags of every delivery of a drop to one person, revoked grants included (not visible through the API). */
  async function deliveryState(userId: string, dropId: string) {
    const rows = await t.db.drizzle
      .select({ readAt: deliveries.readAt, version: deliveries.stateVersion })
      .from(deliveries)
      .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, deliveries.hId))
      .where(and(eq(deliveries.dropId, dropId), eq(harnessEndpoints.userId, userId)));
    return rows.map((r) => ({ read: r.readAt !== null, version: r.version }));
  }

  it('stays read-only for a member who left and rejoined: the old delivery lost its grant and gives no state', async () => {
    await join(carol, carolH);
    const during = await send(aliceH, toGroup(), 'while carol was here');
    expect((await post(`/v1/me/groups/${groupId}/leave`, carol)).statusCode).toBe(200);
    await join(carol, carolH);
    await setHistory(alice, true);

    const detail = await read(carolH, during);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().drop.sources).toEqual(['group_history']);
    expect(await deliveryState(carol.userId, during)).toEqual([{ read: false, version: 0 }]);
    // the dashboard labels what predates the current membership: this one does (she rejoined after it)
    const joinedAt = (await get(`/v1/me/groups/${groupId}`, carol)).json().my_membership.joined_at;
    expect(Date.parse(joinedAt)).toBeGreaterThan(Date.parse(detail.json().drop.created_at));

    for (const change of [{ read: true }, { starred: true }, { archived: true }]) {
      const res = await setState(carolH, during, { expected_version: 0, ...change });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    }
    // "mark this group read" does not reach it either
    const all = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops/mark-read',
      headers: hHeaders(carolH.credential),
      payload: { group_id: groupId },
    });
    expect(all.statusCode, all.body).toBe(200);
    // nor does answering it (ADR 0016's reply_to auto-read), to the group or to its author
    await send(carolH, toGroup(), 'answer in the group', { reply_to: during });
    await send(carolH, [{ type: 'user', user_id: alice.userId }], 'answer to alice', { reply_to: during });
    expect(await deliveryState(carol.userId, during)).toEqual([{ read: false, version: 0 }]);

    // a current member's own delivery still takes state changes
    const bobs = await setState(bobH, during, { expected_version: 0, read: true, starred: true });
    expect(bobs.statusCode, bobs.body).toBe(200);
    expect(bobs.json()).toMatchObject({ read: true, starred: true, state_version: 1 });
  });

  it('stays read-only after the member changed the agent that receives the group, also for an admin', async () => {
    const carolCc = await pair(t, carol, { harness: 'claude-code' });
    await join(carol, carolH);
    const before = await send(aliceH, toGroup(), 'to the old agent');
    const moved = await t.app.inject({
      method: 'PUT',
      url: `/v1/me/groups/${groupId}/bindings`,
      headers: { cookie: carol.cookie, origin: t.origin },
      payload: { h_ids: [carolCc.hId] },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const later = await send(aliceH, toGroup(), 'to the new agent');

    // as an admin of a group whose history is off: readable (audited), not mutable
    await patch(`/v1/me/groups/${groupId}/members/${carol.userId}`, alice, { role: 'admin' });
    expect((await read(carolCc, before)).json().drop.sources).toEqual(['group_admin']);
    expect((await setState(carolCc, before, { expected_version: 0, read: true })).statusCode).toBe(404);
    // as a member of a group whose history is on: the same
    await setHistory(alice, true);
    const history = (await read(carolCc, before)).json().drop;
    expect(history.sources).toEqual(['group_history']);
    // sent after she joined: the dashboard must not call it "before you joined"
    const joinedAt = (await get(`/v1/me/groups/${groupId}`, carol)).json().my_membership.joined_at;
    expect(Date.parse(joinedAt)).toBeLessThan(Date.parse(history.created_at));
    for (const ep of [carolCc, carolH]) {
      const res = await setState(ep, before, { expected_version: 0, read: true });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    }
    expect(await deliveryState(carol.userId, before)).toEqual([{ read: false, version: 0 }]);
    // what reaches the new agent is hers to mark
    const ok = await setState(carolCc, later, { expected_version: 0, read: true });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('with account-wide reads off, an agent reading only the history cannot change what another agent received', async () => {
    const carolCc = await pair(t, carol, { harness: 'claude-code' });
    await join(carol, carolH);
    const early = await send(aliceH, toGroup(), 'to her first agent');
    // her second agent receives the group from now on, beside the first
    const both = await t.app.inject({
      method: 'PUT',
      url: `/v1/me/groups/${groupId}/bindings`,
      headers: { cookie: carol.cookie, origin: t.origin },
      payload: { h_ids: [carolH.hId, carolCc.hId] },
    });
    expect(both.statusCode, both.body).toBe(200);
    await setHistory(alice, true);
    const off = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me/mailbox-settings',
      headers: { cookie: carol.cookie, origin: t.origin },
      payload: { cross_h_mailbox_enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);

    expect((await read(carolCc, early)).json().drop.sources).toEqual(['group_history']);
    const refused = await setState(carolCc, early, { expected_version: 0, read: true, archived: true });
    expect(refused.statusCode, refused.body).toBe(404);
    expect(refused.json().code).toBe('NOT_FOUND');
    expect(await deliveryState(carol.userId, early)).toEqual([{ read: false, version: 0 }]);
    // the agent that received it still marks it, for her
    const ok = await setState(carolH, early, { expected_version: 0, read: true });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('a group can be created with it on, and the creator owns that choice', async () => {
    const created = await post('/v1/me/groups', bob, {
      slug: 'open-history',
      display_name: 'Open history',
      binding_h_ids: [bobH.hId],
      history_visible: true,
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().history_visible).toBe(true);
    const gid = created.json().group_id as string;
    const early = await send(bobH, toGroup(gid), 'before carol');
    await join(carol, carolH, gid, bob);
    expect(await titles(carolH, `?group_id=${gid}`)).toEqual(['before carol']);
    expect((await read(carolH, early)).statusCode).toBe(200);
  });
});
