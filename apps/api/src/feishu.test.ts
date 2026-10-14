import { feishuMessage, feishuSign, noticeKey } from '@agentdrop/domain';
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
  console.warn('[feishu.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/0123456789abcdef';

it('signs exactly like Feishu’s own examples', () => {
  // Reference value from Feishu's Python example (hmac(key=f"{ts}\n{secret}", msg=b"", sha256), base64).
  expect(feishuSign('demo', 1599360473)).toBe('l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=');
});

it('keys items exactly as the CLI does (apps/cli/src/hook-notifications.test.ts holds the same vectors)', () => {
  expect(noticeKey('drop', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe('d9fedea7cb11c14c');
  expect(noticeKey('contact', 'bob')).toBe('10a032fce09bcc56');
  expect(noticeKey('invitation', 'lab')).toBe('a8d294c9fd72a5de');
  expect(noticeKey('join', 'lab\u0000carol')).toBe('7b4036f0643d39db');
});

it('shows received text as one plain line and always contains the keyword AgentDrop', () => {
  const message = feishuMessage(
    { kind: 'drop', fromName: 'Bob\n\u202e', fromHandle: 'bob', title: 'a\n\nb', link: null },
    'en',
  );
  expect(JSON.stringify(message)).toContain('Direct message: Bob (@bob) · “a b”');
  expect(JSON.stringify(message)).toContain('AgentDrop');
});

it('says whether a message came directly or through a group, and which group', () => {
  const base = { kind: 'drop', fromName: 'Bob', fromHandle: 'bob', title: 'Plan', link: null } as const;
  expect(JSON.stringify(feishuMessage(base, 'zh'))).toContain('私信：Bob（@bob）·「Plan」');
  expect(JSON.stringify(feishuMessage(base, 'en'))).toContain('Direct message: Bob (@bob) · “Plan”');
  const group = { ...base, group: { name: 'Core team', slug: 'core' } };
  expect(JSON.stringify(feishuMessage(group, 'zh'))).toContain(
    '群消息 ·「Core team」#core：Bob（@bob）·「Plan」',
  );
  expect(JSON.stringify(feishuMessage(group, 'en'))).toContain(
    'Group message · “Core team” #core: Bob (@bob) · “Plan”',
  );
  const mention = { ...group, mentioned: true };
  expect(JSON.stringify(feishuMessage(mention, 'zh'))).toContain(
    '群消息 ·「Core team」#core：Bob（@bob） @了你·「Plan」',
  );
  expect(JSON.stringify(feishuMessage(mention, 'en'))).toContain(
    'Group message · “Core team” #core: Bob (@bob) mentioned you · “Plan”',
  );
});

it('names the person and the group for requests and invitations', () => {
  const contact = { kind: 'contact', fromName: '王同学', fromHandle: 'bob', link: null } as const;
  expect(JSON.stringify(feishuMessage(contact, 'zh'))).toContain('联系人申请：王同学（@bob）想加你为联系人');
  expect(JSON.stringify(feishuMessage(contact, 'en'))).toContain(
    'Contact request: 王同学 (@bob) wants to add you as a contact',
  );
  const invitation = { kind: 'invitation', groupName: 'Core team', groupSlug: 'core', link: null } as const;
  expect(JSON.stringify(feishuMessage(invitation, 'zh'))).toContain('群邀请：你被邀请加入「Core team」#core');
  const join = {
    kind: 'join',
    groupName: 'Core team',
    groupSlug: 'core',
    inviteeHandle: 'carol',
    invitedByHandle: 'bob',
    link: null,
  } as const;
  expect(JSON.stringify(feishuMessage(join, 'zh'))).toContain(
    '入群申请：@carol 想加入「Core team」#core（@bob 邀请），只能在网页上决定',
  );
  expect(JSON.stringify(feishuMessage(join, 'en'))).toContain(
    'Join request: @carol wants to join “Core team” #core (invited by @bob); only you can decide, in the dashboard',
  );
});

describeDb('Feishu group-bot notices', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let aliceH: PairedEndpoint;
  let feishu: { url: string; body: Record<string, unknown> }[] = [];
  let reply: Record<string, unknown> = { code: 0, msg: 'success' };
  const fakeFetch = (async (url: string, init: RequestInit) => {
    feishu.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    t = await createTestApp({ feishuFetch: fakeFetch });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    feishu = [];
    reply = { code: 0, msg: 'success' };
    alice = await signUp(t, 'alice');
    aliceH = await pair(t, alice);
  });
  const put = (payload: Record<string, unknown>) =>
    t.app.inject({
      method: 'PUT',
      url: '/v1/me/feishu',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload,
    });

  it('connects only after Feishu accepts a test message, and never returns the address', async () => {
    reply = { code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' };
    const refused = await put({ url: HOOK, secret: 'wrong', language: 'zh' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().details).toMatchObject({ feishu_code: 19021 });
    reply = { code: 0, msg: 'success' };
    const ok = await put({ url: HOOK, secret: 'demo', language: 'zh' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ connected: true, url_hint: '…abcdef', has_secret: true, language: 'zh' });
    const test = feishu.at(-1)?.body as Record<string, unknown>;
    expect(test.msg_type).toBe('post');
    expect(typeof test.sign).toBe('string');
    expect(JSON.stringify(test)).toContain('AgentDrop');
    const me = (
      await t.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: alice.cookie } })
    ).json();
    expect(me.feishu).toEqual({ connected: true, url_hint: '…abcdef', has_secret: true, language: 'zh' });
    expect(JSON.stringify(me)).not.toContain(HOOK);
    // Anything but a Feishu/Lark bot address is refused outright.
    expect(
      (await put({ url: 'https://evil.example.com/open-apis/bot/v2/hook/0123456789abcdef' })).statusCode,
    ).toBe(400);
    const identity = await t.app.inject({
      method: 'GET',
      url: '/v1/h/identity',
      headers: hHeaders(aliceH.credential),
    });
    expect(identity.json().notifications).toEqual({ feishu: true });
    // The agent path (manage scope) connects and disconnects the same way.
    const viaAgent = await t.app.inject({
      method: 'DELETE',
      url: '/v1/h/feishu',
      headers: hHeaders(aliceH.credential),
    });
    expect(viaAgent.json().connected).toBe(false);
    const after = await t.app.inject({
      method: 'GET',
      url: '/v1/h/identity',
      headers: hHeaders(aliceH.credential),
    });
    expect(after.json().notifications).toEqual({ feishu: false });
  });
});
