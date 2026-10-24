import { type Listener, listen } from '@agentdrop/db';
import { EVENTS_CHANNEL } from '@agentdrop/domain';

/** How long-lived event requests behave (ADR 0040). */
export interface StreamLimits {
  /** Long-lived event requests (SSE or waiting long-polls) one person may hold at once, across all their agents. */
  perPerson: number;
  /**
   * An SSE stream that wrote nothing for this long writes a `ping` event, so proxies and clients see it is alive.
   * The caller's credential or session is checked again at least this often, and a client that stopped reading
   * is given this long to catch up before it is cut off.
   */
  keepaliveMs: number;
  /** Longest an SSE stream stays open: EventSource then reconnects through Last-Event-ID and the usual checks. */
  lifetimeMs: number;
}

export const DEFAULT_STREAM_LIMITS: StreamLimits = {
  perPerson: 20,
  keepaliveMs: 25_000,
  lifetimeMs: 15 * 60_000,
};

let limits = DEFAULT_STREAM_LIMITS;

export function streamLimits(): StreamLimits {
  return limits;
}

/** Tests shorten the periods instead of waiting 25 s. Returns a function that puts the previous ones back. */
export function configureStreamLimits(next: Partial<StreamLimits>): () => void {
  const previous = limits;
  limits = { ...limits, ...next };
  return () => {
    limits = previous;
  };
}

/**
 * Wakes requests waiting on a person's event stream (ADR 0040). One LISTEN connection per API process, opened on
 * first use. A wake-up is only a hint to read again: a missed notification costs at most one wait period, because
 * every waiter re-reads when its time is up, and all waiters re-read after the listener reconnects.
 */
export class EventHub {
  private listener: Listener | null = null;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly streams = new Map<string, number>();
  private readonly stopping = new AbortController();

  constructor(
    private readonly connectionString: string,
    private readonly onError: (err: unknown) => void,
  ) {}

  /** Aborts when the server begins to close: open streams and waiting long-polls end so the close can finish. */
  get stopped(): AbortSignal {
    return this.stopping.signal;
  }

  /**
   * Resolves when the person's stream may have changed, after `ms`, or when `signal` aborts. The waiter is
   * registered synchronously, so a caller that registers before reading cannot miss a change made in between.
   */
  wait(userId: string, ms: number, signal?: AbortSignal): Promise<void> {
    if (this.stopping.signal.aborted) return Promise.resolve();
    this.listener ??= listen(this.connectionString, EVENTS_CHANNEL, (id) => this.wake(id), {
      onError: this.onError,
      onReconnect: () => this.wakeAll(),
    });
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const set = this.waiters.get(userId) ?? new Set<() => void>();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        set.delete(done);
        if (set.size === 0 && this.waiters.get(userId) === set) this.waiters.delete(userId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      set.add(done);
      this.waiters.set(userId, set);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** Counts one long-lived request of this person; false when they already hold `max`. */
  acquire(userId: string, max: number): boolean {
    const open = this.streams.get(userId) ?? 0;
    if (open >= max) return false;
    this.streams.set(userId, open + 1);
    return true;
  }

  release(userId: string): void {
    const open = (this.streams.get(userId) ?? 1) - 1;
    if (open <= 0) this.streams.delete(userId);
    else this.streams.set(userId, open);
  }

  /**
   * Ends every stream and waiting long-poll. Runs when the server begins to close (`preClose`), before it waits for
   * in-flight requests: a stream that kept waiting would hold the close open until its client went away.
   */
  stop(): void {
    if (this.stopping.signal.aborted) return;
    this.stopping.abort();
    this.wakeAll();
  }

  async close(): Promise<void> {
    this.stop();
    const listener = this.listener;
    this.listener = null;
    await listener?.close();
  }

  private wake(userId: string): void {
    for (const done of [...(this.waiters.get(userId) ?? [])]) done();
  }

  private wakeAll(): void {
    for (const userId of [...this.waiters.keys()]) this.wake(userId);
  }
}
