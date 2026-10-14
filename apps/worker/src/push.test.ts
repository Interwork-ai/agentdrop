import { randomUUID } from 'node:crypto';
import {
  appUsers,
  authUsers,
  createDatabase,
  type Database,
  deliveries,
  deliveryGrants,
  devices,
  drops,
  groupBindings,
  groupMemberships,
  groups,
  harnessEndpoints,
  pushSubscriptions,
  recipientRoutes,
  runMigrations,
  schema,
} from '@agentdrop/db';
import { loadAuthorizedDrop, noticeKey } from '@agentdrop/domain';
import type { StorageProvider } from '@agentdrop/storage';
import { and, eq, getTableName, isTable, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandlers } from './handlers.js';
import type { DeliveryProgress } from './outbox.js';
import {
  loadWebPushConfig,
  PUSH_REVOKE_AFTER_FAILURES,
  PUSH_TIMEOUT_MS,
  PushDeliveryError,
  resolveDropNotificationAudience,
  sendDropWebPush,
} from './push.js';

function memoryProgress(): DeliveryProgress & { keys: Set<string> } {
  const keys = new Set<string>();
  return { keys, done: (k) => keys.has(k), markDone: async (k) => void keys.add(k) };
}

function pushError(statusCode: number): Error {
  return Object.assign(new Error('remote push failure'), { statusCode });
}

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

interface Fixture {
  authorId: string;
  bobId: string;
  carolId: string;
  bobH: string;
  carolH: string;
  dropId: string;
  carolMembershipId: string;
  groupSlug: string;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

async function seed(db: Database): Promise<Fixture> {
  const authIds = ['author', 'bob', 'carol'].map((name) => `${name}-${randomUUID()}`);
  await db.drizzle
    .insert(authUsers)
    .values(authIds.map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true })));
  const [author, bob, carol] = await db.drizzle
    .insert(appUsers)
    .values([
      {
        authUserId: required(authIds[0], 'author auth id'),
        handle: `author-${randomUUID()}`,
        displayName: 'Author',
      },
      { authUserId: required(authIds[1], 'bob auth id'), handle: `bob-${randomUUID()}`, displayName: 'Bob' },
      {
        authUserId: required(authIds[2], 'carol auth id'),
        handle: `carol-${randomUUID()}`,
        displayName: 'Carol',
      },
    ])
    .returning();
  if (!author || !bob || !carol) throw new Error('fixture user insert failed');
  const deviceRows = await db.drizzle
    .insert(devices)
    .values(
      [author, bob, carol].map((u) => ({ userId: u.id, installationId: randomUUID(), label: u.handle })),
    )
    .returning();
  const endpointRows = await db.drizzle
    .insert(harnessEndpoints)
    .values(
      [author, bob, carol].map((u, i) => ({
        userId: u.id,
        deviceId: required(deviceRows[i], 'device row').id,
        harnessKey: 'codex' as const,
        label: u.handle,
      })),
    )
    .returning();
  const authorH = required(endpointRows[0], 'author endpoint').id;
  const bobH = required(endpointRows[1], 'bob endpoint').id;
  const carolH = required(endpointRows[2], 'carol endpoint').id;
  const [bobRoute, authorRoute] = await db.drizzle
    .insert(recipientRoutes)
    .values([
      { userId: bob.id, label: 'Bob', destinationHId: bobH, isDefault: true },
      { userId: author.id, label: 'Author', destinationHId: authorH, isDefault: true },
    ])
    .returning();
  const [group] = await db.drizzle
    .insert(groups)
    .values({ slug: `group-${randomUUID()}`, displayName: 'Group', ownerUserId: author.id })
    .returning();
  if (!bobRoute || !authorRoute || !group) throw new Error('fixture setup failed');
  const [carolMembership] = await db.drizzle
    .insert(groupMemberships)
    .values({
      groupId: group.id,
      userId: carol.id,
      status: 'active',
      muted: true,
      joinedAt: new Date(),
    })
    .returning();
  if (!carolMembership) throw new Error('membership insert failed');
  const [bobMembership] = await db.drizzle
    .insert(groupMemberships)
    .values({
      groupId: group.id,
      userId: bob.id,
      status: 'active',
      muted: true,
      joinedAt: new Date(),
    })
    .returning();
  if (!bobMembership) throw new Error('membership insert failed');
  const [carolBinding, bobBinding] = await db.drizzle
    .insert(groupBindings)
    .values([
      { membershipId: carolMembership.id, hId: carolH },
      { membershipId: bobMembership.id, hId: bobH },
    ])
    .returning();
  const [drop] = await db.drizzle
    .insert(drops)
    .values({
      authorUserId: author.id,
      originHId: authorH,
      originKind: 'mcp',
      kind: 'text',
      title: 'secret title',
      body: 'secret body',
      bodyChars: 11,
      authorSnapshot: { handle: author.handle, display_name: author.displayName },
      targetSnapshot: {},
      contentHash: randomUUID(),
    })
    .returning();
  if (!carolBinding || !bobBinding || !drop) throw new Error('fixture setup failed');
  const deliveryRows = await db.drizzle
    .insert(deliveries)
    .values([
      { dropId: drop.id, hId: bobH },
      { dropId: drop.id, hId: carolH },
      { dropId: drop.id, hId: authorH },
    ])
    .returning();
  await db.drizzle.insert(deliveryGrants).values([
    { deliveryId: required(deliveryRows[0], 'bob delivery').id, kind: 'direct', routeId: bobRoute.id },
    {
      deliveryId: required(deliveryRows[0], 'bob delivery').id,
      kind: 'group',
      groupId: group.id,
      membershipId: bobMembership.id,
      bindingId: bobBinding.id,
    },
    {
      deliveryId: required(deliveryRows[1], 'carol delivery').id,
      kind: 'group',
      groupId: group.id,
      membershipId: carolMembership.id,
      bindingId: carolBinding.id,
    },
    { deliveryId: required(deliveryRows[2], 'author delivery').id, kind: 'direct', routeId: authorRoute.id },
  ]);
  return {
    authorId: author.id,
    bobId: bob.id,
    carolId: carol.id,
    bobH,
    carolH,
    dropId: drop.id,
    carolMembershipId: carolMembership.id,
    groupSlug: group.slug,
  };
}

