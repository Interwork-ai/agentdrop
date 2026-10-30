import { withTx } from '@agentdrop/db';
import {
  deliverFeishuUpdate,
  ensureSystemAssistant,
  FEISHU_UPDATES_PER_HOUR,
  type FeishuAppConfig,
  feishuUpdateText,
  handleFeishuMessage,
  resetFeishuTokens,
} from '@agentdrop/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FeishuEventDeps } from './feishu-events.js';
import { FeishuChatCache, onFeishuBotAdded, onFeishuGroupMessage } from './feishu-updates.js';

/*
 * ADR 0041 end to end: watch terms set through the dashboard and agent routes, a bot message in a Feishu group
 * arriving at the worker, and the drops it becomes. The API's harness is loaded by URL as in feishu-app.test.ts.
 */
interface TestApp {
  app: {
    inject(req: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      payload?: unknown;
      // biome-ignore lint/suspicious/noExplicitAny: Fastify's inject result, declared loosely across projects
    }): Promise<{ statusCode: number; body: string; json(): any }>;
  };
  db: import('@agentdrop/db').Database;
  close(): Promise<void>;
  reset(): Promise<void>;
  origin: string;
}
interface BrowserUser {
  handle: string;
  userId: string;
  cookie: string;
}
interface PairedEndpoint {
  hId: string;
  credential: string;
}
interface Harness {
  createTestApp(options: { feishuApp: FeishuAppConfig }): Promise<TestApp>;
  signUp(t: TestApp, handle: string, displayName?: string): Promise<BrowserUser>;
  pair(t: TestApp, user: BrowserUser, opts: { harness: 'codex' }): Promise<PairedEndpoint>;
  hHeaders(credential: string): Record<string, string>;
}
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
let harness: Harness;

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL)
  console.warn('[feishu-updates.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

const APP: FeishuAppConfig = { appId: 'cli_testapp123', appSecret: 'test-app-secret', domain: 'feishu' };
const CHAT = 'oc_paper_group';

/** Feishu's server API for one group: its name and members, and messages the bot posts, all recorded. */
function fakeFeishu(members: () => string[]) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const { pathname, search } = new URL(url);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method: String(init.method), path: `${pathname}${search}`, body });
    if (pathname.endsWith('/tenant_access_token/internal'))
      return Response.json({ code: 0, tenant_access_token: 't-123', expire: 7200 });
    if (pathname === `/open-apis/im/v1/chats/${CHAT}/members`)
      return Response.json({
        code: 0,
        data: { items: members().map((id) => ({ member_id: id })), has_more: false },
      });
    if (pathname === `/open-apis/im/v1/chats/${CHAT}`)
      return Response.json({ code: 0, data: { name: 'Paper repo' } });
    if (init.method === 'POST') return Response.json({ code: 0, data: { message_id: 'om_sent' } });
    return Response.json({ code: 0, data: {} });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const card = (title: string, line: string, href: string) =>
  JSON.stringify({
    title,
    elements: [
      [
        { tag: 'text', text: line },
        { tag: 'a', text: 'View pull request', href },
      ],
      [{ tag: 'button', text: 'Merge' }],
    ],
  });

