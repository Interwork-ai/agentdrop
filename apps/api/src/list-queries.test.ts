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

interface SentDrop {
  title: string;
  recipients: Array<{ type: string; label: string; endpoint_count: number }>;
  recipient_status?: Array<{ type: string; label: string; member_count?: number }>;
}

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
    await send([{ type: 'user', user_id: user.userId }]);
  }

  async function send(targets: unknown[], title = 'the ablation run') {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(aliceH.credential),
      payload: {
        request_id: `q-${randomUUID()}`,
        targets,
        payload: {
          payload_version: 1,
          title,
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
  async function queriesForSentPage(
    limit: number,
    check: (drops: SentDrop[]) => void = (drops) =>
      expect(drops[0]?.recipients[0]?.label).toMatch(/^@(bob|carol|dave)$/),
  ): Promise<number> {
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
      check(res.json().drops);
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
    // the recipients of a page are rendered once and shared with its read receipts (it was twice: 26)
    expect(small).toBeLessThanOrEqual(25);
  });

  it('does not grow with group targets and published entries either (ADR 0013)', async () => {
    const [bob, carol] = people as [
      { user: BrowserUser; h: PairedEndpoint },
      { user: BrowserUser; h: PairedEndpoint },
    ];
    const created = await t.app.inject({
      method: 'POST',
      url: '/v1/me/groups',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: {
        slug: 'lab',
        display_name: 'Lab',
        binding_h_ids: [aliceH.hId],
        invite_handles: ['bob', 'carol'],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const groupId = created.json().group_id as string;
    for (const member of [bob, carol]) {
      const accepted = await t.app.inject({
        method: 'POST',
        url: `/v1/me/groups/${groupId}/accept`,
        headers: { cookie: member.user.cookie, origin: t.origin },
        payload: { h_ids: [member.h.hId] },
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
    }
    const published = await t.app.inject({
      method: 'POST',
      url: '/v1/me/routes',
      headers: { cookie: bob.user.cookie, origin: t.origin },
      payload: { alias: 'review', label: 'Review desk', h_id: bob.h.hId, visibility: 'contacts' },
    });
    expect(published.statusCode, published.body).toBe(200);
    const routeId = published.json().route_id as string;
    // newest first: the page always starts with the group, then the published entry, then a person
    for (let i = 0; i < 4; i++) {
      await sendTo(carol.user);
      await send([{ type: 'route', route_id: routeId }], 'to the entry');
      await send([{ type: 'group', group_id: groupId }], 'to the lab');
    }
    const check = (drops: SentDrop[]) => {
      const [group, entry, person] = drops;
      expect(group?.title).toBe('to the lab');
      expect(group?.recipients).toEqual([
        expect.objectContaining({ type: 'group', label: '#lab', endpoint_count: 2 }),
      ]);
      expect(group?.recipient_status).toEqual([expect.objectContaining({ type: 'group', member_count: 2 })]);
      expect(entry?.title).toBe('to the entry');
      expect(entry?.recipients).toEqual([
        expect.objectContaining({ label: '@bob/review', endpoint_count: 1 }),
      ]);
      expect(entry?.recipient_status).toEqual([expect.objectContaining({ label: '@bob/review' })]);
      expect(person?.recipients).toEqual([expect.objectContaining({ type: 'user', label: '@carol' })]);
    };
    const small = await queriesForSentPage(3, check);
    const large = await queriesForSentPage(12, check);
    expect(large).toBe(small);
    // group deliveries and published entries are looked up once per page, not once for recipients and again for
    // receipts (it was 31)
    expect(small).toBeLessThanOrEqual(28);
  });
});
