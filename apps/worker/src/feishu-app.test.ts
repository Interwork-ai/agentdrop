import { randomUUID } from 'node:crypto';
import { appUsers, type Database, feishuAccounts, feishuCards } from '@agentdrop/db';
import {
  adminCloseAccount,
  type FeishuAppConfig,
  feishuAppView,
  handleFeishuMessage,
  noticeKey,
  resetFeishuTokens,
} from '@agentdrop/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sendFeishuNotices } from './feishu.js';
import { type FeishuEventDeps, onFeishuCardPress, onFeishuMessage } from './feishu-events.js';
import { dropNoticeItem } from './feishu-items.js';
import { syncFeishuCards } from './feishu-sync.js';
import { resolveDropNotificationAudience } from './push.js';
import type { NotifyContext } from './webhook.js';

/*
 * The whole path through the API's test server (accounts, contacts, drops, the dashboard routes) and the worker's
 * Feishu code. The API's harness is loaded by URL, as feishu.test.ts loads its database guard: it lives in another
 * TypeScript project, so only the shapes used here are declared.
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
  db: Database;
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
const hHeaders = (credential: string) => harness.hHeaders(credential);

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL)
  console.warn('[feishu-app.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

const APP: FeishuAppConfig = { appId: 'cli_testapp123', appSecret: 'test-app-secret', domain: 'feishu' };

/** Stands in for Feishu's server API: a token, then messages sent and changed, all recorded. */
function fakeFeishu() {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let n = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    const { pathname, search } = new URL(url);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method: String(init.method), path: `${pathname}${search}`, body });
    if (pathname.endsWith('/tenant_access_token/internal'))
      return Response.json({ code: 0, tenant_access_token: 't-123', expire: 7200 });
    if (init.method === 'POST') return Response.json({ code: 0, data: { message_id: `om_${++n}` } });
    return Response.json({ code: 0, data: {} });
  }) as unknown as typeof globalThis.fetch;
  const cards = () =>
    calls
      .filter((c) => c.path.startsWith('/open-apis/im/v1/messages'))
      .map((c) => ({ ...c, card: JSON.parse(String(c.body.content)) as Record<string, unknown> }));
  return { fetch, calls, cards };
}

