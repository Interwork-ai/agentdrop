#!/usr/bin/env node
/**
 * Browser journeys over the dashboard's key paths: a real API + built dashboard + PostgreSQL, driven by Chrome.
 *
 *   E2E_DATABASE_URL=postgresql://localhost:5432/agentdrop_e2e pnpm e2e
 *   E2E_ONLY=core,mailbox pnpm e2e        # a subset while working on one journey
 *   E2E_CONCURRENCY=1 pnpm e2e            # one journey at a time, for debugging
 *
 * Every journey runs twice: once as a secure context (like https) and once on a non-secure http origin (like
 * an internal `http://10.0.0.5:3300`), because the dashboard blanked on plain http while every other test passed
 * (docs/QUALITY.md). The two modes run side by side on their own fresh servers and databases, and the journeys of a
 * mode run concurrently on its server (they seed their own people, so they are independent), `E2E_CONCURRENCY` at a
 * time (default: half the CPU cores). A step fails on any uncaught page error, error boundary, blank page or
 * missing text.
 *
 * Needs: `pnpm build` (apps/api/dist, apps/web/dist), an EMPTY database it may reset (never real data: it drops the
 * public and drizzle schemas), `psql` on PATH and Chrome (`E2E_CHROME` = executable, else the Google Chrome channel; Playwright's chrome-headless-shell runs
 * without ever bringing a window forward).
 * The plain-http mode uses `<E2E_DATABASE_URL>_b` (created if missing) and port `E2E_PORT + 1`; parallel invocations
 * need their own `E2E_DATABASE_URL`, `E2E_PORT` and `E2E_OUT`. Failure screenshots: test-results/<E2E_OUT>/.
 *
 * Journeys live in ./journeys, one file per area, each creating its own people through the API (./api.mjs) with a
 * handle prefix of its own, so they never depend on each other.
 */
import { readdirSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchChrome, openSession, summarize } from '../lib/smoke-kit.mjs';
import { HOST, OUT, resetDatabase, serverFor, serverScope, startApi, stopApi } from './server.mjs';

// Every file in ./journeys is a journey (`export const name`, `export async function run(ctx)`); core starts first.
const dir = join(import.meta.dirname, 'journeys');
const JOURNEYS = [];
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith('.mjs'))
  .sort())
  JOURNEYS.push(await import(pathToFileURL(join(dir, file)).href));
JOURNEYS.sort((a, b) => (a.name === 'core' ? -1 : b.name === 'core' ? 1 : a.name.localeCompare(b.name)));

if (!process.env.E2E_DATABASE_URL) {
  console.error('E2E_DATABASE_URL is required (an empty database this test may reset)');
  process.exit(2);
}
const only = (process.env.E2E_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const selected = only.length ? JOURNEYS.filter((j) => only.includes(j.name)) : JOURNEYS;
if (!selected.length) {
  console.error(
    `no journey matches E2E_ONLY=${process.env.E2E_ONLY}; have: ${JOURNEYS.map((j) => j.name).join(', ')}`,
  );
  process.exit(2);
}
const concurrency = Math.max(
  1,
  Number(process.env.E2E_CONCURRENCY ?? Math.floor(availableParallelism() / 2)),
);

const results = [];

/** Runs `tasks` with at most `limit` in flight. */
async function pool(tasks, limit) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(workers);
}

async function runMode(mode) {
  const server = serverFor(mode);
  console.log(
    `${mode === 'secure' ? 'Secure context (https-like)' : 'Non-secure http origin'}: ${server.base}`,
  );
  let api = null;
  let browser = null;
  try {
    const t0 = Date.now();
    resetDatabase(server);
    api = await startApi(server);
    console.log(`  --   [${mode}] database and server ready in ${Math.round((Date.now() - t0) / 1000)} s`);
    const args = [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`];
    // Chrome's own switch for "treat this http origin as secure": the https case without certificates.
    if (mode === 'secure') args.push(`--unsafely-treat-insecure-origin-as-secure=${server.base}`);
    browser = await launchChrome(args);
    await pool(
      selected.map(
        (journey) => () => serverScope.run(server, () => runJourney(journey, mode, server, browser)),
      ),
      concurrency,
    );
  } catch (err) {
    results.push({
      label: `[${mode}] server`,
      ok: false,
      error: err instanceof Error ? err.stack : String(err),
    });
  } finally {
    await browser?.close();
    if (api) {
      await stopApi(api);
      rmSync(api.storage, { recursive: true, force: true });
    }
  }
}

async function runJourney(journey, mode, server, browser) {
  const ctx = {
    mode,
    base: server.base,
    browser,
    results,
    /**
     * A signed-in browser session for a person returned by api.signUp. By default it reuses the API session
     * cookie; `{ uiSignIn: true }` signs in through the login form instead. Other options (viewport,
     * colorScheme) go to the browser context.
     */
    session: async (label, person, { uiSignIn = false, ...options } = {}) => {
      const s = await openSession(browser, {
        base: server.base,
        label: `[${mode}] ${journey.name}/${label}`,
        email: person.email,
        password: person.password,
        ...(uiSignIn ? {} : { cookie: person.jar.cookie }),
        results,
        outDir: OUT,
        ...options,
      });
      const secure = await s.page.evaluate(() => window.isSecureContext);
      if (secure !== (mode === 'secure'))
        results.push({
          label: `[${mode}] ${label}: secure context`,
          ok: false,
          error: `isSecureContext=${secure}`,
        });
      return s;
    },
  };
  const t0 = Date.now();
  try {
    await journey.run(ctx);
    console.log(`  --   [${mode}] ${journey.name} finished in ${Math.round((Date.now() - t0) / 1000)} s`);
  } catch (err) {
    results.push({
      label: `[${mode}] ${journey.name}: setup`,
      ok: false,
      error: err instanceof Error ? err.stack : String(err),
    });
  }
}

const started = Date.now();
await Promise.all(['secure', 'insecure'].map(runMode));
console.log(
  `\n${selected.length} journey(s) × 2 modes in ${Math.round((Date.now() - started) / 1000)} s (concurrency ${concurrency})`,
);
process.exit(summarize(results, OUT));
