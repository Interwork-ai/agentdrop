import { createHmac } from 'node:crypto';
import { rateLimits, type Tx } from '@agentdrop/db';
import { lt, sql } from 'drizzle-orm';

/**
 * Turns a limiter's name and raw key (an email, an address, an account id) into the key stored in `rate_limits`: a
 * hex HMAC-SHA256 under a key derived from `secret` (the server's AUTH_SECRET). The table, and any log of a failed
 * query, then holds no one's email or address, and every key has the same short length whatever the request sent.
 */
export function rateLimitKeyHasher(secret: string): (name: string, key: string) => string {
  const derived = createHmac('sha256', secret).update('agentdrop/rate-limit-key/v1').digest();
  return (name, key) => createHmac('sha256', derived).update(`${name}:${key}`).digest('hex');
}

/**
 * One request against `key` in a fixed window of `windowMs`, counted atomically in the shared `rate_limits` table: a
 * single statement increments the row, or starts a new window when the old one has passed, and returns the count.
 * Every API process counts against the same row, so the limit holds however many serve. Returns whether this
 * request is within `max`, and when the window frees up. The count stops at `max + 1`: past the limit every request
 * is refused alike, so counting further would only grow the number. `key` should come from `rateLimitKeyHasher`.
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
      count = case when ${rateLimits.resetAt} <= clock_timestamp() then 1
        else least(${rateLimits.count} + 1, ${max}::int + 1) end,
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
