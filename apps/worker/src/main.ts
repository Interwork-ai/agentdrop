/**
 * AgentDrop worker: transactional outbox consumer plus maintenance sweeps. Core delivery never depends on it;
 * everything here is a derived side effect (notifications, cleanup) and is safe to replay.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { connections, createDatabase, withTx } from '@agentdrop/db';
import {
  expireStagedAttachments,
  expireUnlinkedAttachments,
  feishuAppConfigFromEnv,
  initContentEncryption,
  requestBackfill,
  sendUpdateReminders,
  sweepMailboxEvents,
} from '@agentdrop/domain';
import { FsStorage, S3Storage, type StorageProvider } from '@agentdrop/storage';
import { and, isNull, sql } from 'drizzle-orm';
import pino from 'pino';
import { z } from 'zod';
import { startFeishuEvents } from './feishu-events.js';
import { syncFeishuCards } from './feishu-sync.js';
import { createHandlers } from './handlers.js';
import { processOne } from './outbox.js';
import { configureWebPush, loadWebPushConfig } from './push.js';
import type { WebhookOptions } from './webhook.js';

const config = z
  .object({
    DATABASE_URL: z.string().min(1),
    STORAGE_PROVIDER: z.enum(['fs', 's3']).default('fs'),
    FS_STORAGE_DIR: z.string().default('./data/storage'),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z
      .string()
      .optional()
      .transform((v) => (v === undefined ? undefined : /^(1|true|yes)$/i.test(v))),
    WORKER_POLL_MS: z.coerce.number().int().positive().default(2000),
    WORKER_LEASE_S: z.coerce.number().int().positive().default(60),
    WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
    /** Overall budget for one outbox handler run (all webhooks and pushes of one event). */
    WORKER_HANDLER_TIMEOUT_S: z.coerce.number().int().positive().default(300),
    /**
     * Off by default: webhooks to loopback/private/link-local/metadata addresses are refused. Only for self-hosted
     * deployments whose webhook receivers live on the same private network.
     */
    WEBHOOK_ALLOW_PRIVATE_NETWORK: z
      .string()
      .optional()
      .transform((v) => v !== undefined && /^(1|true|yes)$/i.test(v)),
    STAGING_TTL_HOURS: z.coerce.number().int().positive().default(24),
    /** Days mailbox events stay readable on the event stream (ADR 0040); older cursors get RESYNC_REQUIRED. */
    MAILBOX_EVENTS_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    /** Where people open the dashboard; used for the link in Feishu notices. Optional: no link without it. */
    PUBLIC_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    WEB_ORIGIN: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    LOG_LEVEL: z.string().default('info'),
    NODE_ENV: z.string().default('development'),
    /** Same keyring and switch as the API (docs/plan/CONTENT_ENCRYPTION.md): titles in notices, receipts, backfill. */
    CONTENT_KEYS_FILE: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    CONTENT_KEYS: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    CONTENT_ENCRYPTION: z.enum(['off', 'on']).default('off'),
    /** The CLI release people are reminded to upgrade to. Default: the CLI shipped in this build. */
    CLI_LATEST_VERSION: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    /**
     * Days to wait between CLI update reminders to the same person, in order, the last repeating ("1,3,7": a day,
     * three days, then weekly). "0" turns the reminders off.
     */
    UPDATE_REMINDER_DAYS: z
      .string()
      .default('1,3,7')
      .transform((v) =>
        v
          .split(',')
          .map((d) => Number(d.trim()))
          .filter((d) => Number.isFinite(d) && d > 0),
      ),
  })
  .parse(process.env);

const log = pino({ level: config.LOG_LEVEL });
const webPushConfig = loadWebPushConfig(process.env);
configureWebPush(webPushConfig);
const db = createDatabase(config.DATABASE_URL, { max: 3 });
const storage: StorageProvider =
  config.STORAGE_PROVIDER === 's3'
    ? new S3Storage({
        bucket: config.S3_BUCKET ?? '',
        region: config.S3_REGION ?? '',
        endpoint: config.S3_ENDPOINT,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      })
    : new FsStorage(config.FS_STORAGE_DIR);

const webhookOptions: WebhookOptions = {
  allowPrivateNetwork: config.WEBHOOK_ALLOW_PRIVATE_NETWORK,
  onForbidden: (userId) => log.warn({ userId }, 'webhook refused: non-public address'),
};

// the server's own Feishu app (ADR 0039): off unless FEISHU_APP_ID and FEISHU_APP_SECRET are both set
const feishuApp = feishuAppConfigFromEnv(process.env);
const dashboard = config.WEB_ORIGIN ?? config.PUBLIC_BASE_URL ?? null;

const handlers = createHandlers({
  db,
  storage,
  log,
  webPushConfig,
  webhookOptions,
  dashboard,
  fetch,
  feishuApp,
});

