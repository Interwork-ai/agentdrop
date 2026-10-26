import { randomUUID } from 'node:crypto';
import { approvals, drops } from '@agentdrop/db';
import { sendDrop, sweepMailboxEvents } from '@agentdrop/domain';
import { eq, sql } from 'drizzle-orm';
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

  describe("the author's side: sent.changed", () => {
    const sentEvent = (dropId: string) => ({ type: 'sent.changed', drop_id: dropId });
    const open = (h: PairedEndpoint, dropId: string) =>
      t.app.inject({ method: 'GET', url: `/v1/h/drops/${dropId}`, headers: hHeaders(h.credential) });
    const setState = (h: PairedEndpoint, dropId: string, body: Record<string, unknown>) =>
      t.app.inject({
        method: 'PATCH',
        url: `/v1/h/drops/${dropId}/state`,
        headers: hHeaders(h.credential),
        payload: body,
      });
    /** Everything that would tell the author which of Bob's agents, or which person, caused an event. */
    const bobIdentity = () => [bob.userId, bob.handle, bobCodex.hId, bobClaude.hId];

    it('tells the author of their own send and of the first open, never naming who opened it', async () => {
      const aliceCursor = await subscribe(aliceH);
      const carolCursor = await subscribe(carolH);
      const dropId = await send(aliceH, bob);
      const sent = await events(aliceH, { cursor: aliceCursor });
      expect(sent.json().events).toEqual([sentEvent(dropId)]);

      expect((await open(bobCodex, dropId)).statusCode).toBe(200);
      const opened = await events(aliceH, { cursor: sent.json().cursor });
      expect(opened.json().events).toEqual([sentEvent(dropId)]);
      for (const id of bobIdentity()) expect(opened.body).not.toContain(id);
      // what is stored is the drop id on the author's own agent, nothing of the reader's
      const { rows } = await t.db.pool.query(
        "select h_id, delivery_id, payload from mailbox_events where type = 'sent.changed' and drop_id = $1",
        [dropId],
      );
      expect(rows).toEqual([
        { h_id: aliceH.hId, delivery_id: null, payload: {} },
        { h_id: aliceH.hId, delivery_id: null, payload: {} },
      ]);

      // opening it again from another agent of Bob's, or marking it read now, leaves the receipt as it was
      expect((await open(bobClaude, dropId)).statusCode).toBe(200);
      expect((await setState(bobCodex, dropId, { expected_version: 0, read: true })).statusCode).toBe(200);
      expect((await events(aliceH, { cursor: opened.json().cursor })).json().events).toEqual([]);
      expect((await events(carolH, { cursor: carolCursor })).json().events).toEqual([]);
    });

    it('tells the author when the receipt moves, and not when the recipient stars or archives', async () => {
      const dropId = await send(aliceH, bob);
      const cursor = await subscribe(aliceH);
      expect((await setState(bobCodex, dropId, { expected_version: 0, starred: true })).statusCode).toBe(200);
      expect((await setState(bobClaude, dropId, { expected_version: 1, archived: true })).statusCode).toBe(
        200,
      );
      const quiet = await events(aliceH, { cursor });
      expect(quiet.json().events).toEqual([]);

      expect((await setState(bobCodex, dropId, { expected_version: 2, read: true })).statusCode).toBe(200);
      const read = await events(aliceH, { cursor: quiet.json().cursor });
      expect(read.json().events).toEqual([sentEvent(dropId)]);
      for (const id of bobIdentity()) expect(read.body).not.toContain(id);
      // marked unread again before ever opening it: the receipt goes back to unread
      expect((await setState(bobCodex, dropId, { expected_version: 3, read: false })).statusCode).toBe(200);
      expect((await events(aliceH, { cursor: read.json().cursor })).json().events).toEqual([
        sentEvent(dropId),
      ]);
    });

    it('tells the author when a reply marks their drop read for the recipient', async () => {
      const dropId = await send(aliceH, bob);
      const cursor = await subscribe(aliceH);
      const reply = await t.app.inject({
        method: 'POST',
        url: '/v1/h/drops',
        headers: hHeaders(bobCodex.credential),
        payload: {
          request_id: `events-${randomUUID()}`,
          targets: [{ type: 'user', user_id: alice.userId }],
          payload: {
            payload_version: 1,
            title: 'done',
            body: 'the ablation run finished',
            attachment_ids: [],
            extensions: {},
            reply_to: dropId,
          },
        },
      });
      expect(reply.statusCode, reply.body).toBe(200);
      expect((await events(aliceH, { cursor })).json().events).toEqual(
        expect.arrayContaining([
          sentEvent(dropId),
          { type: 'delivery.created', drop_id: reply.json().drop_id },
        ]),
      );
    });

    it("reaches the author's other agents exactly as account-wide reads let them read the drop", async () => {
      const aliceClaude = await pair(t, alice, { harness: 'claude-code' });
      const accountWide = await subscribe(aliceClaude);
      const narrowed = (await events(aliceClaude, { endpoint_scope: 'current' })).json().cursor;
      const dropId = await send(aliceH, bob);
      expect((await events(aliceClaude, { cursor: accountWide })).json().events).toEqual([sentEvent(dropId)]);
      expect(
        (await events(aliceClaude, { cursor: narrowed, endpoint_scope: 'current' })).json().events,
      ).toEqual([]);
    });

    it('tells the author when a held send is approved and committed', async () => {
      const envelope = {
        request_id: `events-${randomUUID()}`,
        targets: [{ type: 'user' as const, user_id: bob.userId }],
        payload: { payload_version: 1, title: 'held', body: 'body', attachment_ids: [], extensions: {} },
      };
      const held = await t.db.drizzle.transaction((tx) =>
        sendDrop(tx, { userId: alice.userId, hId: aliceH.hId, via: 'h_credential' }, envelope, {
          originKind: 'mcp',
          maxGroupRecipients: 3,
          approvalPolicy: async () => ({ needsApproval: true, reasons: ['review'] }),
        }),
      );
      expect(held.outcome).toBe('needs_approval');
      const cursor = await subscribe(aliceH);
      const approval = await t.db.drizzle.query.approvals.findFirst({
        where: eq(approvals.requestId, envelope.request_id),
      });
      if (!approval) throw new Error('missing approval');
      const decided = await t.app.inject({
        method: 'POST',
        url: `/v1/me/approvals/${approval.id}/decide`,
        headers: { cookie: alice.cookie, origin: t.origin },
        payload: { decision: 'approve' },
      });
      expect(decided.statusCode, decided.body).toBe(200);
      const drop = await t.db.drizzle.query.drops.findFirst({ where: eq(drops.authorUserId, alice.userId) });
      if (!drop) throw new Error('nothing committed');
      expect((await events(aliceH, { cursor })).json().events).toEqual([sentEvent(drop.id)]);
    });
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
