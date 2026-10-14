import { randomUUID } from 'node:crypto';
import {
  appUsers,
  authUsers,
  createDatabase,
  type Database,
  runMigrations,
  schema,
  withTx,
} from '@agentdrop/db';
import { adminCloseAccount, noticeKey } from '@agentdrop/domain';
import { eq, getTableName, isTable, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FeishuTarget, sendFeishuNotices } from './feishu.js';
import type { NotifyContext } from './webhook.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/0123456789abcdef';

describeDb('Feishu notices from the worker', () => {
  let db: Database;
  let release: (() => Promise<void>) | undefined;
  let userId: string;
  let sent: Record<string, unknown>[] = [];
  let reply: Record<string, unknown> = { code: 0 };
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  const progress = new Set<string>();
  const context = (): NotifyContext => ({
    eventId: randomUUID(),
    signal: new AbortController().signal,
    progress: { done: (k) => progress.has(k), markDone: async (k) => void progress.add(k) },
  });
  const target = (): FeishuTarget => ({
    userId,
    list: 'drops',
    key: noticeKey('drop', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    item: {
      kind: 'drop',
      fromName: 'Bob',
      fromHandle: 'bob',
      title: 'Results',
      link: 'https://x/app/inbox/a',
    },
  });
  const shown = async () =>
    (await db.drizzle.query.appUsers.findFirst({ where: eq(appUsers.id, userId) }))?.noticeState?.drops ?? [];
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
    sent = [];
    reply = { code: 0 };
    progress.clear();
    const authId = `alice-${randomUUID()}`;
    await db.drizzle
      .insert(authUsers)
      .values({ id: authId, name: authId, email: `${authId}@example.test`, emailVerified: true });
    const [alice] = await db.drizzle
      .insert(appUsers)
      .values({
        authUserId: authId,
        handle: `alice-${randomUUID().slice(0, 8)}`,
        displayName: 'Alice',
        feishuWebhook: { url: HOOK, secret: 'demo', language: 'zh' },
      })
      .returning();
    if (!alice) throw new Error('fixture user insert failed');
    userId = alice.id;
  });

  it('sends once, signed, and records the item as announced for every agent', async () => {
    await sendFeishuNotices(db, [target()], context(), fakeFetch);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      msg_type: 'post',
      timestamp: expect.any(String),
      sign: expect.any(String),
    });
    expect(JSON.stringify(sent[0])).toContain('Results');
    expect(await shown()).toContain(target().key);
    // A second event for the same drop, or one an agent already announced: not sent again.
    progress.clear();
    await sendFeishuNotices(db, [target()], context(), fakeFetch);
    expect(sent).toHaveLength(1);
  });

  it('gives the claim back and retries on a temporary error, and stops on a permanent one', async () => {
    const lines: Record<string, unknown>[] = [];
    const log = {
      info: (f: Record<string, unknown>) => lines.push(f),
      warn: (f: Record<string, unknown>) => lines.push(f),
    };
    reply = { code: 11232, msg: 'frequency limited' };
    await expect(sendFeishuNotices(db, [target()], context(), fakeFetch, log)).rejects.toThrow(
      /feishu 11232/,
    );
    expect(await shown()).not.toContain(target().key);
    reply = { code: 19021, msg: 'sign match fail' };
    const ctx = context();
    await sendFeishuNotices(db, [target()], ctx, fakeFetch, log);
    expect(ctx.progress?.done(`feishu:${userId}:${target().key}`)).toBe(true);
    // Still unannounced, so the agents' end-of-turn notice shows it.
    expect(await shown()).not.toContain(target().key);
    // A later event for the same item (fresh progress) with the bot fixed: sent, then already announced.
    reply = { code: 0 };
    progress.clear();
    await sendFeishuNotices(db, [target()], context(), fakeFetch, log);
    progress.clear();
    await sendFeishuNotices(db, [target()], context(), fakeFetch, log);
    expect(lines.map((l) => [l.outcome, l.feishuCode])).toEqual([
      ['retry', 11232],
      ['gave_up', 19021],
      ['sent', undefined],
      ['already_announced', undefined],
    ]);
    // Enough to explain a missing notice, never enough to post to the person's chat.
    expect(JSON.stringify(lines)).not.toMatch(/hook|demo/);
  });

  it('does nothing for a person without a Feishu bot', async () => {
    await db.drizzle.update(appUsers).set({ feishuWebhook: null }).where(eq(appUsers.id, userId));
    await sendFeishuNotices(db, [target()], context(), fakeFetch);
    expect(sent).toHaveLength(0);
    expect(await shown()).toEqual([]);
  });

  it.each(['suspendedAt', 'deletedAt'] as const)('does not notify an account with %s set', async (field) => {
    await db.drizzle
      .update(appUsers)
      .set({ [field]: new Date() })
      .where(eq(appUsers.id, userId));
    await sendFeishuNotices(db, [target()], context(), fakeFetch);
    expect(sent).toHaveLength(0);
    expect(await shown()).toEqual([]);
  });

  it('removes the Feishu capability on closure and suppresses queued requests', async () => {
    const authId = `admin-${randomUUID()}`;
    await db.drizzle.insert(authUsers).values({ id: authId, name: 'Admin', email: `${authId}@example.test` });
    const [admin] = await db.drizzle
      .insert(appUsers)
      .values({
        authUserId: authId,
        handle: authId,
        displayName: 'Admin',
        isAdmin: true,
      })
      .returning();
    const user = await db.drizzle.query.appUsers.findFirst({ where: eq(appUsers.id, userId) });
    if (!admin || !user) throw new Error('missing account fixture');
    await withTx(db, (tx) => adminCloseAccount(tx, admin.id, userId, user.handle));
    await sendFeishuNotices(
      db,
      [
        {
          userId,
          list: 'contacts',
          key: noticeKey('contact', 'bob'),
          item: { kind: 'contact', fromName: 'Bob', fromHandle: 'bob', link: null },
        },
      ],
      context(),
      fakeFetch,
    );
    expect(sent).toHaveLength(0);
    const closed = await db.drizzle.query.appUsers.findFirst({ where: eq(appUsers.id, userId) });
    expect(closed?.feishuWebhook).toBeNull();
  });
});
