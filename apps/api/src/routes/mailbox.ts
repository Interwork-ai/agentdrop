import {
  AgentDropError,
  directoryLookupInputSchema,
  type EventsResult,
  eventsInputSchema,
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
  readEvents,
  type SendOptions,
  sendDrop,
  sendRequestStatus,
  setDropState,
  withDropContext,
} from '@agentdrop/domain';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { type EventHub, type StreamLimits, streamLimits } from '../events.js';
import { bridgeBefore0411, trimNewerFieldsForOldBridges } from '../plugins/old-bridge.js';
import { createKeyLimiter, requireH, requireUser, userPrincipalOf } from '../plugins/principals.js';
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
  const authorize = requireH(ctx);
  app.addHook('preHandler', authorize);
  trimNewerFieldsForOldBridges(app);
  registerMailboxRoutes(
    app,
    ctx,
    '/v1/h',
    async (req) => {
      const a = req.hAuth;
      if (!a) throw new AgentDropError('UNAUTHORIZED');
      return { userId: a.user.userId, hId: a.endpoint.hId, via: 'h_credential' };
    },
    authorize,
  );
}

export async function webMailboxRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const authorize = requireUser(ctx);
  app.addHook('preHandler', authorize);
  registerMailboxRoutes(
    app,
    ctx,
    '/v1/me/endpoints/:h_id',
    async (req) => {
      const p = userPrincipalOf(req);
      const { h_id } = parse(z.object({ h_id: z.uuid() }), req.params);
      const h = await ctx.db.drizzle.query.harnessEndpoints.findFirst({
        where: eq(harnessEndpoints.id, h_id),
      });
      if (!h || h.userId !== p.userId) throw new AgentDropError('NOT_FOUND', 'endpoint not found');
      return { userId: p.userId, hId: h.id, via: 'user_session' };
    },
    authorize,
  );
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
/** The pre-handler of a prefix: checks the H credential or the browser session and records the principal. */
type Authorize = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** `authorize` is the prefix's pre-handler; a request that stays open (the event stream) runs it again. */
function registerMailboxRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  prefix: string,
  resolve: ScopeResolver,
  authorize: Authorize,
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

  /*
   * A search decrypts and reads up to SEARCH_SCAN_LIMIT messages. At most SEARCH_PER_MINUTE per person per minute,
   * counted across every API process; at most SEARCH_CONCURRENT at a time in this process, which is the CPU it uses.
   */
  const perMinute = createKeyLimiter(ctx, {
    name: 'search',
    windowMs: 60_000,
    max: SEARCH_PER_MINUTE,
    key: (req) => (req.hAuth?.user.userId ?? req.userPrincipal?.userId ?? req.ip) as string,
  });
  const running = new Map<string, number>();
  const searchSlot = async (req: FastifyRequest, userId: string): Promise<() => void> => {
    if ((running.get(userId) ?? 0) >= SEARCH_CONCURRENT) throw new AgentDropError('RATE_LIMITED');
    await perMinute(req);
    running.set(userId, (running.get(userId) ?? 0) + 1);
    return () => {
      const left = (running.get(userId) ?? 1) - 1;
      if (left <= 0) running.delete(userId);
      else running.set(userId, left);
    };
  };

  app.get(`${prefix}/drops`, async (req) => {
    const scope = await resolve(req);
    const input = parse(listDropsInputSchema, coerceQuery(req.query));
    // a search decrypts and reads up to SEARCH_SCAN_LIMIT messages: bounded per person (docs/plan/CONTENT_ENCRYPTION.md §9)
    const release = input.query?.trim() ? await searchSlot(req, scope.userId) : () => {};
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

  const sendOptions = (scope: MailboxScope): SendOptions => ({
    originKind: scope.via === 'h_credential' ? 'mcp' : 'web',
    maxGroupRecipients: ctx.config.MAX_GROUP_RECIPIENTS,
    maxDropFileBytes: ctx.config.MAX_DROP_FILE_BYTES,
    ...(ctx.approvalPolicy ? { approvalPolicy: ctx.approvalPolicy } : {}),
    approvalUrlFor: (id) => `${ctx.config.WEB_ORIGIN ?? ctx.config.PUBLIC_BASE_URL}/approvals/${id}`,
  });

  app.post(`${prefix}/drops`, async (req, reply) => {
    const scope = await resolve(req);
    const input = parse(sendDropInputSchema, req.body);
    const res = await withTx(ctx.db, (tx) => sendDrop(tx, scope, input, sendOptions(scope)));
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

  // The person's event stream (ADR 0040): one read behind two transports, long-poll and SSE.
  app.get(`${prefix}/events`, async (req, reply) => {
    const scope = await resolve(req);
    const hub = ctx.events;
    if (!hub) throw new AgentDropError('INTERNAL', 'event stream unavailable');
    const limits = streamLimits();
    const query = coerceQuery(req.query);
    const lastEventId = req.headers['last-event-id'];
    const input = parse(eventsInputSchema, {
      ...query,
      ...(query.cursor === undefined && typeof lastEventId === 'string' && lastEventId
        ? { cursor: lastEventId }
        : {}),
    });
    const read = (cursor: string | undefined) => readEvents(ctx.db.drizzle, scope, { ...input, cursor });
    const waitMs = (input.wait ?? 0) * 1000;
    const sse = String(req.headers.accept ?? '').includes('text/event-stream');
    if (!sse && !(waitMs > 0 && input.cursor)) return read(input.cursor);
    // A client that left while its credential or session was being checked: its 'close' has already been
    // emitted, so a listener added now would never fire. Nothing to answer and no slot to hold.
    if (clientGone(req, reply)) {
      reply.hijack();
      return reply;
    }
    if (!hub.acquire(scope.userId, limits.perPerson)) throw new AgentDropError('RATE_LIMITED');
    // Ends when the client goes away (the response closes early) or the server begins to close.
    const closed = new AbortController();
    const end = () => closed.abort();
    reply.raw.on('close', end);
    hub.stopped.addEventListener('abort', end, { once: true });
    if (hub.stopped.aborted || clientGone(req, reply)) end();
    // The pre-handler ran once, when the request came in. Before anything more is answered, the credential or
    // session is checked again the same way, and must still read as the same person and agent: a revoked agent,
    // a signed-out session or a suspended account gets nothing further.
    const recheck = async () => {
      await authorize(req, reply);
      const now = await resolve(req);
      if (now.userId !== scope.userId || now.hId !== scope.hId) throw new AgentDropError('UNAUTHORIZED');
    };
    try {
      if (!sse) {
        // A wake-up is a hint: re-read, and keep waiting until the deadline while nothing is there.
        const deadline = Date.now() + waitMs;
        let cursor = input.cursor;
        let waited = false;
        for (;;) {
          const tick = new AbortController();
          // Registered before the read, so a change committed in between still wakes this request.
          const changed = hub.wait(
            scope.userId,
            Math.max(0, deadline - Date.now()),
            AbortSignal.any([closed.signal, tick.signal]),
          );
          const out = await read(cursor);
          if (out.events.length || out.has_more || Date.now() >= deadline || closed.signal.aborted) {
            tick.abort();
            // An answer after waiting: the caller may have lost access meanwhile, and then gets that error.
            if (waited && !clientGone(req, reply)) await recheck();
            // Answered because the server is closing: give up the connection too, or the close waits for it.
            if (hub.stopped.aborted) reply.header('connection', 'close');
            return out;
          }
          await changed;
          waited = true;
          cursor = out.cursor;
        }
      }
      // A bad cursor answers with an ordinary error before the stream starts.
      const first = await read(input.cursor);
      await streamEvents(reply, hub, scope.userId, first, read, recheck, closed.signal, limits);
      return reply;
    } finally {
      closed.abort();
      reply.raw.off('close', end);
      hub.stopped.removeEventListener('abort', end);
      hub.release(scope.userId);
    }
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

/** Tells an idle SSE client the stream is alive. A named event, unlike a comment, is visible to scripts. */
const SSE_PING = 'event: ping\ndata: {}\n\n';
/** A timer may fire a little before its time: what is due that soon counts as due, saving a read in between. */
const DUE_SLACK_MS = 25;

/** True once the client has gone. A close that came before any listener was attached leaves only these flags. */
function clientGone(req: FastifyRequest, reply: FastifyReply): boolean {
  return reply.raw.destroyed || reply.raw.writableEnded || req.raw.socket?.destroyed === true;
}

/**
 * Writes the event stream as SSE: the first batch at once (a fresh subscription learns its cursor), then each
 * further batch as it arrives. Every batch carries the cursor as its `id`, so a reconnecting EventSource resumes
 * through `Last-Event-ID`; a `ping` event (no id) breaks every silence of `keepaliveMs`. A cursor that turns stale
 * mid-stream ends it with a `resync` event. Otherwise the stream simply ends, and a reconnect goes through the
 * pre-handler again: when `recheck` fails (run before each batch and at least once per `keepaliveMs`), when the
 * client stops reading for `keepaliveMs`, and after `lifetimeMs`.
 */
async function streamEvents(
  reply: FastifyReply,
  hub: EventHub,
  userId: string,
  first: EventsResult,
  read: (cursor: string) => Promise<EventsResult>,
  recheck: () => Promise<void>,
  closed: AbortSignal,
  limits: StreamLimits,
): Promise<void> {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  });
  const open = () => !closed.aborted && !res.destroyed && !res.writableEnded;
  const opened = Date.now();
  let lastWrite = opened;
  let checked = opened;
  const since = (at: number, ms: number) => Date.now() - at >= ms - DUE_SLACK_MS;
  const write = (chunk: string) => {
    if (!open()) return;
    lastWrite = Date.now();
    res.write(chunk);
  };
  const batch = (out: EventsResult) =>
    write(`id: ${out.cursor}\nevent: events\ndata: ${JSON.stringify(out)}\n\n`);
  const allowed = async () => {
    try {
      await recheck();
    } catch {
      return false;
    }
    checked = Date.now();
    return true;
  };
  // Nothing more is read while the client has not taken what was written, so a client that stopped reading never
  // has batches piling up in memory. One that does not catch up within `keepaliveMs` is cut off; events are hints,
  // and it resumes after the last batch it did read, through Last-Event-ID.
  const drained = () =>
    new Promise<boolean>((resolve) => {
      if (!res.writableNeedDrain) return resolve(true);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        res.off('drain', onDrain);
        closed.removeEventListener('abort', onClose);
        resolve(ok);
      };
      const onDrain = () => done(true);
      const onClose = () => done(false);
      const timer = setTimeout(() => done(false), limits.keepaliveMs);
      res.on('drain', onDrain);
      closed.addEventListener('abort', onClose, { once: true });
    });
  try {
    batch(first);
    let cursor = first.cursor;
    let more = first.has_more;
    while (open()) {
      if (!(await drained())) {
        if (open()) {
          reply.log.info({ buffered: res.writableLength }, 'event stream ended: the client stopped reading');
          res.destroy();
        }
        break;
      }
      if (since(opened, limits.lifetimeMs)) break;
      // A ping is decided by the time since the last write alone, whatever ended the wait: wake-ups for changes
      // outside this stream's scope and slow reads must not starve it. Like a batch, it follows a fresh check.
      const ping = since(lastWrite, limits.keepaliveMs);
      if ((ping || since(checked, limits.keepaliveMs)) && !(await allowed())) break;
      if (ping) write(SSE_PING);
      const tick = new AbortController();
      // Until a change, or until the next ping, check or the end of the lifetime is due.
      const due = Math.min(lastWrite, checked) + limits.keepaliveMs;
      const changed = more
        ? null
        : hub.wait(
            userId,
            Math.max(0, Math.min(due, opened + limits.lifetimeMs) - Date.now()),
            AbortSignal.any([closed, tick.signal]),
          );
      const out = await read(cursor);
      if (out.events.length) {
        if (!(await allowed())) {
          tick.abort();
          break;
        }
        batch(out);
      }
      cursor = out.cursor;
      more = out.has_more;
      if (!changed) continue;
      if (out.events.length || more) tick.abort();
      else await changed;
    }
  } catch (err) {
    if (err instanceof AgentDropError && err.code === 'RESYNC_REQUIRED')
      write('event: resync\ndata: {"code":"RESYNC_REQUIRED"}\n\n');
    else reply.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'event stream ended');
  } finally {
    // A stream ended by the server closing also gives up its keep-alive connection once the last bytes are out;
    // the server closes idle connections only when the close begins, and this one was busy then.
    const socket = res.socket;
    if (hub.stopped.aborted && socket) res.end(() => socket.end());
    else res.end();
  }
}

/** Query strings arrive as strings; coerce the few numeric/boolean fields the list/directory schemas expect. */
function coerceQuery(query: unknown): Record<string, unknown> {
  const q = { ...(query as Record<string, string | undefined>) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === '') continue;
    if (k === 'limit' || k === 'offset' || k === 'max_chars' || k === 'wait') out[k] = Number(v);
    else if (k === 'unread_only' || k === 'include_group_history') out[k] = v === 'true' || v === '1';
    else out[k] = v;
  }
  return out;
}
