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

describeDb('default autonomous sends', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice', 'Alice');
    bob = await signUp(t, 'bob', 'Bob');
    aliceH = await pair(t, alice, { harness: 'codex' });
    bobH = await pair(t, bob, { harness: 'claude-code' });
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

  it('delivers a review-hinted binary attachment without a human approval step', async () => {
    const bytes = Buffer.concat([Buffer.from('AKIAABCDEFGHIJKLMNOP\0'), Buffer.alloc(256, 7)]);
    const uploaded = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceH.credential),
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'x-agentdrop-filename': 'bundle.bin',
        'x-agentdrop-binary': '1',
      },
      payload: bytes,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    expect(uploaded.json().review_hints.length).toBeGreaterThan(0);

    const sent = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(aliceH.credential),
      payload: {
        request_id: `autonomous-${randomUUID()}`,
        targets: [{ type: 'user', user_id: bob.userId }],
        payload: {
          payload_version: 1,
          kind: 'file',
          title: 'binary result',
          body: 'sent autonomously',
          attachment_ids: [uploaded.json().attachment_id],
          extensions: {},
        },
      },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toMatchObject({ outcome: 'delivered', approval_url: null });

    const approvals = await t.app.inject({
      method: 'GET',
      url: '/v1/me/approvals?status=pending',
      headers: { cookie: alice.cookie },
    });
    expect(approvals.json().approvals).toEqual([]);
    const inbox = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(bobH.credential),
    });
    expect(inbox.json().drops.map((drop: { title: string }) => drop.title)).toEqual(['binary result']);
  });
});
