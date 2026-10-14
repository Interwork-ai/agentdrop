import { randomUUID } from 'node:crypto';
import {
  appUsers,
  authUsers,
  createDatabase,
  type Database,
  groupJoinRequests,
  groups,
  pushSubscriptions,
  runMigrations,
  schema,
} from '@agentdrop/db';
import { noticeKey } from '@agentdrop/domain';
import type { StorageProvider } from '@agentdrop/storage';
import { eq, getTableName, isTable, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHandlers } from './handlers.js';
import type { DeliveryProgress } from './outbox.js';
import type { SendNotification } from './push.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL)
  console.warn('[handlers.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');
const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/0123456789abcdef';

function memoryProgress(): DeliveryProgress & { keys: Set<string> } {
  const keys = new Set<string>();
  return { keys, done: (k) => keys.has(k), markDone: async (k) => void keys.add(k) };
}

describeDb('outbox handlers: push and Feishu say the same thing once per person', () => {
  let db: Database;
  let release: (() => Promise<void>) | undefined;
  let feishu: string[] = [];
  let pushes: Record<string, unknown>[] = [];
  let ids: Record<'alice' | 'bob' | 'carol' | 'dave', { id: string; handle: string }>;
  let groupId: string;
  const truncate = `TRUNCATE TABLE ${Object.values(schema)
    .flatMap((table) => (isTable(table) ? [`"public"."${getTableName(table).replaceAll('"', '""')}"`] : []))
    .join(', ')} RESTART IDENTITY`;
  const quiet = { info() {}, warn() {} } as unknown as Logger;
  const handlers = () =>
    createHandlers({
      db,
      storage: {} as StorageProvider,
      log: quiet,
      webPushConfig: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.test' },
      webhookOptions: { allowPrivateNetwork: false },
      dashboard: 'https://drop.example.test',
      fetch: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        feishu.push(body.content.post.zh_cn.content[0][0].text);
        return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      }) as unknown as typeof fetch,
      sendPush: (async (_subscription: unknown, payload?: string) => {
        pushes.push(JSON.parse(payload ?? '{}'));
        return { statusCode: 201 };
      }) as unknown as SendNotification,
    });
  const context = (progress = memoryProgress()) => ({
    eventId: randomUUID(),
    signal: new AbortController().signal,
    progress,
  });
  const shown = async (userId: string) =>
    (await db.drizzle.query.appUsers.findFirst({ where: eq(appUsers.id, userId) }))?.noticeState;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) return;
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
    feishu = [];
    pushes = [];
    const made = {} as typeof ids;
    for (const name of ['alice', 'bob', 'carol', 'dave'] as const) {
      const authId = `${name}-${randomUUID()}`;
      await db.drizzle
        .insert(authUsers)
        .values({ id: authId, name: authId, email: `${authId}@example.test`, emailVerified: true });
      const handle = `${name}${randomUUID().slice(0, 4)}`;
      const [user] = await db.drizzle
        .insert(appUsers)
        .values({
          authUserId: authId,
          handle,
          displayName: name === 'bob' ? '王同学' : name,
          ...(name === 'alice'
            ? { feishuWebhook: { url: HOOK, secret: null, language: 'zh' as const } }
            : {}),
        })
        .returning();
      if (!user) throw new Error('fixture user insert failed');
      made[name] = { id: user.id, handle };
    }
    ids = made;
    await db.drizzle.insert(pushSubscriptions).values({
      userId: ids.alice.id,
      endpoint: 'https://push.example.test/alice',
      endpointHash: 'd'.repeat(64),
      p256dh: 'p256dh',
      auth: 'auth',
      deviceLabel: 'browser',
    });
    const [group] = await db.drizzle
      .insert(groups)
      .values({ slug: 'core', displayName: 'Core team', ownerUserId: ids.alice.id })
      .returning();
    if (!group) throw new Error('group insert failed');
    groupId = group.id;
  });

  it('announces each join request on its own, naming the invitee and who invited them', async () => {
    await db.drizzle.insert(groupJoinRequests).values([
      { groupId, inviteeUserId: ids.carol.id, invitedByUserId: ids.bob.id },
      { groupId, inviteeUserId: ids.dave.id, invitedByUserId: ids.bob.id },
    ]);
    const payload = {
      user_id: ids.alice.id,
      group_id: groupId,
      group_name: 'Core team',
      group_slug: 'core',
      count: 2,
      invitee_handles: [ids.carol.handle, ids.dave.handle],
    };
    await handlers()['group.join_requested']?.(payload, groupId, context());
    expect(feishu).toEqual([
      `入群申请：@${ids.carol.handle} 想加入「Core team」#core（@${ids.bob.handle} 邀请），只能在网页上决定`,
      `入群申请：@${ids.dave.handle} 想加入「Core team」#core（@${ids.bob.handle} 邀请），只能在网页上决定`,
    ]);
    expect(pushes.map((p) => [p.kind, p.invitee_handle, p.invited_by_handle, p.group_slug])).toEqual([
      ['join', ids.carol.handle, ids.bob.handle, 'core'],
      ['join', ids.dave.handle, ids.bob.handle, 'core'],
    ]);
    // Keyed per invitee, exactly like the agents' notice (`slug\0invitee`), so neither repeats the other.
    expect((await shown(ids.alice.id))?.join_requests.sort()).toEqual(
      [
        noticeKey('join', `core\u0000${ids.carol.handle}`),
        noticeKey('join', `core\u0000${ids.dave.handle}`),
      ].sort(),
    );
    // A request decided before the worker got here is not announced.
    await db.drizzle
      .update(groupJoinRequests)
      .set({ status: 'rejected', decidedAt: new Date() })
      .where(eq(groupJoinRequests.inviteeUserId, ids.dave.id));
    feishu = [];
    pushes = [];
    await handlers()['group.join_requested']?.(
      { ...payload, invitee_handles: [ids.dave.handle] },
      groupId,
      context(),
    );
    expect(feishu).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it('pushes contact requests and invitations too, and records them for the end-of-turn notice', async () => {
    await handlers()['contact.requested']?.(
      { user_id: ids.alice.id, from_handle: ids.bob.handle, from_display_name: '王同学' },
      ids.alice.id,
      context(),
    );
    // Both channels of the same event reach the person; the push does not make Feishu think it was shown before.
    expect(feishu).toEqual([`联系人申请：王同学（@${ids.bob.handle}）想加你为联系人`]);
    expect(pushes).toEqual([
      expect.objectContaining({
        kind: 'contact',
        from_handle: ids.bob.handle,
        from_display_name: '王同学',
        url: '/app/contacts',
      }),
    ]);
    expect((await shown(ids.alice.id))?.contacts).toEqual([noticeKey('contact', ids.bob.handle)]);
    await handlers()['group.invited']?.(
      { user_id: ids.alice.id, group_id: groupId, group_name: 'Core team', group_slug: 'core' },
      groupId,
      context(),
    );
    expect(feishu.at(-1)).toBe('群邀请：你被邀请加入「Core team」#core');
    expect(pushes.at(-1)).toMatchObject({ kind: 'invitation', group_name: 'Core team', group_slug: 'core' });
    expect((await shown(ids.alice.id))?.invitations).toEqual([noticeKey('invitation', 'core')]);
  });

  it('keeps the record when Feishu fails but the push of the same event got through', async () => {
    const failing = createHandlers({
      db,
      storage: {} as StorageProvider,
      log: quiet,
      webPushConfig: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.test' },
      webhookOptions: { allowPrivateNetwork: false },
      dashboard: null,
      fetch: (async () =>
        new Response(JSON.stringify({ code: 11232, msg: 'frequency limited' }), {
          status: 200,
        })) as unknown as typeof fetch,
      sendPush: (async () => ({ statusCode: 201 })) as unknown as SendNotification,
    });
    await expect(
      failing['contact.requested']?.(
        { user_id: ids.alice.id, from_handle: ids.bob.handle, from_display_name: '王同学' },
        ids.alice.id,
        context(),
      ),
    ).rejects.toThrow(/feishu 11232/);
    // The person was told (by push), so the end-of-turn notice must not tell them again.
    expect((await shown(ids.alice.id))?.contacts).toEqual([noticeKey('contact', ids.bob.handle)]);
  });
});
