import { AgentDropError, displayNameSchema, z } from '@agentdrop/contracts';
import { authUsers, withTx } from '@agentdrop/db';
import {
  acceptInviteLink,
  ensureAppUser,
  getSignupSetting,
  getUserByHandle,
  redeemRecoveryCode,
  validateHandle,
} from '@agentdrop/domain';
import { isAPIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authHeaders } from '../auth.js';
import type { AppContext } from '../context.js';
import { createIpLimiter, createKeyLimiter } from '../plugins/principals.js';
import { parse } from '../plugins/validate.js';
import { issueResetLink } from '../reset-link.js';

const signUpSchema = z
  .object({
    email: z.email(),
    password: z.string().min(10).max(256),
    handle: z.string().min(1).max(64),
    display_name: displayNameSchema,
    /** Optional contact invite link token: the inviter's contact request waits for the new account (ADR 0014). */
    invite_token: z.string().min(1).max(256).optional(),
  })
  .strict();

/**
 * The only Better Auth endpoints the dashboard uses. Everything else answers 404: Better Auth's own
 * /sign-up/email would bypass SIGNUP_MODE and create a login without an app_users profile, and the rest
 * (update-user, change-email, social sign-in, ...) has no product behind it.
 */
const AUTH_PROXY_ALLOWED = new Set([
  'POST /api/auth/sign-in/email',
  'POST /api/auth/sign-out',
  'GET /api/auth/get-session',
  'POST /api/auth/request-password-reset',
  'POST /api/auth/reset-password',
]);

