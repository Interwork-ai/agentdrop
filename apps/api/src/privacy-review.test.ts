import { randomUUID } from 'node:crypto';
import { drops, groupBindings, groupMemberships } from '@agentdrop/db';
import { and, eq, sql } from 'drizzle-orm';
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
  console.warn('[privacy-review.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

type Person = { kind: string; handle?: string; public_email?: string | null; alternatives?: unknown[] };
type Member = { handle: string; public_email?: string | null };

/**
 * Who sees a person's published email and the group's repair state (ADR 0012, 0013): only where the person already
 * is, never across a block in either direction, and never merely because an admin reads the group's history.
 */
describeDb('profile and group privacy', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let carol: BrowserUser;
  let dave: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;
  let carolH: PairedEndpoint;
  let daveH: PairedEndpoint;

  const get = (url: string, user: BrowserUser) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: user.cookie } });
  const post = (url: string, user: BrowserUser, payload?: unknown) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: user.cookie, origin: t.origin },
      ...(payload ? { payload } : {}),
    });
  const patch = (url: string, user: BrowserUser, payload: Record<string, unknown>) =>
    t.app.inject({ method: 'PATCH', url, headers: { cookie: user.cookie, origin: t.origin }, payload });
  const hGet = (url: string, h: PairedEndpoint) =>
    t.app.inject({ method: 'GET', url, headers: hHeaders(h.credential) });
  const setEmail = (user: BrowserUser, public_email: string | null) =>
    t.app.inject({
      method: 'PUT',
      url: '/v1/me/public-email',
      headers: { cookie: user.cookie, origin: t.origin },
      payload: { public_email },
    });
  const send = (h: PairedEndpoint, targets: unknown[], title: string, mentions?: string[]) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(h.credential),
      payload: {
        request_id: `req-${randomUUID()}`,
        targets,
        payload: {
          payload_version: 1,
          kind: 'text',
          title,
          body: 'x',
          attachment_ids: [],
          extensions: {},
          ...(mentions ? { mentions } : {}),
        },
      },
    });
  const block = (who: BrowserUser, whom: BrowserUser) =>
    post(`/v1/me/contacts/${whom.userId}/block`, who, { blocked: true });
  async function befriend(a: BrowserUser, b: BrowserUser) {
    expect((await post('/v1/me/contacts/invite', a, { handle: b.handle })).statusCode).toBe(200);
    expect((await post(`/v1/me/contacts/${a.userId}/accept`, b)).statusCode).toBe(200);
  }
  async function groupOf(owner: BrowserUser, slug: string, members: Array<[BrowserUser, PairedEndpoint]>) {
    const created = await post('/v1/me/groups', owner, {
      slug,
      display_name: slug,
      invite_handles: members.map(([u]) => u.handle),
    });
    expect(created.statusCode, created.body).toBe(200);
    const groupId = created.json().group_id as string;
    for (const [u, h] of members)
      expect((await post(`/v1/me/groups/${groupId}/accept`, u, { h_ids: [h.hId] })).statusCode).toBe(200);
    return groupId;
  }
  const personIn = (dir: { entries: Person[] }, handle: string) =>
    dir.entries.find((e) => e.kind === 'person' && e.handle === handle);
  const memberIn = (list: Member[] | undefined, handle: string) => list?.find((m) => m.handle === handle);

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
    carol = await signUp(t, 'carol', 'Carol');
    dave = await signUp(t, 'dave', 'Dave');
    aliceH = await pair(t, alice, { harness: 'codex' });
    bobH = await pair(t, bob, { harness: 'codex' });
    carolH = await pair(t, carol, { harness: 'codex' });
    daveH = await pair(t, dave, { harness: 'codex' });
  });

  it('an admin reading group history they never received does not get the author’s email', async () => {
    await setEmail(dave, 'dave@example.org');
    const groupId = await groupOf(bob, 'lab', [[dave, daveH]]);
    expect((await send(daveH, [{ type: 'group', group_id: groupId }], 'before carol')).statusCode).toBe(200);
    // dave leaves: from now on he is nobody's contact or co-member
    expect((await post(`/v1/me/groups/${groupId}/leave`, dave)).statusCode).toBe(200);
    await post(`/v1/me/groups/${groupId}/invite`, bob, { handles: ['carol'] });
    expect((await post(`/v1/me/groups/${groupId}/accept`, carol, { h_ids: [carolH.hId] })).statusCode).toBe(
      200,
    );
    expect(
      (await patch(`/v1/me/groups/${groupId}/members/${carol.userId}`, bob, { role: 'admin' })).statusCode,
    ).toBe(200);

    const history = (
      await get(
        `/v1/me/endpoints/${carolH.hId}/drops?view=inbox&group_id=${groupId}&include_group_history=true`,
        carol,
      )
    ).json().drops as Array<{ drop_id: string; title: string; sources: string[]; author: Member }>;
    const early = history.find((d) => d.title === 'before carol');
    expect(early?.sources).toEqual(['group_admin']);
    expect(early?.author.handle).toBe('dave');
    expect(early?.author.public_email).toBeNull();
    const read = (await get(`/v1/me/endpoints/${carolH.hId}/drops/${early?.drop_id}`, carol)).json();
    expect(read.drop.author.public_email).toBeNull();
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const exported = await get(
      `/v1/me/endpoints/${carolH.hId}/export?${new URLSearchParams({
        scope: 'group',
        group_id: groupId,
        since,
        until,
        include_group_history: 'true',
      })}`,
      carol,
    );
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).toContain('before carol');
    expect(exported.body).not.toContain('dave@example.org');

    // bob received it: he still sees the address on it, until either side blocks the other
    const bobInbox = (await hGet('/v1/h/drops', bobH)).json().drops;
    expect(bobInbox[0].author.public_email).toBe('dave@example.org');
    expect((await block(dave, bob)).statusCode).toBe(200);
    expect((await hGet('/v1/h/drops', bobH)).json().drops[0].author.public_email).toBeNull();

    // becoming carol's contact makes dave visible to her as a person again
    await befriend(dave, carol);
    const again = (
      await get(
        `/v1/me/endpoints/${carolH.hId}/drops?view=inbox&group_id=${groupId}&include_group_history=true`,
        carol,
      )
    ).json().drops;
    expect(again[0].author.public_email).toBe('dave@example.org');
  });

  for (const direction of ['alice blocks bob', 'bob blocks alice'] as const) {
    it(`hides both emails when ${direction}: contacts, directory, email search and group rosters`, async () => {
      await setEmail(alice, 'alice@example.org');
      await setEmail(bob, 'bob@example.org');
      await befriend(alice, bob);
      const published = await post('/v1/me/routes', bob, {
        alias: 'review',
        label: 'Review desk',
        h_id: bobH.hId,
        visibility: 'contacts',
      });
      expect(published.statusCode, published.body).toBe(200);
      const groupId = await groupOf(carol, 'lab', [
        [alice, aliceH],
        [bob, bobH],
      ]);
      // before the block, each sees the other's address and bob's named entry
      const aliceDir0 = (await hGet('/v1/h/directory?kind=person', aliceH)).json();
      expect(personIn(aliceDir0, 'bob')?.public_email).toBe('bob@example.org');
      expect(personIn(aliceDir0, 'bob')?.alternatives).toHaveLength(1);

      if (direction === 'alice blocks bob') expect((await block(alice, bob)).statusCode).toBe(200);
      else expect((await block(bob, alice)).statusCode).toBe(200);

      for (const [me, myH, other, otherEmail] of [
        [alice, aliceH, bob, 'bob@example.org'],
        [bob, bobH, alice, 'alice@example.org'],
      ] as const) {
        const contacts = (await get('/v1/me/contacts', me)).json().contacts as Member[];
        expect(memberIn(contacts, other.handle)?.public_email ?? null).toBeNull();

        const dir = (await hGet('/v1/h/directory', myH)).json();
        const card = personIn(dir, other.handle);
        // whoever blocked sees no card at all; the blocked side keeps the name only
        if (card) {
          expect(card.public_email).toBeNull();
          expect(card.alternatives).toEqual([]);
        }
        expect(JSON.stringify(dir)).not.toContain(otherEmail);
        const byEmail = (
          await hGet(`/v1/h/directory?kind=person&query=${encodeURIComponent(otherEmail)}`, myH)
        ).json();
        expect(byEmail.entries).toEqual([]);

        const group = (await get(`/v1/me/groups/${groupId}`, me)).json();
        expect(memberIn(group.members, other.handle)?.public_email).toBeNull();
        const groupCard = (await hGet('/v1/h/directory?kind=group', myH)).json().entries[0];
        expect(memberIn(groupCard.active_members, other.handle)?.public_email).toBeNull();
      }
      // carol, who blocked nobody, still sees both
      const carolGroup = (await get(`/v1/me/groups/${groupId}`, carol)).json();
      expect(memberIn(carolGroup.members, 'alice')?.public_email).toBe('alice@example.org');
      expect(memberIn(carolGroup.members, 'bob')?.public_email).toBe('bob@example.org');
    });
  }

  it('a person I blocked does not come back as a group-only candidate', async () => {
    await befriend(alice, bob);
    await groupOf(carol, 'lab', [
      [alice, aliceH],
      [bob, bobH],
      [dave, daveH],
    ]);
    // dave is only a co-member; bob is a contact
    const before = (await hGet('/v1/h/directory?kind=person', aliceH)).json();
    expect(personIn(before, 'dave')).toMatchObject({ contact_status: 'group_only' });
    expect((await block(alice, bob)).statusCode).toBe(200);
    expect((await block(dave, alice)).statusCode).toBe(200);
    const after = (await hGet('/v1/h/directory?kind=person', aliceH)).json();
    expect(personIn(after, 'bob')).toBeUndefined();
    expect(personIn(after, 'dave')).toBeUndefined();
    expect(personIn(after, 'carol')).toMatchObject({ contact_status: 'group_only' });
    // dave, who blocked alice, does not get her as a candidate either
    expect(personIn((await hGet('/v1/h/directory?kind=person', daveH)).json(), 'alice')).toBeUndefined();
  });

  it('mentions go with the one group they were written for', async () => {
    // the test server allows three receiving agents per group send: alice, bob and dave
    const groupId = await groupOf(alice, 'core', [[bob, bobH]]);
    await befriend(alice, dave);
    const group = { type: 'group', group_id: groupId };
    const mixed = await send(aliceH, [group, { type: 'user', user_id: dave.userId }], 'mixed', ['bob']);
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json()).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'mentions' } });
    expect((await hGet('/v1/h/drops', daveH)).json().drops).toHaveLength(0);
    expect((await hGet('/v1/h/drops', bobH)).json().drops).toHaveLength(0);

    // a drop that reached dave directly and the group, with mentions (as older servers allowed): only readers
    // through the group, and the author, see whom it called on
    const legacy = await send(aliceH, [group, { type: 'user', user_id: dave.userId }], 'legacy');
    expect(legacy.statusCode, legacy.body).toBe(200);
    await t.db.drizzle
      .update(drops)
      .set({
        targetSnapshot: sql`${drops.targetSnapshot} || jsonb_build_object('mention_user_ids', jsonb_build_array(${bob.userId}::text))`,
      })
      .where(eq(drops.id, legacy.json().drop_id));
    const daveSees = (await hGet('/v1/h/drops', daveH)).json().drops[0];
    expect(daveSees).toMatchObject({ mentions: [], mentioned_me: false });
    const bobSees = (await hGet('/v1/h/drops', bobH)).json().drops[0];
    expect(bobSees).toMatchObject({ mentions: [{ handle: 'bob' }], mentioned_me: true });
    const aliceSees = (await hGet('/v1/h/drops?view=sent', aliceH)).json().drops[0];
    expect(aliceSees.mentions).toEqual([{ handle: 'bob', display_label: 'Bob' }]);
  });

  it('only owners/admins and the member themselves learn who cannot receive', async () => {
    const groupId = await groupOf(alice, 'core', [
      [bob, bobH],
      [carol, carolH],
    ]);
    // carol's receiving binding is gone (a state older servers could leave behind)
    const [membership] = await t.db.drizzle
      .select({ id: groupMemberships.id })
      .from(groupMemberships)
      .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, carol.userId)));
    await t.db.drizzle
      .update(groupBindings)
      .set({ revokedAt: new Date() })
      .where(eq(groupBindings.membershipId, membership?.id ?? ''));

    const health = async (h: PairedEndpoint) =>
      ((await hGet('/v1/h/requests', h)).json().groups as Array<{ members_needing_repair: number }>)[0];
    expect((await health(aliceH))?.members_needing_repair).toBe(1);
    expect((await health(bobH))?.members_needing_repair).toBe(0);

    const target = [{ type: 'group', group_id: groupId }];
    const byOwner = await send(aliceH, target, 'owner');
    expect(byOwner.json()).toMatchObject({
      code: 'GROUP_RECIPIENT_UNAVAILABLE',
      details: { group_id: groupId, member_handle: 'carol' },
    });
    const byMember = await send(bobH, target, 'member');
    expect(byMember.json().code).toBe('GROUP_RECIPIENT_UNAVAILABLE');
    expect(byMember.json().details).toEqual({ group_id: groupId });
    expect(byMember.body).not.toContain('carol');
    const byThemselves = await send(carolH, target, 'self');
    expect(byThemselves.json().details).toMatchObject({ member_handle: 'carol' });
  });
});