describe('worker Web Push config', () => {
  it('allows disabled and complete config but rejects partial values without leaking them', () => {
    expect(loadWebPushConfig({})).toBeNull();
    expect(
      loadWebPushConfig({
        WEB_PUSH_VAPID_PUBLIC_KEY: 'pub',
        WEB_PUSH_VAPID_PRIVATE_KEY: 'priv',
        WEB_PUSH_VAPID_SUBJECT: 'mailto:ops@example.test',
      }),
    ).toEqual({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.test' });
    const secret = 'do-not-leak';
    expect(() => loadWebPushConfig({ WEB_PUSH_VAPID_PRIVATE_KEY: secret })).toThrow(/set together/);
    try {
      loadWebPushConfig({ WEB_PUSH_VAPID_PRIVATE_KEY: secret });
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describeDb('worker Web Push delivery', () => {
  let db: Database;
  let release: (() => Promise<void>) | undefined;
  let fixture: Fixture;
  const truncate = `TRUNCATE TABLE ${Object.values(schema)
    .flatMap((table) => (isTable(table) ? [`"public"."${getTableName(table).replaceAll('"', '""')}"`] : []))
    .join(', ')} RESTART IDENTITY`;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL || !/(?:test_|_test)/i.test(new URL(TEST_DATABASE_URL).pathname)) {
      throw new Error('TEST_DATABASE_URL must be a dedicated test database');
    }
    const helperUrl = new URL('../../api/src/testing/database-safety.ts', import.meta.url).href;
    const safety = (await import(helperUrl)) as {
      acquireTestDatabaseLock(url: string): Promise<() => Promise<void>>;
    };
    release = await safety.acquireTestDatabaseLock(TEST_DATABASE_URL);
    await runMigrations(TEST_DATABASE_URL);
    db = createDatabase(TEST_DATABASE_URL);
  });
  afterAll(async () => {
    try {
      if (db) await db.close();
    } finally {
      await release?.();
    }
  });
  beforeEach(async () => {
    await db.drizzle.execute(sql.raw(truncate));
    fixture = await seed(db);
  });

  it('links Feishu notices to the receiving H when account-wide reading is disabled', async () => {
    await db.drizzle
      .update(appUsers)
      .set({
        crossHMailboxEnabled: false,
        feishuWebhook: {
          url: 'https://open.feishu.cn/open-apis/bot/v2/hook/0123456789abcdef',
          secret: null,
          language: 'en',
        },
      })
      .where(eq(appUsers.id, fixture.bobId));
    let message = '';
    const handlers = createHandlers({
      db,
      storage: {} as StorageProvider,
      log: { info() {}, warn() {} } as unknown as Logger,
      webPushConfig: null,
      webhookOptions: { allowPrivateNetwork: false },
      dashboard: 'https://drop.example.test',
      fetch: (async (_url, init) => {
        message = String(init?.body);
        return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      }) as typeof fetch,
    });
    await handlers['drop.delivered']?.({ user_ids: [] }, fixture.dropId, {
      eventId: randomUUID(),
      signal: new AbortController().signal,
      progress: memoryProgress(),
    });
    expect(message).toContain(`/app/inbox/${fixture.dropId}?h=${fixture.bobH}`);
    await expect(
      loadAuthorizedDrop(
        db.drizzle,
        {
          userId: fixture.bobId,
          hId: fixture.bobH,
          via: 'user_session',
        },
        fixture.dropId,
      ),
    ).resolves.toMatchObject({ drop: { id: fixture.dropId } });
  });

  it('uses direct grants, suppresses self sends, and honors group mute state', async () => {
    const muted = await resolveDropNotificationAudience(db.drizzle, fixture.dropId);
    // bob got it directly; carol (once unmuted) through the group, which the notice then names
    expect(muted?.recipients).toEqual([
      { userId: fixture.bobId, hId: fixture.bobH, group: null, mentioned: false },
    ]);
    expect(muted?.sender).toEqual({ handle: expect.stringContaining('author-'), displayName: 'Author' });
    expect(muted?.title).toBe('secret title');

    await db.drizzle
      .update(groupMemberships)
      .set({ muted: false })
      .where(eq(groupMemberships.id, fixture.carolMembershipId));
    const unmuted = await resolveDropNotificationAudience(db.drizzle, fixture.dropId);
    expect(unmuted?.recipients).toEqual(
      [
        { userId: fixture.bobId, hId: fixture.bobH, group: null, mentioned: false },
        {
          userId: fixture.carolId,
          hId: fixture.carolH,
          group: { name: 'Group', slug: fixture.groupSlug },
          mentioned: false,
        },
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
    );
    expect(unmuted?.recipients.some((r) => r.userId === fixture.authorId)).toBe(false);

    await db.drizzle.update(appUsers).set({ suspendedAt: new Date() }).where(eq(appUsers.id, fixture.bobId));
    expect((await resolveDropNotificationAudience(db.drizzle, fixture.dropId))?.recipients).toEqual([
      {
        userId: fixture.carolId,
        hId: fixture.carolH,
        group: { name: 'Group', slug: fixture.groupSlug },
        mentioned: false,
      },
    ]);
  });

  it('says it is a reply only to people who may read the original (ADR 0016)', async () => {
    const [bobDelivery] = await db.drizzle
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.dropId, fixture.dropId), eq(deliveries.hId, fixture.bobH)));
    const [original] = await db.drizzle
      .insert(drops)
      .values({
        authorUserId: fixture.bobId,
        originHId: fixture.bobH,
        originKind: 'mcp',
        kind: 'text',
        title: 'bob asked',
        body: 'question',
        bodyChars: 8,
        authorSnapshot: { handle: 'bob', display_name: 'Bob' },
        targetSnapshot: {},
        contentHash: randomUUID(),
      })
      .returning();
    if (!original || !bobDelivery) throw new Error('fixture setup failed');
    await db.drizzle.update(drops).set({ replyToDropId: original.id }).where(eq(drops.id, fixture.dropId));
    await db.drizzle
      .update(groupMemberships)
      .set({ muted: false })
      .where(eq(groupMemberships.id, fixture.carolMembershipId));
    const audience = await resolveDropNotificationAudience(db.drizzle, fixture.dropId);
    // bob wrote the original; carol never received it, so her notice is an ordinary group message
    expect(audience?.recipients.find((r) => r.userId === fixture.bobId)?.replyTo).toEqual({
      title: 'bob asked',
      mine: true,
    });
    expect(audience?.recipients.find((r) => r.userId === fixture.carolId)?.replyTo).toBeUndefined();

    const sent: Array<Record<string, unknown>> = [];
    await db.drizzle.insert(pushSubscriptions).values(
      [fixture.bobId, fixture.carolId].map((userId, i) => ({
        userId,
        endpoint: `https://push.example.test/reply-${i}`,
        endpointHash: `${i}`.padStart(64, '0'),
        p256dh: `p256dh-key-${i}`,
        auth: `auth-key-${i}`,
        deviceLabel: `device-${i}`,
      })),
    );
    const send = vi.fn(async (_subscription: unknown, payload?: string) => {
      sent.push(JSON.parse(payload ?? '{}'));
      return { statusCode: 201 };
    });
    await sendDropWebPush(
      db.drizzle,
      { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.test' },
      fixture.dropId,
      'event-reply',
      new AbortController().signal,
      send as never,
    );
    const byHId = new Map(sent.map((p) => [p.h_id, p]));
    expect(byHId.get(fixture.bobH)).toMatchObject({ reply_to_title: 'bob asked', reply_to_mine: true });
    expect(byHId.get(fixture.carolH)).toMatchObject({ reply_to_title: null, reply_to_mine: false });
    expect(JSON.stringify(byHId.get(fixture.carolH))).not.toContain('bob asked');
  });

  it('a mention reaches a member who muted the group, and says so', async () => {
    const [row] = await db.drizzle.select().from(drops).where(eq(drops.id, fixture.dropId));
    await db.drizzle
      .update(drops)
      .set({ targetSnapshot: { ...(row?.targetSnapshot as object), mention_user_ids: [fixture.carolId] } })
      .where(eq(drops.id, fixture.dropId));
    // carol's membership is still muted from the fixture
    const audience = await resolveDropNotificationAudience(db.drizzle, fixture.dropId);
    expect(audience?.recipients.find((r) => r.userId === fixture.carolId)).toEqual({
      userId: fixture.carolId,
      hId: fixture.carolH,
      group: { name: 'Group', slug: fixture.groupSlug },
      mentioned: true,
    });
  });

  it('names the eligible group with the smallest slug when a drop came through two groups', async () => {
    await db.drizzle
      .update(groupMemberships)
      .set({ muted: false })
      .where(eq(groupMemberships.id, fixture.carolMembershipId));
    const [author] = await db.drizzle.select().from(appUsers).where(eq(appUsers.id, fixture.authorId));
    const [early] = await db.drizzle
      .insert(groups)
      .values({
        slug: `aaa-${randomUUID().slice(0, 8)}`,
        displayName: 'Early',
        ownerUserId: fixture.authorId,
      })
      .returning();
    const [muted] = await db.drizzle
      .insert(groups)
      .values({
        slug: `000-${randomUUID().slice(0, 8)}`,
        displayName: 'Muted',
        ownerUserId: fixture.authorId,
      })
      .returning();
    if (!author || !early || !muted) throw new Error('fixture setup failed');
    const [carolDelivery] = await db.drizzle
      .select()
      .from(deliveries)
      .where(eq(deliveries.hId, fixture.carolH));
    if (!carolDelivery) throw new Error('carol delivery missing');
    for (const [group, isMuted] of [
      [early, false],
      [muted, true],
    ] as const) {
      const [membership] = await db.drizzle
        .insert(groupMemberships)
        .values({
          groupId: group.id,
          userId: fixture.carolId,
          status: 'active',
          muted: isMuted,
          joinedAt: new Date(),
        })
        .returning();
      if (!membership) throw new Error('membership insert failed');
      const [binding] = await db.drizzle
        .insert(groupBindings)
        .values({ membershipId: membership.id, hId: fixture.carolH })
        .returning();
      if (!binding) throw new Error('binding insert failed');
      await db.drizzle.insert(deliveryGrants).values({
        deliveryId: carolDelivery.id,
        kind: 'group',
        groupId: group.id,
        membershipId: membership.id,
        bindingId: binding.id,
      });
    }
    const audience = await resolveDropNotificationAudience(db.drizzle, fixture.dropId);
    // "000-…" sorts first but is muted (and carol is not mentioned), so the notice names "aaa-…".
    expect(audience?.recipients.find((r) => r.userId === fixture.carolId)?.group).toEqual({
      name: 'Early',
      slug: early.slug,
    });
  });

  it('includes the Drop title but not its body, revokes expired endpoints, and retries safely', async () => {
    const values = [201, 410, 503].map((status, i) => ({
      userId: fixture.bobId,
      endpoint: `https://push.example.test/${status}`,
      endpointHash: `${status}`.padStart(64, '0'),
      p256dh: `p256dh-key-${i}`,
      auth: `auth-key-${i}`,
      deviceLabel: `device-${i}`,
    }));
    const subscriptions = await db.drizzle.insert(pushSubscriptions).values(values).returning();
    const payloads: string[] = [];
    const send = vi.fn(async (subscription: { endpoint: string }, payload?: string) => {
      payloads.push(payload ?? '');
      if (subscription.endpoint.endsWith('/201')) return { statusCode: 201 };
      const error = new Error('remote response contained a sensitive endpoint') as Error & {
        statusCode: number;
      };
      error.statusCode = subscription.endpoint.endsWith('/410') ? 410 : 503;
      throw error;
    });
    await expect(
      sendDropWebPush(
        db.drizzle,
        { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.test' },
        fixture.dropId,
        'event-123',
        new AbortController().signal,
        send as never,
      ),
    ).rejects.toBeInstanceOf(PushDeliveryError);
    expect(payloads).toHaveLength(3);
    // Encrypted to the browser, so it says what Feishu says: title, sender nickname and handle, group, mention.
    // Never the body.
    expect(payloads[0]).not.toContain('secret body');
    expect(JSON.parse(payloads[0] ?? '{}')).toMatchObject({
      event_id: 'event-123',
      kind: 'drop',
      drop_id: fixture.dropId,
      h_id: fixture.bobH,
      title: 'secret title',
      from_display_name: 'Author',
      from_handle: expect.stringContaining('author-'),
      mentioned: false,
      url: `/app/inbox/${fixture.dropId}?h=${fixture.bobH}`,
      // bob's copy was sent to him directly
      group_name: null,
      group_slug: null,
    });
    // A push that reached bob records the drop as announced, so his agents' end-of-turn notice does not repeat it.
    const bob = await db.drizzle.query.appUsers.findFirst({ where: eq(appUsers.id, fixture.bobId) });
    expect(bob?.noticeState?.drops).toEqual([noticeKey('drop', fixture.dropId)]);
    const rows = await db.drizzle.select().from(pushSubscriptions);
    const success = rows.find((r) => r.id === required(subscriptions[0], 'successful subscription').id);
    expect(success?.lastSuccessAt).toBeInstanceOf(Date);
    expect(success?.failureCount).toBe(0);
    expect(rows.find((r) => r.id === required(subscriptions[1], 'expired subscription').id)).toBeUndefined();
    expect(
      rows.find((r) => r.id === required(subscriptions[2], 'transient subscription').id)?.failureCount,
    ).toBe(1);
  });

  it('revalidates account and subscription state immediately before dispatch', async () => {
    const [subscription] = await db.drizzle
      .insert(pushSubscriptions)
      .values({
        userId: fixture.bobId,
        endpoint: 'https://fcm.googleapis.com/fcm/send/revalidation',
        endpointHash: 'a'.repeat(64),
        p256dh: 'p256dh-revalidation',
        auth: 'auth-revalidation',
        deviceLabel: 'browser',
      })
      .returning();
    if (!subscription) throw new Error('subscription insert failed');
    const staleAudience = await resolveDropNotificationAudience(db.drizzle, fixture.dropId);
    expect(staleAudience?.recipients.some((recipient) => recipient.userId === fixture.bobId)).toBe(true);

    await db.drizzle.update(appUsers).set({ suspendedAt: new Date() }).where(eq(appUsers.id, fixture.bobId));
    const send = vi.fn();
    await sendDropWebPush(
      db.drizzle,
      { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.test' },
      fixture.dropId,
      'event-revalidate',
      new AbortController().signal,
      send as never,
      staleAudience,
    );
    expect(send).not.toHaveBeenCalled();

    await db.drizzle.update(appUsers).set({ suspendedAt: null }).where(eq(appUsers.id, fixture.bobId));
    await db.drizzle.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
    await sendDropWebPush(
      db.drizzle,
      { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.test' },
      fixture.dropId,
      'event-revoked',
      new AbortController().signal,
      send as never,
      staleAudience,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('revoked or expired drops notify nobody', async () => {
    await db.drizzle.update(drops).set({ revokedAt: new Date() }).where(eq(drops.id, fixture.dropId));
    expect(await resolveDropNotificationAudience(db.drizzle, fixture.dropId)).toBeNull();
    await db.drizzle
      .update(drops)
      .set({ revokedAt: null, expiresAt: new Date(Date.now() - 1000) })
      .where(eq(drops.id, fixture.dropId));
    expect(await resolveDropNotificationAudience(db.drizzle, fixture.dropId)).toBeNull();
    await db.drizzle
      .update(drops)
      .set({ expiresAt: new Date(Date.now() + 3600_000) })
      .where(eq(drops.id, fixture.dropId));
    expect((await resolveDropNotificationAudience(db.drizzle, fixture.dropId))?.recipients).toHaveLength(1);
  });

  it('a retry skips subscriptions already delivered; other 4xx is permanent; a timeout is passed', async () => {
    const statuses = [201, 403, 503];
    const subscriptions = await db.drizzle
      .insert(pushSubscriptions)
      .values(
        statuses.map((status, i) => ({
          userId: fixture.bobId,
          endpoint: `https://push.example.test/${status}`,
          endpointHash: `${status}`.padStart(64, 'b'),
          p256dh: `p256dh-${i}`,
          auth: `auth-${i}`,
          deviceLabel: `device-${i}`,
        })),
      )
      .returning();
    const sent: string[] = [];
    const options: unknown[] = [];
    const send = vi.fn(async (subscription: { endpoint: string }, _payload?: string, opts?: unknown) => {
      sent.push(subscription.endpoint);
      options.push(opts);
      const status = Number(subscription.endpoint.split('/').pop());
      if (status === 201) return { statusCode: 201 };
      throw pushError(status);
    });
    const progress = memoryProgress();
    const run = () =>
      sendDropWebPush(
        db.drizzle,
        { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.test' },
        fixture.dropId,
        'event-progress',
        new AbortController().signal,
        send as never,
        undefined,
        progress,
      );
    await expect(run()).rejects.toBeInstanceOf(PushDeliveryError);
    expect(sent.sort()).toEqual(statuses.map((s) => `https://push.example.test/${s}`).sort());
    expect(options.every((o) => (o as { timeout?: number }).timeout === PUSH_TIMEOUT_MS)).toBe(true);
    const id = (status: number) =>
      required(subscriptions[statuses.indexOf(status)], `subscription ${status}`).id;
    expect([...progress.keys].filter((k) => k.startsWith('push:')).sort()).toEqual(
      [`push:${id(201)}`, `push:${id(403)}`].sort(),
    );
    // The delivered push marked the item as announced by this event, so Feishu of the same event still sends.
    expect(progress.keys.has(`announced:${fixture.bobId}:${noticeKey('drop', fixture.dropId)}`)).toBe(true);

    sent.length = 0;
    await expect(run()).rejects.toBeInstanceOf(PushDeliveryError);
    expect(sent).toEqual(['https://push.example.test/503']);
    const rows = await db.drizzle.select().from(pushSubscriptions);
    expect(rows.find((r) => r.id === id(403))?.failureCount).toBe(1);
    expect(rows.find((r) => r.id === id(503))?.failureCount).toBe(2);
    expect(rows.find((r) => r.id === id(201))?.failureCount).toBe(0);
  });

  it('revokes a subscription after repeated failures and then stops retrying for it', async () => {
    const [subscription] = await db.drizzle
      .insert(pushSubscriptions)
      .values({
        userId: fixture.bobId,
        endpoint: 'https://push.example.test/flaky',
        endpointHash: 'c'.repeat(64),
        p256dh: 'p256dh-flaky',
        auth: 'auth-flaky',
        deviceLabel: 'flaky',
        failureCount: PUSH_REVOKE_AFTER_FAILURES - 1,
      })
      .returning();
    if (!subscription) throw new Error('subscription insert failed');
    const send = vi.fn(async () => {
      throw pushError(503);
    });
    await sendDropWebPush(
      db.drizzle,
      { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.test' },
      fixture.dropId,
      'event-flaky',
      new AbortController().signal,
      send as never,
    );
    expect(send).toHaveBeenCalledTimes(1);
    const [row] = await db.drizzle
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.id, subscription.id));
    expect(row?.revokedAt).toBeInstanceOf(Date);
    expect(row?.failureCount).toBe(PUSH_REVOKE_AFTER_FAILURES);
  });
});
