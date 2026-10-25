/**
 * Integration test harness: real PostgreSQL (TEST_DATABASE_URL), real Better Auth, real routes via app.inject().
 * Tests are skipped with an explicit message when TEST_DATABASE_URL is unset.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessKey } from '@agentdrop/contracts';
import { createDatabase, type Database, runMigrations } from '@agentdrop/db';
import { defaultApprovalPolicy, type FeishuAppConfig, type SendOptions } from '@agentdrop/domain';
import { FsStorage, type StorageProvider } from '@agentdrop/storage';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createAuth } from '../auth.js';
import { loadConfig } from '../config.js';
import type { Mailer } from '../mail.js';
import { acquireTestDatabaseLock, cleanupAll, resetProjectTablesSql } from './database-safety.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export interface TestApp {
  app: FastifyInstance;
  db: Database;
  close(): Promise<void>;
  reset(): Promise<void>;
  origin: string;
}

export async function createTestApp(
  options: {
    approvalPolicy?: SendOptions['approvalPolicy'];
    mailer?: Mailer | null;
    /** Lets a test interpose on storage calls, e.g. to hold a write open at an exact moment. */
    wrapStorage?: (storage: StorageProvider) => StorageProvider;
    /** Stands in for Feishu when a test connects a group-bot webhook. */
    feishuFetch?: typeof fetch;
    /** The server's own Feishu app (ADR 0039); absent: none configured. */
    feishuApp?: FeishuAppConfig;
    /** Pairing starts allowed per address per minute; tests otherwise never meet the limit. */
    pairingStartPerMin?: number;
    /** Extra configuration values, e.g. a small GROUP_STORAGE_QUOTA_BYTES. */
    env?: Record<string, string>;
  } = {},
): Promise<TestApp> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    AUTH_SECRET: 'test-secret-test-secret-test-secret-0000',
    PUBLIC_BASE_URL: 'http://api.test',
    WEB_ORIGIN: 'http://web.test',
    PAIRING_CODE_TTL_S: '600',
    PAIRING_START_PER_MIN: String(options.pairingStartPerMin ?? 10000),
    MAX_GROUP_RECIPIENTS: '3',
    MAX_GROUP_MEMBERS: '4',
    LOG_LEVEL: 'warn',
    ...options.env,
  });
  const releaseLock = await acquireTestDatabaseLock(TEST_DATABASE_URL);
  let db: Database | undefined;
  let app: FastifyInstance | undefined;
  let storageDir: string | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await cleanupAll([
      async () => {
        await app?.close();
      },
      async () => {
        await db?.close();
      },
      () => {
        if (storageDir) rmSync(storageDir, { recursive: true, force: true });
      },
      releaseLock,
    ]);
  };
  try {
    await runMigrations(TEST_DATABASE_URL);
    db = createDatabase(TEST_DATABASE_URL, { max: 5 });
    const auth = createAuth(config, db, { mailer: options.mailer ?? null });
    storageDir = mkdtempSync(join(tmpdir(), 'agentdrop-test-storage-'));
    const fsStorage = new FsStorage(storageDir);
    const storage = options.wrapStorage ? options.wrapStorage(fsStorage) : fsStorage;
    app = await buildApp(
      {
        config,
        db,
        storage,
        auth,
        mailer: options.mailer ?? null,
        ...(options.feishuFetch ? { feishuFetch: options.feishuFetch } : {}),
        ...(options.feishuApp ? { feishuApp: options.feishuApp } : {}),
        approvalPolicy: options.approvalPolicy ?? defaultApprovalPolicy,
      },
      { logger: { level: 'error' } },
    );
    await app.ready();
    const readyDb = db;
    return {
      app,
      db,
      origin: 'http://web.test',
      close,
      async reset() {
        if (closed) throw new Error('Test app is closed');
        await readyDb.drizzle.execute(sql.raw(resetProjectTablesSql));
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Test app startup and cleanup failed');
    }
    throw error;
  }
}

export interface BrowserUser {
  email: string;
  handle: string;
  userId: string;
  cookie: string;
}

/** Signs up a user through the real routes and returns the session cookie for subsequent requests. */
export async function signUp(t: TestApp, handle: string, displayName = handle): Promise<BrowserUser> {
  const email = `${handle}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/auth/sign-up',
    headers: { origin: t.origin },
    payload: { email, password: 'correct-horse-battery-staple', handle, display_name: displayName },
  });
  if (res.statusCode !== 201) throw new Error(`sign-up failed: ${res.statusCode} ${res.body}`);
  const cookie = extractCookies(res.headers['set-cookie']);
  return { email, handle, userId: res.json().user_id, cookie };
}

export function extractCookies(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return list.map((c) => c.split(';')[0]).join('; ');
}

export interface PairedEndpoint {
  hId: string;
  credential: string;
  installationId: string;
}

/** Runs the whole pairing flow: CLI start → browser approve → CLI poll (credential issued once). */
export async function pair(
  t: TestApp,
  user: BrowserUser,
  opts: {
    installationId?: string;
    harness?: HarnessKey;
    profile?: string;
    deviceLabel?: string;
    endpointLabel?: string;
    makeDefault?: boolean;
  } = {},
): Promise<PairedEndpoint> {
  const installationId = opts.installationId ?? randomUUID();
  const start = await t.app.inject({
    method: 'POST',
    url: '/v1/pairing/start',
    payload: {
      installation_id: installationId,
      device_label: opts.deviceLabel ?? 'Test Machine',
      harness_key: opts.harness ?? 'codex',
      profile_key: opts.profile ?? 'default',
      endpoint_label: opts.endpointLabel ?? 'Test Agent',
      bridge_version: '0.2.0-test',
      platform: 'test',
    },
  });
  if (start.statusCode !== 200) throw new Error(`pairing start failed: ${start.body}`);
  const { device_code, user_code } = start.json();
  const decide = await t.app.inject({
    method: 'POST',
    url: '/v1/me/pairing/decide',
    headers: { cookie: user.cookie, origin: t.origin },
    payload: { user_code, decision: 'approve', make_default: opts.makeDefault ?? true },
  });
  if (decide.statusCode !== 200) throw new Error(`pairing decide failed: ${decide.body}`);
  const poll = await t.app.inject({ method: 'POST', url: '/v1/pairing/poll', payload: { device_code } });
  const body = poll.json();
  if (body.status !== 'approved') throw new Error(`pairing poll: ${poll.body}`);
  return { hId: body.h_id, credential: body.credential, installationId };
}

export function hHeaders(credential: string): Record<string, string> {
  return { authorization: `Bearer ${credential}` };
}
