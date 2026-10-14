import { appUsers, auditEvents, authUsers, authVerifications } from '@agentdrop/db';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { redactLoggedUrl } from './app.js';
import type { Mailer, MailMessage } from './mail.js';
import {
  type BrowserUser,
  createTestApp,
  extractCookies,
  signUp,
  TEST_DATABASE_URL,
  type TestApp,
} from './testing/harness.js';

const PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'a-brand-new-password-42';

function stubMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

async function waitFor<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function tokenOf(link: string): string {
  const url = new URL(link);
  expect(url.origin).toBe('http://web.test');
  expect(url.pathname).toBe('/reset-password');
  const token = url.searchParams.get('token');
  if (!token) throw new Error('no token in link');
  return token;
}

function helpers(getT: () => TestApp) {
  const t = () => getT();
  return {
    requestReset: (email: string, remoteAddress = '10.0.0.1') =>
      t().app.inject({
        method: 'POST',
        url: '/api/auth/request-password-reset',
        headers: { origin: t().origin },
        payload: { email },
        remoteAddress,
      }),
    resetPassword: (token: string, newPassword = NEW_PASSWORD) =>
      t().app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        headers: { origin: t().origin },
        payload: { token, newPassword },
      }),
    signIn: (email: string, password: string) =>
      t().app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { origin: t().origin },
        payload: { email, password },
      }),
    me: (u: { cookie: string }) =>
      t().app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: u.cookie, origin: t().origin } }),
  };
}

describe('request log redaction', () => {
  it('never keeps a token query value in logged urls', () => {
    expect(redactLoggedUrl('/reset-password?token=abc123&x=1')).toBe('/reset-password?token=[redacted]&x=1');
    expect(redactLoggedUrl('/a?b=1&token=zz')).toBe('/a?b=1&token=[redacted]');
    expect(redactLoggedUrl('/v1/h/drops?view=inbox&query=%E5%AE%9E%E9%AA%8C&limit=50')).toBe(
      '/v1/h/drops?view=inbox&query=[redacted]&limit=50',
    );
    expect(redactLoggedUrl('/v1/me')).toBe('/v1/me');
  });
});

