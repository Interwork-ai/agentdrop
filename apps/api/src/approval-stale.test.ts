import { randomUUID } from 'node:crypto';
import { sendRequests } from '@agentdrop/db';
import { reviewHintApprovalPolicy } from '@agentdrop/domain';
import { eq } from 'drizzle-orm';
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
  console.warn('[approval-stale.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

/** An approval whose targets can no longer be resolved is closed as stale instead of failing every approve. */
describeDb('approval whose recipients can no longer be resolved', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let carol: BrowserUser;
  let aliceH: PairedEndpoint;
  let bobH: PairedEndpoint;
  let carolH: PairedEndpoint;

  const post = (url: string, u: BrowserUser, payload?: unknown) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: u.cookie, origin: t.origin },
      payload: payload ?? {},
    });
  const get = (url: string, u: BrowserUser) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: u.cookie, origin: t.origin } });

  beforeAll(async () => {
    t = await createTestApp({ approvalPolicy: reviewHintApprovalPolicy });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice', 'Alice');
    bob = await signUp(t, 'bob', 'Bob');
    carol = await signUp(t, 'carol', 'Carol');
    aliceH = await pair(t, alice, { harness: 'codex' });
    bobH = await pair(t, bob, { harness: 'codex' });
    carolH = await pair(t, carol, { harness: 'codex' });
  });

  it('a mentioned member leaving turns approve into STALE_APPROVAL and closes the approval', async () => {
    const g = await post('/v1/me/groups', alice, {
      slug: 'grp',
      display_name: 'G',
      binding_h_ids: [aliceH.hId],
    });
    expect(g.statusCode, g.body).toBe(200);
    const groupId = g.json().group_id as string;
    for (const [u, h] of [
      [bob, bobH],
      [carol, carolH],
    ] as const) {
      expect((await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: u.handle })).statusCode).toBe(
        200,
      );
      const joined = await post(`/v1/me/groups/${groupId}/accept`, u, { h_ids: [h.hId] });
      expect(joined.statusCode, joined.body).toBe(200);
    }
    // a server-classified risky attachment holds the send for approval
    const up = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceH.credential),
        'content-type': 'application/octet-stream',
        'content-length': '20',
        'x-agentdrop-filename': 'k.txt',
      },
      payload: Buffer.from('AKIAABCDEFGHIJKLMNOP'),
    });
    expect(up.statusCode, up.body).toBe(201);
    const requestId = `r-${randomUUID()}`;
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(aliceH.credential),
      payload: {
        request_id: requestId,
        targets: [{ type: 'group', group_id: groupId }],
        payload: {
          payload_version: 1,
          kind: 'text',
          title: 'risky',
          body: 'for carol',
          attachment_ids: [up.json().attachment_id],
          mentions: ['carol'],
          extensions: {},
        },
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    const approvalId = (await get('/v1/me/approvals?status=pending', alice)).json().approvals[0]
      .approval_id as string;

    expect((await post(`/v1/me/groups/${groupId}/leave`, carol)).statusCode).toBe(200);

    const stale = await post(`/v1/me/approvals/${approvalId}/decide`, alice, { decision: 'approve' });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().code).toBe('STALE_APPROVAL');
    const after = (await get(`/v1/me/approvals/${approvalId}`, alice)).json();
    expect(after.status).not.toBe('pending');
    expect((await get('/v1/me/approvals?status=pending', alice)).json().approvals).toHaveLength(0);
    const [req] = await t.db.drizzle.select().from(sendRequests).where(eq(sendRequests.requestId, requestId));
    expect(req?.outcome).toBe('not_sent');

    // not stuck: a second approve is told the approval is gone, and nothing was delivered
    const again = await post(`/v1/me/approvals/${approvalId}/decide`, alice, { decision: 'approve' });
    expect(again.json().code).toBe('APPROVAL_EXPIRED');
    const inbox = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops?view=inbox',
      headers: hHeaders(bobH.credential),
    });
    expect(inbox.json().drops).toHaveLength(0);
  });
});
