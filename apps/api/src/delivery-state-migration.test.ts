import { readFileSync } from 'node:fs';
import { appUsers, deliveries, deliveryGrants } from '@agentdrop/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, hHeaders, pair, signUp, TEST_DATABASE_URL, type TestApp } from './testing/harness.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL)
  console.warn('[delivery-state-migration.test] TEST_DATABASE_URL unset: PostgreSQL tests SKIPPED');

describeDb('delivery state repair after legacy per-agent state', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  async function fixture() {
    await t.reset();
    const user = await signUp(t, 'reader', 'Reader');
    const first = await pair(t, user);
    const second = await pair(t, user, { harness: 'claude-code' });
    const revoked = await pair(t, user, { harness: 'cursor' });
    const sent = await t.app.inject({
      method: 'POST',
      url: '/v1/h/drops',
      headers: hHeaders(first.credential),
      payload: {
        request_id: 'legacy-state',
        targets: [{ type: 'user', user_id: user.userId }],
        payload: {
          payload_version: 1,
          kind: 'text',
          title: 'Legacy',
          body: 'Legacy',
          attachment_ids: [],
          extensions: {},
        },
      },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const dropId = sent.json().drop_id;
    await t.db.drizzle
      .update(appUsers)
      .set({ crossHMailboxEnabled: false })
      .where(eq(appUsers.id, user.userId));
    await t.db.drizzle
      .update(deliveries)
      .set({ readAt: new Date('2026-01-01T00:00:00Z'), stateVersion: 1 })
      .where(and(eq(deliveries.dropId, dropId), eq(deliveries.hId, first.hId)));
    await t.db.drizzle
      .update(deliveries)
      .set({ readAt: new Date('2026-01-01T00:00:00Z'), stateVersion: 2 })
      .where(and(eq(deliveries.dropId, dropId), eq(deliveries.hId, second.hId)));
    const [oldDelivery] = await t.db.drizzle
      .update(deliveries)
      .set({ stateVersion: 9 })
      .where(and(eq(deliveries.dropId, dropId), eq(deliveries.hId, revoked.hId)))
      .returning();
    expect(oldDelivery).toBeDefined();
    await t.db.drizzle
      .update(deliveryGrants)
      .set({ revokedAt: new Date() })
      .where(eq(deliveryGrants.deliveryId, oldDelivery?.id ?? ''));
    return { first, dropId, revoked };
  }

  it('returns a usable person-wide version even when reads are restricted to one agent', async () => {
    const { first, dropId } = await fixture();
    const read = await t.app.inject({
      method: 'GET',
      url: `/v1/h/drops/${dropId}`,
      headers: hHeaders(first.credential),
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().drop.deliveries).toHaveLength(1);
    expect(read.json().drop.state_version).toBe(2);
    const change = await t.app.inject({
      method: 'PATCH',
      url: `/v1/h/drops/${dropId}/state`,
      headers: hHeaders(first.credential),
      payload: { expected_version: read.json().drop.state_version, starred: true },
    });
    expect(change.statusCode, change.body).toBe(200);
  });

  it('repairs every live delivery version and leaves revoked deliveries alone', async () => {
    const { dropId, revoked } = await fixture();
    const migration = readFileSync(
      new URL('../../../packages/db/drizzle/0028_repair_delivery_state_versions.sql', import.meta.url),
      'utf8',
    );
    await t.db.pool.query(migration);
    await t.db.pool.query(migration);
    const rows = await t.db.drizzle.select().from(deliveries).where(eq(deliveries.dropId, dropId));
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.hId !== revoked.hId).map((r) => r.stateVersion)).toEqual([3, 3]);
    expect(rows.find((r) => r.hId === revoked.hId)).toMatchObject({ stateVersion: 9, readAt: null });
  });
});
