import { randomUUID } from 'node:crypto';
import { appUsers, withTx } from '@agentdrop/db';
import { replyAsAssistant } from '@agentdrop/domain';
import { eq, sql } from 'drizzle-orm';
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

if (!TEST_DATABASE_URL)
  console.warn('[admin-product-health.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

type Target = { type: 'user'; user_id: string } | { type: 'group'; group_id: string } | { type: 'self' };

/**
 * ADR 0035: the operator overview's product health, computed from metadata only. Timestamps are moved directly in
 * the database so the 72-hour, 7-day and 28-day windows can be crossed without waiting.
 */
describe.skipIf(!TEST_DATABASE_URL)('operator product health (ADR 0035)', () => {
  let t: TestApp;
  let root: BrowserUser;
  let assistantId: string;

  const get = (url: string, u: BrowserUser) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: u.cookie, origin: t.origin } });
  const post = (url: string, u: BrowserUser, payload?: unknown) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: u.cookie, origin: t.origin },
      payload: payload ?? {},
    });

  async function health() {
    const res = await get('/v1/admin/overview', root);
    expect(res.statusCode, res.body).toBe(200);
    return { body: res.body, ph: res.json().product_health };
  }

  async function send(ep: PairedEndpoint, targets: Target[], title: string, replyTo?: string) {
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
          ...(replyTo ? { reply_to: replyTo } : {}),
        },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().drop_id as string;
  }

  async function befriend(a: BrowserUser, b: BrowserUser) {
    expect((await post('/v1/me/contacts/invite', a, { handle: b.handle })).statusCode).toBe(200);
    expect((await post(`/v1/me/contacts/${a.userId}/accept`, b)).statusCode).toBe(200);
  }

  /** Moves a drop (and its deliveries) to `hours` ago. */
  async function age(dropId: string, hours: number) {
    await t.db.drizzle.execute(sql`
      update drops set created_at = now() - make_interval(secs => ${hours * 3600}) where id = ${dropId}`);
    await t.db.drizzle.execute(sql`
      update deliveries set received_at = (select created_at from drops where id = ${dropId})
      where drop_id = ${dropId}`);
  }

  /** Places a reply `hoursAfter` the drop it answers, which must already be placed. */
  async function after(replyId: string, originalId: string, hoursAfter: number) {
    await t.db.drizzle.execute(sql`
      update drops set created_at = (select created_at from drops where id = ${originalId})
        + make_interval(secs => ${hoursAfter * 3600})
      where id = ${replyId}`);
    await t.db.drizzle.execute(sql`
      update deliveries set received_at = (select created_at from drops where id = ${replyId})
      where drop_id = ${replyId}`);
  }

  async function signedUpAgo(u: BrowserUser, days: number) {
    await t.db.drizzle.execute(sql`
      update app_users set created_at = now() - make_interval(secs => ${days * 86400}) where id = ${u.userId}`);
  }

  /** Places the moment an agent was paired, relative to its owner's sign-up. */
  async function pairedAfterSignup(ep: PairedEndpoint, u: BrowserUser, hours: number) {
    await t.db.drizzle.execute(sql`
      update harness_endpoints set created_at = (select created_at from app_users where id = ${u.userId})
        + make_interval(secs => ${hours * 3600})
      where id = ${ep.hId}`);
  }

  async function sentAfterSignup(dropId: string, u: BrowserUser, hours: number) {
    await t.db.drizzle.execute(sql`
      update drops set created_at = (select created_at from app_users where id = ${u.userId})
        + make_interval(secs => ${hours * 3600})
      where id = ${dropId}`);
  }

  /** Marks a person's copies of a drop read `seconds` after delivery (read state is per person, ADR 0007). */
  async function readAfter(dropId: string, u: BrowserUser, seconds: number) {
    await t.db.drizzle.execute(sql`
      update deliveries set read_at = received_at + make_interval(secs => ${seconds})
      where drop_id = ${dropId}
        and h_id in (select id from harness_endpoints where user_id = ${u.userId})`);
  }

  async function makeGroup(
    owner: BrowserUser,
    ownerH: PairedEndpoint,
    members: [BrowserUser, PairedEndpoint][],
  ) {
    const created = await post('/v1/me/groups', owner, {
      slug: `lab${randomUUID().slice(0, 6)}`,
      display_name: 'Lab',
      binding_h_ids: [ownerH.hId],
    });
    expect(created.statusCode, created.body).toBe(200);
    const groupId = created.json().group_id as string;
    for (const [m, h] of members) {
      expect((await post(`/v1/me/groups/${groupId}/invite`, owner, { handles: [m.handle] })).statusCode).toBe(
        200,
      );
      const acc = await post(`/v1/me/groups/${groupId}/accept`, m, { h_ids: [h.hId] });
      expect(acc.statusCode, acc.body).toBe(200);
    }
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
    root = await signUp(t, 'ph_root', 'Operator Root');
    await t.db.drizzle.update(appUsers).set({ isAdmin: true }).where(eq(appUsers.id, root.userId));
    // the operator's own account is outside every cohort below
    await signedUpAgo(root, 60);
    const [assistant] = await t.db.drizzle
      .select({ id: appUsers.id })
      .from(appUsers)
      .where(eq(appUsers.isSystem, true));
    if (!assistant) throw new Error('the built-in assistant was not created');
    assistantId = assistant.id;
  });

  it('is for administrators only', async () => {
    const someone = await signUp(t, 'ph_someone', 'Someone');
    const denied = await get('/v1/admin/overview', someone);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('FORBIDDEN');
    expect(denied.body).not.toContain('product_health');
  });

  it('reports zeros and no shares on a server where nothing happened', async () => {
    const { ph } = await health();
    expect(ph).toEqual({
      answered_72h: {
        last_7d: { answered: 0, eligible: 0, share: null },
        last_28d: { answered: 0, eligible: 0, share: null },
      },
      active_senders: { last_7d: 0, last_28d: 0 },
      sent_7d: { direct: 0, group: 0 },
      activation: {
        signups_28d: 0,
        in_first_week: 0,
        paired_agent: 0,
        tried_assistant: 0,
        sent_to_people: 0,
      },
      read_latency_7d: { delivered: 0, read: 0, median_seconds: null },
    });
  });

  it('answered within 72 h: only answers by someone else, in time, over messages that had their 72 hours', async () => {
    const alice = await signUp(t, 'ph_alice', 'Alice Example');
    const bob = await signUp(t, 'ph_bob', 'Bob Example');
    const carol = await signUp(t, 'ph_carol', 'Carol Example');
    const aliceH = await pair(t, alice);
    const bobH = await pair(t, bob);
    const carolH = await pair(t, carol);
    await befriend(alice, bob);
    const lab = await makeGroup(alice, aliceH, [
      [bob, bobH],
      [carol, carolH],
    ]);
    const toBob: Target[] = [{ type: 'user', user_id: bob.userId }];
    const toAlice: Target[] = [{ type: 'user', user_id: alice.userId }];
    const toLab: Target[] = [{ type: 'group', group_id: lab }];

    // answered by Bob after 10 h
    const d1 = await send(aliceH, toBob, 'Zeta plan one');
    await age(d1, 100);
    const r1 = await send(bobH, toAlice, 'Zeta answer one', d1);
    await after(r1, d1, 10); // 90 h old, unanswered itself: eligible, not answered
    // answered only after 80 h: too late
    const d2 = await send(aliceH, toBob, 'Zeta plan two');
    await age(d2, 100);
    const r2 = await send(bobH, toAlice, 'Zeta late answer', d2);
    await after(r2, d2, 80); // 20 h old and unanswered: not yet eligible
    // Alice answers her own message: not an answer
    const d3 = await send(aliceH, toBob, 'Zeta plan three');
    await age(d3, 100);
    const r3 = await send(aliceH, toBob, 'Zeta follow-up', d3);
    await after(r3, d3, 1); // 99 h old: eligible, not answered
    // young and unanswered: left out until its 72 hours are up
    const d4 = await send(aliceH, toBob, 'Zeta young');
    await age(d4, 10);
    // young but already answered: counted
    const d5 = await send(aliceH, toBob, 'Zeta young answered');
    await age(d5, 10);
    const r5 = await send(bobH, toAlice, 'Zeta quick answer', d5);
    await after(r5, d5, 1); // 9 h old: not yet eligible
    // a group message answered in the group by Carol
    const d6 = await send(aliceH, toLab, 'Zeta group question');
    await age(d6, 100);
    const r6 = await send(carolH, toLab, 'Zeta group answer', d6);
    await after(r6, d6, 5); // 95 h old: eligible, not answered
    // 20 days old and answered: in the 28-day figure only
    const d10 = await send(aliceH, toBob, 'Zeta older');
    await age(d10, 480);
    const r10 = await send(bobH, toAlice, 'Zeta older answer', d10);
    await after(r10, d10, 2);
    // 40 days old: outside both windows
    const d11 = await send(aliceH, toBob, 'Zeta ancient');
    await age(d11, 960);
    // never counted: a test message to the assistant (and its receipt), My space, a handoff to one's own agents
    const d7 = await send(aliceH, [{ type: 'user', user_id: assistantId }], 'Zeta to the assistant');
    const receipt = await withTx(t.db, (tx) => replyAsAssistant(tx, d7));
    expect(receipt.replied).toBe(true);
    await age(d7, 100);
    await t.db.drizzle.execute(sql`
      update drops set created_at = now() - interval '99 hours' where reply_to_drop_id = ${d7}`);
    const d8 = await send(aliceH, [{ type: 'self' }], 'Zeta for my laptop');
    await age(d8, 100);
    const d12 = await send(aliceH, [{ type: 'user', user_id: alice.userId }], 'Zeta to my other agent');
    await age(d12, 100);

    const { ph, body } = await health();
    // 7 days: d1 d5 d6 answered; r1 d2 d3 r3 r6 eligible but not answered; d4 r2 r5 too young
    expect(ph.answered_72h.last_7d).toEqual({ answered: 3, eligible: 8, share: 3 / 8 });
    // 28 days adds d10 (answered) and its answer r10
    expect(ph.answered_72h.last_28d).toEqual({ answered: 4, eligible: 10, share: 4 / 10 });
    expect(ph.active_senders).toEqual({ last_7d: 3, last_28d: 3 });
    // d1 r1 d2 r2 d3 r3 d4 d5 r5 to one person; d6 r6 to the group
    expect(ph.sent_7d).toEqual({ direct: 9, group: 2 });

    // nothing identifying leaves the server in the overview
    for (const secret of [
      'Zeta',
      'ph_alice',
      'ph_bob',
      'ph_carol',
      'Alice Example',
      alice.email,
      assistantId,
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  it('weekly senders: one person counts once, and someone who only wrote to the assistant or themselves not at all', async () => {
    const alice = await signUp(t, 'ph_alice', 'Alice Example');
    const bob = await signUp(t, 'ph_bob', 'Bob Example');
    const carol = await signUp(t, 'ph_carol', 'Carol Example');
    const aliceH = await pair(t, alice);
    const aliceLaptop = await pair(t, alice, { harness: 'claude-code' });
    const bobH = await pair(t, bob);
    const carolH = await pair(t, carol);
    await befriend(alice, bob);
    // Alice, from two agents, three times
    await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'one');
    await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'two');
    await send(aliceLaptop, [{ type: 'user', user_id: bob.userId }], 'three');
    // Bob only 10 days ago: in the 28-day figure
    const old = await send(bobH, [{ type: 'user', user_id: alice.userId }], 'old');
    await age(old, 240);
    // Carol only tried the assistant and kept a note for herself
    await send(carolH, [{ type: 'user', user_id: assistantId }], 'hello assistant');
    await send(carolH, [{ type: 'self' }], 'note');

    const { ph } = await health();
    expect(ph.active_senders).toEqual({ last_7d: 1, last_28d: 2 });
    expect(ph.sent_7d).toEqual({ direct: 3, group: 0 });
  });

  it('activation: first steps within 7 days of signing up, assistant tries apart from messages to people', async () => {
    // Alice, 10 days ago: paired on day 1, wrote to Bob on day 2
    const alice = await signUp(t, 'ph_alice', 'Alice Example');
    // Bob, 20 days ago: tried the assistant on day 1, paired and wrote to Alice only on day 9 and 10
    const bob = await signUp(t, 'ph_bob', 'Bob Example');
    // Carol, 2 days ago: paired within the hour, nothing sent yet (still in her first week)
    const carol = await signUp(t, 'ph_carol', 'Carol Example');
    // Dave, 40 days ago: outside the cohort although he did everything
    const dave = await signUp(t, 'ph_dave', 'Dave Example');
    // Erin, 5 days ago: nothing yet
    const erin = await signUp(t, 'ph_erin', 'Erin Example');
    const aliceH = await pair(t, alice);
    const bobH = await pair(t, bob);
    const carolH = await pair(t, carol);
    const daveH = await pair(t, dave);
    await befriend(alice, bob);
    await befriend(dave, alice);
    await signedUpAgo(alice, 10);
    await signedUpAgo(bob, 20);
    await signedUpAgo(carol, 2);
    await signedUpAgo(dave, 40);
    await signedUpAgo(erin, 5);
    await pairedAfterSignup(aliceH, alice, 24);
    await pairedAfterSignup(bobH, bob, 9 * 24);
    await pairedAfterSignup(carolH, carol, 1);
    await pairedAfterSignup(daveH, dave, 1);
    await sentAfterSignup(await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'hi'), alice, 48);
    await sentAfterSignup(await send(bobH, [{ type: 'user', user_id: assistantId }], 'test'), bob, 24);
    await sentAfterSignup(await send(bobH, [{ type: 'user', user_id: alice.userId }], 'late'), bob, 10 * 24);
    await sentAfterSignup(await send(daveH, [{ type: 'user', user_id: alice.userId }], 'dave'), dave, 24);
    await sentAfterSignup(await send(daveH, [{ type: 'user', user_id: assistantId }], 'dave'), dave, 24);

    const { ph, body } = await health();
    expect(ph.activation).toEqual({
      signups_28d: 4, // alice, bob, carol, erin
      in_first_week: 2, // carol, erin
      paired_agent: 2, // alice, carol
      tried_assistant: 1, // bob
      sent_to_people: 1, // alice
    });
    for (const secret of ['ph_dave', 'ph_erin', 'Erin Example', erin.email])
      expect(body).not.toContain(secret);
  });

  it('read latency: median per recipient person, odd and even counts, unread and excluded messages left out', async () => {
    const alice = await signUp(t, 'ph_alice', 'Alice Example');
    const bob = await signUp(t, 'ph_bob', 'Bob Example');
    const carol = await signUp(t, 'ph_carol', 'Carol Example');
    const aliceH = await pair(t, alice);
    // Bob has two agents: a direct message reaches both, and still counts once for him
    const bobH = await pair(t, bob);
    await pair(t, bob, { harness: 'claude-code' });
    const carolH = await pair(t, carol);
    await befriend(alice, bob);
    const lab = await makeGroup(alice, aliceH, [
      [bob, bobH],
      [carol, carolH],
    ]);
    const toBob: Target[] = [{ type: 'user', user_id: bob.userId }];
    const a = await send(aliceH, toBob, 'A');
    await age(a, 5);
    const b = await send(aliceH, toBob, 'B');
    await age(b, 4);
    const c = await send(aliceH, toBob, 'C');
    await age(c, 4);
    const d = await send(aliceH, [{ type: 'group', group_id: lab }], 'D');
    await age(d, 3);
    // outside the window, the assistant, My space: never counted, even when read
    const old = await send(aliceH, toBob, 'old');
    await age(old, 10 * 24);
    await readAfter(old, bob, 5);
    const test = await send(aliceH, [{ type: 'user', user_id: assistantId }], 'test');
    await age(test, 2);
    const mine = await send(aliceH, [{ type: 'self' }], 'mine');
    await age(mine, 2);

    // delivered to Bob (A, B, C, D) and Carol (D); nobody read anything yet. Alice's own copy of D is not counted.
    let { ph } = await health();
    expect(ph.read_latency_7d).toEqual({ delivered: 5, read: 0, median_seconds: null });

    await readAfter(a, bob, 60);
    await readAfter(b, bob, 180);
    await readAfter(d, bob, 300);
    ({ ph } = await health());
    expect(ph.read_latency_7d).toEqual({ delivered: 5, read: 3, median_seconds: 180 });

    // even count: the mean of the two middle values
    await readAfter(c, bob, 420);
    ({ ph } = await health());
    expect(ph.read_latency_7d).toEqual({ delivered: 5, read: 4, median_seconds: 240 });

    // a person's earliest read mark on any of their agents' copies is the one that counts
    await t.db.drizzle.execute(sql`
      update deliveries set read_at = received_at + interval '30 seconds'
      where drop_id = ${a} and h_id = ${bobH.hId}`);
    await readAfter(d, carol, 600);
    ({ ph } = await health());
    // 30, 180, 300, 420, 600
    expect(ph.read_latency_7d).toEqual({ delivered: 5, read: 5, median_seconds: 300 });
  });
});
