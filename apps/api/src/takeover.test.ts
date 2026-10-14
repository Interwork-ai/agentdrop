import { randomUUID } from 'node:crypto';
import { deliveries, groupBindings, harnessEndpoints, recipientRoutes } from '@agentdrop/db';
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

/*
 * ADR 0011: a new agent (e.g. on a replacement machine) takes over an agent whose machine is gone. Contacts who
 * remembered the old agent's address, and groups that received only with it, keep reaching the person.
 */
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('an agent takes over another of the same account', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let oldAgent: PairedEndpoint;
  let bobH: PairedEndpoint;
  let codexRoute: string;

  const as = (user: BrowserUser, method: 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: user.cookie, origin: t.origin },
      ...(payload ? { payload } : {}),
    });
  const sendToAlice = (title: string) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(bobH.credential),
      payload: {
        request_id: randomUUID(),
        targets: [{ type: 'user', user_id: alice.userId }],
        payload: { payload_version: 1, kind: 'text', title, body: 'b', attachment_ids: [], extensions: {} },
      },
    });
  const route = async (id: string) =>
    (await t.db.drizzle.select().from(recipientRoutes).where(eq(recipientRoutes.id, id)))[0];
  const deliveredTo = async (dropId: string) =>
    (
      await t.db.drizzle.select({ h: deliveries.hId }).from(deliveries).where(eq(deliveries.dropId, dropId))
    ).map((r) => r.h);

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
    oldAgent = await pair(t, alice, { harness: 'codex' });
    bobH = await pair(t, bob, { harness: 'claude-code' });
    await as(alice, 'POST', '/v1/me/contacts/invite', { handle: bob.handle });
    await as(bob, 'POST', `/v1/me/contacts/${alice.userId}/accept`);
    const [auto] = await t.db.drizzle
      .select()
      .from(recipientRoutes)
      .where(and(eq(recipientRoutes.destinationHId, oldAgent.hId), eq(recipientRoutes.auto, true)));
    codexRoute = auto?.id ?? '';
    // Bob remembers an intentionally published entry; automatic addresses are private.
    const named = await as(alice, 'POST', '/v1/me/routes', {
      alias: 'work',
      label: 'Work',
      h_id: oldAgent.hId,
    });
    expect(named.statusCode, named.body).toBe(200);
    const pref = await as(bob, 'PATCH', `/v1/me/contacts/${alice.userId}`, {
      preferred_route_id: named.json().route_id,
    });
    expect(pref.statusCode, pref.body).toBe(200);
  });

  it('moves addresses and group bindings to the new agent, so nobody has to change anything', async () => {
    const group = await as(alice, 'POST', '/v1/me/groups', {
      slug: 'lab',
      display_name: 'Lab',
      receive_all: false,
      binding_h_ids: [oldAgent.hId],
    });
    expect(group.statusCode, group.body).toBeLessThan(300);
    const before = await sendToAlice('before the machine died');
    expect(await deliveredTo(before.json().drop_id)).toEqual([oldAgent.hId]);

    // the machine is gone; a new one is paired: a new agent with its own address (codex-2)
    const newAgent = await pair(t, alice, { harness: 'codex' });
    const [ownAuto] = await t.db.drizzle
      .select()
      .from(recipientRoutes)
      .where(and(eq(recipientRoutes.destinationHId, newAgent.hId), eq(recipientRoutes.auto, true)));
    expect(ownAuto?.alias).toBe('codex-2');

    const res = await as(alice, 'POST', `/v1/me/endpoints/${newAgent.hId}/take-over`, {
      from_h_id: oldAgent.hId,
    });
    expect(res.statusCode, res.body).toBe(200);
    // its automatic address and the default address both pointed at the old agent
    expect(res.json()).toMatchObject({ routes_moved: 3, bindings_moved: 1 });
    expect(await route(codexRoute)).toMatchObject({
      destinationHId: newAgent.hId,
      revokedAt: null,
      alias: 'codex',
    });
    const [defaultRoute] = await t.db.drizzle
      .select()
      .from(recipientRoutes)
      .where(and(eq(recipientRoutes.userId, alice.userId), eq(recipientRoutes.isDefault, true)));
    expect(defaultRoute).toMatchObject({ destinationHId: newAgent.hId, revokedAt: null });
    expect((await route(ownAuto?.id ?? ''))?.revokedAt).not.toBeNull();
    const [old] = await t.db.drizzle
      .select()
      .from(harnessEndpoints)
      .where(eq(harnessEndpoints.id, oldAgent.hId));
    expect(old?.revokedAt).not.toBeNull();
    const bindings = await t.db.drizzle
      .select()
      .from(groupBindings)
      .where(eq(groupBindings.hId, newAgent.hId));
    expect(bindings.filter((b) => b.revokedAt === null)).toHaveLength(1);

    // bob sends exactly as before (remembered address): it reaches the new agent
    const after = await sendToAlice('after the take-over');
    expect(after.json().outcome).toBe('delivered');
    expect(await deliveredTo(after.json().drop_id)).toEqual([newAgent.hId]);
    // the new agent reads what reached the old one; the old credential no longer works
    const read = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${before.json().drop_id}`,
      headers: hHeaders(newAgent.credential),
    });
    expect(read.statusCode).toBe(200);
    const me = (
      await t.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: alice.cookie } })
    ).json();
    const oldView = me.endpoints.find((e: { h_id: string }) => e.h_id === oldAgent.hId);
    expect(oldView?.taken_over_by).toBe(newAgent.hId);
    const oldCred = await t.app.inject({
      method: 'GET',
      url: '/v1/h/drops',
      headers: hHeaders(oldAgent.credential),
    });
    expect(oldCred.statusCode).toBe(401);
  });

  it('also takes over an agent that was already revoked, bringing back the addresses revoked with it', async () => {
    await as(alice, 'POST', `/v1/me/endpoints/${oldAgent.hId}/revoke`);
    expect(
      (await sendToAlice('while revoked')).json().error?.code ?? (await sendToAlice('x')).json().code,
    ).toBe('PREFERRED_ROUTE_UNAVAILABLE');
    const newAgent = await pair(t, alice, { harness: 'codex' });
    const res = await as(alice, 'POST', `/v1/me/endpoints/${newAgent.hId}/take-over`, {
      from_h_id: oldAgent.hId,
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await sendToAlice('after the take-over');
    expect(after.json().outcome).toBe('delivered');
    expect(await deliveredTo(after.json().drop_id)).toEqual([newAgent.hId]);
    expect((await route(codexRoute))?.alias).toBe('codex');
  });

  it('refuses itself, agents of other people and a revoked agent taking over', async () => {
    const newAgent = await pair(t, alice, { harness: 'codex' });
    const self = await as(alice, 'POST', `/v1/me/endpoints/${newAgent.hId}/take-over`, {
      from_h_id: newAgent.hId,
    });
    expect(self.statusCode).toBe(400);
    const foreign = await as(alice, 'POST', `/v1/me/endpoints/${newAgent.hId}/take-over`, {
      from_h_id: bobH.hId,
    });
    expect(foreign.statusCode).toBe(404);
    await as(alice, 'POST', `/v1/me/endpoints/${newAgent.hId}/revoke`);
    const revoked = await as(alice, 'POST', `/v1/me/endpoints/${newAgent.hId}/take-over`, {
      from_h_id: oldAgent.hId,
    });
    expect(revoked.statusCode).toBe(400);
    // nothing moved: the old agent still has its address
    expect((await route(codexRoute))?.destinationHId).toBe(oldAgent.hId);
  });
});
