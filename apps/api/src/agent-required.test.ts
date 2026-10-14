import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type BrowserUser,
  createTestApp,
  pair,
  signUp,
  TEST_DATABASE_URL,
  type TestApp,
} from './testing/harness.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL)
  console.warn('[agent-required.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

/** Relationships need somewhere to deliver: an account without a paired agent cannot start or accept any. */
describeDb('an account without a paired agent', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let nova: BrowserUser;

  const post = (url: string, u: BrowserUser, payload?: unknown) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: u.cookie, origin: t.origin },
      payload: payload ?? {},
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
    nova = await signUp(t, 'nova', 'Nova');
    await pair(t, alice);
  });

  it('cannot add contacts, accept requests, make invite links, create, join or invite to groups', async () => {
    const refused = async (res: { statusCode: number; json: () => { code: string } }) => {
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('AGENT_REQUIRED');
    };
    await refused(await post('/v1/me/contacts/invite', nova, { handle: 'alice' }));
    await refused(await post('/v1/me/invite-links', nova));
    await refused(await post('/v1/me/groups', nova, { display_name: 'Solo' }));

    // alice reaches out; nova can see it but not accept yet
    expect((await post('/v1/me/contacts/invite', alice, { handle: 'nova' })).statusCode).toBe(200);
    await refused(await post(`/v1/me/contacts/${alice.userId}/accept`, nova));
    const link = (await post('/v1/me/invite-links', alice)).json();
    // a link only leaves (here: keeps) alice's request waiting; nothing is accepted without an agent
    const viaLink = await post(`/v1/me/invite/${link.token}/accept`, nova);
    expect(viaLink.statusCode, viaLink.body).toBe(200);
    expect(viaLink.json()).toMatchObject({ created: false, pending: true, contact: { status: 'requested' } });
    const group = (await post('/v1/me/groups', alice, { slug: 'lab', invite_handles: ['nova'] })).json();
    await refused(await post(`/v1/me/groups/${group.group_id}/accept`, nova, {}));

    // once an agent is paired everything goes through, and the invitations waited
    await pair(t, nova);
    expect((await post(`/v1/me/contacts/${alice.userId}/accept`, nova)).json().status).toBe('accepted');
    expect((await post(`/v1/me/groups/${group.group_id}/accept`, nova, {})).statusCode).toBe(200);
    expect((await post('/v1/me/invite-links', nova)).statusCode).toBe(201);
  });
});
