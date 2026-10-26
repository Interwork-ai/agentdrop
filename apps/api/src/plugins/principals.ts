import { AgentDropError } from '@agentdrop/contracts';
import {
  type AuthenticatedH,
  authenticateHCredential,
  consumeRateLimit,
  getUserByAuthId,
  type HPrincipal,
  rateLimitKeyHasher,
  type UserPrincipal,
} from '@agentdrop/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authHeaders } from '../auth.js';
import type { AppContext } from '../context.js';

declare module 'fastify' {
  interface FastifyRequest {
    hAuth?: AuthenticatedH;
    userPrincipal?: UserPrincipal;
  }
}

/** Pre-handler: requires a valid H credential. The scope is fixed by the credential, never by the request. */
export function requireH(ctx: AppContext) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
    req.hAuth = await authenticateHCredential(ctx.db.drizzle, bearer);
  };
}

export function hPrincipalOf(req: FastifyRequest): HPrincipal {
  if (!req.hAuth) throw new AgentDropError('UNAUTHORIZED');
  return req.hAuth.principal;
}

function allowedOrigins(ctx: AppContext): Set<string> {
  const set = new Set<string>();
  for (const u of [ctx.config.PUBLIC_BASE_URL, ctx.config.WEB_ORIGIN]) {
    if (u) set.add(new URL(u).origin);
  }
  return set;
}

/**
 * Pre-handler: requires a browser session (Better Auth cookie) and, for state-changing methods, a same-origin
 * request (Origin header or Fetch Metadata). Admin abilities never flow from an H credential.
 */
export function requireUser(ctx: AppContext) {
  const origins = allowedOrigins(ctx);
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      // fail closed: a trusted Origin, or (no Origin but) explicit same-origin fetch metadata. Requests with neither
      // header are rejected; the CLI/bridge never uses cookies so nothing legitimate is lost.
      const ok = (origin && origins.has(origin)) || (!origin && site === 'same-origin');
      if (!ok) throw new AgentDropError('FORBIDDEN', 'cross-site request rejected');
    }
    const session = await ctx.auth.api.getSession({ headers: authHeaders(req) });
    if (!session) throw new AgentDropError('UNAUTHORIZED', 'sign in required');
    const user = await getUserByAuthId(ctx.db.drizzle, session.user.id);
    // the built-in assistant has no password, but refuse a session for it even if one were ever minted
    if (!user || user.isSystem) throw new AgentDropError('UNAUTHORIZED', 'profile incomplete');
    // a suspended or closed account keeps nothing: neither the dashboard nor any admin ability
    if (user.deletedAt) throw new AgentDropError('UNAUTHORIZED', 'this account was closed');
    if (user.suspendedAt)
      throw new AgentDropError(
        'ACCOUNT_SUSPENDED',
        user.suspendedReason ? `account suspended: ${user.suspendedReason}` : 'account suspended',
      );
    req.userPrincipal = { kind: 'user', userId: user.id, authUserId: user.authUserId, isAdmin: user.isAdmin };
  };
}

/**
 * Pre-handler for the operator console. Runs after `requireUser`, so it inherits the browser-session and
 * same-origin requirements: an H credential can never reach an admin route, whatever scopes it carries.
 */
export function requireAdmin() {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const p = req.userPrincipal;
    if (!p) throw new AgentDropError('UNAUTHORIZED', 'sign in required');
    if (!p.isAdmin) throw new AgentDropError('FORBIDDEN', 'administrator only');
  };
}

export function userPrincipalOf(req: FastifyRequest): UserPrincipal {
  if (!req.userPrincipal) throw new AgentDropError('UNAUTHORIZED');
  return req.userPrincipal;
}

/** A fixed-window limit per client address (pairing, invite previews, password reset). */
export function createIpLimiter(ctx: AppContext, opts: { name: string; windowMs: number; max: number }) {
  return createKeyLimiter(ctx, { ...opts, key: (req) => req.ip });
}

/**
 * The same window, keyed by whatever identifies the caller. Authenticated bulk routes want the account, not the
 * address: per-IP both punishes everyone behind one NAT and is sidestepped by moving the same credential to a
 * second address. Counted in the shared `rate_limits` table, so every API process enforces one limit; `name` keeps
 * one limiter's keys apart from another's. Only a keyed hash of name and key is stored (`rateLimitKeyHasher`).
 */
export function createKeyLimiter(
  ctx: AppContext,
  opts: { name: string; windowMs: number; max: number; key: (req: FastifyRequest) => string },
) {
  const hash = rateLimitKeyHasher(ctx.config.AUTH_SECRET);
  return async (req: FastifyRequest): Promise<void> => {
    const { allowed } = await consumeRateLimit(
      ctx.db.drizzle,
      hash(opts.name, opts.key(req)),
      opts.windowMs,
      opts.max,
    );
    if (!allowed) throw new AgentDropError('RATE_LIMITED');
  };
}
