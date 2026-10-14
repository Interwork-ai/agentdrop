import { randomUUID } from 'node:crypto';
import { appUsers, attachments, deliveries, recipientRoutes, sendRequests } from '@agentdrop/db';
import { type SendOptions, usedBytes } from '@agentdrop/domain';
import { and, eq } from 'drizzle-orm';
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
  console.warn('[space-storage.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

/** Holds every send whose title starts with HOLD for a human, so a test can change things while it waits. */
const holdPolicy: NonNullable<SendOptions['approvalPolicy']> = async (_tx, { envelope }) =>
  envelope.payload.title.startsWith('HOLD')
    ? { needsApproval: true, reasons: ['test hold'] }
    : { needsApproval: false, reasons: [] };

const QUOTA = 1000;

function payload(title: string, attachmentIds: string[] = [], extra: Record<string, unknown> = {}) {
  return {
    payload_version: 1,
    kind: attachmentIds.length ? 'file' : 'text',
    title,
    body: 'the ablation run',
    attachment_ids: attachmentIds,
    extensions: {},
    ...extra,
  };
}

describeDb('group file space (ADR 0029) and my own space (ADR 0030)', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let carol: BrowserUser;
  let aliceH: PairedEndpoint;
  let aliceLaptop: PairedEndpoint;
  let bobH: PairedEndpoint;
  let carolH: PairedEndpoint;

  const browser = (user: BrowserUser) => ({ cookie: user.cookie, origin: t.origin });
  const post = (url: string, user: BrowserUser, body?: unknown) =>
    t.app.inject({ method: 'POST', url, headers: browser(user), ...(body ? { payload: body } : {}) });
  const get = (url: string, user: BrowserUser) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: user.cookie } });
  const del = (url: string, user: BrowserUser) =>
    t.app.inject({ method: 'DELETE', url, headers: browser(user) });

  async function befriend(a: BrowserUser, b: BrowserUser) {
    await post('/v1/me/contacts/invite', a, { handle: b.handle });
    await post(`/v1/me/contacts/${a.userId}/accept`, b);
  }

  async function upload(ep: PairedEndpoint, size: number, name = 'run.log'): Promise<string> {
    const bytes = Buffer.alloc(size, 'a');
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/h/attachments',
      headers: {
        ...hHeaders(ep.credential),
        'content-type': 'application/octet-stream',
        'content-length': String(size),
        'x-agentdrop-filename': name,
      },
      payload: bytes,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().attachment_id as string;
  }

  const send = (
    ep: PairedEndpoint,
    targets: unknown[],
    title: string,
    attachmentIds: string[] = [],
    extra: Record<string, unknown> = {},
  ) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(ep.credential),
      payload: { request_id: `req-${randomUUID()}`, targets, payload: payload(title, attachmentIds, extra) },
    });
  const list = (ep: PairedEndpoint, q = '') =>
    t.app.inject({ method: 'GET', url: `/v1/h/drops${q}`, headers: hHeaders(ep.credential) });
  const read = (ep: PairedEndpoint, dropId: string) =>
    t.app.inject({ method: 'GET', url: `/v1/h/drops/${dropId}`, headers: hHeaders(ep.credential) });
  const download = (ep: PairedEndpoint, dropId: string, attachmentId: string) =>
    t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}/attachments/${attachmentId}`,
      headers: hHeaders(ep.credential),
    });

  /** Alice's group with Bob and Carol; only aliceH receives it on Alice's side. */
  async function makeGroup(slug: string, members: Array<[BrowserUser, PairedEndpoint]>): Promise<string> {
    const g = await post('/v1/me/groups', alice, { slug, display_name: slug, binding_h_ids: [aliceH.hId] });
    expect(g.statusCode, g.body).toBe(200);
    const id = g.json().group_id as string;
    for (const [u, h] of members) {
      expect((await post(`/v1/me/groups/${id}/invite`, alice, { handle: u.handle })).statusCode).toBe(200);
      const joined = await post(`/v1/me/groups/${id}/accept`, u, { h_ids: [h.hId] });
      expect(joined.statusCode, joined.body).toBe(200);
    }
    return id;
  }

  const storageOf = async (groupId: string, user: BrowserUser = alice) =>
    (await get(`/v1/me/groups/${groupId}`, user)).json().storage as {
      used_bytes: number;
      limit_bytes: number;
    };

  beforeAll(async () => {
    t = await createTestApp({
      approvalPolicy: holdPolicy,
      env: { GROUP_STORAGE_QUOTA_BYTES: String(QUOTA) },
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice', 'Alice');
    bob = await signUp(t, 'bob', 'Bob');
    carol = await signUp(t, 'carol', 'Carol');
    aliceH = await pair(t, alice, { harness: 'codex', endpointLabel: 'Desk agent' });
    aliceLaptop = await pair(t, alice, { harness: 'claude-code', endpointLabel: 'Laptop agent' });
    bobH = await pair(t, bob, { harness: 'codex' });
    carolH = await pair(t, carol, { harness: 'codex' });
    await befriend(alice, bob);
    await befriend(alice, carol);
  });

  describe('group file space', () => {
    it('allows files exactly up to the limit, refuses one byte more, and never refuses a drop without files', async () => {
      const groupId = await makeGroup('lab', [
        [bob, bobH],
        [carol, carolH],
      ]);
      const first = await upload(aliceH, 600);
      expect((await send(aliceH, [{ type: 'group', group_id: groupId }], 'one', [first])).statusCode).toBe(
        200,
      );
      const second = await upload(bobH, 400);
      expect((await send(bobH, [{ type: 'group', group_id: groupId }], 'two', [second])).statusCode).toBe(
        200,
      );
      // every member sees the bar
      expect(await storageOf(groupId, carol)).toEqual({ used_bytes: QUOTA, limit_bytes: QUOTA });

      const over = await upload(carolH, 1);
      const refused = await send(carolH, [{ type: 'group', group_id: groupId }], 'three', [over]);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().code).toBe('GROUP_STORAGE_FULL');
      expect(refused.json().details).toEqual({ group_id: groupId, used: QUOTA, limit: QUOTA, bytes: 1 });
      // nothing of the refused send was written
      expect((await list(bobH)).json().drops.map((d: { title: string }) => d.title)).not.toContain('three');

      // a note without files always fits
      expect((await send(carolH, [{ type: 'group', group_id: groupId }], 'just text')).statusCode).toBe(200);
      expect((await storageOf(groupId)).used_bytes).toBe(QUOTA);
    });

    it('lets only one of two concurrent sends into the remaining space', async () => {
      const groupId = await makeGroup('lab', [[bob, bobH]]);
      const a = await upload(aliceH, 600);
      const b = await upload(bobH, 600);
      const results = await Promise.all([
        send(aliceH, [{ type: 'group', group_id: groupId }], 'alice', [a]),
        send(bobH, [{ type: 'group', group_id: groupId }], 'bob', [b]),
      ]);
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 409]);
      expect(results.find((r) => r.statusCode === 409)?.json().code).toBe('GROUP_STORAGE_FULL');
      expect((await storageOf(groupId)).used_bytes).toBe(600);
    });

    it('counts a file sent to two groups once in each', async () => {
      const lab = await makeGroup('lab', [[bob, bobH]]);
      const reading = await makeGroup('reading', [[carol, carolH]]);
      const file = await upload(aliceH, 700);
      const res = await send(
        aliceH,
        [
          { type: 'group', group_id: lab },
          { type: 'group', group_id: reading },
          { type: 'group', group_id: lab },
        ],
        'both',
        [file],
      );
      expect(res.statusCode, res.body).toBe(200);
      expect((await storageOf(lab)).used_bytes).toBe(700);
      expect((await storageOf(reading)).used_bytes).toBe(700);
      const more = await upload(aliceH, 400);
      const refused = await send(aliceH, [{ type: 'group', group_id: reading }], 'more', [more]);
      expect(refused.json().code).toBe('GROUP_STORAGE_FULL');
      expect(refused.json().details).toMatchObject({ group_id: reading, used: 700, bytes: 400 });
    });

    it("an admin's runtime value wins over the server's configured one", async () => {
      await t.db.drizzle.update(appUsers).set({ isAdmin: true }).where(eq(appUsers.id, alice.userId));
      const before = await get('/v1/admin/settings', alice);
      expect(before.json().group_storage_quota_bytes).toBe(QUOTA);
      const groupId = await makeGroup('lab', [[bob, bobH]]);
      const big = await upload(aliceH, 1500);
      expect((await send(aliceH, [{ type: 'group', group_id: groupId }], 'big', [big])).statusCode).toBe(409);

      const patched = await t.app.inject({
        method: 'PATCH',
        url: '/v1/admin/settings',
        headers: browser(alice),
        payload: { group_storage_quota_bytes: 2 * 1024 * 1024 },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      expect(patched.json()).toMatchObject({
        signup_mode: 'open',
        group_storage_quota_bytes: 2 * 1024 * 1024,
        updated_by_handle: 'alice',
      });
      expect((await send(aliceH, [{ type: 'group', group_id: groupId }], 'big', [big])).statusCode).toBe(200);
      expect(await storageOf(groupId)).toEqual({ used_bytes: 1500, limit_bytes: 2 * 1024 * 1024 });
      const audit = await get('/v1/admin/audit?action=admin.group_storage_quota', alice);
      expect(audit.json().events).toHaveLength(1);
      // a member is no admin
      const denied = await t.app.inject({
        method: 'PATCH',
        url: '/v1/admin/settings',
        headers: browser(bob),
        payload: { group_storage_quota_bytes: 2 * 1024 * 1024 },
      });
      expect(denied.statusCode).toBe(403);
    });

    it('closes a held send whose files no longer fit', async () => {
      const groupId = await makeGroup('lab', [[bob, bobH]]);
      const held = await upload(aliceH, 600);
      const requestId = `req-${randomUUID()}`;
      const res = await t.app.inject({
        method: 'POST',
        url: '/v1/h/drops',
        headers: hHeaders(aliceH.credential),
        payload: {
          request_id: requestId,
          targets: [{ type: 'group', group_id: groupId }],
          payload: payload('HOLD this', [held]),
        },
      });
      expect(res.statusCode, res.body).toBe(202);
      const approvalId = (await get('/v1/me/approvals?status=pending', alice)).json().approvals[0]
        .approval_id as string;
      const meanwhile = await upload(bobH, 500);
      expect(
        (await send(bobH, [{ type: 'group', group_id: groupId }], 'first', [meanwhile])).statusCode,
      ).toBe(200);

      const stale = await post(`/v1/me/approvals/${approvalId}/decide`, alice, { decision: 'approve' });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'STALE_APPROVAL', details: { closed: true } });
      expect((await get('/v1/me/approvals?status=pending', alice)).json().approvals).toHaveLength(0);
      const [req] = await t.db.drizzle
        .select()
        .from(sendRequests)
        .where(eq(sendRequests.requestId, requestId));
      expect(req?.outcome).toBe('not_sent');
    });

    it('owner and admins remove a file: space freed, the file shown removed to every reader, download refused', async () => {
      const groupId = await makeGroup('lab', [
        [bob, bobH],
        [carol, carolH],
      ]);
      const small = await upload(bobH, 200, 'notes.txt');
      expect((await send(bobH, [{ type: 'group', group_id: groupId }], 'notes', [small])).statusCode).toBe(
        200,
      );
      const file = await upload(aliceH, 700, 'weights.bin');
      const sent = await send(aliceH, [{ type: 'group', group_id: groupId }], 'weights', [file]);
      expect(sent.statusCode).toBe(200);
      const dropId = sent.json().drop_id as string;
      const usedBefore = await usedBytes(t.db.drizzle, aliceH.hId);

      // a plain member can neither list nor remove
      const memberList = await get(`/v1/me/groups/${groupId}/files`, bob);
      expect(memberList.statusCode).toBe(403);
      expect(memberList.json().code).toBe('FORBIDDEN');
      const memberRemove = await del(`/v1/me/groups/${groupId}/files/${file}`, bob);
      expect(memberRemove.statusCode).toBe(403);
      expect((await download(carolH, dropId, file)).statusCode).toBe(200);

      const files = await get(`/v1/me/groups/${groupId}/files`, alice);
      expect(files.statusCode, files.body).toBe(200);
      expect(files.json().storage).toEqual({ used_bytes: 900, limit_bytes: QUOTA });
      expect(files.json().files.map((f: { safe_name: string }) => f.safe_name)).toEqual([
        'weights.bin',
        'notes.txt',
      ]);
      expect(files.json().files[1]).toMatchObject({ from_label: 'Bob', byte_size: 200 });
      // people, never their agents (ADR 0013)
      expect(files.body).not.toContain('Desk agent');

      const removed = await del(`/v1/me/groups/${groupId}/files/${file}`, alice);
      expect(removed.statusCode, removed.body).toBe(200);
      expect(removed.json()).toEqual({
        removed: true,
        freed_bytes: 700,
        storage: { used_bytes: 200, limit_bytes: QUOTA },
      });
      expect(await usedBytes(t.db.drizzle, aliceH.hId)).toBe(usedBefore - 700);
      const again = await del(`/v1/me/groups/${groupId}/files/${file}`, alice);
      expect(again.statusCode).toBe(404);

      for (const ep of [bobH, carolH, aliceH]) {
        const detail = (await read(ep, dropId)).json().drop;
        expect(detail.attachments[0]).toMatchObject({ attachment_id: file, removed: true });
        const dl = await download(ep, dropId, file);
        expect(dl.statusCode).toBe(410);
        expect(dl.json().code).toBe('FILE_REMOVED');
      }
      // the other file is untouched and the freed space is usable again
      expect((await read(bobH, dropId)).json().drop.title).toBe('weights');
      const notes = (await list(carolH)).json().drops.find((d: { title: string }) => d.title === 'notes');
      expect((await read(carolH, notes.drop_id)).json().drop.attachments[0].removed).toBeUndefined();
      const next = await upload(carolH, 800);
      expect((await send(carolH, [{ type: 'group', group_id: groupId }], 'next', [next])).statusCode).toBe(
        200,
      );
    });

    it('an admin who joined after a file was sent downloads it through the message; a later plain member cannot', async () => {
      const groupId = await makeGroup('lab', [[bob, bobH]]);
      const file = await upload(bobH, 300, 'weights.bin');
      const sent = await send(bobH, [{ type: 'group', group_id: groupId }], 'weights', [file]);
      expect(sent.statusCode, sent.body).toBe(200);
      const dropId = sent.json().drop_id as string;

      // Carol joins after the send: the drop never reached her mailbox
      expect(
        (await post(`/v1/me/groups/${groupId}/invite`, alice, { handle: carol.handle })).statusCode,
      ).toBe(200);
      expect((await post(`/v1/me/groups/${groupId}/accept`, carol, { h_ids: [carolH.hId] })).statusCode).toBe(
        200,
      );
      const asMember = await download(carolH, dropId, file);
      expect(asMember.statusCode).toBe(404);
      expect(asMember.body).not.toContain('weights.bin');

      // as an admin she reaches the group's files (the Files tab links here), with the same bytes
      const promoted = await t.app.inject({
        method: 'PATCH',
        url: `/v1/me/groups/${groupId}/members/${carol.userId}`,
        headers: browser(alice),
        payload: { role: 'admin' },
      });
      expect(promoted.statusCode, promoted.body).toBe(200);
      const got = await download(carolH, dropId, file);
      expect(got.statusCode, got.body).toBe(200);
      expect(got.rawPayload.equals(Buffer.alloc(300, 'a'))).toBe(true);
      expect(got.headers['content-disposition']).toContain('weights.bin');

      expect((await del(`/v1/me/groups/${groupId}/files/${file}`, carol)).statusCode).toBe(200);
      const gone = await download(carolH, dropId, file);
      expect(gone.statusCode).toBe(410);
      expect(gone.json().code).toBe('FILE_REMOVED');
    });

    it('a held send whose file a group admin removed meanwhile fails cleanly and delivers nothing', async () => {
      const groupId = await makeGroup('lab', [[bob, bobH]]);
      const file = await upload(aliceH, 300);
      expect((await send(aliceH, [{ type: 'group', group_id: groupId }], 'shared', [file])).statusCode).toBe(
        200,
      );
      const held = await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'HOLD direct', [file]);
      expect(held.statusCode, held.body).toBe(202);
      const approvalId = (await get('/v1/me/approvals?status=pending', alice)).json().approvals[0]
        .approval_id as string;
      expect((await del(`/v1/me/groups/${groupId}/files/${file}`, alice)).statusCode).toBe(200);
      const refused = await post(`/v1/me/approvals/${approvalId}/decide`, alice, { decision: 'approve' });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json().code).toBe('ATTACHMENT_NOT_READY');
      expect((await list(bobH)).json().drops.map((d: { title: string }) => d.title)).toEqual(['shared']);
    });
  });

  describe('my own space', () => {
    it('reaches every agent of mine read, stays out of inbox, sent and unread counts, and lists in view space', async () => {
      const file = await upload(aliceH, 300, 'draft.pdf');
      const res = await send(aliceH, [{ type: 'self' }], 'for the laptop', [file]);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().recipients).toEqual([
        {
          type: 'user',
          label: '@alice',
          endpoint_count: 2,
          address: '@alice',
          endpoint_label: null,
          harness_key: null,
        },
      ]);
      const dropId = res.json().drop_id as string;
      const rows = await t.db.drizzle.select().from(deliveries).where(eq(deliveries.dropId, dropId));
      expect(rows.map((r) => r.hId).sort()).toEqual([aliceH.hId, aliceLaptop.hId].sort());
      for (const r of rows) expect(r.readAt).not.toBeNull();

      for (const ep of [aliceH, aliceLaptop]) {
        const inbox = (await list(ep)).json();
        expect(inbox.drops).toHaveLength(0);
        expect(inbox.unread_count).toBe(0);
        expect(inbox.viewer.pending.unread).toBe(0);
        expect((await list(ep, '?view=sent')).json().drops).toHaveLength(0);
        expect((await list(ep, '?view=inbox&unread_only=true')).json().drops).toHaveLength(0);
      }
      const space = (await list(aliceLaptop, '?view=space')).json();
      expect(space.drops.map((d: { drop_id: string }) => d.drop_id)).toEqual([dropId]);
      expect(space.drops[0]).toMatchObject({ read: true, attachment_count: 1 });

      // Even marked unread, it never counts nor shows in the inbox
      const version = space.drops[0].state_version as number;
      const unread = await t.app.inject({
        method: 'PATCH',
        url: `/v1/h/drops/${dropId}/state`,
        headers: hHeaders(aliceLaptop.credential),
        payload: { read: false, expected_version: version },
      });
      expect(unread.statusCode, unread.body).toBe(200);
      expect((await list(aliceLaptop)).json().unread_count).toBe(0);
      expect((await list(aliceLaptop)).json().drops).toHaveLength(0);

      // nobody else sees it
      expect((await read(bobH, dropId)).statusCode).toBe(404);
      expect((await list(bobH, '?view=space')).json().drops).toHaveLength(0);
    });

    it('is readable and downloadable from another agent of mine with account-wide reads off', async () => {
      await t.db.drizzle
        .update(appUsers)
        .set({ crossHMailboxEnabled: false })
        .where(eq(appUsers.id, alice.userId));
      const file = await upload(aliceH, 120);
      const dropId = (await send(aliceH, [{ type: 'self' }], 'pick me up', [file])).json().drop_id as string;
      expect((await list(aliceLaptop, '?view=space')).json().drops).toHaveLength(1);
      expect((await read(aliceLaptop, dropId)).statusCode).toBe(200);
      const dl = await download(aliceLaptop, dropId, file);
      expect(dl.statusCode).toBe(200);
      expect(dl.rawPayload.length).toBe(120);
    });

    it('works with the sending agent as my only agent', async () => {
      const res = await send(carolH, [{ type: 'self' }], 'note to self');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().recipients[0]).toMatchObject({ label: '@carol', endpoint_count: 1 });
      expect((await list(carolH, '?view=space')).json().drops).toHaveLength(1);
    });

    it('cannot be combined with another target or with mentions', async () => {
      const mixed = await send(aliceH, [{ type: 'self' }, { type: 'user', user_id: bob.userId }], 'mixed');
      expect(mixed.statusCode, mixed.body).toBe(400);
      expect(mixed.json()).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'targets' } });
      const mention = await send(aliceH, [{ type: 'self' }], 'mention', [], { mentions: ['bob'] });
      expect(mention.json()).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'mentions' } });
      expect((await list(bobH)).json().drops).toHaveLength(0);
    });

    it('deleting an item hides it and frees the uploading agent quota; nobody else can delete it', async () => {
      const file = await upload(aliceH, 500);
      const dropId = (await send(aliceH, [{ type: 'self' }], 'temp', [file])).json().drop_id as string;
      const used = await usedBytes(t.db.drizzle, aliceH.hId);

      // another account, and a drop that is not in a space, are both not found
      const foreign = await t.app.inject({
        method: 'DELETE',
        url: `/v1/h/space/${dropId}`,
        headers: hHeaders(bobH.credential),
      });
      expect(foreign.statusCode).toBe(404);
      const direct = (await send(aliceH, [{ type: 'user', user_id: bob.userId }], 'to bob')).json()
        .drop_id as string;
      const notSpace = await t.app.inject({
        method: 'DELETE',
        url: `/v1/h/space/${direct}`,
        headers: hHeaders(aliceH.credential),
      });
      expect(notSpace.statusCode).toBe(404);

      // from the other agent, through the agent credential
      const res = await t.app.inject({
        method: 'DELETE',
        url: `/v1/h/space/${dropId}`,
        headers: hHeaders(aliceLaptop.credential),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ drop_id: dropId, deleted: true, freed_bytes: 500 });
      expect(await usedBytes(t.db.drizzle, aliceH.hId)).toBe(used - 500);
      const [row] = await t.db.drizzle.select().from(attachments).where(eq(attachments.id, file));
      expect(row?.status).toBe('deleted');
      expect((await list(aliceH, '?view=space')).json().drops).toHaveLength(0);
      expect((await read(aliceH, dropId)).statusCode).toBe(404);
      const twice = await t.app.inject({
        method: 'DELETE',
        url: `/v1/h/space/${dropId}`,
        headers: hHeaders(aliceH.credential),
      });
      expect(twice.statusCode).toBe(404);

      // the dashboard route reaches the same use-case
      const second = (await send(aliceH, [{ type: 'self' }], 'web')).json().drop_id as string;
      const web = await del(`/v1/me/endpoints/${aliceH.hId}/space/${second}`, alice);
      expect(web.json()).toEqual({ drop_id: second, deleted: true, freed_bytes: 0 });
      expect((await del(`/v1/me/endpoints/${bobH.hId}/space/${second}`, alice)).statusCode).toBe(404);
    });

    it('a handoff to one named agent of mine still arrives unread', async () => {
      const route = await t.db.drizzle.query.recipientRoutes.findFirst({
        where: and(eq(recipientRoutes.destinationHId, aliceLaptop.hId), eq(recipientRoutes.auto, true)),
      });
      expect(route).toBeDefined();
      const res = await send(aliceH, [{ type: 'route', route_id: route?.id }], 'handoff');
      expect(res.statusCode, res.body).toBe(200);
      const inbox = (await list(aliceLaptop)).json();
      expect(inbox.drops.map((d: { title: string }) => d.title)).toEqual(['handoff']);
      expect(inbox.unread_count).toBe(1);
      expect((await list(aliceLaptop, '?view=space')).json().drops).toHaveLength(0);
    });
  });
});
