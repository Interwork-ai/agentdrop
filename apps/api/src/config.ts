import { LIMITS } from '@agentdrop/contracts';
import { z } from 'zod';

/**
 * Startup configuration. Validation is strict on purpose: a production process with
 * dev auth, a filesystem storage backend or a short secret refuses to start.
 */
const boolean = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : /^(1|true|yes)$/i.test(v)));
/** Values shipped in examples and templates (change-me, changeme, REPLACE…, local-only…): never a real secret. */
const PLACEHOLDER_SECRET = /REPLACE|GENERATE_SECURE_RANDOM_VALUE|change[-_ ]?me|local[-_ ]?only|placeholder/i;
const optionalSecret = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('127.0.0.1'),
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
    DATABASE_URL: z.string().min(1),
    AUTH_SECRET: z.string().min(1),
    STORAGE_PROVIDER: z.enum(['fs', 's3']).default('fs'),
    FS_STORAGE_DIR: z.string().default('./data/storage'),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: boolean,
    MAX_FILE_BYTES: z.coerce.number().int().positive().default(52_428_800),
    MAX_DROP_FILE_BYTES: z.coerce.number().int().positive().default(104_857_600),
    H_STORAGE_QUOTA_BYTES: z.coerce.number().int().positive().default(1_073_741_824),
    /**
     * File space of every group (ADR 0029), 512 MiB by default: a send whose files would push a group past it is
     * refused. An admin can change it at runtime from the dashboard (stored in app_settings).
     */
    GROUP_STORAGE_QUOTA_BYTES: z.coerce.number().int().positive().default(536_870_912),
    MAX_GROUP_RECIPIENTS: z.coerce.number().int().positive().max(500).default(200),
    /** People per group (members + outstanding invitations). A different ceiling from MAX_GROUP_RECIPIENTS. */
    MAX_GROUP_MEMBERS: z.coerce.number().int().positive().max(200).default(LIMITS.GROUP_MAX_MEMBERS),
    H_CREDENTIAL_MAX_DAYS: z.coerce.number().int().positive().max(365).default(90),
    PAIRING_CODE_TTL_S: z.coerce.number().int().positive().default(600),
    PAIRING_START_PER_MIN: z.coerce.number().int().positive().default(10),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_CONTENT: boolean.default(false),
    /** Same switch as the worker's: lets a self-hosted intranet save a webhook on a private address. */
    WEBHOOK_ALLOW_PRIVATE_NETWORK: boolean.default(false),
    DEV_AUTH: boolean.default(false),
    TRUST_PROXY: boolean.default(false),
    // a second browser origin (dev server, or the same site on another port); empty means unset (compose passes '')
    WEB_ORIGIN: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    /** Initial sign-up mode; an admin can change it at runtime from the dashboard (stored in app_settings). */
    SIGNUP_MODE: z.enum(['open', 'closed']).default('open'),
    /** Content encryption (docs/plan/CONTENT_ENCRYPTION.md): keyring file, and whether new content is encrypted. */
    CONTENT_KEYS_FILE: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    /** The keyring inline; tests only (a deploy would copy an env value next to its backups). */
    CONTENT_KEYS: optionalSecret,
    CONTENT_ENCRYPTION: z.enum(['off', 'on']).default('off'),
    APP_VERSION: z.string().default('0.5.17'),
    /** When set, the API serves the built dashboard (same origin, so cookies stay first-party). */
    WEB_DIST_DIR: z.string().optional(),
    /** Directory holding the standalone CLI tarball (agentdrop.tgz) served at /install/agentdrop.tgz. */
    CLI_DIST_DIR: z.string().optional(),
    /** Public browser application-server key. The private VAPID key belongs only in the worker process. */
    WEB_PUSH_VAPID_PUBLIC_KEY: optionalSecret,
    /**
     * Optional outgoing mail for password reset, e.g. smtps://user:pass@smtp.example.com:465. Unset means the
     * server sends no email and an administrator hands out reset links instead. Holds a secret: never logged.
     */
    SMTP_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .regex(/^smtps?:\/\//, 'must start with smtp:// or smtps://')
        .optional(),
    ),
    /** Sender address for that mail, e.g. "AgentDrop <no-reply@example.com>". Required with SMTP_URL. */
    MAIL_FROM: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(3).max(256).optional()),
  })
  .superRefine((cfg, ctx) => {
    const prod = cfg.NODE_ENV === 'production';
    if (prod && cfg.DEV_AUTH)
      ctx.addIssue({ code: 'custom', path: ['DEV_AUTH'], message: 'DEV_AUTH must be false in production' });
    if (prod && cfg.STORAGE_PROVIDER === 'fs')
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_PROVIDER'],
        message: 'production requires the s3 storage provider',
      });
    if (prod && cfg.AUTH_SECRET.length < 32)
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_SECRET'],
        message: 'AUTH_SECRET must be at least 32 characters in production',
      });
    if (prod && !cfg.PUBLIC_BASE_URL.startsWith('https://'))
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_BASE_URL'],
        message: 'PUBLIC_BASE_URL must be https in production',
      });
    if (prod && cfg.LOG_CONTENT)
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_CONTENT'],
        message: 'LOG_CONTENT must be false in production',
      });
    if (cfg.CONTENT_KEYS && cfg.NODE_ENV !== 'test')
      ctx.addIssue({
        code: 'custom',
        path: ['CONTENT_KEYS'],
        message: 'CONTENT_KEYS is for tests only; put the keyring in a file and set CONTENT_KEYS_FILE',
      });
    if (cfg.CONTENT_ENCRYPTION === 'on' && !cfg.CONTENT_KEYS_FILE && !cfg.CONTENT_KEYS)
      ctx.addIssue({
        code: 'custom',
        path: ['CONTENT_ENCRYPTION'],
        message: 'CONTENT_ENCRYPTION=on needs CONTENT_KEYS_FILE',
      });
    if (cfg.SMTP_URL && !cfg.MAIL_FROM)
      ctx.addIssue({ code: 'custom', path: ['MAIL_FROM'], message: 'MAIL_FROM is required with SMTP_URL' });
    if (cfg.STORAGE_PROVIDER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_REGION'] as const) {
        if (!cfg[key])
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required for the s3 provider` });
      }
    }
    // A known placeholder fails closed everywhere except unit tests: a development server reachable by others
    // would otherwise sign sessions with a value anyone can read in the repository.
    if (cfg.NODE_ENV !== 'test' && PLACEHOLDER_SECRET.test(cfg.AUTH_SECRET))
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_SECRET'],
        message:
          'AUTH_SECRET still holds a placeholder value; set a long random value (openssl rand -hex 32)',
      });
  });

export type AppConfig = z.infer<typeof schema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Never echo values: only the key path and the rule that failed.
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return parsed.data;
}
