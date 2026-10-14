import {
  AgentDropError,
  directoryLookupInputSchema,
  listDropsInputSchema,
  markAllReadInputSchema,
  readDropInputSchema,
  sendDropInputSchema,
  setDropStateInputSchema,
  type Viewer,
  z,
} from '@agentdrop/contracts';
import { appUsers, harnessEndpoints, withTx } from '@agentdrop/db';
import {
  deleteSpaceItem,
  directoryLookup,
  getMailboxRevision,
  listDrops,
  type MailboxScope,
  markAllRead,
  pendingCounts,
  readDrop,
  sendDrop,
  sendRequestStatus,
  setDropState,
  withDropContext,
} from '@agentdrop/domain';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { bridgeBefore0411, trimNewerFieldsForOldBridges } from '../plugins/old-bridge.js';
import { requireH, requireUser, userPrincipalOf } from '../plugins/principals.js';
import { parse } from '../plugins/validate.js';

const SEARCH_PER_MINUTE = 30;
const SEARCH_CONCURRENT = 2;

/**
 * Mailbox routes are registered twice with different scope resolvers:
 *   /v1/h/...                     H credential: scope fixed by the credential (bridge / MCP)
 *   /v1/me/endpoints/:h_id/...    browser session: scope = one of MY endpoints, ownership verified
 * Both call the same domain use-cases; there is no second authorization implementation.
 */
export async function hMailboxRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', requireH(ctx));
  trimNewerFieldsForOldBridges(app);
  registerMailboxRoutes(app, ctx, '/v1/h', async (req) => {
    const a = req.hAuth;
    if (!a) throw new AgentDropError('UNAUTHORIZED');
    return { userId: a.user.userId, hId: a.endpoint.hId, via: 'h_credential' };
  });
}

export async function webMailboxRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', requireUser(ctx));
  registerMailboxRoutes(app, ctx, '/v1/me/endpoints/:h_id', async (req) => {
    const p = userPrincipalOf(req);
    const { h_id } = parse(z.object({ h_id: z.uuid() }), req.params);
    const h = await ctx.db.drizzle.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, h_id) });
    if (!h || h.userId !== p.userId) throw new AgentDropError('NOT_FOUND', 'endpoint not found');
    return { userId: p.userId, hId: h.id, via: 'user_session' };
  });
}

export async function buildViewer(ctx: AppContext, scope: MailboxScope): Promise<Viewer> {
  const [user, h, revision, pending] = await Promise.all([
    ctx.db.drizzle.query.appUsers.findFirst({ where: eq(appUsers.id, scope.userId) }),
    ctx.db.drizzle.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, scope.hId) }),
    getMailboxRevision(ctx.db.drizzle, scope.hId),
    pendingCounts(ctx.db.drizzle, scope),
  ]);
  if (!user || !h) throw new AgentDropError('UNAUTHORIZED');
  return {
    pending,
    user_id: user.id,
    handle: user.handle,
    display_name: user.displayName,
    public_email: user.publicEmail ?? null,
    h_id: h.id,
    agent_name: h.label,
    directory_revision: user.directoryRevision,
    mailbox_revision: revision,
  };
}

type ScopeResolver = (req: FastifyRequest) => Promise<MailboxScope>;

function registerMailboxRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  prefix: string,
  resolve: ScopeResolver,
): void {
  app.get(`${prefix}/directory`, async (req) => {
    const scope = await resolve(req);
    const input = parse(directoryLookupInputSchema, coerceQuery(req.query));
    const res = await directoryLookup(ctx.db.drizzle, scope, input);
    const viewer = await buildViewer(ctx, scope);
    return trimForLegacyBridge(req, {
      entries: res.entries,
      next_cursor: res.nextCursor,
      directory_revision: viewer.directory_revision,
      ambiguous: res.ambiguous,
      viewer: {
        user_id: viewer.user_id,
        handle: viewer.handle,
        display_name: viewer.display_name,
        public_email: viewer.public_email,
        h_id: viewer.h_id,
        agent_name: viewer.agent_name,
      },
    });
  });

  const searches = new Map<string, { count: number; resetAt: number; running: number }>();
  /** At most SEARCH_PER_MINUTE searches per person per minute and SEARCH_CONCURRENT at a time. */
  const searchSlot = (userId: string): (() => void) => {
    const now = Date.now();
    let s = searches.get(userId);
    if (!s || s.resetAt <= now) {
      s = { count: 0, resetAt: now + 60_000, running: s?.running ?? 0 };
      searches.set(userId, s);
    }
    if (s.count >= SEARCH_PER_MINUTE || s.running >= SEARCH_CONCURRENT)
      throw new AgentDropError('RATE_LIMITED');
    s.count += 1;
    s.running += 1;
    const slot = s;
    return () => {
      slot.running -= 1;
      if (slot.running === 0 && slot.resetAt <= Date.now()) searches.delete(userId);
    };
  };

  app.get(`${prefix}/drops`, async (req) => {
    const scope = await resolve(req);
    const input = parse(listDropsInputSchema, coerceQuery(req.query));
    // a search decrypts and reads up to SEARCH_SCAN_LIMIT messages: bounded per person (docs/plan/CONTENT_ENCRYPTION.md §9)
    const release = input.query?.trim() ? searchSlot(scope.userId) : () => {};
    let res: Awaited<ReturnType<typeof listDrops>>;
    try {
      res = await listDrops(ctx.db.drizzle, scope, input);
    } finally {
      release();
    }
    return {
      drops: (await withDropContext(ctx.db.drizzle, scope.userId, res.drops)).map((drop) =>
        trimReceiptsForOldBridge(req, drop),
      ),
      next_cursor: res.nextCursor,
      unread_count: res.unreadCount,
      ...(res.mutedUnreadCount !== undefined ? { muted_unread_count: res.mutedUnreadCount } : {}),
      viewer: await buildViewer(ctx, scope),
    };
  });

  app.get(`${prefix}/drops/:drop_id`, async (req) => {
    const scope = await resolve(req);
    const { drop_id } = parse(z.object({ drop_id: z.uuid() }), req.params);
    const input = parse(readDropInputSchema, { drop_id, ...coerceQuery(req.query) });
    const connectionId =
      typeof req.headers['x-connection-id'] === 'string' ? req.headers['x-connection-id'] : null;
    const drop = await withTx(ctx.db, (tx) => readDrop(tx, scope, input, connectionId));
    const [labelled] = await withDropContext(ctx.db.drizzle, scope.userId, [drop]);
    return { drop: trimReceiptsForOldBridge(req, labelled ?? drop), viewer: await buildViewer(ctx, scope) };
  });

  app.post(`${prefix}/drops`, async (req, reply) => {
    const scope = await resolve(req);
    const input = parse(sendDropInputSchema, req.body);
    const res = await withTx(ctx.db, (tx) =>
      sendDrop(tx, scope, input, {
        originKind: scope.via === 'h_credential' ? 'mcp' : 'web',
        maxGroupRecipients: ctx.config.MAX_GROUP_RECIPIENTS,
        maxDropFileBytes: ctx.config.MAX_DROP_FILE_BYTES,
        ...(ctx.approvalPolicy ? { approvalPolicy: ctx.approvalPolicy } : {}),
        approvalUrlFor: (id) => `${ctx.config.WEB_ORIGIN ?? ctx.config.PUBLIC_BASE_URL}/approvals/${id}`,
      }),
    );
    const viewer = await buildViewer(ctx, scope);
    reply.status(res.outcome === 'needs_approval' ? 202 : 200);
    return trimForLegacyBridge(req, {
      outcome: res.outcome,
      request_id: res.requestId,
      drop_id: res.dropId,
      recipients: res.recipients,
      approval_url: res.approvalUrl,
      retryable: res.retryable,
      error: res.error,
      viewer,
    });
  });

  app.patch(`${prefix}/drops/:drop_id/state`, async (req) => {
    const scope = await resolve(req);
    const { drop_id } = parse(z.object({ drop_id: z.uuid() }), req.params);
    const input = parse(setDropStateInputSchema, { drop_id, ...(req.body as object) });
    const res = await withTx(ctx.db, (tx) => setDropState(tx, scope, input));
    return { ...res, viewer: await buildViewer(ctx, scope) };
  });

  // "Mark all as read" (ADR 0018): an explicit act of the person, from the dashboard; same scope rules as the inbox.
  app.post(`${prefix}/drops/mark-read`, async (req) => {
    const scope = await resolve(req);
    const input = parse(markAllReadInputSchema, req.body ?? {});
    const res = await withTx(ctx.db, (tx) => markAllRead(tx, scope, input));
    return { ...res, viewer: await buildViewer(ctx, scope) };
  });

  // One item of my own space (ADR 0030): revoked and its files freed. The agent credential (CLI) and an owned agent
  // view in the dashboard reach the same use-case; only the author's own `self` drops qualify.
  app.delete(`${prefix}/space/:drop_id`, async (req) => {
    const scope = await resolve(req);
    const { drop_id } = parse(z.object({ drop_id: z.uuid() }), req.params);
    return withTx(ctx.db, (tx) => deleteSpaceItem(tx, scope, drop_id));
  });

  app.get(`${prefix}/send-requests/:request_id`, async (req) => {
    const scope = await resolve(req);
    const { request_id } = parse(z.object({ request_id: z.string().min(1).max(128) }), req.params);
    return sendRequestStatus(ctx.db.drizzle, scope, request_id);
  });
}

