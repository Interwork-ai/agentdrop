import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hHeaders, pair, signUp, TEST_DATABASE_URL } from '../apps/api/src/testing/harness.js';
import { type LiveApp, startLiveApp } from '../apps/api/src/testing/live.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL)
  console.warn('[live-export.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

/*
 * `app.inject` buffers the whole response and skips the compression middleware, so it cannot show that the
 * export actually streams or that the trailer survives the real HTTP stack. This one goes over a socket.
 */
describeDb('export over a real socket', () => {
  let live: LiveApp;
  beforeAll(async () => {
    live = await startLiveApp();
  });
  afterAll(async () => {
    await live.close();
  });

  it('streams a complete, trailer-terminated body through the real HTTP stack', async () => {
    await live.reset();
    const alice = await signUp(live, 'alice', 'Alice');
    const bob = await signUp(live, 'bob', 'Bob');
    const aliceH = await pair(live, alice, { harness: 'codex' });
    await pair(live, bob, { harness: 'codex' });
    const post = (url: string, user: typeof alice, payload?: unknown) =>
      live.app.inject({
        method: 'POST',
        url,
        headers: { cookie: user.cookie, origin: live.origin },
        ...(payload ? { payload } : {}),
      });
    await post('/v1/me/contacts/invite', alice, { handle: 'bob' });
    await post(`/v1/me/contacts/${alice.userId}/accept`, bob);
    for (let i = 0; i < 5; i++) {
      const sent = await live.app.inject({
        method: 'POST',
        url: '/v1/h/drops',
        headers: hHeaders(aliceH.credential),
        payload: {
          request_id: `live-${randomUUID()}`,
          targets: [{ type: 'user', user_id: bob.userId }],
          payload: {
            payload_version: 1,
            kind: 'text',
            title: `t${i}`,
            body: 'x'.repeat(500),
            attachment_ids: [],
            extensions: {},
          },
        },
      });
      expect(sent.statusCode, sent.body).toBe(200);
      expect(sent.json().outcome, sent.body).toBe('delivered');
    }
    const q = new URLSearchParams({
      scope: 'peer',
      peer_user_id: bob.userId,
      since: new Date(Date.now() - 86400000).toISOString(),
      until: new Date(Date.now() + 86400000).toISOString(),
      include_body: 'true',
    });
    // A real fetch: goes through @fastify/compress and a real socket, unlike app.inject.
    const res = await fetch(`${live.baseUrl}/v1/h/export?${q}`, { headers: hHeaders(aliceH.credential) });
    expect(res.status).toBe(200);
    const body = await res.text();
    const lines = body
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines[0].record).toBe('header');
    expect(lines[0].count).toBe(5);
    expect(lines.filter((l) => l.record === 'drop')).toHaveLength(5);
    const trailer = lines.at(-1);
    expect(trailer.record).toBe('trailer');
    expect(trailer.count).toBe(5);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
  });
});
