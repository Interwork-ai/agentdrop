import type { Database, DrizzleDb, DrizzleTx } from './client.js';

/** Query executor accepted by domain use-cases: either the root db or a transaction. */
export type Tx = DrizzleDb | DrizzleTx;

/**
 * One transaction. A deadlock (40P01) is retried a couple of times: PostgreSQL already rolled the attempt back, and
 * two use-cases taking group and person locks in different orders can meet rarely (for example leaving a group while
 * another member removes their last agent).
 */
export async function withTx<T>(db: Database, fn: (tx: DrizzleTx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.drizzle.transaction(async (tx) => fn(tx));
    } catch (err) {
      if (attempt >= 2 || !isDeadlock(err)) throw err;
    }
  }
}

function isDeadlock(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    if ((e as { code?: unknown }).code === '40P01') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
