/**
 * The servers under test for the browser journeys: a real API + built dashboard on PostgreSQL, one per mode, so the
 * secure and the plain-http run go side by side. Configuration comes from the environment so parallel invocations
 * can use their own databases and ports.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const HOST = 'e2e.test';
export const PASSWORD = 'e2e-password-123';
export const OUT = join(ROOT, 'test-results', process.env.E2E_OUT ?? 'e2e');

/**
 * The server a journey is running against. The runner enters it with `serverScope.run(server, …)`, and the seeding
 * helpers read it from here, so journeys call `signUp(…)` without passing a server around.
 */
export const serverScope = new AsyncLocalStorage();
export function currentServer() {
  const server = serverScope.getStore();
  if (!server) throw new Error('no e2e server in scope');
  return server;
}

/**
 * The secure run uses `E2E_DATABASE_URL` and `E2E_PORT` (default 3390); the plain-http run the same database name
 * with `_b` and the next port. The browser reaches both as `e2e.test`, a name that is not localhost, so each can be
 * made secure or not at will.
 */
export function serverFor(mode) {
  const base = process.env.E2E_DATABASE_URL;
  const port = Number(process.env.E2E_PORT ?? 3390) + (mode === 'secure' ? 0 : 1);
  let db = base;
  if (base && mode !== 'secure') {
    const url = new URL(base);
    url.pathname = `${url.pathname}_b`;
    db = url.toString();
  }
  return { mode, db, port, base: `http://${HOST}:${port}`, direct: `http://127.0.0.1:${port}` };
}

function psql(url, sql) {
  execFileSync('psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

/** Creates the database if needed, drops everything in it and migrates it from scratch. */
export function resetDatabase(server) {
  const name = decodeURIComponent(new URL(server.db).pathname.slice(1));
  const maintenance = new URL(server.db);
  maintenance.pathname = '/postgres';
  const exists = execFileSync(
    'psql',
    [
      maintenance.toString(),
      '-Atc',
      `SELECT 1 FROM pg_database WHERE datname = '${name.replaceAll("'", '')}'`,
    ],
    { encoding: 'utf8' },
  ).trim();
  if (!exists) psql(maintenance.toString(), `CREATE DATABASE "${name.replaceAll('"', '')}"`);
  psql(
    server.db,
    'set client_min_messages = warning; drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;',
  );
  execFileSync('pnpm', ['--silent', 'db:migrate'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: server.db },
  });
}

/** Stops the API and waits until it is gone: a lingering server would answer the next run with stale data. */
export async function stopApi(api) {
  const { child } = api;
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
}

export async function startApi(server) {
  // Refuse to run against a server that is already listening there (a leftover from an interrupted run).
  const occupied = await fetch(`${server.direct}/health/live`).then(
    () => true,
    () => false,
  );
  if (occupied) throw new Error(`port ${server.port} is already in use; stop that process or set E2E_PORT`);
  const storage = mkdtempSync(join(tmpdir(), 'agentdrop-e2e-'));
  const child = spawn(process.execPath, [join(ROOT, 'apps/api/dist/main.js')], {
    cwd: join(ROOT, 'apps/api'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(server.port),
      HOST: '127.0.0.1',
      PUBLIC_BASE_URL: server.base,
      WEB_ORIGIN: server.base,
      DATABASE_URL: server.db,
      AUTH_SECRET: 'e2e-only-secret-not-for-production-0123456789abcdef',
      STORAGE_PROVIDER: 'fs',
      FS_STORAGE_DIR: storage,
      SIGNUP_MODE: 'open',
      // as behind a reverse proxy (production sets it too): a journey that signs in a lot can give its browser its
      // own X-Forwarded-For, so it does not share the per-address sign-in limit with the journeys running beside it
      TRUST_PROXY: 'true',
      // The journeys pair dozens of agents from one address within a minute; apps/api/src/pairing-limit.test.ts
      // proves the limit itself.
      PAIRING_START_PER_MIN: '500',
      LOG_LEVEL: 'warn',
      WEB_DIST_DIR: join(ROOT, 'apps/web/dist'),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null)
      throw new Error(`API exited with code ${child.exitCode} before it was ready`);
    try {
      const res = await fetch(`${server.direct}/health/ready`);
      if (res.ok) return { child, storage };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill('SIGKILL');
  throw new Error('API did not become ready');
}
