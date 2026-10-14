import type { createDatabase } from '@agentdrop/db';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireTestDatabaseLock,
  assertSafeTestDatabase,
  cleanupAll,
  resetProjectTablesSql,
} from './database-safety.js';

function fakeDatabase(failure?: 'connect' | 'lock' | 'close') {
  const release = vi.fn();
  const query = vi.fn(async () => {
    if (failure === 'lock') throw new Error('lock failed');
  });
  const connect = vi.fn(async () => {
    if (failure === 'connect') throw new Error('connect failed');
    return { query, release };
  });
  const close = vi.fn(async () => {
    if (failure === 'close') throw new Error('close failed');
  });
  const factory = vi.fn(() => ({ pool: { connect }, close })) as unknown as typeof createDatabase;
  return { factory, connect, query, release, close };
}

describe('disposable database safeguards (no database required)', () => {
  it.each(['agentdrop_test', 'test_agentdrop', 'agentdrop_ci_test'])('allows %s', (name) => {
    expect(() => assertSafeTestDatabase(`postgresql://user:secret@localhost/${name}`, '')).not.toThrow();
  });
  it.each(['agentdrop', 'postgres', 'contest', 'test', 'test_production/other'])('rejects %s', (name) => {
    expect(() => assertSafeTestDatabase(`postgresql://localhost/${name}`, '')).toThrow();
  });
  it('rejects the application database across credentials, default port and loopback aliases', () => {
    expect(() =>
      assertSafeTestDatabase(
        'postgres://alice@127.0.0.1/app_test',
        'postgresql://bob@localhost:5432/app_test',
      ),
    ).toThrow('DATABASE_URL database');
  });
  it('rejects database overrides and never includes credentials in invalid URL errors', () => {
    expect(() => assertSafeTestDatabase('postgresql://localhost/app_test?dbname=production', '')).toThrow(
      'overrides',
    );
    expect(() => assertSafeTestDatabase('secret-invalid-url', '')).toThrow('Invalid database URL');
  });
  it('validates before connecting', async () => {
    const fake = fakeDatabase();
    await expect(
      acquireTestDatabaseLock('postgresql://localhost/production', '', fake.factory),
    ).rejects.toThrow('dedicated');
    expect(fake.connect).not.toHaveBeenCalled();
  });
  it('holds a dedicated connection until idempotent release', async () => {
    const fake = fakeDatabase();
    const release = await acquireTestDatabaseLock('postgresql://localhost/app_test', '', fake.factory);
    expect(fake.query).toHaveBeenCalledWith('SELECT pg_advisory_lock(1094992978, 1)');
    expect(fake.release).not.toHaveBeenCalled();
    await release();
    await release();
    expect(fake.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
  it.each(['connect', 'lock'] as const)('cleans up after %s failure', async (failure) => {
    const fake = fakeDatabase(failure);
    await expect(
      acquireTestDatabaseLock('postgresql://localhost/app_test', '', fake.factory),
    ).rejects.toThrow(`${failure} failed`);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.release).toHaveBeenCalledTimes(failure === 'lock' ? 1 : 0);
  });
  it('runs remaining cleanup after a resource close fails', async () => {
    const storageCleanup = vi.fn();
    const releaseLock = vi.fn();
    await expect(
      cleanupAll([
        () => {
          throw new Error('app close failed');
        },
        storageCleanup,
        releaseLock,
      ]),
    ).rejects.toThrow('cleanup failed');
    expect(storageCleanup).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
  it('only truncates schema-owned tables and cannot cascade to unrelated tables', () => {
    expect(resetProjectTablesSql).toContain('"public"."app_users"');
    expect(resetProjectTablesSql).toContain('"public"."outbox_events"');
    expect(resetProjectTablesSql).not.toMatch(/cascade|pg_tables|__drizzle/i);
  });
});
