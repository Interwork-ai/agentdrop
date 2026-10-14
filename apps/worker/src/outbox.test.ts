import { randomUUID } from 'node:crypto';
import { createDatabase, type Database, outboxEvents, runMigrations, withTx } from '@agentdrop/db';
import { enqueueOutbox } from '@agentdrop/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  claimEvent,
  completeEvent,
  failEvent,
  PROGRESS_KEY,
  processOne,
  recordProgress,
  renewEvent,
} from './outbox.js';

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test value');
  return value;
}

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL) console.info('SKIP outbox PostgreSQL tests: TEST_DATABASE_URL is unset');

describeDb('outbox production leasing and fencing', () => {
  let db: Database;
  let release: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    // Runtime import shares the API test lock without compiling its source into the worker package.
    const helperUrl = new URL('../../api/src/testing/database-safety.ts', import.meta.url).href;
    const safety = (await import(helperUrl)) as {
      acquireTestDatabaseLock(url: string): Promise<() => Promise<void>>;
    };
    release = await safety.acquireTestDatabaseLock(required(TEST_DATABASE_URL));
    await runMigrations(required(TEST_DATABASE_URL));
    db = createDatabase(required(TEST_DATABASE_URL), { max: 4 });
  });
  beforeEach(async () => {
    // Only the dedicated, validated test database, under the shared lifecycle advisory lock.
    await db.drizzle.delete(outboxEvents);
  });
  afterAll(async () => {
    try {
      if (db) await db.close();
    } finally {
      await release?.();
    }
  });
  const seed = async () => {
    const aggregateId = randomUUID();
    await withTx(db, (tx) => enqueueOutbox(tx, 'drop.delivered', aggregateId, { endpoint_count: 1 }));
    return aggregateId;
  };
  const row = async (id: string) =>
    required((await db.drizzle.select().from(outboxEvents).where(eq(outboxEvents.id, id)))[0]);
  const expire = async (id: string) => {
    await db.drizzle
      .update(outboxEvents)
      .set({ lockedUntil: new Date(0) })
      .where(eq(outboxEvents.id, id));
  };

  it('concurrent production claims select one owner and increment the token on reclaim', async () => {
    await seed();
    const claims = await Promise.all([claimEvent(db, 60_000), claimEvent(db, 60_000)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = required(claims.find(Boolean));
    expect(first.attempts).toBe(1);
    expect(await claimEvent(db, 60_000)).toBeNull();
    await expire(first.id);
    const next = required(await claimEvent(db, 60_000));
    expect(next.id).toBe(first.id);
    expect(next.attempts).toBe(2);
  });

  it('expired leases cannot complete, fail, or renew, even before reclaim', async () => {
    await seed();
    const old = required(await claimEvent(db, 60_000));
    await expire(old.id);
    expect(await completeEvent(db, old)).toBe(false);
    expect(await failEvent(db, old, 1)).toBe(false);
    expect(await renewEvent(db, old, 60_000)).toBe(false);
    expect((await row(old.id)).deadAt).toBeNull();
  });

  it('stale complete and failure cannot overwrite a newer claim or completed result', async () => {
    await seed();
    const old = required(await claimEvent(db, 60_000));
    await expire(old.id);
    const next = required(await claimEvent(db, 60_000));
    expect(await completeEvent(db, old)).toBe(false);
    expect(await failEvent(db, old, 1)).toBe(false);
    expect(await renewEvent(db, old, 60_000)).toBe(false);
    expect(await completeEvent(db, next)).toBe(true);
    const completed = await row(next.id);
    expect(await failEvent(db, old, 1)).toBe(false);
    expect(await row(next.id)).toEqual(completed);
  });

  it('stale completion cannot overwrite a newer retry schedule', async () => {
    await seed();
    const old = required(await claimEvent(db, 60_000));
    await expire(old.id);
    const next = required(await claimEvent(db, 60_000));
    expect(await failEvent(db, next, 8)).toBe(true);
    const scheduled = await row(next.id);
    expect(await completeEvent(db, old)).toBe(false);
    expect(await failEvent(db, old, 1)).toBe(false);
    expect(await row(next.id)).toEqual(scheduled);
  });

  it('process retries with backoff then dead-letters without storing handler secrets', async () => {
    await seed();
    const ids: string[] = [];
    const handlers = {
      'drop.delivered': async (_payload: Record<string, unknown>, _id: string, ctx: { eventId: string }) => {
        ids.push(ctx.eventId);
        throw new Error('https://secret.example/token');
      },
    };
    expect(await processOne(db, handlers, { leaseMs: 60_000, maxAttempts: 2 })).toBe(true);
    const first = await row(required(ids[0]));
    expect(first.attempts).toBe(1);
    expect(first.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(first.lastError).toBe('HANDLER_FAILED');
    expect(first.deadAt).toBeNull();
    expect(await processOne(db, handlers, { leaseMs: 60_000, maxAttempts: 2 })).toBe(false);
    await db.drizzle
      .update(outboxEvents)
      .set({ availableAt: new Date(0) })
      .where(eq(outboxEvents.id, first.id));
    await processOne(db, handlers, { leaseMs: 60_000, maxAttempts: 2 });
    expect(ids).toEqual([first.id, first.id]);
    const dead = await row(first.id);
    expect(dead.attempts).toBe(2);
    expect(dead.deadAt).not.toBeNull();
    expect(dead.deliveredAt).toBeNull();
    expect(await claimEvent(db, 60_000)).toBeNull();
  });

  it('an event whose lease expired on its last attempt is dead-lettered, not reclaimed forever', async () => {
    await seed();
    const last = required(await claimEvent(db, 60_000, 1));
    expect(last.attempts).toBe(1);
    // the worker crashed: no fail/complete, the lease simply runs out
    await expire(last.id);
    const exhausted: string[] = [];
    expect(await claimEvent(db, 60_000, 1, (event) => exhausted.push(event.id))).toBeNull();
    expect(exhausted).toEqual([last.id]);
    const dead = await row(last.id);
    expect(dead.deadAt).not.toBeNull();
    expect(dead.lastError).toBe('ATTEMPTS_EXHAUSTED');
    expect(dead.attempts).toBe(1);
  });

  it('per-target progress survives a retry, is hidden from the payload, and is fenced by the lease', async () => {
    await seed();
    const seen: Array<{ payload: Record<string, unknown>; done: boolean[] }> = [];
    let fail = true;
    const handlers = {
      'drop.delivered': async (
        payload: Record<string, unknown>,
        _id: string,
        ctx: { progress: { done(k: string): boolean; markDone(k: string): Promise<void> } },
      ) => {
        seen.push({ payload, done: ['a', 'b'].map((k) => ctx.progress.done(k)) });
        if (!ctx.progress.done('a')) await ctx.progress.markDone('a');
        if (fail) throw new Error('b failed');
        await ctx.progress.markDone('b');
      },
    };
    await processOne(db, handlers, { leaseMs: 60_000, maxAttempts: 3 });
    const [event] = await db.drizzle.select().from(outboxEvents);
    const id = required(event).id;
    expect((await row(id)).payload).toMatchObject({ [PROGRESS_KEY]: ['a'] });
    await db.drizzle
      .update(outboxEvents)
      .set({ availableAt: new Date(0) })
      .where(eq(outboxEvents.id, id));
    fail = false;
    await processOne(db, handlers, { leaseMs: 60_000, maxAttempts: 3 });
    expect(seen.map((s) => s.done)).toEqual([
      [false, false],
      [true, false],
    ]);
    expect(seen.every((s) => !(PROGRESS_KEY in s.payload))).toBe(true);
    const done = await row(id);
    expect(done.deliveredAt).not.toBeNull();
    expect(done.payload).toMatchObject({ endpoint_count: 1, [PROGRESS_KEY]: ['a', 'b'] });
    // a stale owner can no longer write progress
    expect(await recordProgress(db, done, 'c')).toBe(false);
  });

  it('a handler that ignores its deadline is abandoned and the attempt counts as failed', async () => {
    await seed();
    const outcomes: string[] = [];
    let aborted = false;
    await processOne(
      db,
      {
        'drop.delivered': async (_payload, _id, ctx) => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
          });
          await new Promise(() => undefined);
        },
      },
      { leaseMs: 60_000, maxAttempts: 3, handlerTimeoutMs: 50, onOutcome: (e) => outcomes.push(e.outcome) },
    );
    expect(outcomes).toEqual(['retry']);
    expect(aborted).toBe(true);
    const [event] = await db.drizzle.select().from(outboxEvents);
    expect(required(event).lastError).toBe('HANDLER_FAILED');
    expect(required(event).lockedUntil).toBeNull();
  });

  it('process renews a long handler lease and completes using the stable event id', async () => {
    await seed();
    let id = '';
    await processOne(
      db,
      {
        'drop.delivered': async (_payload, _aggregateId, context) => {
          id = context.eventId;
          const initial = required((await row(id)).lockedUntil).getTime();
          // Wait for a heartbeat, not for lease expiry, to avoid scheduling-sensitive assertions.
          const deadline = Date.now() + 4000;
          while (required((await row(id)).lockedUntil).getTime() <= initial && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(required((await row(id)).lockedUntil).getTime()).toBeGreaterThan(initial);
          expect(await claimEvent(db, 3000)).toBeNull();
          expect(context.signal.aborted).toBe(false);
        },
      },
      { leaseMs: 3000, maxAttempts: 2 },
    );
    expect((await row(id)).deliveredAt).not.toBeNull();
  });
});
