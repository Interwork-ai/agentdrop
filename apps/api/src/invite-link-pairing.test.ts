import { randomUUID } from 'node:crypto';
import { contactInviteLinks, contacts, outboxEvents } from '@agentdrop/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type BrowserUser,
  createTestApp,
  extractCookies,
  hHeaders,
  pair,
  signUp,
  TEST_DATABASE_URL,
  type TestApp,
} from './testing/harness.js';

/**
 * ADR 0034: someone who opens an invite link before they have an agent is connected as soon as they pair one. Only
 * requests that came from a still-live link are accepted on pairing; the inviter hears it as an ordinary accepted
 * request, naming the person and nothing about their agents (ADR 0013).
 */
describe.skipIf(!TEST_DATABASE_URL)('invite link accepted on the first pairing', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;

  type ContactRow = { user_id: string; status: string; from_invite_link?: boolean } & Record<string, unknown>;
  const as = (u: BrowserUser) => ({ cookie: u.cookie, origin: t.origin });
  const get = (url: string, u: BrowserUser) => t.app.inject({ method: 'GET', url, headers: as(u) });
  const post = (url: string, u: BrowserUser, payload?: unknown) =>
    t.app.inject({ method: 'POST', url, headers: as(u), payload: payload ?? {} });
  const contactOf = async (u: BrowserUser, peerId: string) =>
    ((await get('/v1/me/contacts', u)).json().contacts as ContactRow[]).find((c) => c.user_id === peerId);
  const statusOf = async (u: BrowserUser, peerId: string) => (await contactOf(u, peerId))?.status;
  const acceptedNotices = async (userId: string) =>
    t.db.drizzle
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, 'contact.accepted'), eq(outboxEvents.aggregateId, userId)));
  const createLink = async (u: BrowserUser) => {
    const res = await post('/v1/me/invite-links', u);
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { link_id: string; token: string };
  };
  const openLink = async (u: BrowserUser, token: string) => {
    const res = await post(`/v1/me/invite/${token}/accept`, u);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { created: boolean; pending: boolean; contact: ContactRow };
  };
  const rowVersions = async () =>
    (await t.db.drizzle.select().from(contacts))
      .map((c) => `${c.ownerUserId}:${c.status}:${c.version}`)
      .sort();
  const sendTo = async (credential: string, userId: string) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(credential),
      payload: {
        request_id: randomUUID(),
        targets: [{ type: 'user', user_id: userId }],
        payload: { payload_version: 1, title: 'the ablation run', body: 'numbers attached later' },
      },
    });

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

  it('accepts the request when the invitee pairs, tells the inviter once, and a second pairing changes nothing', async () => {
    const link = await createLink(alice);
    const opened = await openLink(bob, link.token);
    expect(opened).toMatchObject({ created: false, pending: true, contact: { status: 'requested' } });
    // both people see that this request will complete on its own
    expect(await contactOf(bob, alice.userId)).toMatchObject({ status: 'requested', from_invite_link: true });
    expect(await contactOf(alice, bob.userId)).toMatchObject({ status: 'invited', from_invite_link: true });
    expect(await acceptedNotices(alice.userId)).toHaveLength(0);

    const bobH = await pair(t, bob, { harness: 'claude-code', endpointLabel: 'Secret lab laptop' });
    expect(await statusOf(bob, alice.userId)).toBe('accepted');
    expect(await statusOf(alice, bob.userId)).toBe('accepted');
    expect((await contactOf(alice, bob.userId))?.from_invite_link).toBe(false);

    // the inviter hears it the usual way, naming the person only
    const notices = await acceptedNotices(alice.userId);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toEqual({
      user_id: alice.userId,
      from_handle: 'bob',
      from_display_name: 'Bob',
    });
    // nothing about bob's agent reaches alice: not in the notice, not in her contact view
    const aliceView = JSON.stringify(await get('/v1/me/contacts', alice).then((r) => r.json()));
    for (const leak of ['Secret lab laptop', 'claude-code', bobH.hId]) {
      expect(JSON.stringify(notices)).not.toContain(leak);
      expect(aliceView).not.toContain(leak);
    }

    // they can message each other now, in both directions
    expect((await sendTo(bobH.credential, alice.userId)).statusCode).toBe(200);

    // idempotent: another pairing (a second agent) changes no row and announces nothing again
    const before = await rowVersions();
    await pair(t, bob, { harness: 'codex' });
    expect(await rowVersions()).toEqual(before);
    expect(await acceptedNotices(alice.userId)).toHaveLength(1);
    // reopening the link is a no-op, counted once
    expect(await openLink(bob, link.token)).toMatchObject({ created: false, pending: false });
    expect(
      (await t.db.drizzle.select().from(contactInviteLinks).where(eq(contactInviteLinks.id, link.link_id)))[0]
        ?.useCount,
    ).toBe(1);
  });

  it('also completes a sign-up through the link once the new account pairs', async () => {
    const link = await createLink(alice);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      headers: { origin: t.origin },
      payload: {
        email: 'wang@example.test',
        password: 'correct-horse-battery-staple',
        handle: 'wang',
        display_name: 'Wang',
        invite_token: link.token,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().invite).toEqual({ accepted: false, pending: true, inviter_handle: 'alice' });
    const wang: BrowserUser = {
      email: 'wang@example.test',
      handle: 'wang',
      userId: res.json().user_id,
      cookie: extractCookies(res.headers['set-cookie']),
    };
    expect(await statusOf(wang, alice.userId)).toBe('requested');
    await pair(t, wang);
    expect(await statusOf(wang, alice.userId)).toBe('accepted');
    expect(await statusOf(alice, wang.userId)).toBe('accepted');
    expect(await acceptedNotices(alice.userId)).toHaveLength(1);
  });

  it('leaves requests made by handle pending, and accepts a handle request the invitee then confirmed by link', async () => {
    const carol = await signUp(t, 'carol', 'Carol');
    const mia = await signUp(t, 'mia', 'Mia');
    await pair(t, carol);
    await pair(t, mia);
    // carol asks by handle only
    expect((await post('/v1/me/contacts/invite', carol, { handle: 'bob' })).statusCode).toBe(200);
    // mia asks by handle, and bob then opens mia's link too: opening it is bob saying yes
    expect((await post('/v1/me/contacts/invite', mia, { handle: 'bob' })).statusCode).toBe(200);
    const miaLink = await createLink(mia);
    expect(await openLink(bob, miaLink.token)).toMatchObject({ pending: true });
    // alice's link
    const link = await createLink(alice);
    await openLink(bob, link.token);
    expect((await contactOf(bob, carol.userId))?.from_invite_link).toBe(false);

    await pair(t, bob);
    expect(await statusOf(bob, alice.userId)).toBe('accepted');
    expect(await statusOf(bob, mia.userId)).toBe('accepted');
    expect(await statusOf(bob, carol.userId)).toBe('requested');
    expect(await statusOf(carol, bob.userId)).toBe('invited');
    expect(await acceptedNotices(carol.userId)).toHaveLength(0);
    // still the person's choice
    const accept = await post(`/v1/me/contacts/${carol.userId}/accept`, bob);
    expect(accept.statusCode, accept.body).toBe(200);
  });

  it('accepts nothing from a link revoked or expired before the pairing, or across a block', async () => {
    const carol = await signUp(t, 'carol', 'Carol');
    const mia = await signUp(t, 'mia', 'Mia');
    await pair(t, carol);
    await pair(t, mia);
    const revoked = await createLink(alice);
    const expired = await createLink(carol);
    const blocked = await createLink(mia);
    await openLink(bob, revoked.token);
    await openLink(bob, expired.token);
    await openLink(bob, blocked.token);
    expect((await post(`/v1/me/invite-links/${revoked.link_id}/revoke`, alice)).statusCode).toBe(200);
    await t.db.drizzle
      .update(contactInviteLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(contactInviteLinks.id, expired.link_id));
    expect((await post(`/v1/me/contacts/${bob.userId}/block`, mia, { blocked: true })).statusCode).toBe(200);
    // nobody is promised a connection the pairing will not make
    for (const [u, peer] of [
      [bob, alice],
      [alice, bob],
      [bob, carol],
      [carol, bob],
    ] as const)
      expect((await contactOf(u, peer.userId))?.from_invite_link).toBe(false);

    await pair(t, bob);
    expect(await statusOf(bob, alice.userId)).toBe('requested');
    expect(await statusOf(bob, carol.userId)).toBe('requested');
    expect(await statusOf(alice, bob.userId)).toBe('invited');
    expect(await statusOf(carol, bob.userId)).toBe('invited');
    expect(await statusOf(mia, bob.userId)).toBe('blocked');
    for (const u of [alice, carol, mia]) expect(await acceptedNotices(u.userId)).toHaveLength(0);
    // the waiting requests are still bob's to accept by hand
    expect((await post(`/v1/me/contacts/${alice.userId}/accept`, bob)).json().status).toBe('accepted');
  });

  it('keeps the immediate accept for someone who already has an agent', async () => {
    await pair(t, bob);
    const link = await createLink(alice);
    expect(await openLink(bob, link.token)).toMatchObject({
      created: true,
      pending: false,
      contact: { status: 'accepted', from_invite_link: false },
    });
    expect(await acceptedNotices(alice.userId)).toHaveLength(1);
    // a later pairing finds nothing to do
    await pair(t, bob, { harness: 'opencode' });
    expect(await acceptedNotices(alice.userId)).toHaveLength(1);
  });

  it('forgets the link when the inviter asks again by handle after a removal', async () => {
    const link = await createLink(alice);
    await openLink(bob, link.token);
    // bob declines: the request is gone
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/v1/me/contacts/${alice.userId}`, headers: as(bob) }))
        .statusCode,
    ).toBe(200);
    expect(await statusOf(bob, alice.userId)).toBeUndefined();
    // alice asks by handle: an ordinary request, which pairing does not accept
    expect((await post('/v1/me/contacts/invite', alice, { handle: 'bob' })).statusCode).toBe(200);
    expect((await contactOf(bob, alice.userId))?.from_invite_link).toBe(false);
    await pair(t, bob);
    expect(await statusOf(bob, alice.userId)).toBe('requested');
  });
});
