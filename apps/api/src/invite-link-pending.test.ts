import { randomUUID } from 'node:crypto';
import { contactInviteLinks, outboxEvents } from '@agentdrop/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type BrowserUser,
  createTestApp,
  hHeaders,
  pair,
  signUp,
  TEST_DATABASE_URL,
  type TestApp,
} from './testing/harness.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL)
  console.warn('[invite-link-pending.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

/**
 * ADR 0014: an invite link opened by someone with no paired agent leaves the owner's contact request on the server
 * (not in a browser); their pairing accepts it (ADR 0034, see invite-link-pairing.test.ts).
 */
describeDb('invite link accepted without a paired agent', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;

  const as = (u: BrowserUser) => ({ cookie: u.cookie, origin: t.origin });
  const get = (url: string, u: BrowserUser) => t.app.inject({ method: 'GET', url, headers: as(u) });
  const post = (url: string, u: BrowserUser, payload?: unknown) =>
    t.app.inject({ method: 'POST', url, headers: as(u), payload: payload ?? {} });
  const statusOf = async (u: BrowserUser, peerId: string) =>
    ((await get('/v1/me/contacts', u)).json().contacts as Array<{ user_id: string; status: string }>).find(
      (c) => c.user_id === peerId,
    )?.status;
  const useCount = async (linkId: string) =>
    (await t.db.drizzle.select().from(contactInviteLinks).where(eq(contactInviteLinks.id, linkId)))[0]
      ?.useCount;
  const requestsFor = async (userId: string) =>
    (
      await t.db.drizzle
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.type, 'contact.requested'), eq(outboxEvents.aggregateId, userId)))
    ).length;

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
    await pair(t, alice);
  });

  it('leaves a pending request both sides see; accepted on Contacts after pairing; reuse is idempotent', async () => {
    const link = (await post('/v1/me/invite-links', alice)).json() as { link_id: string; token: string };

    const first = await post(`/v1/me/invite/${link.token}/accept`, bob);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      created: false,
      pending: true,
      contact: { handle: 'alice', status: 'requested' },
    });
    expect(await statusOf(alice, bob.userId)).toBe('invited');
    expect(await statusOf(bob, alice.userId)).toBe('requested');
    expect(await useCount(link.link_id)).toBe(1);
    expect(await requestsFor(bob.userId)).toBe(1);

    // a second use (another browser, a reload) changes nothing and announces nothing again
    const second = await post(`/v1/me/invite/${link.token}/accept`, bob);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ created: false, pending: true, contact: { status: 'requested' } });
    expect(await useCount(link.link_id)).toBe(1);
    expect(await requestsFor(bob.userId)).toBe(1);

    // still no agent: the request waits
    const early = await post(`/v1/me/contacts/${alice.userId}/accept`, bob);
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('AGENT_REQUIRED');

    // pairing accepts the request the link left (ADR 0034); accepting it again by hand is a no-op
    const bobH = await pair(t, bob);
    expect(await statusOf(alice, bob.userId)).toBe('accepted');
    const accepted = await post(`/v1/me/contacts/${alice.userId}/accept`, bob);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().status).toBe('accepted');
    const sent = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(bobH.credential),
      payload: {
        request_id: randomUUID(),
        targets: [{ type: 'user', user_id: alice.userId }],
        payload: { payload_version: 1, title: 'hi', body: 'hello' },
      },
    });
    expect(sent.statusCode, sent.body).toBe(200);

    // and the link is a no-op now
    const after = await post(`/v1/me/invite/${link.token}/accept`, bob);
    expect(after.json()).toMatchObject({ created: false, pending: false, contact: { status: 'accepted' } });
    expect(await useCount(link.link_id)).toBe(1);
  });

  it('still refuses dead, own and blocked links without leaving a request', async () => {
    const link = (await post('/v1/me/invite-links', alice)).json() as { link_id: string; token: string };
    expect((await post(`/v1/me/invite/${link.token}/accept`, alice)).json().details.reason).toBe('self');

    await post(`/v1/me/contacts/${bob.userId}/block`, alice, { blocked: true });
    expect((await post(`/v1/me/invite/${link.token}/accept`, bob)).json().code).toBe('BLOCKED');
    await post(`/v1/me/contacts/${bob.userId}/block`, alice, { blocked: false });

    await post(`/v1/me/invite-links/${link.link_id}/revoke`, alice);
    const revoked = await post(`/v1/me/invite/${link.token}/accept`, bob);
    expect(revoked.statusCode).toBe(400);
    expect(revoked.json().details.reason).toBe('revoked');
    expect(await statusOf(bob, alice.userId)).toBeUndefined();
    expect(await useCount(link.link_id)).toBe(0);
    expect(await requestsFor(bob.userId)).toBe(0);
  });
});