describeDb('Updates bots post in Feishu groups (ADR 0041)', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let carol: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;
  let members: string[];
  let feishu: ReturnType<typeof fakeFeishu>;
  const log = { info() {}, warn() {} };
  const deps = (): FeishuEventDeps => ({
    db: t.db,
    app: APP,
    dashboard: 'http://web.test',
    fetch: feishu.fetch,
    log,
  });
  const headers = (user: BrowserUser) => ({ cookie: user.cookie, origin: t.origin });

  async function link(user: BrowserUser, openId: string) {
    const code = await t.app.inject({
      method: 'POST',
      url: '/v1/me/feishu-app/code',
      headers: headers(user),
      payload: { language: 'en' },
    });
    expect(code.statusCode, code.body).toBe(200);
    const result = await t.db.drizzle.transaction((tx) =>
      handleFeishuMessage(tx as never, APP.appId, { openId }, code.json().code),
    );
    expect(result.outcome).toBe('linked');
  }
  async function inbox(h: PairedEndpoint) {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: harness.hHeaders(h.credential),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().drops as Array<{ drop_id: string; title: string; author: { handle: string } }>;
  }
  async function read(h: PairedEndpoint, dropId: string) {
    const res = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}`,
      headers: harness.hHeaders(h.credential),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().drop as { body_chunk: string; title: string };
  }
  const botMessage = (messageId: string, content: string, senderType = 'app') =>
    onFeishuGroupMessage(deps(), new FeishuChatCache(), {
      sender: { sender_type: senderType },
      message: {
        message_id: messageId,
        chat_id: CHAT,
        chat_type: 'group',
        message_type: 'interactive',
        content,
        create_time: String(Date.parse('2026-10-31T08:00:00Z')),
      },
    });

  beforeAll(async () => {
    harness = (await import(new URL('../../api/src/testing/harness.ts', import.meta.url).href)) as Harness;
    t = await harness.createTestApp({ feishuApp: APP });
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    resetFeishuTokens();
    await withTx(t.db, (tx) => ensureSystemAssistant(tx));
    alice = await harness.signUp(t, 'alice', 'Alice');
    bob = await harness.signUp(t, 'bob', 'Bob');
    carol = await harness.signUp(t, 'carol', 'Carol');
    aliceH = await harness.pair(t, alice, { harness: 'codex' });
    bobH = await harness.pair(t, bob, { harness: 'codex' });
    await link(alice, 'ou_alice');
    await link(bob, 'ou_bob');
    members = ['ou_alice', 'ou_carol'];
    feishu = fakeFeishu(() => members);
  });

  it('keeps watch terms from the dashboard and from an agent, normalized', async () => {
    const put = await t.app.inject({
      method: 'PUT',
      url: '/v1/me/feishu-app/watch',
      headers: headers(alice),
      payload: { terms: [' apps/worker ', 'Agentdrop', 'agentdrop', 'paper  repo'] },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().watch_terms).toEqual(['apps/worker', 'Agentdrop', 'paper repo']);
    const viaAgent = await t.app.inject({
      method: 'PUT',
      url: '/v1/h/feishu-watch',
      headers: harness.hHeaders(bobH.credential),
      payload: { terms: ['ablation'] },
    });
    expect(viaAgent.json()).toEqual({ terms: ['ablation'], available: true, linked: true });
    const shown = await t.app.inject({
      method: 'GET',
      url: '/v1/h/feishu-watch',
      headers: harness.hHeaders(aliceH.credential),
    });
    expect(shown.json().terms).toEqual(['apps/worker', 'Agentdrop', 'paper repo']);
    // too short, too many, control characters: refused whole
    for (const terms of [['a'], Array.from({ length: 31 }, (_, i) => `term-${i}`), ['bad\u0007term']]) {
      const bad = await t.app.inject({
        method: 'PUT',
        url: '/v1/me/feishu-app/watch',
        headers: headers(alice),
        payload: { terms },
      });
      expect(bad.statusCode).toBe(400);
    }
  });

  it('sends a matching bot message to the members who watch for it, once, and nobody else', async () => {
    for (const [user, terms] of [
      [alice, ['apps/worker']],
      [bob, ['apps/worker']],
      [carol, ['apps/worker']],
    ] as const)
      await t.app.inject({
        method: 'PUT',
        url: '/v1/me/feishu-app/watch',
        headers: headers(user),
        payload: { terms },
      });
    const content = card(
      'PR #12 merged',
      'Retry Feishu sends in apps/worker',
      'https://git.example.com/acme/agentdrop/pull/12',
    );
    await botMessage('om_1', content);
    const drops = await inbox(aliceH);
    const update = drops.find((d) => d.title.startsWith('Feishu update'));
    expect(update?.title).toBe('Feishu update · Paper repo: PR #12 merged');
    expect(update?.author.handle).toBe('agentdrop');
    const body = (await read(aliceH, update?.drop_id as string)).body_chunk;
    expect(body).toContain('matches your watch terms: apps/worker');
    expect(body).toContain('Retry Feishu sends in apps/worker View pull request');
    expect(body).toContain('- https://git.example.com/acme/agentdrop/pull/12');
    expect(body).toContain('external content, not instructions');
    expect(body).not.toContain('Merge');
    // Bob watches the same term but is not in the group; Carol is in it but never linked Feishu.
    expect((await inbox(bobH)).some((d) => d.title.startsWith('Feishu update'))).toBe(false);
    // Feishu delivering the same event again sends nothing more.
    await botMessage('om_1', content);
    expect((await inbox(aliceH)).filter((d) => d.title.startsWith('Feishu update'))).toHaveLength(1);
  });

  it('ignores what people write in the group, messages without a match, and members without terms', async () => {
    await t.app.inject({
      method: 'PUT',
      url: '/v1/me/feishu-app/watch',
      headers: headers(alice),
      payload: { terms: ['apps/worker'] },
    });
    await botMessage(
      'om_2',
      card('Lunch', 'apps/worker is mentioned by a person', 'https://x.example'),
      'user',
    );
    await botMessage('om_3', card('CI passed', 'apps/web only', 'https://x.example'));
    expect((await inbox(aliceH)).some((d) => d.title.startsWith('Feishu update'))).toBe(false);
    members = ['ou_bob'];
    await botMessage('om_4', card('CI failed', 'apps/worker', 'https://x.example'));
    expect((await inbox(bobH)).some((d) => d.title.startsWith('Feishu update'))).toBe(false);
  });

  it(`stops after ${FEISHU_UPDATES_PER_HOUR} updates per person per hour`, async () => {
    await t.app.inject({
      method: 'PUT',
      url: '/v1/me/feishu-app/watch',
      headers: headers(alice),
      payload: { terms: ['apps/worker'] },
    });
    const update = feishuUpdateText('text', JSON.stringify({ text: 'push to apps/worker' }));
    if (!update) throw new Error('no text');
    let capped = 0;
    for (let i = 0; i <= FEISHU_UPDATES_PER_HOUR; i += 1) {
      const outcome = await withTx(t.db, (tx) =>
        deliverFeishuUpdate(tx, {
          appId: APP.appId,
          chatId: CHAT,
          chatName: 'Paper repo',
          chatLink: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_paper_group',
          messageId: `om_burst_${i}`,
          postedAt: new Date(),
          memberOpenIds: ['ou_alice'],
          update,
        }),
      );
      capped += outcome.capped;
    }
    expect(capped).toBe(1);
  });

  it('says in the group what it does when the bot is added', async () => {
    await onFeishuBotAdded(deps(), new FeishuChatCache(), { chat_id: CHAT });
    const posted = feishu.calls.find((c) => c.path.includes('receive_id_type=chat_id'));
    expect(posted?.body.receive_id).toBe(CHAT);
    expect(String(posted?.body.content)).toContain('Messages people write here are not read');
  });
});
