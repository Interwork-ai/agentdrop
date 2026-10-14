import { createDatabase } from '@agentdrop/db';

/*
 * One PostgreSQL database per vitest worker, so test files run in parallel instead of one after another on a shared
 * database. `TEST_DATABASE_URL=…/agentdrop_test` becomes `…/agentdrop_w3_test` in worker 3 (`test_x` becomes
 * `test_w3_x`), which still satisfies the harness's disposable-name rule (testing/database-safety.ts). The database
 * is created on first use; the harness migrates and truncates it as before.
 */
const base = process.env.TEST_DATABASE_URL;
const worker = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID;
if (base && worker && !process.env.AGENTDROP_TEST_DATABASE_READY) {
  const url = new URL(base);
  const name = decodeURIComponent(url.pathname.slice(1));
  const own = name.endsWith('_test')
    ? `${name.slice(0, -'_test'.length)}_w${worker}_test`
    : name.startsWith('test_')
      ? `test_w${worker}_${name.slice('test_'.length)}`
      : name;
  if (own !== name) {
    const maintenance = new URL(base);
    maintenance.pathname = '/postgres';
    const admin = createDatabase(maintenance.toString(), { max: 1 });
    try {
      const found = await admin.pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [own]);
      if (found.rowCount === 0) {
        try {
          await admin.pool.query(`CREATE DATABASE "${own.replaceAll('"', '')}"`);
        } catch (err) {
          // another run created it between the check and here
          if ((err as { code?: string }).code !== '42P04') throw err;
        }
      }
    } finally {
      await admin.close();
    }
    url.pathname = `/${own}`;
    process.env.TEST_DATABASE_URL = url.toString();
  }
  process.env.AGENTDROP_TEST_DATABASE_READY = '1';
}
