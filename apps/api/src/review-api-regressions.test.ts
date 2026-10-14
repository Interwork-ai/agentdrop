import { attachments, authUsers, outboxEvents, withTx } from '@agentdrop/db';
import { expireStagedAttachments } from '@agentdrop/domain';
import type { StorageProvider } from '@agentdrop/storage';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { redactLoggedUrl } from './app.js';
import { createTestApp, hHeaders, pair, signUp, TEST_DATABASE_URL, type TestApp } from './testing/harness.js';

describe('request URL credential redaction', () => {
  it.each([
    '/invite/review-secret',
    '/v1/invite/review-secret',
    '/v1/me/invite/review-secret/accept',
    '/v1/%69nvite/review-secret',
    '/reset-password?%74oken=review-secret&next=inbox',
    '/v1/h/drops?%71uery=review-secret&limit=10',
    '/reset-password?token=first&token=review-secret',
  ])('does not log the credential or search text in %s', (url) => {
    expect(redactLoggedUrl(url)).not.toContain('review-secret');
    expect(redactLoggedUrl(url)).toContain('[redacted]');
  });

  it('preserves useful paths and unrelated query fields', () => {
    expect(redactLoggedUrl('/v1/me/invite/example/accept?next=inbox')).toBe(
      '/v1/me/invite/[redacted]/accept?next=inbox',
    );
    expect(redactLoggedUrl('/v1/me?tab=settings')).toBe('/v1/me?tab=settings');
  });
});

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL)
  console.warn('[review-api-regressions.test] TEST_DATABASE_URL unset: PostgreSQL tests SKIPPED');

describeDb('API review regressions', () => {
  let t: TestApp;
  let storage: StorageProvider;
  const keys = new Set<string>();

  beforeAll(async () => {
    t = await createTestApp({
      wrapStorage: (inner) => {
        storage = inner;
        return Object.assign(Object.create(inner), {
          put: (...args: Parameters<StorageProvider['put']>) => {
            keys.add(args[0]);
            return inner.put(...args);
          },
          promote: async (from: string, to: string) => {
            keys.add(to);
            await inner.promote(from, to);
          },
        });
      },
    });
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await t.reset();
    keys.clear();
  });

  it('reports an existing email as a non-retryable field error without changing the original account', async () => {
    const original = await signUp(t, 'original');
    const result = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      headers: { origin: t.origin },
      payload: {
        email: original.email,
        password: 'another-long-password',
        handle: 'second',
        display_name: 'Second',
      },
    });
    expect(result.statusCode, result.body).toBe(400);
    expect(result.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      retryable: false,
      details: { field: 'email', reason: 'already_registered' },
    });
    const accounts = await t.db.drizzle.select().from(authUsers).where(eq(authUsers.email, original.email));
    expect(accounts).toHaveLength(1);
    const me = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: original.cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user_id).toBe(original.userId);
  });

  it('retains the completed object key across a failed finalization so a later sweep removes it', async () => {
    const endpoint = await pair(t, await signUp(t, 'uploader'));
    // Fail after the storage operation has completed, at the database transition to ready. No request-side
    // cleanup is allowed to hide the crash window: the persisted staging row must identify the existing object.
    await t.db.pool.query(`CREATE FUNCTION review_fail_finalize() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'ready' THEN RAISE EXCEPTION 'injected attachment finalization failure'; END IF;
        RETURN NEW;
      END $$`);
    await t.db.pool.query(`CREATE TRIGGER review_fail_finalize BEFORE UPDATE ON attachments
      FOR EACH ROW EXECUTE FUNCTION review_fail_finalize()`);
    try {
      const result = await t.app.inject({
        method: 'POST',
        url: '/v1/h/attachments',
        headers: { ...hHeaders(endpoint.credential), 'content-type': 'application/octet-stream' },
        payload: Buffer.from('recover this completed upload'),
      });
      expect(result.statusCode).toBe(500);
    } finally {
      await t.db.pool.query('DROP TRIGGER review_fail_finalize ON attachments');
      await t.db.pool.query('DROP FUNCTION review_fail_finalize()');
    }
    const [row] = await t.db.drizzle.select().from(attachments);
    expect(row?.status).toBe('staging');
    if (!row) throw new Error('missing staging row');
    expect(await storage.exists(row.storageKey)).toBe(true);
    await withTx(t.db, (tx) => expireStagedAttachments(tx, new Date(Date.now() + 1_000)));
    const cleanup = await t.db.drizzle
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, 'attachment.cleanup'));
    expect(cleanup).toHaveLength(1);
    // Execute the durable cleanup payload just as the worker does, including an idempotent retry.
    for (const event of cleanup) {
      const payload = event.payload as { storage_key: string };
      await storage.delete(payload.storage_key);
      await storage.delete(payload.storage_key);
    }
    for (const key of keys) expect(await storage.exists(key)).toBe(false);
  });
});
