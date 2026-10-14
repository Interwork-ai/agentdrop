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
if (!TEST_DATABASE_URL)
  console.warn('[contact-remove.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

describeDb('agentdrop contact remove (describe first, remove only with confirm)', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let carol: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;
  const post = (url: string, user: BrowserUser, payload: Record<string, unknown> = {}) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: user.cookie, origin: t.origin }, payload });
  const remove = (handles: string[], confirm?: boolean) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/h/contacts/remove',
      headers: hHeaders(aliceH.credential),
      payload: { handles, ...(confirm === undefined ? {} : { confirm }) },
    });
  const contactsOfAlice = async () =>
    (await t.app.inject({ method: 'GET', url: '/v1/me/contacts', headers: { cookie: alice.cookie } }))
      .json()
      .contacts.map((c: { handle: string }) => c.handle);

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice');
    bob = await signUp(t, 'bob', 'Bob');
    carol = await signUp(t, 'carol');
    aliceH = await pair(t, alice);
    bobH = await pair(t, bob);
    for (const peer of [bob, carol]) {
      await post('/v1/me/contacts/invite', alice, { handle: peer.handle });
      await post(`/v1/me/contacts/${alice.userId}/accept`, peer);
    }
    await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(bobH.credential),
      payload: {
        request_id: `r-${randomUUID()}`,
        targets: [{ type: 'user', user_id: alice.userId }],
        payload: {
          payload_version: 1,
          kind: 'text',
          title: 'hi',
          body: 'x',
          attachment_ids: [],
          extensions: {},
        },
      },
    });
    await post('/v1/me/groups', alice, { slug: 'lab', display_name: 'Lab', invite_handles: ['bob'] });
    const groups = (
      await t.app.inject({ method: 'GET', url: '/v1/me/groups', headers: { cookie: bob.cookie } })
    ).json().groups;
    await post(`/v1/me/groups/${groups[0].group_id}/accept`, bob, {});
  });

  it('describes without removing, then removes only with confirm', async () => {
    const preview = await remove(['@bob']);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().removed).toBe(false);
    expect(preview.json().contacts[0]).toMatchObject({
      handle: 'bob',
      display_name: 'Bob',
      status: 'accepted',
      drops_from_them: 1,
      drops_to_them: 0,
      shared_groups: ['lab'],
      is_system: false,
    });
    expect(preview.json().contacts[0].last_drop_at).not.toBeNull();
    expect(await contactsOfAlice()).toContain('bob');
    const done = await remove(['bob'], true);
    expect(done.json().removed).toBe(true);
    expect(await contactsOfAlice()).not.toContain('bob');
    expect(await contactsOfAlice()).toContain('carol');
  });

  it('is all or nothing: one unknown handle removes nobody', async () => {
    const res = await remove(['carol', 'nobody'], true);
    expect(res.statusCode).toBe(404);
    expect(res.json().details.handles).toEqual(['nobody']);
    expect(await contactsOfAlice()).toContain('carol');
  });
});
