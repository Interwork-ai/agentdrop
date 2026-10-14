import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type DrizzleDb = NodePgDatabase<typeof schema>;
export type DrizzleTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface Database {
  readonly drizzle: DrizzleDb;
  readonly pool: pg.Pool;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string, opts: { max?: number } = {}): Database {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return {
    drizzle: db,
    pool,
    async ping() {
      const client = await pool.connect();
      try {
        await client.query('select 1');
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
