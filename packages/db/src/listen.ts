import pg from 'pg';

export interface Listener {
  close(): Promise<void>;
}

export interface ListenOptions {
  onError?: (err: unknown) => void;
  onReconnect?: () => void;
  /** How often the connection is checked with a query while it is quiet; tests shorten it. */
  checkEveryMs?: number;
}

/** A check that takes longer than this (or than the time to the next check) counts as a dead connection. */
const CHECK_TIMEOUT_MS = 5_000;

/**
 * A dedicated connection that LISTENs on one channel and hands each notification's payload to `onNotify`. After a
 * connection error it reconnects with backoff (0.5 s doubling to 30 s). Notifications sent while it was away are
 * lost, so `onReconnect` runs once LISTEN is active again and lets the caller re-check whatever it waits on.
 *
 * A listening connection never sends anything by itself, so one dropped without a word (a NAT or firewall idle
 * timeout, a failover) would go unnoticed and every wake-up would be lost until a restart. TCP keepalive and a
 * periodic `SELECT 1` (which also keeps NAT mappings alive) find it, and a check that fails reconnects. It needs a
 * direct or session-mode connection: a transaction-mode pooler accepts LISTEN but never delivers a notification.
 */
export function listen(
  connectionString: string,
  channel: string,
  onNotify: (payload: string) => void,
  opts: ListenOptions = {},
): Listener {
  let active: pg.Client | null = null;
  let retry: NodeJS.Timeout | null = null;
  let check: NodeJS.Timeout | null = null;
  let closed = false;
  let delay = 500;

  const stopChecking = () => {
    if (check) clearInterval(check);
    check = null;
  };

  const reconnectLater = (client: pg.Client) => {
    if (closed || retry || (active !== null && active !== client)) return;
    if (active === client) {
      active = null;
      stopChecking();
    }
    client.end().catch(() => undefined);
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, delay);
    retry.unref();
    delay = Math.min(delay * 2, 30_000);
  };

  /** Runs `SELECT 1` on the listening connection; no answer in time reconnects. */
  const startChecking = (client: pg.Client) => {
    const every = opts.checkEveryMs ?? 30_000;
    let running = false;
    check = setInterval(() => {
      if (running || active !== client) return;
      running = true;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('listener check timed out')),
          Math.min(CHECK_TIMEOUT_MS, every),
        );
      });
      Promise.race([client.query('SELECT 1'), timedOut])
        .catch((err: unknown) => {
          opts.onError?.(err);
          reconnectLater(client);
        })
        .finally(() => {
          clearTimeout(timer);
          running = false;
        });
    }, every);
    check.unref();
  };

  const connect = async () => {
    if (closed) return;
    const client = new pg.Client({
      connectionString,
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    client.on('notification', (msg) => {
      if (msg.channel === channel && msg.payload) onNotify(msg.payload);
    });
    client.on('error', (err) => {
      opts.onError?.(err);
      reconnectLater(client);
    });
    client.on('end', () => reconnectLater(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${client.escapeIdentifier(channel)}`);
      if (closed) {
        await client.end().catch(() => undefined);
        return;
      }
      active = client;
      delay = 500;
      startChecking(client);
      opts.onReconnect?.();
    } catch (err) {
      opts.onError?.(err);
      reconnectLater(client);
    }
  };

  void connect();
  return {
    async close() {
      closed = true;
      stopChecking();
      if (retry) clearTimeout(retry);
      const client = active;
      active = null;
      await client?.end().catch(() => undefined);
    },
  };
}