/** Reset requests per address and per email; Better Auth's own limiter is per process and off in tests. */
const RESET_REQUESTS_PER_IP_PER_HOUR = 10;
const RESET_REQUESTS_PER_EMAIL_PER_HOUR = 3;
/** Recovery-code attempts: a code has ~60 bits, so these only slow down a careless script. */
const RECOVERY_ATTEMPTS_PER_IP_PER_HOUR = 20;
const RECOVERY_ATTEMPTS_PER_EMAIL_PER_HOUR = 5;

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const resetIpLimiter = createIpLimiter(ctx, {
    name: 'reset-ip',
    windowMs: 3_600_000,
    max: RESET_REQUESTS_PER_IP_PER_HOUR,
  });
  const resetEmailLimiter = createKeyLimiter(ctx, {
    name: 'reset-email',
    windowMs: 3_600_000,
    max: RESET_REQUESTS_PER_EMAIL_PER_HOUR,
    key: (req) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      return typeof email === 'string' ? `reset:${email.trim().toLowerCase()}` : `reset-ip:${req.ip}`;
    },
  });

  // Better Auth handles sign-in, sign-out, session and password reset under /api/auth/*
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const url = new URL(req.url, ctx.config.PUBLIC_BASE_URL);
      if (!AUTH_PROXY_ALLOWED.has(`${req.method} ${url.pathname}`))
        throw new AgentDropError('NOT_FOUND', 'route not found');
      if (url.pathname === '/api/auth/request-password-reset') {
        // without SMTP nothing could be delivered; the dashboard points people to an administrator instead
        if (!ctx.mailer)
          throw new AgentDropError(
            'FORBIDDEN',
            'this server does not send email; ask an administrator for a password reset link',
          );
        await resetIpLimiter(req);
        await resetEmailLimiter(req);
      }
      const headers = authHeaders(req);
      const init: RequestInit = { method: req.method, headers };
      if (req.body !== undefined && req.body !== null && req.method !== 'GET')
        init.body = JSON.stringify(req.body);
      const response = await ctx.auth.handler(new Request(url.toString(), init));
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') reply.header('set-cookie', response.headers.getSetCookie());
        else reply.header(key, value);
      });
      return reply.send(response.body ? await response.text() : null);
    },
  });

  /*
   * A recovery code instead of email (ADR 0036): the account email plus one unused code from the person's set
   * returns a one-time reset link. Every failure answers alike, so it says nothing about which accounts exist;
   * attempts are limited per address and per email.
   */
  const recoverIpLimiter = createIpLimiter(ctx, {
    name: 'recover-ip',
    windowMs: 3_600_000,
    max: RECOVERY_ATTEMPTS_PER_IP_PER_HOUR,
  });
  const recoverEmailLimiter = createKeyLimiter(ctx, {
    name: 'recover-email',
    windowMs: 3_600_000,
    max: RECOVERY_ATTEMPTS_PER_EMAIL_PER_HOUR,
    key: (req) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      return typeof email === 'string' ? `recover:${email.trim().toLowerCase()}` : `recover-ip:${req.ip}`;
    },
  });
  app.post('/v1/auth/recover-with-code', async (req, reply) => {
    await recoverIpLimiter(req);
    await recoverEmailLimiter(req);
    const body = parse(
      z.object({ email: z.string().min(3).max(320), code: z.string().min(1).max(64) }).strict(),
      req.body,
    );
    const target = await withTx(ctx.db, (tx) => redeemRecoveryCode(tx, body.email, body.code));
    reply.header('Cache-Control', 'no-store');
    return issueResetLink(ctx, target);
  });

  /**
   * Sign-up with an application handle. The handle is reserved in app_users before the auth user is created so
   * two people cannot race for the same handle; on failure the auth user is removed again.
   */
  /** Public: the sign-up page reads this before showing the form, so a closed server says so instead of 403-ing. */
  app.get('/v1/auth/signup-policy', async () => {
    const setting = await getSignupSetting(ctx.db.drizzle, ctx.config.SIGNUP_MODE);
    // how a forgotten password is recovered here: by email, or through a link an administrator hands over
    return {
      mode: setting.mode,
      password_reset: ctx.mailer ? 'email' : 'admin',
      recovery: ['device', 'code'],
    };
  });

  app.post('/v1/auth/sign-up', async (req, reply) => {
    const body = parse(signUpSchema, req.body);
    const setting = await getSignupSetting(ctx.db.drizzle, ctx.config.SIGNUP_MODE);
    if (setting.mode === 'closed')
      throw new AgentDropError('SIGNUP_DISABLED', 'sign-up is closed on this server');
    const handle = validateHandle(body.handle);
    if (await getUserByHandle(ctx.db.drizzle, handle)) {
      throw new AgentDropError('VALIDATION_FAILED', 'handle already taken', { field: 'handle' });
    }
    const res = await ctx.auth.api
      .signUpEmail({
        body: { email: body.email, password: body.password, name: body.display_name },
        headers: authHeaders(req),
        returnHeaders: true,
      })
      .catch((err: unknown) => {
        if (
          isAPIError(err) &&
          ['USER_ALREADY_EXISTS', 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'].includes(err.body?.code ?? '')
        ) {
          throw new AgentDropError('VALIDATION_FAILED', 'email already registered', {
            field: 'email',
            reason: 'already_registered',
          });
        }
        throw err;
      });
    const authUserId = res.response.user.id;
    try {
      await withTx(ctx.db, (tx) => ensureAppUser(tx, { authUserId, handle, displayName: body.display_name }));
    } catch (err) {
      // compensate: the auth user exists but the profile could not be created (e.g. a concurrent same-handle
      // sign-up won). We own the auth tables, so delete the row directly (sessions/accounts cascade).
      try {
        await ctx.db.drizzle.delete(authUsers).where(eq(authUsers.id, authUserId));
      } catch (cleanupErr) {
        req.log.error({ err: cleanupErr, authUserId }, 'sign-up compensation failed: orphaned auth user');
      }
      throw err;
    }
    const cookies = res.headers.getSetCookie();
    if (cookies.length > 0) reply.header('set-cookie', cookies);
    const userId = (await getUserByHandle(ctx.db.drizzle, handle))?.id;
    // a dead or foreign invite link never fails the sign-up; the page is told and can explain it
    // A new account has no agent yet (ADR 0014), so a live link normally leaves the inviter's contact request
    // waiting (`pending`); the first pairing accepts it (ADR 0034).
    let invite: { accepted: boolean; pending?: boolean; inviter_handle?: string; code?: string } | undefined;
    if (body.invite_token && userId) {
      const token = body.invite_token;
      try {
        const out = await withTx(ctx.db, (tx) => acceptInviteLink(tx, userId, token));
        invite = out.pending
          ? { accepted: false, pending: true, inviter_handle: out.contact.handle }
          : { accepted: true, inviter_handle: out.contact.handle };
      } catch (err) {
        if (!(err instanceof AgentDropError)) req.log.error({ err }, 'invite link on sign-up failed');
        invite = { accepted: false, code: err instanceof AgentDropError ? err.code : 'INTERNAL' };
      }
    }
    return reply.status(201).send({ user_id: userId, handle, ...(invite ? { invite } : {}) });
  });
}
