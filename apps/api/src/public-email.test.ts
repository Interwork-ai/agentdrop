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
  console.warn('[public-email.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

/** ADR 0012: one published email per person, the same on every agent, visible only where the person already is. */
describeDb('public email on the person profile', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let carol: BrowserUser;
  let dave: BrowserUser;
  let aliceCodex: PairedEndpoint;
  let aliceClaude: PairedEndpoint;
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
  const setEmail = (user: BrowserUser, public_email: string | null) =>
    t.app.inject({
      method: 'PUT',
      url: '/v1/me/public-email',
      headers: { cookie: user.cookie, origin: t.origin },
      payload: { public_email },
    });
  const hGet = (url: string, h: PairedEndpoint, userAgent?: string) =>
    t.app.inject({
      method: 'GET',
      url,
      headers: { ...hHeaders(h.credential), ...(userAgent ? { 'user-agent': userAgent } : {}) },
    });
  const personIn = (dir: { entries: Array<{ kind: string; handle?: string }> }, handle: string) =>
    dir.entries.find((e) => e.kind === 'person' && e.handle === handle) as
      | { public_email?: string | null }
      | undefined;

  async function befriend(a: BrowserUser, b: BrowserUser) {
    expect((await post('/v1/me/contacts/invite', a, { handle: b.handle })).statusCode).toBe(200);
    expect((await post(`/v1/me/contacts/${a.userId}/accept`, b)).statusCode).toBe(200);
  }

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
    aliceCodex = await pair(t, alice, { harness: 'codex', endpointLabel: 'Alice Codex' });
    aliceClaude = await pair(t, alice, { harness: 'claude-code', endpointLabel: 'Alice Claude' });
    bobH = await pair(t, bob, { harness: 'codex' });
    carolH = await pair(t, carol, { harness: 'codex' });
    daveH = await pair(t, dave, { harness: 'codex' });
  });

  it('is set, normalized, cleared and validated with a browser session only', async () => {
    const me0 = (await get('/v1/me', alice)).json();
    expect(me0.public_email).toBeNull();
    expect(me0.sign_in_email).toBe(alice.email);

    const set = await setEmail(alice, '  Alice@Example.ORG ');
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().public_email).toBe('alice@example.org');
    expect(set.json().directory_revision).toBeGreaterThan(me0.directory_revision);
    expect((await get('/v1/me', alice)).json().public_email).toBe('alice@example.org');

    const bad = await setEmail(alice, 'not an email');
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'public_email' } });
    expect((await get('/v1/me', alice)).json().public_email).toBe('alice@example.org');

    // a cross-site request is refused like every other cookie-authenticated write
    const csrf = await t.app.inject({
      method: 'PUT',
      url: '/v1/me/public-email',
      headers: { cookie: alice.cookie, origin: 'https://evil.example' },
      payload: { public_email: 'x@example.org' },
    });
    expect(csrf.statusCode).toBe(403);
    // an agent credential cannot change it
    const viaAgent = await t.app.inject({
      method: 'PUT',
      url: '/v1/me/public-email',
      headers: hHeaders(aliceCodex.credential),
      payload: { public_email: 'x@example.org' },
    });
    expect([401, 403]).toContain(viaAgent.statusCode);
    expect((await get('/v1/me', alice)).json().public_email).toBe('alice@example.org');

    expect((await setEmail(alice, '')).json().public_email).toBeNull();
    expect((await setEmail(alice, 'alice@example.org')).statusCode).toBe(200);
    expect((await setEmail(alice, null)).json().public_email).toBeNull();
  });

  it('every agent of the person carries the same address, in its own viewer and on drops it sends', async () => {
    await befriend(alice, bob);
    await setEmail(alice, 'alice@example.org');
    for (const h of [aliceCodex, aliceClaude]) {
      const id = await hGet('/v1/h/identity', h);
      expect(id.json().viewer.public_email).toBe('alice@example.org');
      const list = await hGet('/v1/h/drops', h);
      expect(list.json().viewer.public_email).toBe('alice@example.org');
    }
    for (const [h, title] of [
      [aliceCodex, 'from codex'],
      [aliceClaude, 'from claude'],
    ] as const) {
      const sent = await t.app.inject({
        method: 'POST',
        url: '/v1/h/drops',
        headers: hHeaders(h.credential),
        payload: {
          request_id: `req-${randomUUID()}`,
          targets: [{ type: 'user', user_id: bob.userId }],
          payload: {
            payload_version: 1,
            kind: 'text',
            title,
            body: 'hi',
            attachment_ids: [],
            extensions: {},
          },
        },
      });
      expect(sent.statusCode, sent.body).toBe(200);
    }
    const inbox = (await hGet('/v1/h/drops', bobH)).json();
    expect(inbox.drops).toHaveLength(2);
    for (const d of inbox.drops) expect(d.author.public_email).toBe('alice@example.org');
    const read = (await hGet(`/v1/h/drops/${inbox.drops[0].drop_id}`, bobH)).json();
    expect(read.drop.author.public_email).toBe('alice@example.org');

    // the author card follows the live profile: withdrawing the address hides it on drops already sent
    await setEmail(alice, null);
    const after = (await hGet('/v1/h/drops', bobH)).json();
    for (const d of after.drops) expect(d.author.public_email).toBeNull();
  });

  it('contacts and group co-members see it and can search by it; pending, blocked and strangers do not', async () => {
    await setEmail(alice, 'alice@example.org');
    await befriend(alice, bob);
    // carol shares a group with alice but is not her contact
    await befriend(bob, carol);
    const created = await post('/v1/me/groups', bob, {
      slug: 'lab',
      display_name: 'Lab',
      binding_h_ids: [bobH.hId],
    });
    expect(created.statusCode, created.body).toBe(200);
    const groupId = created.json().group_id;
    await post(`/v1/me/groups/${groupId}/invite`, bob, { handle: 'alice' });
    await post(`/v1/me/groups/${groupId}/invite`, bob, { handle: 'carol' });
    expect(
      (await post(`/v1/me/groups/${groupId}/accept`, alice, { h_ids: [aliceCodex.hId] })).statusCode,
    ).toBe(200);
    // dave has only been invited by alice, never accepted
    expect((await post('/v1/me/contacts/invite', alice, { handle: 'dave' })).statusCode).toBe(200);

    const bobDir = (await hGet('/v1/h/directory?query=alice', bobH)).json();
    expect(personIn(bobDir, 'alice')?.public_email).toBe('alice@example.org');
    const byEmail = (await hGet('/v1/h/directory?query=alice%40example.org', bobH)).json();
    expect(byEmail.entries.map((e: { handle?: string }) => e.handle)).toEqual(['alice']);
    const contacts = (await get('/v1/me/contacts', bob)).json().contacts;
    expect(contacts.find((c: { handle: string }) => c.handle === 'alice').public_email).toBe(
      'alice@example.org',
    );

    // carol, still only invited to the group, sees neither the roster nor the address
    let carolGroup = (await get(`/v1/me/groups/${groupId}`, carol)).json();
    expect(carolGroup.members).toEqual([]);
    expect(personIn((await hGet('/v1/h/directory?query=alice', carolH)).json(), 'alice')).toBeUndefined();
    expect((await post(`/v1/me/groups/${groupId}/accept`, carol, { h_ids: [carolH.hId] })).statusCode).toBe(
      200,
    );
    carolGroup = (await get(`/v1/me/groups/${groupId}`, carol)).json();
    expect(carolGroup.members.find((m: { handle: string }) => m.handle === 'alice').public_email).toBe(
      'alice@example.org',
    );
    expect(personIn((await hGet('/v1/h/directory?query=alice', carolH)).json(), 'alice')?.public_email).toBe(
      'alice@example.org',
    );

    // a pending invitation shows the name so dave can decide, but not the address; a stranger finds nothing
    const daveContacts = (await get('/v1/me/contacts', dave)).json().contacts;
    const fromAlice = daveContacts.find((c: { handle: string }) => c.handle === 'alice');
    expect(fromAlice.status).toBe('requested');
    expect(fromAlice.public_email).toBeNull();
    const daveDir = (await hGet('/v1/h/directory?query=alice%40example.org', daveH)).json();
    expect(daveDir.entries).toEqual([]);
    const pending = (await hGet('/v1/h/requests', daveH)).json();
    expect(JSON.stringify(pending)).not.toContain('alice@example.org');

    // bob blocks alice: her address leaves his contact list
    expect((await post(`/v1/me/contacts/${alice.userId}/block`, bob, { blocked: true })).statusCode).toBe(
      200,
    );
    const blocked = (await get('/v1/me/contacts', bob)).json().contacts;
    expect(blocked.find((c: { handle: string }) => c.handle === 'alice').public_email).toBeNull();
  });

  it('bridges before 0.4.11 get responses without the field, newer ones keep it', async () => {
    await befriend(alice, bob);
    await setEmail(alice, 'alice@example.org');
    await setEmail(bob, 'bob@example.org');
    const old = 'agentdrop-bridge/0.4.10 (test)';
    const oldDir = await hGet('/v1/h/directory', bobH, old);
    expect(oldDir.statusCode).toBe(200);
    expect(oldDir.body).not.toContain('public_email');
    expect((await hGet('/v1/h/identity', bobH, old)).body).not.toContain('public_email');
    const current = await hGet('/v1/h/directory', bobH, 'agentdrop-bridge/0.4.20 (test)');
    expect(personIn(current.json(), 'alice')?.public_email).toBe('alice@example.org');
    expect(current.json().viewer.public_email).toBe('bob@example.org');
  });
});