let stopping = false;

async function maintenance(): Promise<void> {
  const cutoff = new Date(Date.now() - config.STAGING_TTL_HOURS * 3600 * 1000);
  const keys = await withTx(db, (tx) => expireStagedAttachments(tx, cutoff));
  if (keys.length) log.info({ count: keys.length }, 'expired staging attachments');
  const unused = await withTx(db, (tx) => expireUnlinkedAttachments(tx, cutoff));
  if (unused.length) log.info({ count: unused.length }, 'released unused uploads');
  // connections silent for 30 minutes are closed for hygiene (they are diagnostics, not permissions)
  const closed = await db.drizzle
    .update(connections)
    .set({ closedAt: new Date() })
    .where(and(isNull(connections.closedAt), sql`${connections.lastSeenAt} < now() - interval '30 minutes'`))
    .returning({ id: connections.id });
  if (closed.length) log.info({ count: closed.length }, 'closed silent connections');
  // Mailbox events back the event stream for a bounded window (ADR 0040); swept in batches, at most 20 per pass.
  const eventsBefore = new Date(Date.now() - config.MAILBOX_EVENTS_RETENTION_DAYS * 86_400_000);
  let swept = 0;
  for (let pass = 0; pass < 20; pass++) {
    const n = await withTx(db, (tx) => sweepMailboxEvents(tx, eventsBefore, EVENT_SWEEP_BATCH));
    swept += n;
    if (n < EVENT_SWEEP_BATCH) break;
  }
  if (swept) log.info({ count: swept }, 'swept old mailbox events');
  if (
    cliLatest &&
    config.UPDATE_REMINDER_DAYS.length > 0 &&
    Date.now() - lastReminderSweep > 60 * 60 * 1000
  ) {
    lastReminderSweep = Date.now();
    const sent = await withTx(db, (tx) =>
      sendUpdateReminders(tx, {
        latest: cliLatest,
        scheduleMs: config.UPDATE_REMINDER_DAYS.map((d) => d * 86_400_000),
        activeWithinMs: 14 * 86_400_000,
      }),
    );
    if (sent) log.info({ count: sent, latest: cliLatest }, 'sent CLI update reminders');
  }
}

let lastReminderSweep = 0;
const EVENT_SWEEP_BATCH = 5000;
/** The CLI version this build ships (apps/cli/package.json next to this app), unless configured. */
const cliLatest = config.CLI_LATEST_VERSION ?? shippedCliVersion();
function shippedCliVersion(): string | undefined {
  try {
    const url = new URL('../../cli/package.json', import.meta.url);
    return (JSON.parse(readFileSync(url, 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  await storage.ping();
  const encryption = await withTx(db, (tx) =>
    initContentEncryption(tx, {
      source: {
        file: config.CONTENT_KEYS_FILE,
        inline: config.CONTENT_KEYS,
        allowInline: config.NODE_ENV === 'test',
      },
      mode: config.CONTENT_ENCRYPTION,
    }),
  );
  log.info(encryption, 'content encryption');
  if (encryption.mode === 'on' && (await withTx(db, requestBackfill))) log.info('content backfill queued');
  log.info({ provider: storage.kind }, 'worker started');
  const stopFeishu = feishuApp ? startFeishuEvents({ db, app: feishuApp, dashboard, fetch, log }) : null;
  let lastMaintenance = 0;
  let lastFeishuSync = 0;
  while (!stopping) {
    let did = false;
    try {
      did = await processOne(db, handlers, {
        leaseMs: config.WORKER_LEASE_S * 1000,
        maxAttempts: config.WORKER_MAX_ATTEMPTS,
        handlerTimeoutMs: config.WORKER_HANDLER_TIMEOUT_S * 1000,
        onOutcome: (event) => {
          log[event.outcome === 'dead' ? 'error' : event.outcome === 'delivered' ? 'info' : 'warn'](
            event,
            'outbox outcome',
          );
        },
      });
      if (Date.now() - lastMaintenance > 10 * 60 * 1000) {
        await maintenance();
        lastMaintenance = Date.now();
      }
      if (feishuApp && Date.now() - lastFeishuSync > 60 * 1000) {
        lastFeishuSync = Date.now();
        const changed = await syncFeishuCards(db, feishuApp, { dashboard, fetch });
        if (changed) log.info({ count: changed }, 'feishu cards follow reads elsewhere');
      }
    } catch (err) {
      log.error({ err }, 'worker loop error');
    }
    if (!did) await new Promise((r) => setTimeout(r, config.WORKER_POLL_MS));
  }
  stopFeishu?.();
  await db.close();
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    stopping = true;
    log.info({ sig }, 'stopping');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log.fatal({ err }, 'worker crashed');
    process.exit(1);
  });
}
