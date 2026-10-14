import { randomUUID } from 'node:crypto';
import { approvals, attachments, contacts, deliveries, recipientRoutes, withTx } from '@agentdrop/db';
import { expireUnlinkedAttachments, reviewHintApprovalPolicy } from '@agentdrop/domain';
import { and, eq, isNull } from 'drizzle-orm';
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
  console.warn(
    '[review-domain-regressions.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED',
  );

describeDb('approval attachments and per-person relationship/mailbox state', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let aliceH: PairedEndpoint;
  const post = (url: string, user: BrowserUser, payload: Record<string, unknown> = {}) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: user.cookie, origin: t.origin }, payload });
  const get = (url: string, user: BrowserUser) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: user.cookie } });
  const send = (h: PairedEndpoint, targets: unknown[], attachmentIds: string[] = []) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(h.credential),
      payload: {
        request_id: randomUUID(),
        targets,
        payload: {
          payload_version: 1,
          kind: 'text',
          title: 'Regression example',
          body: 'Example body',
          attachment_ids: attachmentIds,
          extensions: {},
        },
      },
    });

  beforeAll(async () => {
    t = await createTestApp({ approvalPolicy: reviewHintApprovalPolicy });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice');
    aliceH = await pair(t, alice);
  });

  async function heldAttachment() {
    const upload = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(aliceH.credential),
        'content-type': 'application/octet-stream',
        'content-length': '20',
        'x-agentdrop-filename': 'example.txt',
      },
      payload: Buffer.from('AKIAABCDEFGHIJKLMNOP'),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const attachmentId = upload.json().attachment_id as string;
    const sent = await send(aliceH, [{ type: 'user', user_id: alice.userId }], [attachmentId]);
    expect(sent.statusCode, sent.body).toBe(202);
    const pending = await get('/v1/me/approvals?status=pending', alice);
    return { attachmentId, approvalId: pending.json().approvals[0].approval_id as string };
  }

  it('does not delete an attachment held by a live approval', async () => {
    const { attachmentId, approvalId } = await heldAttachment();
    const removed = await t.app.inject({
      method: 'DELETE',
      url: `/v1/h/attachments/${attachmentId}`,
      headers: hHeaders(aliceH.credential),
    });
    expect(removed.statusCode, removed.body).toBe(400);
    expect(removed.json().code).toBe('VALIDATION_FAILED');
    const approved = await post(`/v1/me/approvals/${approvalId}/decide`, alice, { decision: 'approve' });
    expect(approved.statusCode, approved.body).toBe(200);
    const downloaded = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${approved.json().drop_id}/attachments/${attachmentId}`,
      headers: hHeaders(aliceH.credential),
    });
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(downloaded.body).toBe('AKIAABCDEFGHIJKLMNOP');
  });

  it('keeps old uploads while approval is pending and releases them after rejection', async () => {
    const { attachmentId, approvalId } = await heldAttachment();
    await t.db.drizzle
      .update(attachments)
      .set({ createdAt: new Date(Date.now() - 3 * 86_400_000) })
      .where(eq(attachments.id, attachmentId));
    const cutoff = new Date(Date.now() - 86_400_000);
    expect(await withTx(t.db, (tx) => expireUnlinkedAttachments(tx, cutoff))).toHaveLength(0);
    const rejected = await post(`/v1/me/approvals/${approvalId}/decide`, alice, { decision: 'reject' });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await withTx(t.db, (tx) => expireUnlinkedAttachments(tx, cutoff))).toHaveLength(1);
  });

  it('revalidates attachments in approvals persisted before attachment deletion was guarded', async () => {
    const { attachmentId, approvalId } = await heldAttachment();
    // A legacy pending approval can reference an upload already deleted by the old cleanup path.
    await t.db.drizzle
      .update(attachments)
      .set({ status: 'deleted', byteSize: 0, deletedAt: new Date() })
      .where(eq(attachments.id, attachmentId));
    const approved = await post(`/v1/me/approvals/${approvalId}/decide`, alice, { decision: 'approve' });
    expect(approved.statusCode, approved.body).toBe(422);
    expect(approved.json().code).toBe('ATTACHMENT_NOT_READY');
    const [row] = await t.db.drizzle.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.status).toBe('pending');
    expect((await get(`/v1/me/endpoints/${aliceH.hId}/drops?view=sent`, alice)).json().drops).toHaveLength(0);
  });

  async function makeContacts() {
    const bob = await signUp(t, 'bob');
    const bobH = await pair(t, bob);
    expect((await post('/v1/me/contacts/invite', alice, { handle: bob.handle })).statusCode).toBe(200);
    expect((await post(`/v1/me/contacts/${alice.userId}/accept`, bob)).statusCode).toBe(200);
    return { bob, bobH };
  }

  async function publishEmail() {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/v1/me/public-email',
      headers: { cookie: alice.cookie, origin: t.origin },
      payload: { public_email: 'new@example.test' },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function assertNotRelated(bob: BrowserUser, bobH: PairedEndpoint) {
    const listed = (await get('/v1/me/contacts', bob)).json().contacts;
    const entry = listed.find((c: { user_id: string }) => c.user_id === alice.userId);
    expect(entry?.public_email ?? null).toBeNull();
    const directory = await t.app.inject({
      method: 'GET',
      url: '/v1/h/directory?query=alice',
      headers: hHeaders(bobH.credential),
    });
    expect(directory.statusCode, directory.body).toBe(200);
    expect(directory.json().entries.some((e: { user_id?: string }) => e.user_id === alice.userId)).toBe(
      false,
    );
  }

  it('removing a blocked relationship keeps the block without restoring contact access on unblock', async () => {
    const { bob, bobH } = await makeContacts();
    expect((await post(`/v1/me/contacts/${alice.userId}/block`, bob, { blocked: true })).statusCode).toBe(
      200,
    );
    const removed = await t.app.inject({
      method: 'DELETE',
      url: `/v1/me/contacts/${bob.userId}`,
      headers: { cookie: alice.cookie, origin: t.origin },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await post('/v1/me/contacts/invite', alice, { handle: bob.handle })).json().code).toBe('BLOCKED');
    expect((await post(`/v1/me/contacts/${alice.userId}/block`, bob, { blocked: false })).statusCode).toBe(
      200,
    );
    await publishEmail();
    await assertNotRelated(bob, bobH);
    const invited = await post('/v1/me/contacts/invite', bob, { handle: alice.handle });
    expect(invited.json().status).toBe('invited');
    expect((await post(`/v1/me/contacts/${bob.userId}/accept`, alice)).statusCode).toBe(200);
    const sent = await send(bobH, [{ type: 'user', user_id: alice.userId }]);
    expect(sent.statusCode, sent.body).toBe(200);
  });

  it('does not trust legacy one-sided accepted rows and repairs them when inviting again', async () => {
    const { bob, bobH } = await makeContacts();
    await t.db.drizzle
      .delete(contacts)
      .where(and(eq(contacts.ownerUserId, alice.userId), eq(contacts.peerUserId, bob.userId)));
    await publishEmail();
    await assertNotRelated(bob, bobH);
    const invited = await post('/v1/me/contacts/invite', bob, { handle: alice.handle });
    expect(invited.statusCode, invited.body).toBe(200);
    expect(invited.json().status).toBe('invited');
    expect(invited.json().public_email).toBeNull();
    expect((await post(`/v1/me/contacts/${bob.userId}/accept`, alice)).statusCode).toBe(200);
  });

  it('initializes every own delivery unread when a group send also explicitly addresses one own agent', async () => {
    const other = await pair(t, alice);
    const group = await post('/v1/me/groups', alice, {
      slug: 'mixed',
      display_name: 'Mixed',
      receive_all: true,
    });
    expect(group.statusCode, group.body).toBe(200);
    const [route] = await t.db.drizzle
      .select()
      .from(recipientRoutes)
      .where(
        and(
          eq(recipientRoutes.destinationHId, other.hId),
          eq(recipientRoutes.auto, true),
          isNull(recipientRoutes.revokedAt),
        ),
      );
    expect(route).toBeDefined();
    const sent = await send(aliceH, [
      { type: 'group', group_id: group.json().group_id },
      { type: 'route', route_id: route?.id },
    ]);
    expect(sent.statusCode, sent.body).toBe(200);
    const own = await t.db.drizzle
      .select()
      .from(deliveries)
      .where(eq(deliveries.dropId, sent.json().drop_id));
    expect(own).toHaveLength(2);
    expect(own.every((d) => d.readAt === null)).toBe(true);
    for (const h of [aliceH, other]) {
      const list = await t.app.inject({
        method: 'GET',
        url: '/v1/h/drops?view=inbox&endpoint_scope=current',
        headers: hHeaders(h.credential),
      });
      expect(
        list.json().drops.find((d: { drop_id: string }) => d.drop_id === sent.json().drop_id)?.read,
      ).toBe(false);
    }
  });
});
