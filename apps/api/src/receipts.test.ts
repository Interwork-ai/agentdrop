import { randomUUID } from 'node:crypto';
import { listDropsResultSchema, readDropResultSchema } from '@agentdrop/contracts';
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
  console.warn('[receipts.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

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

type Summary = {
  drop_id: string;
  read: boolean;
  state_version: number;
  deliveries: Array<{ h_id: string; read: boolean; state_version: number }>;
  recipient_status?: Array<Record<string, unknown>>;
};

describeDb(
  'read receipts: the author sees who opened a drop, the reader keeps their own unread state',
  () => {
    let t: TestApp;
    let alice: BrowserUser;
    let bob: BrowserUser;
    let carol: BrowserUser;
    let aliceH: PairedEndpoint;
    let bobCc: PairedEndpoint;
    let bobCodex: PairedEndpoint;
    let carolH: PairedEndpoint;

    const post = (url: string, user: BrowserUser, body?: unknown) =>
      t.app.inject({
        method: 'POST',
        url,
        headers: { cookie: user.cookie, origin: t.origin },
        ...(body ? { payload: body } : {}),
      });

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
    async function send(ep: PairedEndpoint, targets: unknown[], title: string): Promise<string> {
      const res = await t.app.inject({
        method: 'POST',
        url: '/v1/h/drops',
        headers: hHeaders(ep.credential),
        payload: { request_id: `req-${randomUUID()}`, targets, payload: payload(title) },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().drop_id;
    }
    const list = (ep: PairedEndpoint, q = '', ua?: string) =>
      t.app.inject({
        method: 'GET',
        url: `/v1/h/drops${q}`,
        headers: { ...hHeaders(ep.credential), ...(ua ? { 'user-agent': ua } : {}) },
      });
    const read = (ep: PairedEndpoint, dropId: string, ua?: string) =>
      t.app.inject({
        method: 'GET',
        url: `/v1/h/drops/${dropId}`,
        headers: { ...hHeaders(ep.credential), ...(ua ? { 'user-agent': ua } : {}) },
      });
    async function sentSummary(ep: PairedEndpoint, dropId: string): Promise<Summary> {
      const res = await list(ep, '?view=sent');
      expect(res.statusCode, res.body).toBe(200);
      const found = (res.json().drops as Summary[]).find((d) => d.drop_id === dropId);
      if (!found) throw new Error('sent drop missing');
      return found;
    }
    async function joinGroup(groupId: string, user: BrowserUser, h: PairedEndpoint) {
      const inv = await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: user.handle });
      expect(inv.statusCode, inv.body).toBe(200);
      const acc = await post(`/v1/me/groups/${groupId}/accept`, user, { h_ids: [h.hId] });
      expect(acc.statusCode, acc.body).toBe(200);
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
      carol = await signUp(t, 'carol', '李同学');
      aliceH = await pair(t, alice, { harness: 'codex' });
      bobCc = await pair(t, bob, { harness: 'claude-code', endpointLabel: '科研助手' });
      bobCodex = await pair(t, bob, { harness: 'codex', endpointLabel: '阅读助手' });
      carolH = await pair(t, carol, { harness: 'codex' });
      await befriend(alice, bob);
      await befriend(alice, carol);
    });

    it('direct send: delivered and unread until the recipient opens it; opening leaves their unread state alone', async () => {
      const dropId = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'draft');
      const before = await sentSummary(aliceH, dropId);
      expect(before.recipient_status).toEqual([
        { type: 'user', label: expect.stringMatching(/^@bob/), delivered: true, read_at: null },
      ]);

      // the author reading their own drop is not a receipt
      expect((await read(aliceH, dropId)).statusCode).toBe(200);
      expect((await sentSummary(aliceH, dropId)).recipient_status?.[0]?.read_at).toBeNull();

      // listing (previews) is not opening
      const bobList = (await list(bobCc)).json();
      const unreadBefore = bobList.unread_count;
      const mine = (bobList.drops as Summary[]).find((d) => d.drop_id === dropId);
      expect(mine?.read).toBe(false);
      expect(mine?.recipient_status).toBeUndefined();
      expect((await sentSummary(aliceH, dropId)).recipient_status?.[0]?.read_at).toBeNull();

      const opened = await read(bobCc, dropId);
      expect(opened.statusCode, opened.body).toBe(200);
      // a recipient never sees receipts of someone else's drop
      expect(opened.json().drop.recipient_status).toBeUndefined();

      const after = await sentSummary(aliceH, dropId);
      const readAt = after.recipient_status?.[0]?.read_at;
      expect(typeof readAt).toBe('string');
      // the author's own detail carries the same receipt
      expect((await read(aliceH, dropId)).json().drop.recipient_status?.[0]?.read_at).toBe(readAt);

      // bob's mailbox: still unread, same state version, same unread count
      const bobAfter = (await list(bobCc)).json();
      expect(bobAfter.unread_count).toBe(unreadBefore);
      const again = (bobAfter.drops as Summary[]).find((d) => d.drop_id === dropId);
      expect(again?.read).toBe(false);
      expect(again?.deliveries.map((x) => [x.read, x.state_version])).toEqual(
        mine?.deliveries.map((x) => [x.read, x.state_version]),
      );

      // opening again later (or a later chunk) keeps the first time
      await read(bobCc, dropId);
      expect((await sentSummary(aliceH, dropId)).recipient_status?.[0]?.read_at).toBe(readAt);
      // nothing about bob's agents leaks into the receipt
      const raw = JSON.stringify(after.recipient_status);
      expect(raw).not.toContain(bobCc.hId);
      expect(raw).not.toContain(bobCodex.hId);
      expect(raw).not.toContain('科研助手');
      expect(raw).not.toContain('阅读助手');
    });

    it('opening from another of the recipient’s agents counts (account-wide)', async () => {
      const dropId = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'account wide');
      const delivered = (await list(bobCc))
        .json()
        .drops.find((d: Summary) => d.drop_id === dropId) as Summary;
      const receiving = delivered.deliveries[0]?.h_id;
      const other = receiving === bobCc.hId ? bobCodex : bobCc;
      expect(other.hId).not.toBe(receiving);
      expect((await read(other, dropId)).statusCode).toBe(200);
      expect(typeof (await sentSummary(aliceH, dropId)).recipient_status?.[0]?.read_at).toBe('string');
    });

    it('an explicit mark-read also counts, and so does opening it in the dashboard', async () => {
      const marked = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'marked');
      const state = (await list(bobCc)).json().drops.find((d: Summary) => d.drop_id === marked) as Summary;
      const receiving = state.deliveries[0];
      const receiver = receiving?.h_id === bobCc.hId ? bobCc : bobCodex;
      const res = await t.app.inject({
        method: 'PATCH',
        url: `/v1/h/drops/${marked}/state`,
        headers: hHeaders(receiver.credential),
        payload: { expected_version: receiving?.state_version ?? 0, read: true },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(typeof (await sentSummary(aliceH, marked)).recipient_status?.[0]?.read_at).toBe('string');

      const web = await send(aliceH, [{ type: 'user', user_id: carol.userId }], 'web');
      const opened = await t.app.inject({
        method: 'GET',
        url: `/v1/me/endpoints/${carolH.hId}/drops/${web}`,
        headers: { cookie: carol.cookie },
      });
      expect(opened.statusCode, opened.body).toBe(200);
      expect(typeof (await sentSummary(aliceH, web)).recipient_status?.[0]?.read_at).toBe('string');
    });

    it('group: k/n per person, the author excluded, an admin reading history is not a receipt', async () => {
      const created = await post('/v1/me/groups', alice, {
        slug: 'research',
        display_name: '论文讨论组',
        binding_h_ids: [aliceH.hId],
      });
      expect(created.statusCode, created.body).toBe(200);
      const groupId = created.json().group_id as string;
      await joinGroup(groupId, bob, bobCc);
      const early = await send(aliceH, [{ type: 'group', group_id: groupId }], 'before carol');
      await joinGroup(groupId, carol, carolH);
      const later = await send(aliceH, [{ type: 'group', group_id: groupId }], 'with carol');

      expect((await sentSummary(aliceH, later)).recipient_status).toEqual([
        { type: 'group', label: '#research', member_count: 2, read_count: 0, readers: [] },
      ]);
      // the author received their own group drop; opening it does not count toward k/n
      expect((await read(aliceH, later)).statusCode).toBe(200);
      // bob opens it from his other agent (account-wide), carol has not
      expect((await read(bobCodex, later)).statusCode).toBe(200);
      const status = (await sentSummary(aliceH, later)).recipient_status?.[0] as {
        member_count: number;
        read_count: number;
        readers: Array<{ display_label: string; handle: string; read_at: string }>;
      };
      expect(status.member_count).toBe(2);
      expect(status.read_count).toBe(1);
      expect(status.readers).toEqual([
        { display_label: '王同学', handle: 'bob', read_at: expect.any(String) },
      ]);
      // the author's private remark wins over the public nickname
      await t.app.inject({
        method: 'PATCH',
        url: `/v1/me/contacts/${bob.userId}`,
        headers: { cookie: alice.cookie, origin: t.origin },
        payload: { remark: '老王' },
      });
      const remarked = (await sentSummary(aliceH, later)).recipient_status?.[0] as typeof status;
      expect(remarked.readers[0]?.display_label).toBe('老王');

      // carol joined after the early drop; promoted to admin she may read it, but that is not a receipt
      await t.app.inject({
        method: 'PATCH',
        url: `/v1/me/groups/${groupId}/members/${carol.userId}`,
        headers: { cookie: alice.cookie, origin: t.origin },
        payload: { role: 'admin' },
      });
      const adminRead = await read(carolH, early);
      expect(adminRead.statusCode, adminRead.body).toBe(200);
      expect(adminRead.json().drop.sources).toEqual(['group_admin']);
      expect(adminRead.json().drop.recipient_status).toBeUndefined();
      expect((await sentSummary(aliceH, early)).recipient_status).toEqual([
        { type: 'group', label: '#research', member_count: 1, read_count: 0, readers: [] },
      ]);

      // members other than the author never get receipts, not even through the group timeline
      const bobView = (await list(bobCc, `?group_id=${groupId}`)).json().drops as Summary[];
      expect(bobView.length).toBeGreaterThan(0);
      for (const d of bobView) expect(d.recipient_status).toBeUndefined();
      const history = (await list(carolH, `?group_id=${groupId}&include_group_history=true`)).json()
        .drops as Summary[];
      for (const d of history) expect(d.recipient_status).toBeUndefined();
    });

    it('version skew: bridges before 0.4.11 never see the field, newer ones do, and the field is optional', async () => {
      const dropId = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'skew');
      const oldList = (await list(aliceH, '?view=sent', 'agentdrop-bridge/0.4.10 node')).json();
      expect(oldList.drops[0]).not.toHaveProperty('recipient_status');
      const oldRead = (await read(aliceH, dropId, 'agentdrop-bridge/0.3.2')).json();
      expect(oldRead.drop).not.toHaveProperty('recipient_status');
      const newList = (await list(aliceH, '?view=sent', 'agentdrop-bridge/0.4.11')).json();
      expect(newList.drops[0].recipient_status).toHaveLength(1);

      // what a new bridge does with an old server's result: parse succeeds without the field
      const newRead = (await read(aliceH, dropId)).json();
      const { recipient_status: _omit, ...withoutField } = newRead.drop;
      expect(readDropResultSchema.safeParse({ ...newRead, drop: withoutField }).success).toBe(true);
      expect(listDropsResultSchema.safeParse(oldList).success).toBe(true);
      // and a current result round-trips through the advertised schema with the receipts intact
      const parsed = listDropsResultSchema.safeParse(newList);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.drops[0]?.recipient_status).toEqual(newList.drops[0].recipient_status);
    });
  },
);
