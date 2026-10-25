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
 * A list page costs a fixed number of queries, whatever it shows: rendering who each drop went to, its read receipts,
 * replies and requests is done for the whole page at once, never once per drop (it was, through privateRecipients).
 */
describeDb('a list page costs a fixed number of queries', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let aliceH: PairedEndpoint;
  let people: Array<{ user: BrowserUser; h: PairedEndpoint }>;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice', 'Alice');
    aliceH = await pair(t, alice, { harness: 'codex' });
    people = [];
    for (const name of ['bob', 'carol', 'dave']) {
      const user = await signUp(t, name, name);
      people.push({ user, h: await pair(t, user, { harness: 'codex' }) });
      await t.app.inject({
        method: 'POST',
        url: '/v1/me/contacts/invite',
        headers: { cookie: alice.cookie, origin: t.origin },
        payload: { handle: name },
      });
      await t.app.inject({
        method: 'POST',
        url: `/v1/me/contacts/${alice.userId}/accept`,
        headers: { cookie: user.cookie, origin: t.origin },
      });
    }
  });

  async function sendTo(user: BrowserUser) {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(aliceH.credential),
      payload: {
        request_id: `q-${randomUUID()}`,
        targets: [{ type: 'user', user_id: user.userId }],
        payload: {
          payload_version: 1,
          title: 'the ablation run',
          body: 'seed 7',
          attachment_ids: [],
          extensions: {},
        },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  /**
   * Queries run while listing Alice's sent drops: every query goes through a client checked out of the pool, so each
   * client checked out meanwhile is counted once per query and put back as it was afterwards.
   */
  async function queriesForSentPage(limit: number): Promise<number> {
    let count = 0;
    type Client = Parameters<Parameters<TestApp['db']['pool']['on']>[1]>[0] & { query: unknown };
    const originals = new Map<Client, unknown>();
    const onAcquire = (client: Client) => {
      if (originals.has(client)) return;
      const query = client.query;
      originals.set(client, query);
      (client as { query: unknown }).query = (...args: unknown[]) => {
        count += 1;
        return (query as (...a: unknown[]) => unknown).apply(client, args);
      };
    };
    t.db.pool.on('acquire', onAcquire);
    try {
      const res = await t.app.inject({
        method: 'GET',
        url: `/v1/h/drops?view=sent&limit=${limit}`,
        headers: hHeaders(aliceH.credential),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().drops).toHaveLength(limit);
      expect(res.json().drops[0].recipients[0].label).toMatch(/^@(bob|carol|dave)$/);
    } finally {
      t.db.pool.off('acquire', onAcquire);
      for (const [client, query] of originals) (client as { query: unknown }).query = query;
    }
    return count;
  }

  it('does not grow with the number of drops on the page', async () => {
    for (let i = 0; i < 12; i++) await sendTo((people[i % people.length] as { user: BrowserUser }).user);
    const small = await queriesForSentPage(2);
    const large = await queriesForSentPage(12);
    expect(large).toBe(small);
  });
});
