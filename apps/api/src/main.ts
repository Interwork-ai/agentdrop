import { createDatabase, withTx } from '@agentdrop/db';
import {
  defaultApprovalPolicy,
  ensureSystemAssistant,
  feishuAppConfigFromEnv,
  initContentEncryption,
} from '@agentdrop/domain';
import { FsStorage, S3Storage } from '@agentdrop/storage';
import { buildApp } from './app.js';
import { createAuth } from './auth.js';
import { ConfigError, loadConfig } from './config.js';
import { createMailer } from './mail.js';

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[agentdrop-api] ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const db = createDatabase(config.DATABASE_URL);
  const storage =
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
  await storage.ping();
  // before anything reads or writes content: refuses to start with a missing or wrong keyring
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
  console.info(
    `[agentdrop-api] content encryption ${encryption.mode}${encryption.kid ? ` (key ${encryption.kid})` : ''}`,
  );
  if (encryption.missing_keys)
    console.warn(
      `[agentdrop-api] keys used by this database are missing from the keyring: ${encryption.missing_keys.join(', ')}`,
    );
  // the built-in @agentdrop test contact; idempotent and serialized, so several API processes may all run it
  const assistant = await withTx(db, (tx) => ensureSystemAssistant(tx));
  if (!assistant) console.warn('[agentdrop-api] handle @agentdrop belongs to a person; assistant disabled');
  const mailer = createMailer(config);
  const auth = createAuth(config, db, { mailer });
  // the server's own Feishu app (ADR 0039): the API only needs its id, for the bot link; the worker holds the secret
  const feishuApp = feishuAppConfigFromEnv(process.env, { requireSecret: false });
  const app = await buildApp({
    config,
    db,
    storage,
    auth,
    mailer,
    approvalPolicy: defaultApprovalPolicy,
    feishuApp,
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err) => {
  console.error('[agentdrop-api] fatal', err instanceof Error ? err.message : err);
  process.exit(1);
});
