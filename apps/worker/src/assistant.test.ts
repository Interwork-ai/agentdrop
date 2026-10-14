import { randomUUID } from 'node:crypto';
import {
  authUsers,
  createDatabase,
  type Database,
  devices,
  drops,
  harnessEndpoints,
  runMigrations,
  schema,
  withTx,
} from '@agentdrop/db';
import {
  type AssistantReplyOutcome,
  ensureAppUser,
  ensureAutoRoute,
  openDrop,
  sendDrop,
  setDefaultReceivingEndpoint,
} from '@agentdrop/domain';
import { eq, getTableName, isTable, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_PROGRESS_KEY, runAssistantEcho } from './assistant.js';
import type { DeliveryProgress } from './outbox.js';

function memoryProgress(): DeliveryProgress & { keys: Set<string> } {
  const keys = new Set<string>();
  return { keys, done: (k) => keys.has(k), markDone: async (k) => void keys.add(k) };
}

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL) console.info('SKIP assistant echo PostgreSQL tests: TEST_DATABASE_URL is unset');

describe('assistant echo handler', () => {
  const noDb = {} as Database;

  it('runs the reply once per event and records progress', async () => {
    const reply = vi.fn(
      async (): Promise<AssistantReplyOutcome> => ({ replied: true, dropId: randomUUID() }),
    );
    const progress = memoryProgress();
    const first = await runAssistantEcho(noDb, 'drop-1', { user_ids: ['u'] }, progress, reply);
    expect(first?.replied).toBe(true);
    expect(progress.keys.has(ASSISTANT_PROGRESS_KEY)).toBe(true);
    // a replay of the same event after the progress write skips the reply entirely
    expect(await runAssistantEcho(noDb, 'drop-1', { user_ids: ['u'] }, progress, reply)).toBeNull();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('skips drops with no recipients and leaves progress untouched when the reply fails', async () => {
    const reply = vi.fn(async (): Promise<AssistantReplyOutcome> => {
      throw new Error('db down');
    });
    const progress = memoryProgress();
    expect(await runAssistantEcho(noDb, 'drop-2', { user_ids: [] }, progress, reply)).toBeNull();
    expect(reply).not.toHaveBeenCalled();
    await expect(runAssistantEcho(noDb, 'drop-2', { user_ids: ['u'] }, progress, reply)).rejects.toThrow();
    expect(progress.keys.size).toBe(0);
  });
});

describeDb('assistant echo against PostgreSQL', () => {
  let db: Database;
  let release: (() => Promise<void>) | undefined;
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
    db = createDatabase(TEST_DATABASE_URL, { max: 3 });
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
  });

  /** A person with one paired agent; creating the profile also creates the assistant and the contact pair. */
  async function person() {
    return withTx(db, async (tx) => {
      const authId = `u-${randomUUID()}`;
      await tx.insert(authUsers).values({ id: authId, name: 'Pat', email: `${authId}@example.test` });
      const user = await ensureAppUser(tx, { authUserId: authId, handle: 'pat', displayName: 'Pat' });
      const [device] = await tx
        .insert(devices)
        .values({ userId: user.id, installationId: randomUUID(), label: 'laptop' })
        .returning();
      if (!device) throw new Error('fixture');
      const [h] = await tx
        .insert(harnessEndpoints)
        .values({ userId: user.id, deviceId: device.id, harnessKey: 'codex', label: 'Codex' })
        .returning();
      if (!h) throw new Error('fixture');
      await ensureAutoRoute(tx, user.id, h.id);
      await setDefaultReceivingEndpoint(tx, user.id, h.id);
      const assistant = await tx.query.appUsers.findFirst({
        where: (u, { eq: equals }) => equals(u.isSystem, true),
      });
      if (!assistant) throw new Error('assistant missing');
      return { userId: user.id, hId: h.id, assistantId: assistant.id };
    });
  }

  async function sendToAssistant(p: { userId: string; hId: string; assistantId: string }, title = 'hello') {
    const res = await withTx(db, (tx) =>
      sendDrop(
        tx,
        { userId: p.userId, hId: p.hId, via: 'h_credential' },
        {
          request_id: `req-${randomUUID()}`,
          targets: [{ type: 'user', user_id: p.assistantId }],
          payload: { payload_version: 1, title, body: 'abc' },
        },
        { originKind: 'mcp', maxGroupRecipients: 5 },
      ),
    );
    if (!res.dropId) throw new Error('send failed');
    return res.dropId;
  }

  it('replies exactly once even when the event replays with lost progress, and never answers itself', async () => {
    const p = await person();
    const dropId = await sendToAssistant(p);
    const payload = { user_ids: [p.assistantId] };

    const first = await runAssistantEcho(db, dropId, payload, memoryProgress());
    expect(first?.replied).toBe(true);
    // a crash between the reply and the progress write: the next attempt starts with empty progress
    const replay = await runAssistantEcho(db, dropId, payload, memoryProgress());
    expect(replay).toEqual({ replied: false, reason: 'already_replied' });
    const replies = await db.drizzle.select().from(drops).where(eq(drops.authorUserId, p.assistantId));
    expect(replies).toHaveLength(1);
    const reply = replies[0];
    expect(reply && openDrop(reply).title).toBe('Receipt: hello');
    expect(replies[0]?.expiresAt).not.toBeNull();

    // the reply itself raises drop.delivered for the person; the handler must not answer it
    if (!first?.replied) throw new Error('no reply');
    const loop = await runAssistantEcho(db, first.dropId, { user_ids: [p.userId] }, memoryProgress());
    expect(loop).toEqual({ replied: false, reason: 'own_drop' });
    expect(await db.drizzle.select().from(drops).where(eq(drops.authorUserId, p.assistantId))).toHaveLength(
      1,
    );
  });

  it('answers a Chinese title in Chinese', async () => {
    const p = await person();
    const dropId = await sendToAssistant(p, '你好');
    expect(
      (await runAssistantEcho(db, dropId, { user_ids: [p.assistantId] }, memoryProgress()))?.replied,
    ).toBe(true);
    const [reply] = await db.drizzle.select().from(drops).where(eq(drops.authorUserId, p.assistantId));
    expect(reply && openDrop(reply).title).toBe('回执：你好');
  });

  it('concurrent replays of one event produce one reply', async () => {
    const p = await person();
    const dropId = await sendToAssistant(p);
    const payload = { user_ids: [p.assistantId] };
    // the loser either sees the winner's request row or waits on its unique index and gets the same drop back
    await Promise.all([
      runAssistantEcho(db, dropId, payload, memoryProgress()),
      runAssistantEcho(db, dropId, payload, memoryProgress()),
    ]);
    expect(await db.drizzle.select().from(drops).where(eq(drops.authorUserId, p.assistantId))).toHaveLength(
      1,
    );
  });
});
