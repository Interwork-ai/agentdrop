import { randomUUID } from 'node:crypto';
import { approvals, contacts, drops, recipientRoutes, sendRequests } from '@agentdrop/db';
import { sendDrop } from '@agentdrop/domain';
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
if (!TEST_DATABASE_URL) console.info('SKIP agent privacy PostgreSQL tests: TEST_DATABASE_URL is unset');

describeDb('other people never see private agent topology', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let a: PairedEndpoint;
  let b: PairedEndpoint;
  let b2: PairedEndpoint;
  const as = (user: BrowserUser, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: user.cookie, origin: t.origin },
      ...(payload ? { payload } : {}),
    });
  const read = (url: string, endpoint = a) =>
    t.app.inject({ method: 'GET', url, headers: hHeaders(endpoint.credential) });
  const envelope = (targets: unknown[]) => ({
    request_id: randomUUID(),
    targets,
    payload: { payload_version: 1, title: 'Privacy check', body: 'hello' },
  });
  const send = (body: Record<string, unknown>) =>
    t.app.inject({ method: 'POST', url: '/v1/h/drops', headers: hHeaders(a.credential), payload: body });
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice', 'Alice');
    bob = await signUp(t, 'bob', 'Bob');
    a = await pair(t, alice, { harness: 'codex', endpointLabel: 'Alice private agent' });
    b = await pair(t, bob, { harness: 'codex', endpointLabel: 'Bob secret workstation' });
    b2 = await pair(t, bob, { harness: 'claude-code', endpointLabel: 'Bob secret reader' });
    await as(alice, 'POST', '/v1/me/contacts/invite', { handle: 'bob' });
    await as(bob, 'POST', `/v1/me/contacts/${alice.userId}/accept`);
  });

  it.each(['user', 'route'])(
    'redacts legacy %s target snapshots in retries, sent lists, detail and receipts',
    async (type) => {
      const body = envelope([{ type: 'user', user_id: bob.userId }]);
      const sent = await send(body);
      expect(sent.statusCode, sent.body).toBe(200);
      const dropId = sent.json().drop_id;
      const old = [
        {
          type,
          label: '@bob/codex',
          endpoint_count: 2,
          address: '@bob/codex',
          endpoint_label: 'Bob secret workstation',
          harness_key: 'codex',
        },
      ];
      const row = await t.db.drizzle.query.drops.findFirst({ where: eq(drops.id, dropId) });
      const req = await t.db.drizzle.query.sendRequests.findFirst({
        where: eq(sendRequests.requestId, body.request_id),
      });
      await t.db.drizzle
        .update(drops)
        .set({ targetSnapshot: { ...(row?.targetSnapshot as object), recipients: old } })
        .where(eq(drops.id, dropId));
      await t.db.drizzle
        .update(sendRequests)
        .set({ result: { ...(req?.result as object), recipients: old } })
        .where(eq(sendRequests.requestId, body.request_id));
      const expected = [
        { type, label: '@bob', endpoint_count: 1, address: '@bob', endpoint_label: null, harness_key: null },
      ];
      expect((await send(body)).json().recipients).toEqual(expected);
      const detail = (await read(`/v1/h/drops/${dropId}`)).json().drop;
      expect(detail.recipients).toEqual(expected);
      expect(detail.recipient_status[0].label).toBe('@bob');
      expect((await read('/v1/h/drops?view=sent')).json().drops[0].recipients).toEqual(expected);
      const own = (await read(`/v1/h/drops/${dropId}`, b2)).json().drop;
      expect(own.deliveries).toHaveLength(2);
      expect(own.deliveries.map((d: { agent_name: string }) => d.agent_name).sort()).toEqual([
        'Bob secret reader',
        'Bob secret workstation',
      ]);
    },
  );

  it('hides historical group fan-out in approval previews and replay, then in committed history', async () => {
    const created = await as(alice, 'POST', '/v1/me/groups', { slug: 'privacy', display_name: 'Privacy' });
    const groupId = created.json().group_id;
    await as(alice, 'POST', `/v1/me/groups/${groupId}/invite`, { handle: 'bob' });
    const accepted = await as(bob, 'POST', `/v1/me/groups/${groupId}/accept`, {});
    expect(accepted.statusCode, accepted.body).toBe(200);
    const body = envelope([{ type: 'group', group_id: groupId }]);
    const pending = await t.db.drizzle.transaction((tx) =>
      sendDrop(tx, { userId: alice.userId, hId: a.hId, via: 'h_credential' }, body, {
        originKind: 'mcp',
        maxGroupRecipients: 3,
        approvalPolicy: async () => ({ needsApproval: true, reasons: ['review'] }),
      }),
    );
    const row = await t.db.drizzle.query.approvals.findFirst({
      where: eq(approvals.requestId, body.request_id),
    });
    if (!row) throw new Error('missing approval');
    const old = [
      {
        type: 'group',
        label: '#privacy',
        endpoint_count: 3,
        address: null,
        endpoint_label: null,
        harness_key: null,
      },
    ];
    await t.db.drizzle
      .update(approvals)
      .set({ targetSnapshot: { ...(row.targetSnapshot as object), recipients: old } })
      .where(eq(approvals.id, row.id));
    await t.db.drizzle
      .update(sendRequests)
      .set({ result: { ...pending, recipients: old } })
      .where(eq(sendRequests.requestId, body.request_id));
    expect((await send(body)).json().recipients[0].endpoint_count).toBe(1);
    const preview = await as(alice, 'GET', `/v1/me/approvals/${row.id}`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().recipients[0].endpoint_count).toBe(1);
    const list = await as(alice, 'GET', '/v1/me/approvals');
    expect(list.json().approvals[0].recipients[0].endpoint_count).toBe(1);
    const committedBody = envelope([{ type: 'group', group_id: groupId }]);
    const committed = await send(committedBody);
    const dropId = committed.json().drop_id;
    const drop = await t.db.drizzle.query.drops.findFirst({ where: eq(drops.id, dropId) });
    await t.db.drizzle
      .update(drops)
      .set({ targetSnapshot: { ...(drop?.targetSnapshot as object), recipients: old } })
      .where(eq(drops.id, dropId));
    const detail = (await read(`/v1/h/drops/${dropId}`)).json().drop;
    expect(detail.recipients[0].endpoint_count).toBe(1);
    expect(detail.recipient_status[0].member_count).toBe(1);
    const before = await as(alice, 'GET', `/v1/me/groups/${groupId}`);
    expect(before.json()).toMatchObject({ endpoint_total: 0, endpoints_over_limit: false });
    await pair(t, bob, { harness: 'opencode', endpointLabel: 'Another private agent' });
    const after = await as(alice, 'GET', `/v1/me/groups/${groupId}`);
    expect(after.json()).toMatchObject({ endpoint_total: 4, endpoints_over_limit: true });
    const denied = await send(envelope([{ type: 'group', group_id: groupId }]));
    expect(denied.json()).toMatchObject({ code: 'TOO_MANY_RECIPIENTS', details: { limit: 3 } });
    expect(denied.json().details.endpoints).toBeUndefined();
  });

  it('ignores old automatic preferences, blocks new ones and strips foreign signatures', async () => {
    const auto = await t.db.drizzle.query.recipientRoutes.findFirst({
      where: and(eq(recipientRoutes.destinationHId, b.hId), eq(recipientRoutes.auto, true)),
    });
    if (!auto) throw new Error('missing route');
    expect(
      (await as(alice, 'PATCH', `/v1/me/contacts/${bob.userId}`, { preferred_route_id: auto.id })).json()
        .code,
    ).toBe('ROUTE_UNAVAILABLE');
    await t.db.drizzle
      .update(contacts)
      .set({ preferredRouteId: auto.id })
      .where(and(eq(contacts.ownerUserId, alice.userId), eq(contacts.peerUserId, bob.userId)));
    const card = (await read('/v1/h/directory?query=bob')).json().entries[0];
    expect(card).toMatchObject({
      alternatives: [],
      default_endpoint: null,
      preference_applied: false,
      preference_problem: null,
    });
    expect(card.receives_on_all_agents).toBeUndefined();
    const sent = await send(envelope([{ type: 'user', user_id: bob.userId }]));
    expect((await read(`/v1/h/drops/${sent.json().drop_id}`, b)).json().drop.deliveries).toHaveLength(2);
    await as(alice, 'PATCH', `/v1/me/endpoints/${a.hId}`, { public_name: 'Alice secret signature' });
    const signed = await send(envelope([{ type: 'user', user_id: bob.userId }]));
    expect((await read(`/v1/h/drops/${signed.json().drop_id}`, b)).json().drop.author.public_name).toBeNull();
    expect((await read(`/v1/h/drops/${signed.json().drop_id}`)).json().drop.author.public_name).toBe(
      'Alice secret signature',
    );
    const malicious = {
      ...envelope([{ type: 'route', route_id: auto.id }]),
      assistantReplyToDropId: signed.json().drop_id,
    };
    expect((await send(malicious)).statusCode).toBeGreaterThanOrEqual(400);
    const blocked = await send(envelope([{ type: 'route', route_id: auto.id }]));
    expect(blocked.json().code).toBe('ROUTE_UNAVAILABLE');
    expect(blocked.body).not.toContain('Bob secret');
  });
});
