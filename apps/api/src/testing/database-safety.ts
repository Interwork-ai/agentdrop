import { createDatabase, schema } from '@agentdrop/db';
import { getTableName, isTable } from 'drizzle-orm';

function databaseIdentity(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid database URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected a PostgreSQL URL');
  // Connection-string overrides can change the database/host after URL validation.
  if ([...url.searchParams.keys()].some((key) => ['host', 'port', 'dbname', 'database'].includes(key)))
    throw new Error('Database URL connection overrides are not supported in tests');
  const name = decodeURIComponent(url.pathname.slice(1));
  const host = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'loopback' : url.hostname;
  return { name, identity: `${host}:${url.port || '5432'}/${name}` };
}

/** Tests only accept explicitly named disposable databases, never the configured application database. */
export function assertSafeTestDatabase(testUrl: string, applicationUrl = process.env.DATABASE_URL): void {
  const test = databaseIdentity(testUrl);
  if (!/^(?:test_[a-z0-9_]+|[a-z0-9_]+_test)$/i.test(test.name))
    throw new Error('TEST_DATABASE_URL must name a dedicated test_* or *_test database');
  if (applicationUrl && test.identity === databaseIdentity(applicationUrl).identity)
    throw new Error('TEST_DATABASE_URL must not point to the DATABASE_URL database');
}

/** Run every cleanup even if an earlier one fails. */
export async function cleanupAll(actions: Array<() => Promise<void> | void>): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Test resource cleanup failed');
}

/** Held on its own connection for the entire test-app lifetime, including migrations and resets. */
export async function acquireTestDatabaseLock(
  testUrl: string,
  applicationUrl = process.env.DATABASE_URL,
  factory: typeof createDatabase = createDatabase,
): Promise<() => Promise<void>> {
  assertSafeTestDatabase(testUrl, applicationUrl);
  const lockDb = factory(testUrl, { max: 1 });
  const connect = () => lockDb.pool.connect();
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    client = await lockDb.pool.connect();
    await client.query('SELECT pg_advisory_lock(1094992978, 1)');
  } catch (error) {
    await cleanupAll([() => client?.release(true), () => lockDb.close()]);
    throw error;
  }
  const connection = client;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    // Destroying the dedicated session releases the advisory lock even after a query failure.
    await cleanupAll([() => connection.release(true), () => lockDb.close()]);
  };
}

/** No CASCADE: an unexpected external FK fails safely instead of truncating unrelated tables. */
export const resetProjectTablesSql = `TRUNCATE TABLE ${Object.values(schema)
  .flatMap((table) => (isTable(table) ? [`"public"."${getTableName(table).replaceAll('"', '""')}"`] : []))
  .join(', ')} RESTART IDENTITY`;
