import { withTx } from '@agentdrop/db';
import { claimNoticeItem, getNoticeState, getSeenNoticeState } from '@agentdrop/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, hHeaders, pair, signUp, TEST_DATABASE_URL, type TestApp } from './testing/harness.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL)
  console.warn('[notice-state.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

const keys = (drops: string[]) => ({ drops, contacts: [], invitations: [], join_requests: [], approvals: 0 });

describeDb('shared notice record (ADR 0007)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  it('of agents claiming at the same moment, exactly one sees an item as new', async () => {
    const bob = await signUp(t, 'bob');
    // Paired concurrently on purpose: approving several pairings of one account at once used to deadlock.
    const agents = await Promise.all([
      pair(t, bob, { harness: 'codex' }),
      pair(t, bob, { harness: 'claude-code' }),
      pair(t, bob, { harness: 'opencode' }),
    ]);
    const claim = (credential: string, drops: string[]) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/h/notice-state/claim',
        headers: hHeaders(credential),
        payload: keys(drops),
      });
    const item = 'aaaaaaaaaaaaaaaa';
    // Ten claims from three agents race for the same new item.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => claim(agents[i % 3]?.credential ?? '', [item])),
    );
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    const sawItNew = results.filter((r) => !(r.json().previous?.drops ?? []).includes(item));
    expect(sawItNew).toHaveLength(1);
    // A later item is new again, once; the record keeps both.
    const next = await claim(agents[1]?.credential ?? '', [item, 'bbbbbbbbbbbbbbbb']);
    expect(next.json().previous.drops).toEqual([item]);
    const state = await t.app.inject({
      method: 'GET',
      url: '/v1/h/notice-state',
      headers: hHeaders(agents[2]?.credential ?? ''),
    });
    expect(state.json().state.drops).toEqual([item, 'bbbbbbbbbbbbbbbb']);
    // Anything that is not a 16-hex-digit hash is refused: names and ids never reach the record.
    const bad = await claim(agents[0]?.credential ?? '', ['alice']);
    expect(bad.statusCode).toBe(400);
  });

  it('records are per person', async () => {
    const [alice, bob] = [await signUp(t, 'alice'), await signUp(t, 'bob')];
    const [a, b] = [await pair(t, alice), await pair(t, bob)];
    const claim = (credential: string) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/h/notice-state/claim',
        headers: hHeaders(credential),
        payload: keys(['cccccccccccccccc']),
      });
    expect((await claim(a.credential)).json().previous).toBeNull();
    expect((await claim(b.credential)).json().previous).toBeNull();
  });

  describe('seen in an agent', () => {
    const A = 'aaaaaaaaaaaaaaaa';
    const B = 'bbbbbbbbbbbbbbbb';
    const C = 'cccccccccccccccc';
    const seen = (credential: string) =>
      t.app.inject({ method: 'GET', url: '/v1/h/notice-state/seen', headers: hHeaders(credential) });
    const claimSeen = (credential: string, payload: unknown) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/h/notice-state/seen/claim',
        headers: hHeaders(credential),
        payload: payload as Record<string, unknown>,
      });

    it('starts empty, returns the previous seen record and merges, shared by every agent', async () => {
      const bob = await signUp(t, 'bob');
      const [codex, claude] = [await pair(t, bob), await pair(t, bob, { harness: 'claude-code' })];
      const fresh = await seen(codex.credential);
      expect(fresh.statusCode, fresh.body).toBe(200);
      expect(fresh.json()).toEqual({ state: null });

      const first = await claimSeen(codex.credential, keys([A]));
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toEqual({ previous: null });
      const second = await claimSeen(claude.credential, keys([B]));
      expect(second.json().previous.drops).toEqual([A]);
      expect((await seen(codex.credential)).json().state.drops).toEqual([A, B]);
    });

    it('also records the items as shown in the shared record', async () => {
      const bob = await signUp(t, 'bob');
      const agent = await pair(t, bob);
      await t.app.inject({
        method: 'POST',
        url: '/v1/h/notice-state/claim',
        headers: hHeaders(agent.credential),
        payload: keys([A]),
      });
      await claimSeen(agent.credential, keys([B]));
      const shown = await withTx(t.db, (tx) => getNoticeState(tx, bob.userId));
      expect(shown.state?.drops).toEqual([A, B]);
      // The seen record holds only what an agent session saw.
      expect((await seen(agent.credential)).json().state.drops).toEqual([B]);
    });

    it('push and Feishu claims never write the seen record', async () => {
      const bob = await signUp(t, 'bob');
      const agent = await pair(t, bob);
      expect(await withTx(t.db, (tx) => claimNoticeItem(tx, bob.userId, 'drops', A))).toBe(true);
      expect((await withTx(t.db, (tx) => getNoticeState(tx, bob.userId))).state?.drops).toEqual([A]);
      expect((await withTx(t.db, (tx) => getSeenNoticeState(tx, bob.userId))).state).toBeNull();
      // So the agent still sees the item as new once.
      expect((await claimSeen(agent.credential, keys([A]))).json().previous).toBeNull();
      expect((await claimSeen(agent.credential, keys([A]))).json().previous.drops).toEqual([A]);
    });

    it('of agents claiming at the same moment, exactly one sees an item as new', async () => {
      const bob = await signUp(t, 'bob');
      const agents = await Promise.all([
        pair(t, bob, { harness: 'codex' }),
        pair(t, bob, { harness: 'claude-code' }),
        pair(t, bob, { harness: 'opencode' }),
      ]);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => claimSeen(agents[i % 3]?.credential ?? '', keys([C]))),
      );
      for (const r of results) expect(r.statusCode, r.body).toBe(200);
      expect(results.filter((r) => !(r.json().previous?.drops ?? []).includes(C))).toHaveLength(1);
    });

    it('refuses an invalid body or query and touches nothing', async () => {
      const bob = await signUp(t, 'bob');
      const agent = await pair(t, bob);
      const bad = await claimSeen(agent.credential, keys(['alice']));
      expect(bad.statusCode).toBe(400);
      expect(bad.json().code).toBe('VALIDATION_FAILED');
      const missing = await claimSeen(agent.credential, { drops: [A] });
      expect(missing.json().code).toBe('VALIDATION_FAILED');
      const query = await t.app.inject({
        method: 'GET',
        url: '/v1/h/notice-state/seen?user_id=x',
        headers: hHeaders(agent.credential),
      });
      expect(query.json().code).toBe('VALIDATION_FAILED');
      expect((await seen(agent.credential)).json().state).toBeNull();
      expect((await withTx(t.db, (tx) => getNoticeState(tx, bob.userId))).state).toBeNull();
    });

    it('needs an agent credential', async () => {
      const bob = await signUp(t, 'bob');
      const res = await t.app.inject({
        method: 'GET',
        url: '/v1/h/notice-state/seen',
        headers: { cookie: bob.cookie, origin: t.origin },
      });
      expect(res.statusCode).toBe(401);
    });

    it('leaves other accounts untouched', async () => {
      const [alice, bob] = [await signUp(t, 'alice'), await signUp(t, 'bob')];
      const [a, b] = [await pair(t, alice), await pair(t, bob)];
      await claimSeen(a.credential, keys([A]));
      expect((await seen(b.credential)).json().state).toBeNull();
      expect((await withTx(t.db, (tx) => getNoticeState(tx, bob.userId))).state).toBeNull();
      expect((await claimSeen(b.credential, keys([A]))).json().previous).toBeNull();
    });
  });
});
