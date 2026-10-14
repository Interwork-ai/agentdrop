import { AsyncLocalStorage } from 'node:async_hooks';
import {
  appUsers,
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  type Database,
} from '@agentdrop/db';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import { type Mailer, passwordResetMail } from './mail.js';

/**
 * The one header Better Auth reads a client address from. Its own default (`X-Forwarded-For`) is whatever the client
 * sends unless a proxy overwrites it, so a forged header would give every sign-in attempt a fresh address and slip
 * past the per-address sign-in limit. The server sets this header itself from Fastify's `req.ip`, which honours
 * forwarding headers only with TRUST_PROXY.
 */
export const CLIENT_IP_HEADER = 'x-agentdrop-client-ip';

/** Request headers for any Better Auth call: the client's own, with the client address the server determined. */
export function authHeaders(req: FastifyRequest): Headers {
  const headers = fromNodeHeaders(req.headers);
  headers.delete(CLIENT_IP_HEADER);
  headers.set(CLIENT_IP_HEADER, req.ip);
  return headers;
}

/** Reset links live one hour. */
export const PASSWORD_RESET_TTL_S = 60 * 60;

/**
 * Set while an administrator generates a reset link: Better Auth's sendResetPassword callback then hands the link
 * back to that request instead of mailing it. Outside such a scope the callback mails (or, without SMTP, drops) it.
 */
export const resetLinkCapture = new AsyncLocalStorage<{ link?: string }>();

export interface AuthOptions {
  /** null/undefined: no email is sent; password reset then works only through admin-generated links. */
  mailer?: Mailer | null;
  /** Mail delivery failures. Receives no address, link or token. */
  onMailError?: (err: unknown) => void;
}

/** The dashboard page that sets the new password (same base as the pairing page link). */
export function resetPageUrl(config: AppConfig, token: string): string {
  const base = config.WEB_ORIGIN ?? config.PUBLIC_BASE_URL;
  const url = new URL('/reset-password', base);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Web login uses Better Auth (email + password). Its tables stay separate from
 * the domain tables; the application profile (handle, nickname) lives in app_users and is created by our
 * own sign-up route so handle uniqueness is enforced before an auth user exists.
 */
export function createAuth(config: AppConfig, db: Database, opts: AuthOptions = {}) {
  const mailer = opts.mailer ?? null;
  const onMailError =
    opts.onMailError ??
    ((err: unknown) =>
      console.warn(
        '[agentdrop-api] password reset mail failed',
        err instanceof Error ? ((err as { code?: string }).code ?? err.name) : 'unknown',
      ));
  const trusted = [config.PUBLIC_BASE_URL, config.WEB_ORIGIN].filter((v): v is string => Boolean(v));
  return betterAuth({
    baseURL: config.PUBLIC_BASE_URL,
    basePath: '/api/auth',
    secret: config.AUTH_SECRET,
    database: drizzleAdapter(db.drizzle, {
      provider: 'pg',
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 256,
      resetPasswordTokenExpiresIn: PASSWORD_RESET_TTL_S,
      // a reset ends every browser session of that account (agent credentials are separate and unaffected)
      revokeSessionsOnPasswordReset: true,
      // Better Auth's own url points at its GET redirect endpoint; the dashboard page takes the token directly.
      // Neither the link nor the token is ever logged.
      sendResetPassword: async ({ user, token }) => {
        const link = resetPageUrl(config, token);
        const capture = resetLinkCapture.getStore();
        if (capture) {
          capture.link = link;
          return;
        }
        if (!mailer) return;
        // not awaited: an existing address must not answer measurably slower than an unknown one
        void (async () => {
          const profile = await db.drizzle.query.appUsers.findFirst({
            where: eq(appUsers.authUserId, user.id),
          });
          // closed and built-in accounts never get reset mail
          if (!profile || profile.deletedAt || profile.isSystem) return;
          await mailer.send(passwordResetMail(user.email, link));
        })().catch(onMailError);
      },
    },
    trustedOrigins: trusted,
    session: {
      // 60 days, renewed once a day while in use: someone who uses the dashboard stays signed in (ADR 0036)
      expiresIn: 60 * 60 * 24 * 60,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: { enabled: config.NODE_ENV !== 'test', window: 60, max: 60 },
    advanced: {
      // only the address the server put there (authHeaders), never one the client wrote
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      cookiePrefix: 'agentdrop',
      // any https public origin gets Secure cookies, not only NODE_ENV=production (a deployment may run as development behind https)
      useSecureCookies: config.NODE_ENV === 'production' || config.PUBLIC_BASE_URL.startsWith('https://'),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