describe.skipIf(!TEST_DATABASE_URL)('password reset by email', () => {
  let t: TestApp;
  const mailer = stubMailer();
  const h = helpers(() => t);
  let alice: BrowserUser;

  beforeAll(async () => {
    t = await createTestApp({ mailer });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    mailer.sent.length = 0;
    alice = await signUp(t, 'alice', 'Alice');
  });

  it('tells the sign-in page that reset works by email', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/auth/signup-policy' });
    expect(res.json()).toMatchObject({ mode: 'open', password_reset: 'email' });
  });

  it('mails a one-hour, single-use link that ends old sessions and replaces the password', async () => {
    expect((await h.me(alice)).statusCode).toBe(200);
    const req = await h.requestReset(alice.email, '10.0.1.1');
    expect(req.statusCode, req.body).toBe(200);
    const mail = await waitFor(() => mailer.sent[0]);
    expect(mail.to).toBe(alice.email);
    expect(mail.text).not.toContain(PASSWORD);
    const link = mail.text.split('\n').find((l) => l.startsWith('http'));
    if (!link) throw new Error('no link in mail');
    const token = tokenOf(link);

    // stored with a one-hour expiry
    const [row] = await t.db.drizzle
      .select()
      .from(authVerifications)
      .where(eq(authVerifications.identifier, `reset-password:${token}`));
    const ttl = (row?.expiresAt.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(55 * 60_000);
    expect(ttl).toBeLessThanOrEqual(60 * 60_000 + 5_000);

    const tooShort = await h.resetPassword(token, 'short');
    expect(tooShort.statusCode).toBe(400);

    const done = await h.resetPassword(token);
    expect(done.statusCode, done.body).toBe(200);

    // the old browser session is gone
    expect((await h.me(alice)).statusCode).toBe(401);
    expect((await h.signIn(alice.email, PASSWORD)).statusCode).toBe(401);
    const fresh = await h.signIn(alice.email, NEW_PASSWORD);
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect((await h.me({ cookie: extractCookies(fresh.headers['set-cookie']) })).statusCode).toBe(200);

    // single use
    const again = await h.resetPassword(token, 'yet-another-password-1');
    expect(again.statusCode).toBe(400);
  });

  it('refuses an expired link', async () => {
    await h.requestReset(alice.email, '10.0.2.1');
    const mail = await waitFor(() => mailer.sent[0]);
    const token = tokenOf(mail.text.split('\n').find((l) => l.startsWith('http')) ?? '');
    await t.db.drizzle
      .update(authVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authVerifications.identifier, `reset-password:${token}`));
    expect((await h.resetPassword(token)).statusCode).toBe(400);
    expect((await h.signIn(alice.email, PASSWORD)).statusCode).toBe(200);
  });

  it('answers an unknown address exactly like a known one and mails nothing', async () => {
    const known = await h.requestReset(alice.email, '10.0.3.1');
    const unknown = await h.requestReset('nobody@example.test', '10.0.3.1');
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);
    await waitFor(() => mailer.sent[0]);
    await new Promise((r) => setTimeout(r, 50));
    expect(mailer.sent.map((m) => m.to)).toEqual([alice.email]);
  });

  it('does not mail closed or built-in accounts', async () => {
    const bob = await signUp(t, 'bob', 'Bob');
    await t.db.drizzle.update(appUsers).set({ isSystem: true }).where(eq(appUsers.id, bob.userId));
    expect((await h.requestReset(bob.email, '10.0.4.1')).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(mailer.sent).toHaveLength(0);
  });

  it('rate-limits reset requests per email and per address', async () => {
    for (let i = 0; i < 3; i++)
      expect((await h.requestReset(alice.email, `10.0.5.${i + 1}`)).statusCode).toBe(200);
    const perEmail = await h.requestReset(alice.email, '10.0.5.9');
    expect(perEmail.statusCode).toBe(429);
    expect(perEmail.json().code).toBe('RATE_LIMITED');

    for (let i = 0; i < 10; i++)
      expect((await h.requestReset(`someone${i}@example.test`, '10.0.6.1')).statusCode).toBe(200);
    expect((await h.requestReset('someone-else@example.test', '10.0.6.1')).statusCode).toBe(429);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('password reset without SMTP', () => {
  let t: TestApp;
  const h = helpers(() => t);
  let root: BrowserUser;
  let alice: BrowserUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    root = await signUp(t, 'root_op', '运营');
    alice = await signUp(t, 'alice', 'Alice');
    await t.db.drizzle.update(appUsers).set({ isAdmin: true }).where(eq(appUsers.id, root.userId));
  });

  const resetLink = (by: BrowserUser, userId: string) =>
    t.app.inject({
      method: 'POST',
      url: `/v1/admin/users/${userId}/password-reset-link`,
      headers: { cookie: by.cookie, origin: t.origin },
      payload: {},
    });

  it('points people to an administrator and refuses email requests', async () => {
    const policy = await t.app.inject({ method: 'GET', url: '/v1/auth/signup-policy' });
    expect(policy.json()).toMatchObject({ password_reset: 'admin' });
    const req = await h.requestReset(alice.email);
    expect(req.statusCode).toBe(403);
    const rows = await t.db.drizzle
      .select()
      .from(authVerifications)
      .where(like(authVerifications.identifier, 'reset-password:%'));
    expect(rows).toHaveLength(0);
  });

  it('lets an administrator generate a one-time link, audited without the token', async () => {
    const first = await resetLink(root, alice.userId);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const firstToken = tokenOf(first.json().url);
    expect(Date.parse(first.json().expires_at)).toBeGreaterThan(Date.now() + 55 * 60_000);

    // a newer link retires the older one
    const second = await resetLink(root, alice.userId);
    const token = tokenOf(second.json().url);
    expect((await h.resetPassword(firstToken)).statusCode).toBe(400);

    const audit = await t.db.drizzle
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'admin.password_reset_link'));
    expect(audit).toHaveLength(2);
    expect(audit[0]?.actorUserId).toBe(root.userId);
    expect(audit[0]?.targetId).toBe(alice.userId);
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain(token);
    expect(auditText).not.toContain(firstToken);

    expect((await h.resetPassword(token)).statusCode).toBe(200);
    expect((await h.me(alice)).statusCode).toBe(401);
    expect((await h.signIn(alice.email, NEW_PASSWORD)).statusCode).toBe(200);
    expect((await h.resetPassword(token, 'another-password-99')).statusCode).toBe(400);
  });

  it('is for administrators only and refuses closed and built-in accounts', async () => {
    const denied = await resetLink(alice, root.userId);
    expect(denied.statusCode).toBe(403);

    const bob = await signUp(t, 'bob', 'Bob');
    await t.db.drizzle.update(appUsers).set({ isSystem: true }).where(eq(appUsers.id, bob.userId));
    expect((await resetLink(root, bob.userId)).statusCode).toBe(403);

    const carol = await signUp(t, 'carol', 'Carol');
    const close = await t.app.inject({
      method: 'POST',
      url: `/v1/admin/users/${carol.userId}/close`,
      headers: { cookie: root.cookie, origin: t.origin },
      payload: { confirm_handle: 'carol' },
    });
    expect(close.statusCode, close.body).toBe(200);
    expect((await resetLink(root, carol.userId)).statusCode).toBe(400);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('Better Auth proxy', () => {
  let t: TestApp;
  const h = helpers(() => t);

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  it('refuses Better Auth sign-up and other unused endpoints', async () => {
    const email = 'sneaky@example.test';
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: t.origin },
      payload: { email, password: PASSWORD, name: 'Sneaky' },
    });
    expect(res.statusCode).toBe(404);
    expect(await t.db.drizzle.select().from(authUsers).where(eq(authUsers.email, email))).toHaveLength(0);

    for (const [method, url] of [
      ['POST', '/api/auth/update-user'],
      ['POST', '/api/auth/change-email'],
      ['POST', '/api/auth/sign-in/social'],
      ['GET', '/api/auth/reset-password/sometoken?callbackURL=/'],
    ] as const) {
      const r = await t.app.inject({ method, url, headers: { origin: t.origin }, payload: {} });
      expect(r.statusCode, url).toBe(404);
    }
  });

  it('still signs in, reads the session and signs out', async () => {
    const alice = await signUp(t, 'alice', 'Alice');
    const signIn = await h.signIn(alice.email, PASSWORD);
    expect(signIn.statusCode, signIn.body).toBe(200);
    const cookie = extractCookies(signIn.headers['set-cookie']);
    const session = await t.app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json().user.email).toBe(alice.email);
    const out = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie, origin: t.origin },
      payload: {},
    });
    expect(out.statusCode).toBe(200);
    expect((await h.me({ cookie })).statusCode).toBe(401);
  });
});
