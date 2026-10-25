import { randomUUID } from 'node:crypto';
import { listDropsResultSchema, readDropResultSchema } from '@agentdrop/contracts';
import { drops, mailboxEvents } from '@agentdrop/db';
import type { ApprovalDecision } from '@agentdrop/domain';
import { and, eq } from 'drizzle-orm';
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
  console.warn('[reply.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

/** Held for a human when the title starts with HOLD, so the approval path can be exercised. */
async function holdPolicy(
  _tx: unknown,
  ctx: { envelope: { payload: { title: string } } },
): Promise<ApprovalDecision> {
  const held = ctx.envelope.payload.title.startsWith('HOLD');
  return { needsApproval: held, reasons: held ? ['test hold'] : [] };
}

type Summary = {
  drop_id: string;
  title: string;
  read: boolean;
  state_version: number;
  deliveries: Array<{ h_id: string; read: boolean; state_version: number }>;
  reply_to?: { drop_id: string; title: string; mine?: boolean } | null;
  replies?: {
    count: number;
    latest_at: string | null;
    authors?: Array<{ handle: string; progress?: string }>;
  };
  progress?: string;
};

describeDb(
  'replies reference a drop; answering or posting in a group marks what it answers read (ADR 0016)',
  () => {
    let t: TestApp;
    let alice: BrowserUser;
    let bob: BrowserUser;
    let carol: BrowserUser;
    let aliceH: PairedEndpoint;
    let bobA: PairedEndpoint;
    let bobB: PairedEndpoint;
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
    }

    function sendRaw(
      ep: PairedEndpoint,
      targets: unknown[],
      title: string,
      extra: Record<string, unknown> = {},
      requestId = `req-${randomUUID()}`,
    ) {
      return t.app.inject({
        method: 'POST',
        url: '/v1/h/drops',
        headers: hHeaders(ep.credential),
        payload: {
          request_id: requestId,
          targets,
          payload: { payload_version: 1, kind: 'text', title, body: `body of ${title}`, ...extra },
        },
      });
    }
    async function send(ep: PairedEndpoint, targets: unknown[], title: string, extra = {}): Promise<string> {
      const res = await sendRaw(ep, targets, title, extra);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().drop_id;
    }
    const toUser = (u: BrowserUser) => [{ type: 'user', user_id: u.userId }];
    const toGroup = (id: string) => [{ type: 'group', group_id: id }];

    async function list(ep: PairedEndpoint, q = ''): Promise<{ drops: Summary[]; raw: string }> {
      const res = await t.app.inject({
        method: 'GET',
        url: `/v1/h/drops${q}`,
        headers: hHeaders(ep.credential),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(listDropsResultSchema.safeParse(res.json()).success).toBe(true);
      return { drops: res.json().drops, raw: res.body };
    }
    async function find(ep: PairedEndpoint, dropId: string, q = ''): Promise<Summary> {
      const found = (await list(ep, q)).drops.find((d) => d.drop_id === dropId);
      if (!found) throw new Error(`drop ${dropId} not listed`);
      return found;
    }
    async function read(ep: PairedEndpoint, dropId: string) {
      const res = await t.app.inject({
        method: 'GET',
        url: `/v1/h/drops/${dropId}`,
        headers: hHeaders(ep.credential),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(readDropResultSchema.safeParse(res.json()).success).toBe(true);
      return { drop: res.json().drop as Summary, raw: res.body };
    }
    async function createGroup(slug: string, members: Array<[BrowserUser, PairedEndpoint]>) {
      const created = await post('/v1/me/groups', alice, {
        slug,
        display_name: slug,
        binding_h_ids: [aliceH.hId],
      });
      expect(created.statusCode, created.body).toBe(200);
      const groupId = created.json().group_id as string;
      for (const [user, h] of members) {
        const inv = await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: user.handle });
        expect(inv.statusCode, inv.body).toBe(200);
        const acc = await post(`/v1/me/groups/${groupId}/accept`, user, { h_ids: [h.hId] });
        expect(acc.statusCode, acc.body).toBe(200);
      }
      return groupId;
    }
    async function setState(ep: PairedEndpoint, dropId: string, read: boolean) {
      const current = await find(ep, dropId);
      const res = await t.app.inject({
        method: 'PATCH',
        url: `/v1/h/drops/${dropId}/state`,
        headers: hHeaders(ep.credential),
        payload: { expected_version: current.state_version, read },
      });
      expect(res.statusCode, res.body).toBe(200);
    }

    beforeAll(async () => {
      t = await createTestApp({ approvalPolicy: holdPolicy as never });
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
      bobA = await pair(t, bob, { harness: 'claude-code', endpointLabel: '科研助手' });
      bobB = await pair(t, bob, { harness: 'codex', endpointLabel: '阅读助手' });
      carolH = await pair(t, carol, { harness: 'codex' });
      await befriend(alice, bob);
      await befriend(alice, carol);
      await befriend(bob, carol);
    });

    it('refuses a reply_to the sender cannot read with one answer for unreadable and nonexistent, sending nothing', async () => {
      const private_ = await send(aliceH, toUser(carol), 'between alice and carol');
      const unreadable = await sendRaw(bobA, toUser(alice), 'nosy', { reply_to: private_ });
      const missing = await sendRaw(bobA, toUser(alice), 'nosy', { reply_to: randomUUID() });
      for (const res of [unreadable, missing]) {
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
        expect(res.json().details).toEqual({ field: 'reply_to' });
        expect(res.body).not.toContain(private_);
        expect(res.body).not.toContain('between alice and carol');
      }
      // the same words either way: the answer never says whether the drop exists
      expect(unreadable.json().message).toBe(missing.json().message);
      const sent = await t.db.drizzle.select().from(drops).where(eq(drops.authorUserId, bob.userId));
      expect(sent).toHaveLength(0);
    });

    it('reply_to is part of idempotency content', async () => {
      const q = await send(aliceH, toUser(bob), 'question');
      const other = await send(aliceH, toUser(bob), 'other question');
      const requestId = `req-${randomUUID()}`;
      const first = await sendRaw(bobA, toUser(alice), 'answer', { reply_to: q }, requestId);
      expect(first.statusCode, first.body).toBe(200);
      const same = await sendRaw(bobA, toUser(alice), 'answer', { reply_to: q }, requestId);
      expect(same.json().drop_id).toBe(first.json().drop_id);
      const changed = await sendRaw(bobA, toUser(alice), 'answer', { reply_to: other }, requestId);
      expect(changed.statusCode, changed.body).toBe(409);
      expect(changed.json().code).toBe('IDEMPOTENCY_CONFLICT');
      const dropped = await sendRaw(bobA, toUser(alice), 'answer', {}, requestId);
      expect(dropped.json().code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('shows the original only to readers who may read it, and counts readable replies for the author', async () => {
      const q = await send(aliceH, toUser(bob), 'Secret plan');
      const answer = await send(bobA, toUser(alice), 'Re: Secret plan', { reply_to: q });

      // alice wrote the original: she sees what it answers, in her list and in the detail
      expect((await find(aliceH, answer)).reply_to).toEqual({ drop_id: q, title: 'Secret plan', mine: true });
      expect((await read(aliceH, answer)).drop.reply_to).toEqual({
        drop_id: q,
        title: 'Secret plan',
        mine: true,
      });
      // bob received the original, so his own reply names it too
      expect((await find(bobA, answer, '?view=sent')).reply_to).toEqual({
        drop_id: q,
        title: 'Secret plan',
        mine: false,
      });

      // a drop that answers nothing says so with null
      expect((await find(aliceH, q, '?view=sent')).reply_to).toBeNull();

      // forwarded to carol, who never received the original: no title, no id
      const forwarded = await send(bobA, toUser(carol), 'FYI', { reply_to: q });
      const carolView = await read(carolH, forwarded);
      expect(carolView.drop.reply_to).toBeNull();
      expect(carolView.raw).not.toContain('Secret plan');
      expect(carolView.raw).not.toContain(q);
      const carolList = await list(carolH);
      expect(carolList.drops.find((d) => d.drop_id === forwarded)?.reply_to).toBeNull();
      expect(carolList.raw).not.toContain('Secret plan');

      // replies: on the author's own drop only, counting what she may read (not bob's note to carol)
      const sentQ = await find(aliceH, q, '?view=sent');
      expect(sentQ.replies).toMatchObject({ count: 1, authors: [{ handle: 'bob' }] });
      expect(typeof sentQ.replies?.latest_at).toBe('string');
      expect((await read(aliceH, q)).drop.replies?.count).toBe(1);
      // nothing about bob's agents in it (ADR 0013)
      expect(JSON.stringify(sentQ.replies)).not.toMatch(/科研助手|阅读助手|claude-code/);
      // bob did not write the original: no replies block for him
      expect((await find(bobA, q)).replies).toBeUndefined();

      // once the original is gone, the reference reads null and the reply stays
      await t.db.drizzle.update(drops).set({ revokedAt: new Date() }).where(eq(drops.id, q));
      expect((await find(aliceH, answer)).reply_to).toBeNull();
    });

    it('reply_to says whether the viewing person wrote the original, from any of their agents', async () => {
      const aliceCc = await pair(t, alice, { harness: 'claude-code' });
      const core = await createGroup('core', [
        [bob, bobA],
        [carol, carolH],
      ]);
      const q = await send(aliceH, toUser(bob), 'Budget question');
      const answer = await send(bobA, toUser(alice), 'Re: Budget question', { reply_to: q });
      const ask = await send(aliceH, toGroup(core), 'Group ask');
      const groupAnswer = await send(bobA, toGroup(core), 'Re: Group ask', { reply_to: ask });
      const own = { drop_id: q, title: 'Budget question', mine: true };

      // the person wrote it, through another agent: still theirs (list, search, detail)
      expect((await find(aliceCc, answer)).reply_to).toEqual(own);
      expect((await find(aliceCc, answer, '?query=Budget')).reply_to).toEqual(own);
      expect((await read(aliceCc, answer)).drop.reply_to).toEqual(own);
      // the dashboard reads the same through an owned agent view
      const web = await t.app.inject({
        method: 'GET',
        url: `/v1/me/endpoints/${aliceCc.hId}/drops`,
        headers: { cookie: alice.cookie },
      });
      expect(web.statusCode, web.body).toBe(200);
      expect(web.json().drops.find((d: Summary) => d.drop_id === answer)?.reply_to).toEqual(own);
      // bob answered someone else's drop
      expect((await find(bobB, answer, '?view=sent')).reply_to).toMatchObject({ drop_id: q, mine: false });

      // group timeline: the author sees their own drop answered, other members see someone else's
      expect((await find(aliceCc, groupAnswer, `?group_id=${core}`)).reply_to).toMatchObject({
        drop_id: ask,
        mine: true,
      });
      expect((await find(carolH, groupAnswer, `?group_id=${core}`)).reply_to).toMatchObject({
        drop_id: ask,
        mine: false,
      });

      // bridges before 0.4.11 never knew reply_to and do not get it at all
      const legacy = await t.app.inject({
        method: 'GET',
        url: '/v1/h/drops',
        headers: { ...hHeaders(aliceH.credential), 'user-agent': 'agentdrop-bridge/0.4.10' },
      });
      expect(legacy.body).not.toContain('reply_to');
    });

    it('rule 1: replying marks the original read for the replier on every agent, and nobody else', async () => {
      const q = await send(aliceH, [...toUser(bob), ...toUser(carol)], 'question for two');
      const before = await find(bobA, q);
      expect(before.read).toBe(false);
      expect(before.deliveries.map((d) => d.h_id).sort()).toEqual([bobA.hId, bobB.hId].sort());

      await send(bobA, toUser(alice), 'answer', { reply_to: q });
      const after = await find(bobB, q, '?endpoint_scope=current');
      expect(after.read).toBe(true);
      expect(after.state_version).toBe(before.state_version + 1);
      expect(
        (await find(bobA, q)).deliveries.every((d) => d.read && d.state_version === after.state_version),
      ).toBe(true);
      // both of bob's mailboxes hear about it, as with set_drop_state
      const events = await t.db.drizzle
        .select()
        .from(mailboxEvents)
        .where(and(eq(mailboxEvents.dropId, q), eq(mailboxEvents.type, 'delivery.state')));
      expect(events.map((e) => e.hId).sort()).toEqual([bobA.hId, bobB.hId].sort());
      // carol's copy is hers: still unread
      expect((await find(carolH, q)).read).toBe(false);

      // replying to my own drop (no delivery of mine) changes nothing and still sends
      const own = await send(aliceH, toUser(bob), 'my note');
      await send(aliceH, toUser(bob), 'follow-up', { reply_to: own });
      expect((await find(bobA, own)).read).toBe(false);
    });

    it('rule 2: posting in a group marks earlier drops from that group read, mentions included; nothing else', async () => {
      const core = await createGroup('core', [
        [bob, bobA],
        [carol, carolH],
      ]);
      const side = await createGroup('side', [[bob, bobA]]);
      const g1 = await send(aliceH, toGroup(core), 'g1');
      const g2 = await send(aliceH, toGroup(core), 'g2 calls on bob', { mentions: ['bob'] });
      const other = await send(aliceH, toGroup(side), 'side');
      const direct = await send(aliceH, toUser(bob), 'direct');
      expect((await find(bobA, g2)).read).toBe(false);

      await send(bobA, toGroup(core), 'bob catches up');
      for (const id of [g1, g2]) expect((await find(bobA, id)).read, id).toBe(true);
      for (const id of [other, direct]) expect((await find(bobA, id)).read, id).toBe(false);
      // other people's state is theirs
      expect((await find(carolH, g1)).read).toBe(false);
      // and carol posting catches up carol, not bob's later drops
      const g3 = await send(aliceH, toGroup(core), 'g3');
      await send(carolH, toGroup(core), 'carol catches up');
      for (const id of [g1, g2, g3]) expect((await find(carolH, id)).read, id).toBe(true);
      expect((await find(bobA, g3)).read).toBe(false);
    });

    it('acknowledges a group request in the group: a quoted reply that mentions its author (ADR 0021)', async () => {
      const core = await createGroup('core', [
        [bob, bobA],
        [carol, carolH],
      ]);
      const ask = await send(aliceH, toGroup(core), 'please check split C');
      await send(bobA, toGroup(core), 'Re: please check split C', { reply_to: ask, mentions: ['alice'] });
      const ack = (await list(aliceH)).drops.find((d) => d.title === 'Re: please check split C');
      // the author is called on and sees which of their drops it answers
      expect(ack?.reply_to).toEqual({ drop_id: ask, title: 'please check split C', mine: true });
      expect((ack as { mentioned_me?: boolean } | undefined)?.mentioned_me).toBe(true);
      // the other members see the same quote, so they know it is in hand
      const seenByCarol = (await list(carolH)).drops.find((d) => d.title === 'Re: please check split C');
      expect(seenByCarol?.reply_to).toEqual({ drop_id: ask, title: 'please check split C', mine: false });
      expect((seenByCarol as { mentioned_me?: boolean } | undefined)?.mentioned_me).toBe(false);
      // and the one who answered has caught up on it
      expect((await find(bobA, ask)).read).toBe(true);
      expect((await find(aliceH, ask, '?view=sent')).replies?.count).toBe(1);
    });

    it('a held send applies the rule when it is approved, not before', async () => {
      const q = await send(aliceH, toUser(bob), 'question');
      const held = await sendRaw(bobA, toUser(alice), 'HOLD answer', { reply_to: q });
      expect(held.statusCode, held.body).toBe(202);
      expect(held.json().outcome).toBe('needs_approval');
      expect((await find(bobA, q)).read).toBe(false);
      const approvalId = String(held.json().approval_url).split('/').pop();
      const decided = await post(`/v1/me/approvals/${approvalId}/decide`, bob, { decision: 'approve' });
      expect(decided.statusCode, decided.body).toBe(200);
      expect((await find(bobA, q)).read).toBe(true);
    });

    it('an approval whose reply_to became unreadable closes instead of sending', async () => {
      const core = await createGroup('core', [[bob, bobA]]);
      const g = await send(aliceH, toGroup(core), 'group question');
      const held = await sendRaw(bobA, toUser(alice), 'HOLD answer', { reply_to: g });
      expect(held.statusCode, held.body).toBe(202);
      const left = await post(`/v1/me/groups/${core}/leave`, bob);
      expect(left.statusCode, left.body).toBe(200);
      const approvalId = String(held.json().approval_url).split('/').pop();
      const decided = await post(`/v1/me/approvals/${approvalId}/decide`, bob, { decision: 'approve' });
      expect(decided.json().code).toBe('STALE_APPROVAL');
      const sent = await t.db.drizzle.select().from(drops).where(eq(drops.authorUserId, bob.userId));
      expect(sent).toHaveLength(0);
    });

    it('replaying the same request returns the first result without marking anything again', async () => {
      const q = await send(aliceH, toUser(bob), 'question');
      const requestId = `req-${randomUUID()}`;
      const first = await sendRaw(bobA, toUser(alice), 'answer', { reply_to: q }, requestId);
      expect(first.statusCode, first.body).toBe(200);
      expect((await find(bobA, q)).read).toBe(true);
      await setState(bobA, q, false);
      const replay = await sendRaw(bobA, toUser(alice), 'answer', { reply_to: q }, requestId);
      expect(replay.json().drop_id).toBe(first.json().drop_id);
      expect((await find(bobA, q)).read).toBe(false);
    });

    it('a reply says where the asked-for work stands; the asker sees each person’s latest word (ADR 0038)', async () => {
      const ask = await send(aliceH, toUser(bob), 'Clean the dataset');
      // progress means nothing without the drop it answers: refused, nothing sent
      const alone = await sendRaw(bobA, toUser(alice), 'done', { progress: 'done' });
      expect(alone.statusCode, alone.body).toBe(400);
      expect(alone.json()).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'progress' } });
      const bogus = await sendRaw(bobA, toUser(alice), 'done', { reply_to: ask, progress: 'paused' });
      expect(bogus.statusCode, bogus.body).toBe(400);

      const started = await send(bobA, toUser(alice), 'On it', { reply_to: ask, progress: 'started' });
      expect((await find(aliceH, started)).progress).toBe('started');
      expect((await read(aliceH, started)).drop.progress).toBe('started');
      expect((await find(aliceH, ask, '?view=sent')).replies?.authors).toEqual([
        expect.objectContaining({ handle: 'bob', progress: 'started' }),
      ]);
      // a later note without progress keeps the last word; a later progress replaces it
      await send(bobB, toUser(alice), 'Quick question', { reply_to: ask });
      expect((await find(aliceH, ask, '?view=sent')).replies?.authors?.[0]?.progress).toBe('started');
      const done = await send(bobB, toUser(alice), 'Done', { reply_to: ask, progress: 'done' });
      expect((await read(aliceH, ask)).drop.replies).toMatchObject({
        count: 3,
        authors: [{ handle: 'bob', progress: 'done' }],
      });
      // an ordinary drop carries none
      expect((await find(aliceH, ask, '?view=sent')).progress).toBeUndefined();
      // a person who may not read the replies sees none of their progress: carol never got them
      const forwarded = await send(aliceH, toUser(carol), 'FYI', { reply_to: ask });
      expect((await read(carolH, forwarded)).drop.reply_to).toBeNull();
      // bob's own sent reply shows what he said
      expect((await find(bobA, done, '?view=sent')).progress).toBe('done');
    });

    it('progress is part of idempotency content', async () => {
      const ask = await send(aliceH, toUser(bob), 'Review the draft');
      const requestId = `req-${randomUUID()}`;
      const first = await sendRaw(
        bobA,
        toUser(alice),
        'Re',
        { reply_to: ask, progress: 'started' },
        requestId,
      );
      expect(first.statusCode, first.body).toBe(200);
      const same = await sendRaw(
        bobA,
        toUser(alice),
        'Re',
        { reply_to: ask, progress: 'started' },
        requestId,
      );
      expect(same.json().drop_id).toBe(first.json().drop_id);
      const changed = await sendRaw(
        bobA,
        toUser(alice),
        'Re',
        { reply_to: ask, progress: 'done' },
        requestId,
      );
      expect(changed.json().code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('reading a reply marks nothing read', async () => {
      const q = await send(aliceH, toUser(bob), 'question');
      const answer = await send(bobA, toUser(alice), 'answer', { reply_to: q });
      await read(aliceH, answer);
      await list(aliceH);
      expect((await find(aliceH, answer)).read).toBe(false);
    });
  },
);
