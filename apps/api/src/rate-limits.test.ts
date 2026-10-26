import { randomBytes } from 'node:crypto';
import { createDatabase, type Database, rateLimits } from '@agentdrop/db';
import { consumeRateLimit, sweepRateLimits } from '@agentdrop/domain';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from './context.js';
import type { Mailer } from './mail.js';
import { createKeyLimiter } from './plugins/principals.js';
import { createTestApp, TEST_DATABASE_URL, type TestApp } from './testing/harness.js';

const mailer: Mailer = { send: async () => {} };

/*
 * The shared `rate_limits` table holds no one's email or address: every key is a keyed hash of fixed length, so an
 * over-long or personal value can neither break the primary key nor sit in the table (or a failed query's log) in the
 * clear. Windows restart once they pass, and the worker sweeps ended ones in batches.
 */
describe.skipIf(!TEST_DATABASE_URL)('shared rate limits', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ mailer });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const keys = async () =>
    (await t.db.drizzle.select({ key: rateLimits.key }).from(rateLimits)).map((row) => row.key);

  it('answers an over-long email with VALIDATION_FAILED before any limiter counts it', async () => {
    // random, so the database cannot compress it below the index's row limit
    const email = `${randomBytes(2000).toString('hex')}@example.org`;
    const recover = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/recover-with-code',
      payload: { email, code: 'zzzz-zzzz-zzzz' },
      remoteAddress: '10.30.0.1',
    });
    expect(recover.statusCode, recover.body).toBe(400);
    expect(recover.json().code).toBe('VALIDATION_FAILED');
    const reset = await t.app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      headers: { origin: t.origin },
      payload: { email },
      remoteAddress: '10.30.0.1',
    });
    expect(reset.statusCode, reset.body).toBe(400);
    expect(reset.json().code).toBe('VALIDATION_FAILED');
    expect(await keys()).toEqual([]);
  });

  it('stores a fixed-length hash, never the email or the address', async () => {
    const email = 'alice@example.org';
    await t.app.inject({
      method: 'POST',
      url: '/v1/auth/recover-with-code',
      payload: { email, code: 'zzzz-zzzz-zzzz' },
      remoteAddress: '10.30.0.2',
    });
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/request-password-reset',
      headers: { origin: t.origin },
      payload: { email },
      remoteAddress: '10.30.0.2',
    });
    const stored = await keys();
    // per address and per email, for recovery and for reset
    expect(stored).toHaveLength(4);
    for (const key of stored) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).not.toContain('@');
      expect(key).not.toContain('10.30.0.2');
      expect(key).not.toContain('alice');
    }
  });

  it('counts the same email as one limit across two connection pools', async () => {
    const other = createDatabase(TEST_DATABASE_URL as string, { max: 2 });
    const config = { AUTH_SECRET: 'test-secret-test-secret-test-secret-0000' };
    try {
      const limiter = (db: Database) =>
        createKeyLimiter({ db, config } as unknown as AppContext, {
          name: 'recover-email',
          windowMs: 60_000,
          max: 2,
          key: () => 'recover:alice@example.org',
        });
      const req = {} as FastifyRequest;
      await limiter(t.db)(req);
      await limiter(other)(req);
      await expect(limiter(t.db)(req)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      const stored = await keys();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await other.close();
    }
  });

  it('restarts a window once it has passed, and stops counting past the limit', async () => {
    const db = t.db.drizzle;
    for (let i = 0; i < 2; i++) expect((await consumeRateLimit(db, 'w', 60_000, 2)).allowed).toBe(true);
    for (let i = 0; i < 5; i++) expect((await consumeRateLimit(db, 'w', 60_000, 2)).allowed).toBe(false);
    const [row] = await db.select().from(rateLimits);
    expect(row?.count).toBe(3);
    // the window ends
    await db.update(rateLimits).set({ resetAt: sql`clock_timestamp() - interval '1 second'` });
    const again = await consumeRateLimit(db, 'w', 60_000, 2);
    expect(again.allowed).toBe(true);
    expect(again.resetAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
    const [restarted] = await db.select().from(rateLimits);
    expect(restarted?.count).toBe(1);
  });

  it('sweeps ended windows in batches and keeps live ones', async () => {
    const db = t.db.drizzle;
    await db.insert(rateLimits).values([
      ...['a', 'b', 'c', 'd', 'e'].map((key) => ({
        key,
        count: 1,
        resetAt: new Date(Date.now() - 7_200_000),
      })),
      { key: 'live', count: 1, resetAt: new Date(Date.now() + 60_000) },
      { key: 'recent', count: 1, resetAt: new Date(Date.now() - 60_000) },
    ]);
    const before = new Date(Date.now() - 3_600_000);
    expect(await sweepRateLimits(db, before, 2)).toBe(2);
    expect(await sweepRateLimits(db, before, 2)).toBe(2);
    expect(await sweepRateLimits(db, before, 2)).toBe(1);
    expect(await sweepRateLimits(db, before, 2)).toBe(0);
    expect((await keys()).sort()).toEqual(['live', 'recent']);
  });
});
