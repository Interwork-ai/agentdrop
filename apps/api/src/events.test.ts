import { randomUUID } from 'node:crypto';
import { sweepMailboxEvents } from '@agentdrop/domain';
import { sql } from 'drizzle-orm';
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

describeDb('the per-person event stream (ADR 0040)', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let carol: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobCodex: PairedEndpoint;
  let bobClaude: PairedEndpoint;
  let carolH: PairedEndpoint;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice', 'Alice');
    bob = await signUp(t, 'bob', 'Bob');
    carol = await signUp(t, 'carol', 'Carol');
    aliceH = await pair(t, alice, { harness: 'codex' });
    bobCodex = await pair(t, bob, { harness: 'codex' });
    bobClaude = await pair(t, bob, { harness: 'claude-code' });
    carolH = await pair(t, carol, { harness: 'codex' });
    await befriend(alice, bob);
  });

  async function befriend(a: BrowserUser, b: BrowserUser) {
    const invited = await t.app.inject({
      method: 'POST',
      url: '/v1/me/contacts/invite',
      headers: { cookie: a.cookie, origin: t.origin },
      payload: { handle: b.handle },
    });
    expect(invited.statusCode, invited.body).toBeLessThan(300);
    const accepted = await t.app.inject({
      method: 'POST',
      url: `/v1/me/contacts/${a.userId}/accept`,
      headers: { cookie: b.cookie, origin: t.origin },
    });
    expect(accepted.statusCode, accepted.body).toBeLessThan(300);
  }

  const events = (h: PairedEndpoint, query: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url: '/v1/h/events', query, headers: hHeaders(h.credential) });

  async function subscribe(h: PairedEndpoint): Promise<string> {
    const res = await events(h);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ events: [], has_more: false });
    return res.json().cursor;
  }

  async function send(from: PairedEndpoint, to: BrowserUser, title = 'hello'): Promise<string> {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(from.credential),
      payload: {
        request_id: `events-${randomUUID()}`,
        targets: [{ type: 'user', user_id: to.userId }],
        payload: { payload_version: 1, title, body: 'body', attachment_ids: [], extensions: {} },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().drop_id;
  }

  it('subscribes from now, then announces a delivery once although it reached two agents', async () => {
    const cursor = await subscribe(bobCodex);
    const dropId = await send(aliceH, bob);
    const res = await events(bobCodex, { cursor });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().events).toEqual([{ type: 'delivery.created', drop_id: dropId }]);
    const again = await events(bobCodex, { cursor: res.json().cursor });
    expect(again.json().events).toEqual([]);
  });

  it("brings the person's state change to every agent of theirs, coalesced, and to nobody else", async () => {
    const dropId = await send(aliceH, bob);
    const bobCursor = await subscribe(bobClaude);
    const carolCursor = await subscribe(carolH);
    const marked = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${dropId}/state`,
      headers: hHeaders(bobCodex.credential),
      payload: { expected_version: 0, read: true },
    });
    expect(marked.statusCode, marked.body).toBe(200);
    expect((await events(bobClaude, { cursor: bobCursor })).json().events).toEqual([
      { type: 'delivery.state', drop_id: dropId },
    ]);
    expect((await events(carolH, { cursor: carolCursor })).json().events).toEqual([]);
  });

  it('answers a long-poll as soon as something arrives', async () => {
    const cursor = await subscribe(bobCodex);
    const started = Date.now();
    const waiting = events(bobCodex, { cursor, wait: '10' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const dropId = await send(aliceH, bob);
    const res = await waiting;
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().events).toEqual([{ type: 'delivery.created', drop_id: dropId }]);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('announces directory changes such as a contact request', async () => {
    const cursor = await subscribe(carolH);
    const invited = await t.app.inject({
      method: 'POST',
      url: '/v1/me/contacts/invite',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { handle: carol.handle },
    });
    expect(invited.statusCode, invited.body).toBeLessThan(300);
    expect((await events(carolH, { cursor })).json().events).toContainEqual({
      type: 'directory.changed',
      drop_id: null,
    });
  });

  it('binds a cursor to its person and scope: a damaged, foreign or out-of-scope one is RESYNC_REQUIRED', async () => {
    const cursor = await subscribe(bobCodex);
    for (const res of [
      await events(bobCodex, { cursor: 'not-a-cursor' }),
      await events(aliceH, { cursor }),
    ]) {
      expect(res.statusCode, res.body).toBe(410);
      expect(res.json().code).toBe('RESYNC_REQUIRED');
    }
    await t.db.drizzle.execute(
      sql`update app_users set cross_h_mailbox_enabled = false where id = ${bob.userId}`,
    );
    expect((await events(bobCodex, { cursor })).statusCode).toBe(410);
    expect((await events(bobCodex)).statusCode).toBe(200);
  });

  it('answers RESYNC_REQUIRED for events swept by retention instead of silently skipping them', async () => {
    const cursor = await subscribe(bobCodex);
    await send(aliceH, bob, 'first');
    await send(aliceH, bob, 'second');
    await t.db.drizzle.execute(sql`update mailbox_events set created_at = now() - interval '40 days'`);
    expect(await sweepMailboxEvents(t.db.drizzle, new Date(Date.now() - 30 * 86_400_000))).toBeGreaterThan(0);
    const res = await events(bobCodex, { cursor });
    expect(res.statusCode, res.body).toBe(410);
    expect(res.json().code).toBe('RESYNC_REQUIRED');
  });

  it('streams SSE: the cursor first, then each batch with its cursor as the event id', async () => {
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const address = t.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const closed = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/h/events`, {
        headers: { ...hHeaders(bobCodex.credential), accept: 'text/event-stream' },
        signal: closed.signal,
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      if (!res.body) throw new Error('no body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const until = async (needle: string) => {
        while (!text.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`stream ended before ${needle}: ${text}`);
          text += decoder.decode(value, { stream: true });
        }
      };
      await until('\n\n');
      expect(text).toMatch(
        /^id: \S+\nevent: events\ndata: \{"events":\[\],"cursor":"\S+","has_more":false\}\n\n/,
      );
      const dropId = await send(aliceH, bob);
      await until(dropId);
      expect(text).toContain(`{"type":"delivery.created","drop_id":"${dropId}"}`);
    } finally {
      closed.abort();
    }
  });

  it('advertises the event stream at /.well-known/agentdrop', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/.well-known/agentdrop' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ protocol: 'agentdrop/v1', capabilities: ['events'] });
  });
});

describeDb('shutting down with open event streams', () => {
  // A fresh app, since the test closes it; created in the hook so waiting for the shared test database lock counts
  // against the hook's longer timeout, never against the test's.
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  it('ends open SSE streams and waiting long-polls, so the server closes at once', async () => {
    await t.reset();
    const dana = await signUp(t, 'dana', 'Dana');
    const danaH = await pair(t, dana, { harness: 'codex' });
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const address = t.app.server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const stream = await fetch(`${base}/v1/h/events`, {
      headers: { ...hHeaders(danaH.credential), accept: 'text/event-stream' },
    });
    if (!stream.body) throw new Error('no body');
    const reader = stream.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const cursor = /^id: (\S+)\n/.exec(first)?.[1];
    if (!cursor) throw new Error(`no cursor in ${first}`);
    const longPoll = fetch(`${base}/v1/h/events?wait=25&cursor=${encodeURIComponent(cursor)}`, {
      headers: hHeaders(danaH.credential),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const started = Date.now();
    await t.app.close();
    expect(Date.now() - started).toBeLessThan(5000);
    for (;;) if ((await reader.read()).done) break;
    expect((await longPoll).status).toBe(200);
  });
});
