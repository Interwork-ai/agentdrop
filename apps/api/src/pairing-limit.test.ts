import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@agentdrop/db';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from './context.js';
import { createKeyLimiter } from './plugins/principals.js';
import { createTestApp, TEST_DATABASE_URL, type TestApp } from './testing/harness.js';

// Pairing start is the one unauthenticated write; the browser journeys raise its limit to seed many agents, so the
// limit itself is proven here.
describe.skipIf(!TEST_DATABASE_URL)('pairing start is limited per address', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ pairingStartPerMin: 3 });
    await t.reset();
  });
  afterAll(async () => {
    await t.close();
  });

  const start = (ip: string) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/pairing/start',
      remoteAddress: ip,
      payload: {
        installation_id: randomUUID(),
        device_label: 'laptop',
        harness_key: 'codex',
        profile_key: 'codex',
        endpoint_label: 'Codex',
        bridge_version: '0.5.3',
        platform: 'linux',
      },
    });

  it('refuses the request over the limit with RATE_LIMITED, and only for that address', async () => {
    for (let i = 0; i < 3; i++) expect((await start('10.20.0.1')).statusCode).toBe(200);
    const over = await start('10.20.0.1');
    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe('RATE_LIMITED');
    expect((await start('10.20.0.2')).statusCode).toBe(200);
  });

  it('is one limit for every API process on the database, not one per process', async () => {
    // two connection pools to the same database, as two API processes have
    const other = createDatabase(TEST_DATABASE_URL as string, { max: 2 });
    try {
      const limiter = (db: Database) =>
        createKeyLimiter(
          {
            db,
            config: { AUTH_SECRET: 'test-secret-test-secret-test-secret-0000' },
          } as unknown as AppContext,
          {
            name: 'shared',
            windowMs: 60_000,
            max: 3,
            key: () => 'one',
          },
        );
      const here = limiter(t.db);
      const there = limiter(other);
      const req = {} as FastifyRequest;
      await here(req);
      await there(req);
      await here(req);
      await expect(there(req)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      await other.close();
    }
  });
});