describeDb('Feishu notices as cards from the server’s own app (ADR 0039)', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;
  let feishu: ReturnType<typeof fakeFeishu>;
  const log = { info() {}, warn() {} };
  const deps = (): FeishuEventDeps => ({
    db: t.db,
    app: APP,
    dashboard: 'http://web.test',
    fetch: feishu.fetch,
    log,
  });
  const progress = new Set<string>();
  const context = (): NotifyContext => ({
    eventId: randomUUID(),
    signal: new AbortController().signal,
    progress: { done: (k) => progress.has(k), markDone: async (k) => void progress.add(k) },
  });

  const post = (url: string, user: BrowserUser, body?: unknown) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: user.cookie, origin: t.origin },
      ...(body ? { payload: body } : {}),
    });
  async function send(title: string): Promise<string> {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(bobH.credential),
      payload: {
        request_id: `req-${randomUUID()}`,
        targets: [{ type: 'user', user_id: alice.userId }],
        payload: { payload_version: 1, kind: 'text', title, body: 'body' },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().drop_id;
  }
  async function aliceSees(dropId: string) {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(aliceH.credential),
    });
    return (
      res.json().drops as Array<{ drop_id: string; read: boolean; starred: boolean; state_version: number }>
    ).find((d) => d.drop_id === dropId);
  }
  async function link(user: BrowserUser, openId: string) {
    const code = await post('/v1/me/feishu-app/code', user, { language: 'zh' });
    expect(code.statusCode, code.body).toBe(200);
    const result = await t.db.drizzle.transaction((tx) =>
      handleFeishuMessage(tx as never, APP.appId, { openId }, code.json().code),
    );
    expect(result.outcome).toBe('linked');
  }
  async function notify(dropId: string) {
    const audience = await resolveDropNotificationAudience(t.db.drizzle, dropId);
    const recipient = audience?.recipients.find((r) => r.userId === alice.userId);
    if (!recipient) throw new Error('alice is not in the audience');
    await sendFeishuNotices(
      t.db,
      [
        {
          userId: alice.userId,
          list: 'drops',
          key: noticeKey('drop', dropId),
          item: dropNoticeItem(audience, recipient, `http://web.test/app/inbox/${dropId}`),
          drop: { dropId, hId: recipient.hId },
        },
      ],
      context(),
      feishu.fetch,
      undefined,
      APP,
    );
  }

  beforeAll(async () => {
    harness = (await import(new URL('../../api/src/testing/harness.ts', import.meta.url).href)) as Harness;
    t = await harness.createTestApp({ feishuApp: APP });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    resetFeishuTokens();
    progress.clear();
    feishu = fakeFeishu();
    alice = await harness.signUp(t, 'alice', 'Alice');
    bob = await harness.signUp(t, 'bob', '王同学');
    aliceH = await harness.pair(t, alice, { harness: 'codex' });
    bobH = await harness.pair(t, bob, { harness: 'codex' });
    await post('/v1/me/contacts/invite', alice, { handle: bob.handle });
    await post(`/v1/me/contacts/${alice.userId}/accept`, bob);
  });

  it('a one-time code sent to the bot links the account; the dashboard sees the link', async () => {
    // a server without an app offers nothing
    expect(await t.db.drizzle.transaction((tx) => feishuAppView(tx as never, alice.userId, null))).toEqual({
      available: false,
      linked: false,
      bot_link: null,
      linked_at: null,
      watch_terms: [],
    });
    const before = await t.app.inject({
      method: 'GET',
      url: '/v1/me/feishu-app',
      headers: { cookie: alice.cookie },
    });
    expect(before.json()).toMatchObject({ available: true, linked: false });
    expect(before.json().bot_link).toContain('appId=cli_testapp123');

    const code = await post('/v1/me/feishu-app/code', alice, { language: 'zh' });
    expect(code.json().code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    // the person sends it in their own words: lower case and without the dash still counts
    const words = `我的代码 ${code.json().code.replace('-', '').toLowerCase()}`;
    await onFeishuMessage(deps(), {
      sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
      message: {
        message_id: randomUUID(),
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: words }),
      },
    });
    const after = await t.app.inject({
      method: 'GET',
      url: '/v1/me/feishu-app',
      headers: { cookie: alice.cookie },
    });
    expect(after.json()).toMatchObject({ available: true, linked: true });
    // the bot answers in the language the code was asked for, plain text only
    const answer = feishu.cards().at(-1);
    expect(answer?.body.receive_id).toBe('ou_alice');
    expect(JSON.stringify(answer?.card)).toContain('已连接');
    expect(JSON.stringify(answer?.card)).not.toContain('"markdown"');
    // the code is used up
    const again = await t.db.drizzle.transaction((tx) =>
      handleFeishuMessage(tx as never, APP.appId, { openId: 'ou_alice' }, code.json().code),
    );
    expect(again.outcome).toBe('bad_code');
    // a group chat or another bot is not a person linking an account
    feishu.calls.length = 0;
    await onFeishuMessage(deps(), {
      sender: { sender_id: { open_id: 'ou_x' }, sender_type: 'user' },
      message: {
        message_id: randomUUID(),
        chat_type: 'group',
        message_type: 'text',
        content: '{"text":"hi"}',
      },
    });
    expect(feishu.calls).toEqual([]);
  });

  it('wrong codes are limited to five an hour; the unlink words and Disconnect remove the link', async () => {
    for (let i = 0; i < 5; i += 1)
      expect(
        (
          await t.db.drizzle.transaction((tx) =>
            handleFeishuMessage(tx as never, APP.appId, { openId: 'ou_guess' }, 'ABCD-EFGH'),
          )
        ).outcome,
      ).toBe('bad_code');
    const code = await post('/v1/me/feishu-app/code', alice);
    const blocked = await t.db.drizzle.transaction((tx) =>
      handleFeishuMessage(tx as never, APP.appId, { openId: 'ou_guess' }, code.json().code),
    );
    expect(blocked.outcome).toBe('too_many');

    await link(alice, 'ou_alice');
    const unlinked = await t.db.drizzle.transaction((tx) =>
      handleFeishuMessage(tx as never, APP.appId, { openId: 'ou_alice' }, ' 解绑 '),
    );
    expect(unlinked.outcome).toBe('unlinked');
    await link(alice, 'ou_alice');
    const off = await t.app.inject({
      method: 'DELETE',
      url: '/v1/me/feishu-app',
      headers: { cookie: alice.cookie, origin: t.origin },
    });
    expect(off.json()).toMatchObject({ linked: false });
    // one Feishu user links one account: linking bob from the same Feishu user moves the link
    await link(alice, 'ou_shared');
    await link(bob, 'ou_shared');
    const rows = await t.db.drizzle.select().from(feishuAccounts);
    expect(rows.map((r) => r.userId)).toEqual([bob.userId]);
  });

  it('a linked person gets cards, not the group bot; a press marks read or stars for the person only', async () => {
    await link(alice, 'ou_alice');
    const dropId = await send('Ablation results');
    await notify(dropId);
    const [card] = feishu.cards();
    expect(card?.path).toBe('/open-apis/im/v1/messages?receive_id_type=open_id');
    expect(card?.body).toMatchObject({ receive_id: 'ou_alice', msg_type: 'interactive' });
    const text = JSON.stringify(card?.card);
    expect(text).toContain('私信：王同学（@bob）·「Ablation results」');
    expect(text).toContain(JSON.stringify({ v: 1, a: 'read', d: dropId }));
    // names and titles are plain text: no markdown, and no body
    expect(text).not.toContain('"markdown"');
    expect(text).not.toContain('"body":"body"');
    expect((await t.db.drizzle.select().from(feishuCards)).map((c) => c.messageId)).toEqual(['om_1']);

    // someone else pressing the card changes nothing
    const stranger = await onFeishuCardPress(deps(), {
      operator: { open_id: 'ou_mallory' },
      action: { value: { v: 1, a: 'read', d: dropId } },
    });
    expect(stranger).toMatchObject({ toast: { type: 'info' } });
    expect((await aliceSees(dropId))?.read).toBe(false);

    const before = (await aliceSees(dropId))?.state_version ?? 0;
    const read = await onFeishuCardPress(deps(), {
      operator: { open_id: 'ou_alice' },
      action: { value: { v: 1, a: 'read', d: dropId } },
    });
    expect(read).toMatchObject({ toast: { type: 'success', content: '已标为已读' }, card: { type: 'raw' } });
    expect(JSON.stringify(read)).toContain('"disabled":true');
    const seen = await aliceSees(dropId);
    expect(seen?.read).toBe(true);
    expect(seen?.state_version).toBeGreaterThan(before);

    const star = await onFeishuCardPress(deps(), {
      operator: { open_id: 'ou_alice' },
      action: { value: { v: 1, a: 'star', d: dropId } },
    });
    expect(star).toMatchObject({ toast: { content: '已收藏' } });
    expect((await aliceSees(dropId))?.starred).toBe(true);
    // a value that is not ours is refused before anything is looked up
    const forged = await onFeishuCardPress(deps(), {
      operator: { open_id: 'ou_alice' },
      action: { value: { v: 1, a: 'archive', d: dropId } },
    });
    expect(forged).toMatchObject({ toast: { type: 'error' } });
  });

  it('cards follow a read elsewhere; closing the account unlinks', async () => {
    await link(alice, 'ou_alice');
    const dropId = await send('Split C numbers');
    await notify(dropId);
    expect(await syncFeishuCards(t.db, APP, { dashboard: 'http://web.test', fetch: feishu.fetch })).toBe(0);
    const current = await aliceSees(dropId);
    const patch = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${dropId}/state`,
      headers: hHeaders(aliceH.credential),
      payload: { expected_version: current?.state_version ?? 0, read: true },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(await syncFeishuCards(t.db, APP, { dashboard: 'http://web.test', fetch: feishu.fetch })).toBe(1);
    const update = feishu.cards().at(-1);
    expect(update).toMatchObject({ method: 'PATCH', path: '/open-apis/im/v1/messages/om_1' });
    expect(JSON.stringify(update?.card)).toContain('"template":"grey"');
    // nothing left to change
    expect(await syncFeishuCards(t.db, APP, { dashboard: 'http://web.test', fetch: feishu.fetch })).toBe(0);

    await t.db.drizzle.update(appUsers).set({ isAdmin: true }).where(eq(appUsers.id, bob.userId));
    await t.db.drizzle.transaction((tx) => adminCloseAccount(tx as never, bob.userId, alice.userId, 'alice'));
    expect(
      await t.db.drizzle.select().from(feishuAccounts).where(eq(feishuAccounts.userId, alice.userId)),
    ).toEqual([]);
  });
});
