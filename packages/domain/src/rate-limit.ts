import { rateLimits, type Tx } from '@agentdrop/db';
import { lt, sql } from 'drizzle-orm';

/**
 * One request against `key` in a fixed window of `windowMs`, counted atomically in the shared `rate_limits` table: a
 * single statement increments the row, or starts a new window when the old one has passed, and returns the count.
 * Every API process counts against the same row, so the limit holds however many serve. Returns whether this
 * request is within `max`, and when the window frees up.
 */
export async function consumeRateLimit(
  tx: Tx,
  key: string,
  windowMs: number,
  max: number,
): Promise<{ allowed: boolean; resetAt: Date }> {
  const { rows } = await tx.execute<{ count: number; reset_at: Date }>(sql`
    insert into ${rateLimits} (key, count, reset_at)
    values (${key}, 1, clock_timestamp() + ${windowMs} * interval '1 millisecond')
    on conflict (key) do update set
      count = case when ${rateLimits.resetAt} <= clock_timestamp() then 1 else ${rateLimits.count} + 1 end,
      reset_at = case when ${rateLimits.resetAt} <= clock_timestamp()
        then clock_timestamp() + ${windowMs} * interval '1 millisecond' else ${rateLimits.resetAt} end
    returning count, reset_at`);
  const row = rows[0];
  return { allowed: (row?.count ?? 1) <= max, resetAt: new Date(row?.reset_at ?? Date.now()) };
}

/** Deletes up to `batch` windows that ended before `before` (the worker's sweep); returns how many went. */
export async function sweepRateLimits(tx: Tx, before: Date, batch = 5000): Promise<number> {
  const result = await tx.execute(sql`
    delete from ${rateLimits} where ${rateLimits.key} in (
      select ${rateLimits.key} from ${rateLimits} where ${lt(rateLimits.resetAt, before)} limit ${batch})`);
  return result.rowCount ?? 0;
}
