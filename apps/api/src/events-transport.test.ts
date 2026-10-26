import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import net from 'node:net';
import { listen } from '@agentdrop/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureStreamLimits } from './events.js';
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An SSE response read as it arrives: what was written so far, and whether the server ended it. */
interface OpenStream {
  text(): string;
  ended(): boolean;
  /** Resolves once the text contains `needle` (true), or false when the stream ends first or `ms` pass. */
  until(needle: string, ms?: number): Promise<boolean>;
  /** Resolves once the server ended the stream (true), or false after `ms`. */
  end(ms?: number): Promise<boolean>;
  close(): void;
}

/*
 * How the event stream behaves as a long-lived request (ADR 0040): open streams re-check the caller, a client that
 * left early holds nothing, an idle stream pings whatever wakes it, a client that stops reading is cut off.
 */
describeDb('the event stream as a long-lived request', () => {
  let t: TestApp;
  let base: string;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;
  let restoreLimits: () => void;

  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const address = t.app.server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    // seconds instead of the production 25 s and 15 min
    restoreLimits = configureStreamLimits({ keepaliveMs: 600, lifetimeMs: 60_000 });
    await t.reset();
    alice = await signUp(t, 'alice', 'Alice');
    bob = await signUp(t, 'bob', 'Bob');
    aliceH = await pair(t, alice, { harness: 'codex' });
    bobH = await pair(t, bob, { harness: 'codex' });
    await t.app.inject({
      method: 'POST',
      url: '/v1/me/contacts/invite',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { handle: bob.handle },
    });
    await t.app.inject({
      method: 'POST',
      url: `/v1/me/contacts/${alice.userId}/accept`,
      headers: { cookie: bob.cookie, origin: t.origin },
    });
  });
  afterEach(() => restoreLimits());

  async function open(path: string, headers: Record<string, string>): Promise<OpenStream> {
    const stop = new AbortController();
    const res = await fetch(`${base}${path}`, {
      headers: { ...headers, accept: 'text/event-stream' },
      signal: stop.signal,
    });
    expect(res.status, await (res.ok ? Promise.resolve('') : res.text())).toBe(200);
    if (!res.body) throw new Error('no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let ended = false;
    const waiters = new Set<() => void>();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          for (const w of waiters) w();
        }
      } catch {
        // aborted by the test
      }
      ended = true;
      for (const w of waiters) w();
    })();
    const waitFor = (check: () => boolean, ms: number) =>
      new Promise<boolean>((resolve) => {
        if (check()) return resolve(true);
        const timer = setTimeout(() => {
          waiters.delete(w);
          resolve(check());
        }, ms);
        const w = () => {
          if (!check() && !ended) return;
          clearTimeout(timer);
          waiters.delete(w);
          resolve(check());
        };
        waiters.add(w);
      });
    const stream: OpenStream = {
      text: () => text,
      ended: () => ended,
      until: (needle, ms = 5000) => waitFor(() => text.includes(needle), ms),
      end: (ms = 5000) => waitFor(() => ended, ms),
      close: () => stop.abort(),
    };
    expect(await stream.until('\n\n')).toBe(true);
    return stream;
  }
  const agentStream = (h: PairedEndpoint) => open('/v1/h/events', hHeaders(h.credential));
  const dashboardStream = (user: BrowserUser, h: PairedEndpoint) =>
    open(`/v1/me/endpoints/${h.hId}/events`, { cookie: user.cookie });

  async function send(title = 'hello'): Promise<string> {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(aliceH.credential),
      payload: {
        request_id: `transport-${randomUUID()}`,
        targets: [{ type: 'user', user_id: bob.userId }],
        payload: { payload_version: 1, title, body: 'the ablation run', attachment_ids: [], extensions: {} },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().drop_id as string;
  }

  describe('an open stream keeps nothing once its caller lost access', () => {
    it('ends when the agent is revoked, and the next drop never reaches it', async () => {
      // a lost machine's agent: the person's other agent keeps receiving, which the account-wide stream would show
      await pair(t, bob, { harness: 'claude-code' });
      const stream = await agentStream(bobH);
      const revoked = await t.app.inject({
        method: 'POST',
        url: `/v1/me/endpoints/${bobH.hId}/revoke`,
        headers: { cookie: bob.cookie, origin: t.origin },
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      const dropId = await send();
      expect(await stream.end()).toBe(true);
      expect(stream.text()).not.toContain(dropId);
    });

    it('ends when the agent’s credential is revoked (at the next check), and writes nothing more', async () => {
      const stream = await agentStream(bobH);
      const revoked = await t.app.inject({
        method: 'POST',
        url: `/v1/me/endpoints/${bobH.hId}/credentials/revoke`,
        headers: { cookie: bob.cookie, origin: t.origin },
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      const dropId = await send();
      expect(await stream.end()).toBe(true);
      expect(stream.text()).not.toContain(dropId);
    });

    it('ends a dashboard stream once its session is signed out', async () => {
      const stream = await dashboardStream(bob, bobH);
      const out = await t.app.inject({
        method: 'POST',
        url: '/api/auth/sign-out',
        headers: { cookie: bob.cookie, origin: t.origin, 'content-type': 'application/json' },
        payload: {},
      });
      expect(out.statusCode, out.body).toBe(200);
      const dropId = await send();
      expect(await stream.end()).toBe(true);
      expect(stream.text()).not.toContain(dropId);
    });

    it('ends every stream of a suspended account', async () => {
      const agent = await agentStream(bobH);
      const dashboard = await dashboardStream(bob, bobH);
      await t.db.pool.query('update app_users set suspended_at = now() where id = $1', [bob.userId]);
      const dropId = await send();
      expect(await agent.end()).toBe(true);
      expect(await dashboard.end()).toBe(true);
      expect(agent.text()).not.toContain(dropId);
      expect(dashboard.text()).not.toContain(dropId);
    });

    it('ends a stream after its lifetime, so the client reconnects through the usual checks', async () => {
      restoreLimits();
      restoreLimits = configureStreamLimits({ keepaliveMs: 600, lifetimeMs: 1500 });
      const stream = await agentStream(bobH);
      expect(await stream.end(5000)).toBe(true);
    });
  });

  it('holds no slot for a client that left while its credential was being checked', async () => {
    restoreLimits();
    restoreLimits = configureStreamLimits({ perPerson: 3, keepaliveMs: 600, lifetimeMs: 60_000 });
    for (let round = 0; round < 3; round++) {
      // stalls the credential check in the pre-handler, before the route can see the client go
      const lock = await t.db.pool.connect();
      await lock.query('begin');
      await lock.query('lock table h_credentials in access exclusive mode');
      const aborts = [0, 1, 2].map(() => new AbortController());
      const requests = aborts.map((a) =>
        fetch(`${base}/v1/h/events`, {
          headers: { ...hHeaders(bobH.credential), accept: 'text/event-stream' },
          signal: a.signal,
        }).catch(() => null),
      );
      await sleep(300);
      for (const a of aborts) a.abort();
      await Promise.all(requests);
      await sleep(100);
      await lock.query('commit');
      lock.release();
      await sleep(300);
    }
    // nine requests left early; with only three slots, any one they held would refuse this stream
    const stream = await agentStream(bobH);
    stream.close();
  });

  it('pings an idle stream on time even while it keeps being woken for changes outside its scope', async () => {
    const bobClaude = await pair(t, bob, { harness: 'claude-code' });
    // Bob receives on his other agent only: the drops below wake this agent's stream (they are Bob's) without an
    // event in its scope
    const only = await t.app.inject({
      method: 'POST',
      url: '/v1/me/default-endpoint',
      headers: { cookie: bob.cookie, origin: t.origin },
      payload: { h_id: bobClaude.hId },
    });
    expect(only.statusCode, only.body).toBe(200);
    const stream = await open('/v1/h/events?endpoint_scope=current', hHeaders(bobH.credential));
    const pings = () => stream.text().split('event: ping').length - 1;
    const started = Date.now();
    while (Date.now() - started < 1800) {
      await send('elsewhere');
      await sleep(150);
    }
    expect(pings()).toBeGreaterThanOrEqual(2);
    expect(stream.text()).toContain('event: ping\ndata: {}\n\n');
    expect(stream.text()).not.toContain('delivery.created');
    stream.close();
  });

  it('cuts off a client that stopped reading instead of buffering every batch', {
    timeout: 60_000,
  }, async () => {
    let streamRes: ServerResponse | null = null;
    const onRequest = (req: { url?: string }, res: ServerResponse) => {
      if (req.url?.startsWith('/v1/h/events')) streamRes = res;
    };
    t.app.server.on('request', onRequest);
    const socket = net.connect(Number(new URL(base).port), '127.0.0.1');
    try {
      await new Promise((resolve) => socket.once('connect', resolve));
      socket.write(
        `GET /v1/h/events HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\nAuthorization: Bearer ${bobH.credential}\r\n\r\n`,
      );
      // never reads again
      socket.pause();
      for (let i = 0; i < 100 && !(streamRes as ServerResponse | null)?.headersSent; i++) await sleep(20);
      const res = streamRes as ServerResponse | null;
      if (!res) throw new Error('the stream never started');
      // More than the sockets hold, read back to back. How much that is depends on the kernel: Linux grows a
      // loopback socket's buffers to several megabytes, macOS does not, so events are added in rounds of 300 pages
      // of 100 until the stream gives up on the client, not in one fixed amount.
      let buffered = 0;
      const deadline = Date.now() + 40_000;
      for (let round = 0; round < 12 && !res.destroyed && Date.now() < deadline; round++) {
        await fabricate(bobH.hId, 30_000);
        await t.db.pool.query('select pg_notify($1, $2)', ['agentdrop_events', bob.userId]);
        for (let i = 0; i < 60 && !res.destroyed; i++) {
          buffered = Math.max(buffered, res.writableLength);
          await sleep(50);
        }
      }
      expect(res.destroyed).toBe(true);
      // nothing more was read while it lagged: at most one page past the socket's own buffer
      expect(buffered).toBeLessThan(128 * 1024);
    } finally {
      socket.destroy();
      t.app.server.off('request', onRequest);
    }
  });

  /** Writes `n` events for an agent the way the server does: the next revisions, then the head. */
  async function fabricate(hId: string, n: number) {
    await t.db.pool.query(
      'insert into mailbox_heads (h_id, revision) values ($1, 0) on conflict do nothing',
      [hId],
    );
    await t.db.pool.query(
      `insert into mailbox_events (h_id, revision, type, drop_id)
       select $1::uuid, h.revision + g, 'delivery.state', gen_random_uuid()
       from mailbox_heads h, generate_series(1, $2::int) g where h.h_id = $1::uuid`,
      [hId, n],
    );
    await t.db.pool.query('update mailbox_heads set revision = revision + $2::int where h_id = $1::uuid', [
      hId,
      n,
    ]);
  }
});

describeDb('the LISTEN connection', () => {
  // Created before the tests: waiting for the shared test database lock counts against a hook's longer timeout,
  // never against a test's.
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  it('reconnects after its backend is terminated, and delivers what comes after', async () => {
    const url = TEST_DATABASE_URL as string;
    const channel = `agentdrop_listen_test_${randomUUID().slice(0, 8)}`;
    const got: string[] = [];
    let reconnects = 0;
    const listener = listen(url, channel, (payload) => got.push(payload), {
      onReconnect: () => {
        reconnects += 1;
      },
    });
    try {
      for (let i = 0; i < 50 && reconnects === 0; i++) await sleep(50);
      expect(reconnects).toBe(1);
      await t.db.pool.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
         where query ilike $1 and pid <> pg_backend_pid()`,
        [`%LISTEN%${channel}%`],
      );
      for (let i = 0; i < 100 && reconnects < 2; i++) await sleep(50);
      expect(reconnects).toBe(2);
      await t.db.pool.query('select pg_notify($1, $2)', [channel, 'after']);
      for (let i = 0; i < 50 && !got.includes('after'); i++) await sleep(50);
      expect(got).toContain('after');
    } finally {
      await listener.close();
    }
  });

  it('notices a connection that went silent without closing (a NAT or firewall drop) and reconnects', async () => {
    const target = new URL(TEST_DATABASE_URL as string);
    // A proxy in front of PostgreSQL that can swallow everything on the connections open so far, as a NAT that
    // forgot the mapping does: no error and no close reach either side. New connections pass as usual.
    const open: Array<{ silent: boolean }> = [];
    const proxy = net.createServer((client) => {
      const state = { silent: false };
      open.push(state);
      const server = net.connect(Number(target.port || 5432), target.hostname);
      client.on('data', (chunk) => {
        if (!state.silent) server.write(chunk);
      });
      server.on('data', (chunk) => {
        if (!state.silent) client.write(chunk);
      });
      const end = () => {
        client.destroy();
        server.destroy();
      };
      client.on('error', end);
      server.on('error', end);
      client.on('close', end);
      server.on('close', end);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    const via = new URL(target);
    via.hostname = '127.0.0.1';
    via.port = String(typeof address === 'object' && address ? address.port : 0);
    let reconnects = 0;
    const listener = listen(
      via.toString(),
      `agentdrop_listen_test_${randomUUID().slice(0, 8)}`,
      () => undefined,
      {
        checkEveryMs: 200,
        onError: () => undefined,
        onReconnect: () => {
          reconnects += 1;
        },
      },
    );
    try {
      for (let i = 0; i < 50 && reconnects === 0; i++) await sleep(50);
      expect(reconnects).toBe(1);
      for (const connection of open) connection.silent = true;
      for (let i = 0; i < 60 && reconnects < 2; i++) await sleep(50);
      expect(reconnects).toBe(2);
    } finally {
      await listener.close();
      await new Promise((resolve) => proxy.close(resolve));
    }
  });
});
