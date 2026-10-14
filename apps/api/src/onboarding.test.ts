import { randomUUID } from 'node:crypto';
import { appUsers, authUsers, contactInviteLinks, contacts, drops, withTx } from '@agentdrop/db';
import {
  ensureSystemAssistant,
  getSystemAssistant,
  replyAsAssistant,
  SYSTEM_ASSISTANT_HANDLE,
  setSignupMode,
} from '@agentdrop/domain';
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

describe.skipIf(!TEST_DATABASE_URL)('onboarding: invite links and the @agentdrop assistant', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;

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
    paired.clear();
  });

  const as = (u: BrowserUser) => ({ cookie: u.cookie, origin: t.origin });
  const get = (url: string, u?: BrowserUser) =>
    t.app.inject({ method: 'GET', url, ...(u ? { headers: as(u) } : {}) });
  const post = (url: string, u: BrowserUser, payload?: unknown) =>
    t.app.inject({ method: 'POST', url, headers: as(u), payload: payload ?? {} });
  /** Relationships need a paired agent (AGENT_REQUIRED); only these tests' people who act get one. */
  const paired = new Map<string, PairedEndpoint>();
  const ensureAgent = async (u: BrowserUser) => {
    const known = paired.get(u.userId);
    if (known) return known;
    const h = await pair(t, u);
    paired.set(u.userId, h);
    return h;
  };
  const createLink = async (u: BrowserUser) => {
    await ensureAgent(u);
    const res = await post('/v1/me/invite-links', u);
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { link_id: string; token: string; url: string; use_count: number };
  };
  const contactOf = async (u: BrowserUser, peerId: string) => {
    const list = (await get('/v1/me/contacts', u)).json().contacts as Array<{
      user_id: string;
      status: string;
      handle: string;
      is_system: boolean;
    }>;
    return list.find((c) => c.user_id === peerId);
  };
  const send = (from: PairedEndpoint, targets: unknown[], title: string, requestId = randomUUID()) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(from.credential),
      payload: { request_id: requestId, targets, payload: { payload_version: 1, title, body: '你好，测试' } },
    });
  const assistant = async () => {
    const a = await getSystemAssistant(t.db.drizzle);
    if (!a) throw new Error('assistant missing');
    return a;
  };
  const reply = (dropId: string) => withTx(t.db, (tx) => replyAsAssistant(tx, dropId));

  /* ------------------------------------------------------------------ invite links */

  it('creates, lists and revokes links; the plain token is only in the create response', async () => {
    const link = await createLink(alice);
    expect(link.url).toBe(`http://web.test/invite/${link.token}`);
    const listed = (await get('/v1/me/invite-links', alice)).json().links;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ link_id: link.link_id, status: 'active', use_count: 0 });
    expect(JSON.stringify(listed)).not.toContain(link.token);
    const [row] = await t.db.drizzle.select().from(contactInviteLinks);
    expect(row?.tokenHash).not.toBe(link.token);
    // bob cannot list or revoke alice's link
    expect((await get('/v1/me/invite-links', bob)).json().links).toHaveLength(0);
    expect((await post(`/v1/me/invite-links/${link.link_id}/revoke`, bob)).statusCode).toBe(404);
    const revoked = await post(`/v1/me/invite-links/${link.link_id}/revoke`, alice);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe('revoked');
    // signed-out creation is refused
    expect((await t.app.inject({ method: 'POST', url: '/v1/me/invite-links', payload: {} })).statusCode).toBe(
      403,
    );
  });

  it('allows at most five active links', async () => {
    const links = [];
    for (let i = 0; i < 5; i++) links.push(await createLink(alice));
    const sixth = await post('/v1/me/invite-links', alice);
    expect(sixth.statusCode).toBe(400);
    await post(`/v1/me/invite-links/${links[0]?.link_id}/revoke`, alice);
    expect((await post('/v1/me/invite-links', alice)).statusCode).toBe(201);
  });

  it('previews publicly with only the inviter name and validity', async () => {
    const link = await createLink(alice);
    const preview = await get(`/v1/invite/${link.token}`);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({
      valid: true,
      reason: null,
      inviter: { handle: 'alice', display_name: 'Alice' },
      expires_at: expect.any(String),
    });
    expect((await get(`/v1/invite/${'x'.repeat(43)}`)).statusCode).toBe(404);
    expect((await get('/v1/invite/bad token')).statusCode).toBe(404);
    await post(`/v1/me/invite-links/${link.link_id}/revoke`, alice);
    expect((await get(`/v1/invite/${link.token}`)).json()).toMatchObject({ valid: false, reason: 'revoked' });
  });

  it('accepting a valid link makes both sides accepted contacts and can be reused by several people', async () => {
    const link = await createLink(alice);
    const bobH = await ensureAgent(bob);
    const res = await post(`/v1/me/invite/${link.token}/accept`, bob);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ created: true, contact: { handle: 'alice', status: 'accepted' } });
    expect((await contactOf(alice, bob.userId))?.status).toBe('accepted');
    expect((await contactOf(bob, alice.userId))?.status).toBe('accepted');
    // they can now send to each other
    expect((await send(bobH, [{ type: 'user', user_id: alice.userId }], 'hi')).statusCode).toBe(200);

    // already contacts: no-op, use_count unchanged
    const again = await post(`/v1/me/invite/${link.token}/accept`, bob);
    expect(again.json().created).toBe(false);
    const carol = await signUp(t, 'carol', 'Carol');
    await ensureAgent(carol);
    expect((await post(`/v1/me/invite/${link.token}/accept`, carol)).json().created).toBe(true);
    const [row] = await t.db.drizzle.select().from(contactInviteLinks);
    expect(row?.useCount).toBe(2);
  });

  it('accepting turns a pending handle invitation into an accepted pair', async () => {
    await ensureAgent(bob);
    await post('/v1/me/contacts/invite', bob, { handle: 'alice' });
    const link = await createLink(alice);
    expect((await post(`/v1/me/invite/${link.token}/accept`, bob)).json().created).toBe(true);
    expect((await contactOf(alice, bob.userId))?.status).toBe('accepted');
    expect((await contactOf(bob, alice.userId))?.status).toBe('accepted');
  });

  it('refuses expired, revoked and own links, and blocks from either side', async () => {
    const link = await createLink(alice);
    await ensureAgent(bob);
    const self = await post(`/v1/me/invite/${link.token}/accept`, alice);
    expect(self.statusCode).toBe(400);
    expect(self.json().details.reason).toBe('self');

    await t.db.drizzle
      .update(contactInviteLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(contactInviteLinks.id, link.link_id));
    const expired = await post(`/v1/me/invite/${link.token}/accept`, bob);
    expect(expired.statusCode).toBe(400);
    expect(expired.json().details.reason).toBe('expired');
    expect((await get(`/v1/invite/${link.token}`)).json()).toMatchObject({ valid: false, reason: 'expired' });

    const revokedLink = await createLink(alice);
    await post(`/v1/me/invite-links/${revokedLink.link_id}/revoke`, alice);
    const revoked = await post(`/v1/me/invite/${revokedLink.token}/accept`, bob);
    expect(revoked.json().details.reason).toBe('revoked');

    // alice blocked bob
    const live = await createLink(alice);
    await post(`/v1/me/contacts/${bob.userId}/block`, alice, { blocked: true });
    const blockedByOwner = await post(`/v1/me/invite/${live.token}/accept`, bob);
    expect(blockedByOwner.json().code).toBe('BLOCKED');
    await post(`/v1/me/contacts/${bob.userId}/block`, alice, { blocked: false });
    // bob blocked alice
    await post(`/v1/me/contacts/${alice.userId}/block`, bob, { blocked: true });
    const blockedByVisitor = await post(`/v1/me/invite/${live.token}/accept`, bob);
    expect(blockedByVisitor.json().code).toBe('BLOCKED');
    expect(
      (await t.db.drizzle.select().from(contactInviteLinks).where(eq(contactInviteLinks.id, live.link_id)))[0]
        ?.useCount,
    ).toBe(0);
    expect((await get('/v1/me/invite/nope/accept', bob)).statusCode).toBe(404);
  });

  it('sign-up with invite_token connects both accounts; a bad token does not fail sign-up', async () => {
    const link = await createLink(alice);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      headers: { origin: t.origin },
      payload: {
        email: 'dave@example.test',
        password: 'correct-horse-battery-staple',
        handle: 'dave',
        display_name: 'Dave',
        invite_token: link.token,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    // a brand-new account has no agent yet: sign-up succeeds and alice's request waits for dave (ADR 0014)
    expect(res.json().invite).toEqual({ accepted: false, pending: true, inviter_handle: 'alice' });
    expect((await contactOf(alice, res.json().user_id))?.status).toBe('invited');
    const dave = {
      email: 'dave@example.test',
      handle: 'dave',
      userId: res.json().user_id as string,
      cookie: (res.headers['set-cookie'] as string[] | string | undefined)
        ? ([] as string[])
            .concat(res.headers['set-cookie'] as string[] | string)
            .map((c) => c.split(';')[0])
            .join('; ')
        : '',
    };
    expect((await contactOf(dave, alice.userId))?.status).toBe('requested');
    // pairing accepts the waiting request (ADR 0034); reopening the link is a no-op, the use was counted once
    await ensureAgent(dave);
    expect((await contactOf(alice, dave.userId))?.status).toBe('accepted');
    expect((await post(`/v1/me/invite/${link.token}/accept`, dave)).json()).toMatchObject({
      created: false,
      pending: false,
    });
    expect(
      (await t.db.drizzle.select().from(contactInviteLinks).where(eq(contactInviteLinks.id, link.link_id)))[0]
        ?.useCount,
    ).toBe(1);

    const bad = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      headers: { origin: t.origin },
      payload: {
        email: 'erin@example.test',
        password: 'correct-horse-battery-staple',
        handle: 'erin',
        display_name: 'Erin',
        invite_token: 'x'.repeat(43),
      },
    });
    expect(bad.statusCode, bad.body).toBe(201);
    expect(bad.json().invite).toEqual({ accepted: false, code: 'NOT_FOUND' });
    // a dead link is refused on sign-up exactly as before, without leaving a request
    await post(`/v1/me/invite-links/${link.link_id}/revoke`, alice);
    const late = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      headers: { origin: t.origin },
      payload: {
        email: 'gina@example.test',
        password: 'correct-horse-battery-staple',
        handle: 'gina',
        display_name: 'Gina',
        invite_token: link.token,
      },
    });
    expect(late.json().invite).toEqual({ accepted: false, code: 'VALIDATION_FAILED' });
    expect(await contactOf(alice, late.json().user_id)).toBeUndefined();
  });

  it('a closed server stays closed even with a valid invite link', async () => {
    const link = await createLink(alice);
    await withTx(t.db, (tx) => setSignupMode(tx, alice.userId, 'closed'));
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      headers: { origin: t.origin },
      payload: {
        email: 'frank@example.test',
        password: 'correct-horse-battery-staple',
        handle: 'frank',
        display_name: 'Frank',
        invite_token: link.token,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('SIGNUP_DISABLED');
  });

  /* ------------------------------------------------------------------ the @agentdrop assistant */

  it('every new account has the assistant as an accepted contact', async () => {
    const a = await assistant();
    const c = await contactOf(alice, a.userId);
    expect(c).toMatchObject({ handle: SYSTEM_ASSISTANT_HANDLE, status: 'accepted', is_system: true });
    const [theirs] = await t.db.drizzle
      .select()
      .from(contacts)
      .where(and(eq(contacts.ownerUserId, a.userId), eq(contacts.peerUserId, alice.userId)));
    expect(theirs?.status).toBe('accepted');
  });

  it('existing accounts are backfilled when the assistant is first created, once', async () => {
    await t.reset();
    const ids = ['old1', 'old2'].map((n) => `${n}-${randomUUID()}`);
    await t.db.drizzle
      .insert(authUsers)
      .values(ids.map((id) => ({ id, name: id, email: `${id}@example.test` })));
    const users = await t.db.drizzle
      .insert(appUsers)
      .values(ids.map((id, i) => ({ authUserId: id, handle: `old${i}`, displayName: `Old ${i}` })))
      .returning();
    const created = await withTx(t.db, (tx) => ensureSystemAssistant(tx));
    const again = await withTx(t.db, (tx) => ensureSystemAssistant(tx));
    expect(again).toEqual(created);
    for (const u of users) {
      const rows = await t.db.drizzle.select().from(contacts).where(eq(contacts.ownerUserId, u.id));
      expect(rows).toEqual([expect.objectContaining({ peerUserId: created?.userId, status: 'accepted' })]);
    }
    // a user who removed it does not get it back on the next boot
    const first = users[0];
    if (!first || !created) throw new Error('fixture');
    await t.db.drizzle.delete(contacts).where(eq(contacts.ownerUserId, first.id));
    await withTx(t.db, (tx) => ensureSystemAssistant(tx));
    expect(await t.db.drizzle.select().from(contacts).where(eq(contacts.ownerUserId, first.id))).toEqual([]);
  });

  it('concurrent creation yields one assistant', async () => {
    await t.reset();
    const results = await Promise.all([
      withTx(t.db, (tx) => ensureSystemAssistant(tx)),
      withTx(t.db, (tx) => ensureSystemAssistant(tx)),
    ]);
    expect(results[0]).toEqual(results[1]);
    const rows = await t.db.drizzle.select().from(appUsers).where(eq(appUsers.isSystem, true));
    expect(rows).toHaveLength(1);
  });

  it('can be sent to; replies once to the sending agent even when replayed; never answers itself', async () => {
    const a = await assistant();
    const aliceCodex = await pair(t, alice, { harness: 'codex' });
    const aliceClaude = await pair(t, alice, { harness: 'claude-code', makeDefault: false });
    const res = await send(aliceClaude, [{ type: 'user', user_id: a.userId }], '第一条测试');
    expect(res.statusCode, res.body).toBe(200);
    const dropId = res.json().drop_id as string;
    // test traffic expires after 30 days
    const [sent] = await t.db.drizzle.select().from(drops).where(eq(drops.id, dropId));
    const ttl = (sent?.expiresAt?.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(29 * 24 * 3600 * 1000);
    expect(ttl).toBeLessThanOrEqual(30 * 24 * 3600 * 1000);

    const first = await reply(dropId);
    expect(first.replied).toBe(true);
    expect(await reply(dropId)).toEqual({ replied: false, reason: 'already_replied' });
    if (!first.replied) throw new Error('no reply');
    expect(await reply(first.dropId)).toEqual({ replied: false, reason: 'own_drop' });

    // the receipt lands on the agent that sent (claude), not on the default receiver (codex)
    const inbox = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?view=inbox&endpoint_scope=current',
      headers: hHeaders(aliceClaude.credential),
    });
    const titles = inbox.json().drops.map((d: { title: string }) => d.title);
    expect(titles).toEqual(['回执：第一条测试']);
    const codexInbox = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?view=inbox&endpoint_scope=current',
      headers: hHeaders(aliceCodex.credential),
    });
    expect(codexInbox.json().drops).toHaveLength(0);
    const detail = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${first.dropId}`,
      headers: hHeaders(aliceClaude.credential),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json().drop.body_chunk as string;
    expect(body).toContain('第一条测试');
    expect(body).toContain('正文：5 个字符');
    expect(body).toContain('附件：无');
    expect(body).toContain('去网页联系人页生成邀请链接');
    expect(detail.json().drop.expires_at).not.toBeNull();

    // having answered, the assistant counts as having read the original: the sender sees "已读"
    const sentView = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?view=sent',
      headers: hHeaders(aliceClaude.credential),
    });
    const original = sentView.json().drops.find((d: { drop_id: string }) => d.drop_id === dropId);
    expect(original.recipient_status[0].read_at).not.toBeNull();
  });

  it('does not answer group sends, and cannot be invited into a group', async () => {
    const aliceH = await pair(t, alice);
    const created = await post('/v1/me/groups', alice, {
      slug: 'team',
      display_name: 'Team',
      binding_h_ids: [aliceH.hId],
    });
    expect(created.statusCode, created.body).toBe(200);
    const groupId = created.json().group_id;
    const inv = await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: SYSTEM_ASSISTANT_HANDLE });
    expect(inv.statusCode).toBe(400);
    const res = await send(aliceH, [{ type: 'group', group_id: groupId }], 'group only');
    expect(res.statusCode, res.body).toBe(200);
    expect(await reply(res.json().drop_id)).toEqual({ replied: false, reason: 'not_addressed' });
    // a group-involving send is not capped to 30 days
    const [row] = await t.db.drizzle.select().from(drops).where(eq(drops.id, res.json().drop_id));
    expect(row?.expiresAt).toBeNull();
  });

  it('can be removed, blocked and re-added like a contact', async () => {
    const a = await assistant();
    const aliceH = await pair(t, alice);
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/v1/me/contacts/${a.userId}`, headers: as(alice) }))
        .statusCode,
    ).toBe(200);
    expect((await send(aliceH, [{ type: 'user', user_id: a.userId }], 'x')).json().code).toBe(
      'NOT_A_CONTACT',
    );
    const readd = await post('/v1/me/contacts/invite', alice, { handle: SYSTEM_ASSISTANT_HANDLE });
    expect(readd.json().status).toBe('accepted');
    const ok = await send(aliceH, [{ type: 'user', user_id: a.userId }], 'back');
    expect(ok.statusCode).toBe(200);
    await post(`/v1/me/contacts/${a.userId}/block`, alice, { blocked: true });
    expect((await send(aliceH, [{ type: 'user', user_id: a.userId }], 'y')).json().code).toBe('BLOCKED');
    // a drop sent before the block is not answered after it
    expect(await reply(ok.json().drop_id)).toEqual({ replied: false, reason: 'not_allowed' });
  });

  it('an admin cannot suspend, promote, close or revoke the assistant; it is not counted as a user', async () => {
    const a = await assistant();
    await t.db.drizzle.update(appUsers).set({ isAdmin: true }).where(eq(appUsers.id, alice.userId));
    expect((await post(`/v1/admin/users/${a.userId}/suspend`, alice, { reason: 'x' })).statusCode).toBe(403);
    expect((await post(`/v1/admin/users/${a.userId}/admin`, alice, { is_admin: true })).statusCode).toBe(403);
    expect(
      (await post(`/v1/admin/users/${a.userId}/close`, alice, { confirm_handle: SYSTEM_ASSISTANT_HANDLE }))
        .statusCode,
    ).toBe(403);
    expect((await post(`/v1/admin/endpoints/${a.hId}/revoke`, alice)).statusCode).toBe(403);
    const overview = (await get('/v1/admin/overview', alice)).json();
    expect(overview.users.total ?? overview.users_total).toBe(2);
  });
});
