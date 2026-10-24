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

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

/*
 * What the event stream reads (ADR 0040), beyond the basics in events.test.ts: large backlogs, damaged histories,
 * cursors from elsewhere, how a bulk change is announced, and which writers announce `directory.changed`.
 */
describeDb('the event stream: what it reads and announces', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let carol: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;
  let carolH: PairedEndpoint;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice', 'Alice');
    bob = await signUp(t, 'bob', 'Bob');
    carol = await signUp(t, 'carol', 'Carol');
    aliceH = await pair(t, alice, { harness: 'codex' });
    bobH = await pair(t, bob, { harness: 'codex' });
    carolH = await pair(t, carol, { harness: 'codex' });
    await befriend(alice, bob);
    await befriend(alice, carol);
  });

  const browser = (user: BrowserUser) => ({ cookie: user.cookie, origin: t.origin });
  const post = (url: string, user: BrowserUser, body?: unknown) =>
    t.app.inject({ method: 'POST', url, headers: browser(user), ...(body ? { payload: body } : {}) });
  const patch = (url: string, user: BrowserUser, body: Record<string, unknown>) =>
    t.app.inject({ method: 'PATCH', url, headers: browser(user), payload: body });

  async function befriend(a: BrowserUser, b: BrowserUser) {
    expect((await post('/v1/me/contacts/invite', a, { handle: b.handle })).statusCode).toBeLessThan(300);
    expect((await post(`/v1/me/contacts/${a.userId}/accept`, b)).statusCode).toBeLessThan(300);
  }

  const events = (h: PairedEndpoint, query: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url: '/v1/h/events', query, headers: hHeaders(h.credential) });

  async function subscribe(h: PairedEndpoint): Promise<string> {
    const res = await events(h);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().cursor;
  }

  async function send(from: PairedEndpoint, to: BrowserUser, title = 'hello', attachmentIds: string[] = []) {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(from.credential),
      payload: {
        request_id: `core-${randomUUID()}`,
        targets: [{ type: 'user', user_id: to.userId }],
        payload: {
          payload_version: 1,
          kind: attachmentIds.length ? 'file' : 'text',
          title,
          body: 'the ablation run',
          attachment_ids: attachmentIds,
          extensions: {},
        },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().drop_id as string;
  }

  /** Reads every page from `cursor`; returns all events and the pages they came in. */
  async function readAll(h: PairedEndpoint, cursor: string, limit = 100) {
    const pages: Array<Array<{ type: string; drop_id: string | null }>> = [];
    let next = cursor;
    for (let i = 0; i < 200; i++) {
      const res = await events(h, { cursor: next, limit: String(limit) });
      expect(res.statusCode, res.body).toBe(200);
      pages.push(res.json().events);
      next = res.json().cursor;
      if (!res.json().has_more) return { pages, cursor: next };
    }
    throw new Error('the stream never caught up');
  }

  /** Writes `n` events for an agent the way the server does: the next revisions, then the head. */
  async function fabricate(hId: string, n: number, type = 'delivery.state') {
    await t.db.pool.query(
      'insert into mailbox_heads (h_id, revision) values ($1, 0) on conflict do nothing',
      [hId],
    );
    await t.db.pool.query(
      `insert into mailbox_events (h_id, revision, type, drop_id)
       select $1::uuid, h.revision + g, $3, gen_random_uuid()
       from mailbox_heads h, generate_series(1, $2::int) g where h.h_id = $1::uuid`,
      [hId, n, type],
    );
    await t.db.pool.query('update mailbox_heads set revision = revision + $2::int where h_id = $1::uuid', [
      hId,
      n,
    ]);
  }

  it('pages a backlog spread over several agents completely, each agent in order, nothing twice', async () => {
    const agents = [bobH];
    for (let i = 0; i < 3; i++) agents.push(await pair(t, bob, { harness: 'claude-code', profile: `p${i}` }));
    const cursor = await subscribe(bobH);
    for (const [i, a] of agents.entries()) await fabricate(a.hId, 150 + i * 40);
    const { pages } = await readAll(bobH, cursor, 100);
    const all = pages.flat();
    // 150 + 190 + 230 + 270 distinct drops, one event each
    expect(all).toHaveLength(840);
    expect(new Set(all.map((e) => e.drop_id)).size).toBe(840);
    expect(pages.length).toBeGreaterThanOrEqual(9);
    // caught up: nothing more
    expect((await events(bobH, { cursor: (await readAll(bobH, cursor)).cursor })).json().events).toEqual([]);
  });

  it('answers RESYNC_REQUIRED for a hole in the middle of an agent’s kept events, not only a swept prefix', async () => {
    const cursor = await subscribe(bobH);
    for (const title of ['one', 'two', 'three']) await send(aliceH, bob, title);
    const { rows } = await t.db.pool.query<{ revision: string }>(
      'select revision from mailbox_events where h_id = $1 order by revision',
      [bobH.hId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const middle = rows[Math.floor(rows.length / 2)]?.revision;
    await t.db.pool.query('delete from mailbox_events where h_id = $1 and revision = $2', [bobH.hId, middle]);
    const res = await events(bobH, { cursor });
    expect(res.statusCode, res.body).toBe(410);
    expect(res.json().code).toBe('RESYNC_REQUIRED');
  });

  it('answers RESYNC_REQUIRED for a cursor ahead of this server (a database restored from a backup)', async () => {
    await send(aliceH, bob, 'before the backup');
    const ahead = await subscribe(bobH);
    // the restore: the head and the directory go back
    await t.db.pool.query('update mailbox_heads set revision = revision - 1 where h_id = $1', [bobH.hId]);
    const res = await events(bobH, { cursor: ahead });
    expect(res.statusCode, res.body).toBe(410);
    expect(res.json().code).toBe('RESYNC_REQUIRED');

    const fresh = await subscribe(bobH);
    await t.db.pool.query('update app_users set directory_revision = directory_revision - 1 where id = $1', [
      bob.userId,
    ]);
    expect((await events(bobH, { cursor: fresh })).json().code).toBe('RESYNC_REQUIRED');
  });

  it('keeps the cursor small for a person with many agents', async () => {
    // 150 agents over the years (revoked ones stay visible in account scope), each of which had events
    const device = (
      await t.db.pool.query('select device_id from harness_endpoints where id = $1', [bobH.hId])
    ).rows[0].device_id;
    const { rows } = await t.db.pool.query<{ id: string }>(
      `insert into harness_endpoints (user_id, device_id, harness_key, profile_key, label, revoked_at)
       select $1::uuid, $2::uuid, 'codex', 'old-' || g, 'Old ' || g, case when g % 2 = 0 then now() else null end
       from generate_series(1, 150) g returning id`,
      [bob.userId, device],
    );
    for (const r of rows) await fabricate(r.id, 3);
    const cursor = await subscribe(bobH);
    expect(cursor.length).toBeLessThan(2500);
    expect((await events(bobH, { cursor })).statusCode).toBe(200);
    await fabricate(rows[0]?.id as string, 1);
    expect((await events(bobH, { cursor })).json().events).toHaveLength(1);
  });

  it('refuses a damaged or foreign cursor as RESYNC_REQUIRED', async () => {
    const cursor = await subscribe(bobH);
    const bytes = Buffer.from(cursor, 'base64url');
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    for (const res of [
      await events(bobH, { cursor: bytes.toString('base64url') }),
      await events(carolH, { cursor }),
    ]) {
      expect(res.statusCode, res.body).toBe(410);
      expect(res.json().code).toBe('RESYNC_REQUIRED');
    }
  });

  it('announces each drop of a mark-all-read once, however many agents of the person hold it', async () => {
    const bobClaude = await pair(t, bob, { harness: 'claude-code' });
    await pair(t, bob, { harness: 'opencode' });
    const drops = [];
    for (let i = 0; i < 40; i++) drops.push(await send(aliceH, bob, `drop ${i}`));
    const cursor = await subscribe(bobClaude);
    const marked = await t.app.inject({
      method: 'POST',
      url: `/v1/me/endpoints/${bobH.hId}/drops/mark-read`,
      headers: browser(bob),
      payload: {},
    });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json().marked).toBe(40);
    // 40 drops × 3 agents = 120 rows; read 30 at a time, each drop must appear once per page and once overall
    const { pages } = await readAll(bobClaude, cursor, 30);
    const states = pages.flat().filter((e) => e.type === 'delivery.state');
    expect(new Set(states.map((e) => e.drop_id))).toEqual(new Set(drops));
    // a drop's copies are adjacent, so only one split by a page boundary is announced twice
    expect(states.length).toBeLessThanOrEqual(40 + pages.length);
    for (const page of pages) {
      const ids = page.filter((e) => e.type === 'delivery.state').map((e) => e.drop_id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('tells nobody whose grant was revoked that a file was removed from a drop they can no longer open', async () => {
    const g = await post('/v1/me/groups', alice, { slug: 'lab', display_name: 'Lab' });
    expect(g.statusCode, g.body).toBe(200);
    const groupId = g.json().group_id as string;
    expect((await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: bob.handle })).statusCode).toBe(
      200,
    );
    expect((await post(`/v1/me/groups/${groupId}/accept`, bob, { h_ids: [bobH.hId] })).statusCode).toBe(200);
    const upload = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceH.credential),
        'content-type': 'application/octet-stream',
        'content-length': '64',
        'x-agentdrop-filename': 'weights.bin',
      },
      payload: Buffer.alloc(64, 'a'),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const file = upload.json().attachment_id as string;
    const sent = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(aliceH.credential),
      payload: {
        request_id: `core-${randomUUID()}`,
        targets: [{ type: 'group', group_id: groupId }],
        payload: {
          payload_version: 1,
          kind: 'file',
          title: 'weights',
          body: 'the ablation run',
          attachment_ids: [file],
          extensions: {},
        },
      },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const dropId = sent.json().drop_id as string;
    expect((await post(`/v1/me/groups/${groupId}/leave`, bob)).statusCode).toBe(200);
    const bobCursor = await subscribe(bobH);
    const aliceCursor = await subscribe(aliceH);
    const removed = await t.app.inject({
      method: 'DELETE',
      url: `/v1/me/groups/${groupId}/files/${file}`,
      headers: browser(alice),
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await events(bobH, { cursor: bobCursor })).json().events).not.toContainEqual({
      type: 'attachment.removed',
      drop_id: dropId,
    });
    expect((await events(aliceH, { cursor: aliceCursor })).json().events).toContainEqual({
      type: 'attachment.removed',
      drop_id: dropId,
    });
  });

  describe('directory.changed for group changes', () => {
    async function groupWith(members: Array<[BrowserUser, PairedEndpoint]>, policy?: string) {
      const g = await post('/v1/me/groups', alice, { slug: 'garden', display_name: 'Garden club' });
      expect(g.statusCode, g.body).toBe(200);
      const id = g.json().group_id as string;
      for (const [u, h] of members) {
        expect((await post(`/v1/me/groups/${id}/invite`, alice, { handle: u.handle })).statusCode).toBe(200);
        expect((await post(`/v1/me/groups/${id}/accept`, u, { h_ids: [h.hId] })).statusCode).toBe(200);
      }
      if (policy)
        expect(
          (await patch(`/v1/me/groups/${id}/policy`, alice, { member_invite_policy: policy })).statusCode,
        ).toBe(200);
      return id;
    }
    const announced = async (h: PairedEndpoint, cursor: string) =>
      (await events(h, { cursor }))
        .json()
        .events.some((e: { type: string }) => e.type === 'directory.changed');

    it('tells the owner of a request waiting for them, and the member who asked when it is decided', async () => {
      const dave = await signUp(t, 'dave', 'Dave');
      await pair(t, dave, { harness: 'codex' });
      await befriend(bob, dave);
      const id = await groupWith([[bob, bobH]], 'admin_approval');
      const owner = await subscribe(aliceH);
      const asked = await post(`/v1/me/groups/${id}/invite`, bob, { handle: dave.handle });
      expect(asked.statusCode, asked.body).toBe(200);
      expect(await announced(aliceH, owner)).toBe(true);

      const member = await subscribe(bobH);
      const decided = await post(`/v1/me/groups/${id}/requests/${dave.userId}/decide`, alice, {
        decision: 'reject',
      });
      expect(decided.statusCode, decided.body).toBe(200);
      expect(await announced(bobH, member)).toBe(true);
    });

    it('tells the members of a role change, a new owner, and a changed policy', async () => {
      const id = await groupWith([
        [bob, bobH],
        [carol, carolH],
      ]);
      let cursor = await subscribe(carolH);
      expect(
        (await patch(`/v1/me/groups/${id}/members/${bob.userId}`, alice, { role: 'admin' })).statusCode,
      ).toBe(200);
      expect(await announced(carolH, cursor)).toBe(true);

      cursor = await subscribe(bobH);
      expect(
        (await patch(`/v1/me/groups/${id}/members/${bob.userId}`, alice, { role: 'owner' })).statusCode,
      ).toBe(200);
      expect(await announced(bobH, cursor)).toBe(true);

      cursor = await subscribe(carolH);
      expect((await patch(`/v1/me/groups/${id}/policy`, bob, { history_visible: true })).statusCode).toBe(
        200,
      );
      expect(await announced(carolH, cursor)).toBe(true);
    });
  });

  it('wakes a waiting long-poll at once when the person renames themselves', async () => {
    const cursor = await subscribe(bobH);
    const started = Date.now();
    const waiting = events(bobH, { cursor, wait: '20' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const renamed = await patch('/v1/me', bob, { display_name: 'Robert' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const res = await waiting;
    expect(res.json().events).toContainEqual({ type: 'directory.changed', drop_id: null });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('makes an old cursor resync at once when account-wide reads are switched off', async () => {
    const cursor = await subscribe(bobH);
    const started = Date.now();
    const waiting = events(bobH, { cursor, wait: '20' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await patch('/v1/me/mailbox-settings', bob, { cross_h_mailbox_enabled: false })).statusCode).toBe(
      200,
    );
    const res = await waiting;
    expect(res.statusCode, res.body).toBe(410);
    expect(res.json().code).toBe('RESYNC_REQUIRED');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
