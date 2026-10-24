import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { configureGroupStorageQuota } from '@agentdrop/domain';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { EventHub } from './events.js';
import { registerErrorHandler } from './plugins/errors.js';
import { adminRoutes } from './routes/admin.js';
import { approvalRoutes } from './routes/approvals.js';
import { hAttachmentRoutes, webAttachmentRoutes } from './routes/attachments.js';
import { authRoutes } from './routes/auth.js';
import { contactRoutes, inviteLinkPublicRoutes } from './routes/contacts.js';
import { hExportRoutes, webExportRoutes } from './routes/export.js';
import { groupRoutes } from './routes/groups.js';
import { hIdentityRoutes } from './routes/h.js';
import { healthRoutes } from './routes/health.js';
import { installRoutes } from './routes/install.js';
import { hMailboxRoutes, webMailboxRoutes } from './routes/mailbox.js';
import { hManageRoutes } from './routes/manage.js';
import { meRoutes } from './routes/me.js';
import { pairingRoutes } from './routes/pairing.js';

export interface BuildAppOptions {
  logger?: boolean | object;
}

/**
 * Request logs keep routing information, never invite credentials, password-reset tokens or search text.
 * Decode names for matching without rewriting unrelated URL bytes; encoded names and duplicate query keys
 * must receive the same treatment as the ordinary spelling.
 */
export function redactLoggedUrl(url: string): string {
  const decoded = (value: string) => {
    try {
      return decodeURIComponent(value.replace(/\+/g, ' ')).toLowerCase();
    } catch {
      return '';
    }
  };
  return url
    .replace(/^[^?#]*/, (path) => {
      const parts = path.split('/');
      return parts
        .map((part, i) => (i > 0 && decoded(parts[i - 1] ?? '') === 'invite' ? '[redacted]' : part))
        .join('/');
    })
    .replace(/([?&])([^=&#]+)=([^&#]*)/g, (entry, separator: string, key: string) =>
      ['token', 'query'].includes(decoded(key)) ? `${separator}${key}=[redacted]` : entry,
    );
}

const redactingReqSerializer = {
  req: (req: FastifyRequest) => ({
    method: req.method,
    url: redactLoggedUrl(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  }),
};

function withRedaction(logger: boolean | object): boolean | object {
  if (logger === false) return false;
  const base = logger === true ? {} : logger;
  return {
    ...base,
    serializers: { ...(base as { serializers?: object }).serializers, ...redactingReqSerializer },
  };
}

export async function buildApp(baseCtx: AppContext, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  // the fallback while no admin has set the group file space at runtime (ADR 0029)
  configureGroupStorageQuota(baseCtx.config.GROUP_STORAGE_QUOTA_BYTES);
  let log: FastifyInstance['log'] | null = null;
  const ctx: AppContext = {
    ...baseCtx,
    events:
      baseCtx.events ??
      new EventHub(baseCtx.config.DATABASE_URL, (err) =>
        log?.warn({ err: err instanceof Error ? err.message : String(err) }, 'event listener error'),
      ),
  };
  const app = Fastify({
    logger: withRedaction(
      opts.logger ??
        (ctx.config.NODE_ENV === 'development'
          ? { level: ctx.config.LOG_LEVEL, transport: { target: 'pino-pretty', options: { colorize: true } } }
          : { level: ctx.config.LOG_LEVEL }),
    ),
    trustProxy: ctx.config.TRUST_PROXY,
    bodyLimit: 1024 * 1024, // JSON bodies; file uploads use a dedicated streaming route with its own limit
    requestIdHeader: 'x-request-id',
  });

  registerErrorHandler(app);
  log = app.log;
  // Only the hub this app created is stopped and closed here; one handed in belongs to the caller. Streams end in
  // preClose, before the server waits for in-flight requests; the listener connection closes after them.
  if (!baseCtx.events) {
    app.addHook('preClose', async () => ctx.events?.stop());
    app.addHook('onClose', async () => ctx.events?.close());
  }

  await app.register(compress, { encodings: ['br', 'gzip'], threshold: 1024 });
  await app.register(cookie);
  await app.register(cors, {
    origin: ctx.config.WEB_ORIGIN ? [ctx.config.WEB_ORIGIN] : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-Id'],
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (req.url.startsWith('/assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    else reply.header('Cache-Control', 'no-store');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; worker-src 'self'; manifest-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    );
  });

  await app.register(async (i) => healthRoutes(i, ctx));
  await app.register(async (i) => installRoutes(i, ctx));
  await app.register(async (i) => authRoutes(i, ctx));
  await app.register(async (i) => pairingRoutes(i, ctx));
  await app.register(async (i) => meRoutes(i, ctx));
  await app.register(async (i) => hIdentityRoutes(i, ctx));
  await app.register(async (i) => hMailboxRoutes(i, ctx));
  await app.register(async (i) => hExportRoutes(i, ctx));
  await app.register(async (i) => hManageRoutes(i, ctx));
  await app.register(async (i) => webMailboxRoutes(i, ctx));
  await app.register(async (i) => webExportRoutes(i, ctx));
  await app.register(async (i) => inviteLinkPublicRoutes(i, ctx));
  await app.register(async (i) => contactRoutes(i, ctx));
  await app.register(async (i) => hAttachmentRoutes(i, ctx));
  await app.register(async (i) => webAttachmentRoutes(i, ctx));
  await app.register(async (i) => approvalRoutes(i, ctx));
  await app.register(async (i) => adminRoutes(i, ctx));
  await app.register(async (i) => groupRoutes(i, ctx));

  // Dashboard (single-page app) served from the same origin in production; API routes take precedence.
  const dist = ctx.config.WEB_DIST_DIR ? resolve(ctx.config.WEB_DIST_DIR) : null;
  if (dist && existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, wildcard: false, index: false });
    app.get('/*', async (req, reply) => {
      if (
        req.url.startsWith('/v1/') ||
        req.url.startsWith('/api/') ||
        req.url.startsWith('/health/') ||
        req.url.startsWith('/install')
      ) {
        return reply
          .status(404)
          .send({ code: 'NOT_FOUND', message: 'route not found', next_action: '', retryable: false });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