/**
 * Bridges before 0.3.0 advertise tool output schemas (additionalProperties: false) without the per-agent address
 * fields, so responses to them are trimmed to the shape they published. Detected from `agentdrop-bridge/<version>`.
 */
function legacyBridge(req: FastifyRequest): boolean {
  const ua = req.headers['user-agent'];
  const m = typeof ua === 'string' ? /^agentdrop-bridge\/(\d+)\.(\d+)\.(\d+)/.exec(ua) : null;
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major === 0 && minor < 3;
}

function trimForLegacyBridge<T extends { entries?: unknown[]; recipients?: unknown[] }>(
  req: FastifyRequest,
  body: T,
): T {
  if (!legacyBridge(req)) return body;
  const out = { ...body };
  if (Array.isArray(out.entries)) {
    out.entries = out.entries.map((e) => {
      const entry = e as Record<string, unknown>;
      if (entry.kind !== 'person') return entry;
      const { default_endpoint: _omit, ...rest } = entry;
      return {
        ...rest,
        alternatives: (entry.alternatives as Record<string, unknown>[]).map(
          ({ harness_key: _h, auto: _a, ...alt }) => alt,
        ),
      };
    });
  }
  if (Array.isArray(out.recipients)) {
    out.recipients = out.recipients.map((r) => {
      const { address: _ad, endpoint_label: _el, harness_key: _hk, ...rest } = r as Record<string, unknown>;
      return rest;
    });
  }
  return out;
}

/** Bridges before 0.4.11 would hand `recipient_status` to a strict MCP client that rejects it (see old-bridge.ts). */
function trimReceiptsForOldBridge<T extends { recipient_status?: unknown }>(req: FastifyRequest, drop: T): T {
  if (drop.recipient_status === undefined || !bridgeBefore0411(req)) return drop;
  const { recipient_status: _omit, ...rest } = drop;
  return rest as T;
}

/** Query strings arrive as strings; coerce the few numeric/boolean fields the list/directory schemas expect. */
function coerceQuery(query: unknown): Record<string, unknown> {
  const q = { ...(query as Record<string, string | undefined>) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === '') continue;
    if (k === 'limit' || k === 'offset' || k === 'max_chars') out[k] = Number(v);
    else if (k === 'unread_only' || k === 'include_group_history') out[k] = v === 'true' || v === '1';
    else out[k] = v;
  }
  return out;
}
