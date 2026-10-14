import { type Database, outboxEvents, withTx } from '@agentdrop/db';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

export type ClaimedEvent = typeof outboxEvents.$inferSelect;

/**
 * Per-target progress inside one event. A handler that fans out (one webhook per user, one push per subscription)
 * marks each target done as soon as it succeeds, so a retry caused by one failing target does not re-send to the
 * targets that already got it. Stored in the event's own payload under PROGRESS_KEY; fenced like every outcome.
 */
export interface DeliveryProgress {
  done(key: string): boolean;
  markDone(key: string): Promise<void>;
}

export type Handler = (
  payload: Record<string, unknown>,
  aggregateId: string,
  context: { eventId: string; signal: AbortSignal; progress: DeliveryProgress },
) => Promise<void>;

export const PROGRESS_KEY = '_done';

const leaseEnd = (leaseMs: number) => sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`;
const owned = (event: ClaimedEvent) =>
  and(
    eq(outboxEvents.id, event.id),
    eq(outboxEvents.attempts, event.attempts),
    isNull(outboxEvents.deliveredAt),
    isNull(outboxEvents.deadAt),
    sql`${outboxEvents.lockedUntil} > clock_timestamp()`,
  );

/**
 * attempts is the fencing token: every successful claim increases it under the row lock. An event whose lease
 * expired after its last allowed attempt (the worker crashed or hung instead of failing it) is dead-lettered here
 * rather than reclaimed forever.
 */
export async function claimEvent(
  db: Database,
  leaseMs: number,
  maxAttempts = Number.POSITIVE_INFINITY,
  onExhausted?: (event: ClaimedEvent) => void,
): Promise<ClaimedEvent | null> {
  return withTx(db, async (tx) => {
    for (;;) {
      const [event] = await tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            isNull(outboxEvents.deliveredAt),
            isNull(outboxEvents.deadAt),
            sql`${outboxEvents.availableAt} <= clock_timestamp()`,
            or(isNull(outboxEvents.lockedUntil), sql`${outboxEvents.lockedUntil} <= clock_timestamp()`),
          ),
        )
        .orderBy(outboxEvents.availableAt)
        .limit(1)
        .for('update', { skipLocked: true });
      if (!event) return null;
      if (event.attempts >= maxAttempts) {
        await tx
          .update(outboxEvents)
          .set({ deadAt: sql`clock_timestamp()`, lockedUntil: null, lastError: 'ATTEMPTS_EXHAUSTED' })
          .where(eq(outboxEvents.id, event.id));
        onExhausted?.(event);
        continue;
      }
      const [claimed] = await tx
        .update(outboxEvents)
        .set({ lockedUntil: leaseEnd(leaseMs), attempts: event.attempts + 1 })
        .where(eq(outboxEvents.id, event.id))
        .returning();
      return claimed ?? null;
    }
  });
}

/** Appends one finished target to the event's progress; false when the lease is no longer ours. */
export async function recordProgress(db: Database, event: ClaimedEvent, key: string): Promise<boolean> {
  const rows = await db.drizzle
    .update(outboxEvents)
    .set({
      payload: sql`jsonb_set(${outboxEvents.payload}, ${`{${PROGRESS_KEY}}`}::text[], coalesce(${outboxEvents.payload} -> ${PROGRESS_KEY}::text, '[]'::jsonb) || jsonb_build_array(${key}::text))`,
    })
    .where(owned(event))
    .returning({ id: outboxEvents.id });
  return rows.length === 1;
}

function progressOf(event: ClaimedEvent, db: Database): DeliveryProgress {
  const payload = event.payload as Record<string, unknown>;
  const stored = payload[PROGRESS_KEY];
  const done = new Set(Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : []);
  return {
    done: (key) => done.has(key),
    markDone: async (key) => {
      if (done.has(key)) return;
      if (!(await recordProgress(db, event, key))) throw new Error('LEASE_LOST');
      done.add(key);
    },
  };
}

export async function renewEvent(db: Database, event: ClaimedEvent, leaseMs: number): Promise<boolean> {
  const rows = await db.drizzle
    .update(outboxEvents)
    .set({ lockedUntil: leaseEnd(leaseMs) })
    .where(owned(event))
    .returning({ id: outboxEvents.id });
  return rows.length === 1;
}

export async function completeEvent(db: Database, event: ClaimedEvent): Promise<boolean> {
  const rows = await db.drizzle
    .update(outboxEvents)
    .set({ deliveredAt: sql`clock_timestamp()`, lockedUntil: null, lastError: null })
    .where(owned(event))
    .returning({ id: outboxEvents.id });
  return rows.length === 1;
}

export async function failEvent(db: Database, event: ClaimedEvent, maxAttempts: number): Promise<boolean> {
  const dead = event.attempts >= maxAttempts;
  const backoffMs = Math.min(3600_000, 2 ** event.attempts * 1000);
  const rows = await db.drizzle
    .update(outboxEvents)
    .set({
      lockedUntil: null,
      // Handler errors may include a webhook URL, credentials or payload. Store only a fixed outcome.
      lastError: 'HANDLER_FAILED',
      ...(dead ? { deadAt: sql`clock_timestamp()` } : { availableAt: leaseEnd(backoffMs) }),
    })
    .where(owned(event))
    .returning({ id: outboxEvents.id });
  return rows.length === 1;
}

/**
 * At-least-once side effects: fencing protects database outcomes, not remote delivery. A crash after
 * a webhook succeeds can replay it. Receivers deduplicate by the stable context.eventId.
 * Heartbeats cover long handlers; a lost/expired lease is never revived and cannot commit an outcome.
 */
export async function processOne(
  db: Database,
  handlers: Record<string, Handler>,
  options: {
    leaseMs: number;
    maxAttempts: number;
    /** Overall budget for one handler run; on expiry its signal aborts and the attempt counts as failed. */
    handlerTimeoutMs?: number;
    onOutcome?: (event: {
      id: string;
      type: string;
      attempts: number;
      outcome: 'delivered' | 'retry' | 'dead' | 'lease_lost';
    }) => void;
  },
): Promise<boolean> {
  const event = await claimEvent(db, options.leaseMs, options.maxAttempts, (exhausted) =>
    options.onOutcome?.({
      id: exhausted.id,
      type: exhausted.type,
      attempts: exhausted.attempts,
      outcome: 'dead',
    }),
  );
  if (!event) return false;
  const controller = new AbortController();
  const deadline = new AbortController();
  const deadlineTimer =
    options.handlerTimeoutMs === undefined
      ? undefined
      : setTimeout(() => deadline.abort(), options.handlerTimeoutMs);
  const timedOut = new Promise<never>((_resolve, reject) => {
    deadline.signal.addEventListener('abort', () => reject(new Error('HANDLER_TIMEOUT')), { once: true });
  });
  timedOut.catch(() => undefined);
  let renewal = Promise.resolve();
  let renewing = false;
  const timer = setInterval(
    () => {
      if (renewing || controller.signal.aborted) return;
      renewing = true;
      renewal = renewEvent(db, event, options.leaseMs)
        .then((ok) => {
          if (!ok) controller.abort();
        })
        .catch(() => {
          controller.abort();
        })
        .finally(() => {
          renewing = false;
        });
    },
    Math.max(1, Math.floor(options.leaseMs / 3)),
  );
  timer.unref();
  let failed = false;
  try {
    const handler = handlers[event.type];
    if (!handler) throw new Error('UNSUPPORTED_EVENT');
    const { [PROGRESS_KEY]: _progress, ...payload } = event.payload as Record<string, unknown>;
    // A handler that ignores its signal is abandoned at the deadline; its late writes are fenced out by the lease.
    await Promise.race([
      handler(payload, event.aggregateId, {
        eventId: event.id,
        signal: AbortSignal.any([controller.signal, deadline.signal]),
        progress: progressOf(event, db),
      }),
      timedOut,
    ]);
  } catch {
    failed = true;
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(timer);
    await renewal;
  }
  const committed =
    !controller.signal.aborted &&
    (failed ? await failEvent(db, event, options.maxAttempts) : await completeEvent(db, event));
  options.onOutcome?.({
    id: event.id,
    type: event.type,
    attempts: event.attempts,
    outcome: !committed
      ? 'lease_lost'
      : !failed
        ? 'delivered'
        : event.attempts >= options.maxAttempts
          ? 'dead'
          : 'retry',
  });
  return true;
}
