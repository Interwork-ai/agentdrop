import { accountRecoveryCodes, appUsers, auditEvents, authSessions, hCredentials } from '@agentdrop/db';
import { normalizeRecoveryCode } from '@agentdrop/domain';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type BrowserUser,
  createTestApp,
  hHeaders,
  type PairedEndpoint,
  pair,
  signUp,
  TEST_DATABASE_URL,
  type TestApp,
} from './testing/harness.js';

/*
 * Getting back into an account without email or an administrator (ADR 0036): a reset link from a paired device,
 * or from one of the person's recovery codes. Both end in the ordinary one-time reset link.
 */

const PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'a-brand-new-password-42';

describe('recovery code format', () => {
  it('reads case, spaces, dashes and look-alike letters forgivingly, and nothing else', () => {
    expect(normalizeRecoveryCode('K7M2-Q9XA-3FPW')).toBe('k7m2q9xa3fpw');
    expect(normalizeRecoveryCode(' k7m2 q9xa 3fpw ')).toBe('k7m2q9xa3fpw');
    // o reads as 0, i and l as 1
    expect(normalizeRecoveryCode('k7m2-q9xa-3fpo')).toBe('k7m2q9xa3fp0');
    expect(normalizeRecoveryCode('i7m2-q9xa-3fpl')).toBe('17m2q9xa3fp1');
    // u is not in the alphabet; wrong lengths are no code
    expect(normalizeRecoveryCode('u7m2-q9xa-3fpw')).toBeNull();
    expect(normalizeRecoveryCode('k7m2-q9xa')).toBeNull();
    expect(normalizeRecoveryCode('')).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('account recovery (ADR 0036)', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let aliceH: PairedEndpoint;

  const browser = (u: BrowserUser) => ({ cookie: u.cookie, origin: t.origin });
  const deviceLink = (ep: PairedEndpoint, remoteAddress = '10.0.0.1') =>
    t.app.inject({
      method: 'POST',
      url: '/v1/h/account/recovery-link',
      headers: hHeaders(ep.credential),
      payload: {},
      remoteAddress,
    });
  const resetPassword = (token: string, newPassword = NEW_PASSWORD) =>
    t.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      headers: { origin: t.origin },
      payload: { token, newPassword },
    });
  const signIn = (email: string, password: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: t.origin },
      payload: { email, password },
    });
  const me = (u: BrowserUser) => t.app.inject({ method: 'GET', url: '/v1/me', headers: browser(u) });
  const status = (u: BrowserUser) =>
    t.app.inject({ method: 'GET', url: '/v1/me/recovery-codes', headers: browser(u) });
  const generate = (u: BrowserUser, password = PASSWORD) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/me/recovery-codes',
      headers: browser(u),
      payload: { password },
    });
  const redeem = (email: string, code: string, remoteAddress = '10.0.0.2') =>
    t.app.inject({
      method: 'POST',
      url: '/v1/auth/recover-with-code',
      headers: { origin: t.origin },
      payload: { email, code },
      remoteAddress,
    });
  const tokenOf = (url: string) => {
    const u = new URL(url);
    expect(u.pathname).toBe('/reset-password');
    const token = u.searchParams.get('token');
    if (!token) throw new Error('no token');
    return token;
  };
  const auditOf = (action: string) =>
    t.db.drizzle.select().from(auditEvents).where(eq(auditEvents.action, action));

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice', 'Alice');
    bob = await signUp(t, 'bob', 'Bob');
    aliceH = await pair(t, alice, { harness: 'codex', endpointLabel: 'Desk agent' });
  });

  describe('from a paired device', () => {
    it('gives a one-time link that replaces the password and ends web sessions; agents keep working', async () => {
      const res = await deviceLink(aliceH);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { url, expires_at } = res.json() as { url: string; expires_at: string };
      const ttl = new Date(expires_at).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(55 * 60_000);
      expect(ttl).toBeLessThanOrEqual(60 * 60_000 + 5_000);

      const done = await resetPassword(tokenOf(url));
      expect(done.statusCode, done.body).toBe(200);
      expect((await me(alice)).statusCode).toBe(401);
      expect((await signIn(alice.email, PASSWORD)).statusCode).toBe(401);
      expect((await signIn(alice.email, NEW_PASSWORD)).statusCode).toBe(200);
      // the agent's credential is not a web session
      const identity = await t.app.inject({
        method: 'GET',
        url: '/v1/h/identity',
        headers: hHeaders(aliceH.credential),
      });
      expect(identity.statusCode).toBe(200);
      // single use
      expect((await resetPassword(tokenOf(url), 'yet-another-password-1')).statusCode).toBe(400);
    });

    it('audits who asked from which agent, never the link', async () => {
      const res = await deviceLink(aliceH);
      const [entry] = await auditOf('account.recovery_link');
      expect(entry).toMatchObject({ actorUserId: alice.userId, hId: aliceH.hId, result: 'ok' });
      expect(entry?.meta).toEqual({ via: 'device' });
      expect(JSON.stringify(entry)).not.toContain(tokenOf(res.json().url));
    });

    it('a newer link retires the older one', async () => {
      const first = tokenOf((await deviceLink(aliceH)).json().url);
      const second = tokenOf((await deviceLink(aliceH)).json().url);
      expect((await resetPassword(first)).statusCode).toBe(400);
      expect((await resetPassword(second)).statusCode).toBe(200);
    });

    it('needs a valid agent credential: none, a browser session or a revoked one are refused', async () => {
      const none = await t.app.inject({ method: 'POST', url: '/v1/h/account/recovery-link', payload: {} });
      expect(none.statusCode).toBe(401);
      const session = await t.app.inject({
        method: 'POST',
        url: '/v1/h/account/recovery-link',
        headers: browser(alice),
        payload: {},
      });
      expect(session.statusCode).toBe(401);
      await t.db.drizzle
        .update(hCredentials)
        .set({ revokedAt: new Date() })
        .where(eq(hCredentials.hId, aliceH.hId));
      expect((await deviceLink(aliceH)).statusCode).toBe(401);
    });

    it('is refused for a suspended account', async () => {
      await t.db.drizzle
        .update(appUsers)
        .set({ suspendedAt: new Date() })
        .where(eq(appUsers.id, alice.userId));
      const res = await deviceLink(aliceH);
      expect(res.statusCode).not.toBe(200);
      expect(res.body).not.toContain('reset-password');
    });

    it('allows a few links per hour per account', async () => {
      for (let i = 0; i < 5; i++) expect((await deviceLink(aliceH, `10.1.0.${i}`)).statusCode).toBe(200);
      const sixth = await deviceLink(aliceH, '10.1.0.9');
      expect(sixth.statusCode).toBe(429);
    });
  });

  describe('recovery codes', () => {
    async function codesFor(u: BrowserUser): Promise<string[]> {
      const res = await generate(u);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().codes as string[];
    }

    it('are generated only with the current password, shown once, and stored as hashes', async () => {
      expect((await status(alice)).json()).toEqual({ remaining: 0, total: 0, created_at: null });
      const wrong = await generate(alice, 'not-my-password');
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().details).toMatchObject({ field: 'password', reason: 'password_incorrect' });
      expect(await t.db.drizzle.select().from(accountRecoveryCodes)).toHaveLength(0);

      const res = await generate(alice);
      expect(res.headers['cache-control']).toBe('no-store');
      const codes = res.json().codes as string[];
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      for (const c of codes)
        expect(c).toMatch(/^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/);
      expect(res.json().status).toMatchObject({ remaining: 10, total: 10 });

      const rows = await t.db.drizzle.select().from(accountRecoveryCodes);
      const stored = JSON.stringify(rows);
      for (const c of codes) {
        expect(stored).not.toContain(c);
        expect(stored).not.toContain(c.replace(/-/g, ''));
      }
      const [audit] = await auditOf('account.recovery_codes_generated');
      expect(audit).toMatchObject({ actorUserId: alice.userId, meta: { count: 10 } });
      expect(JSON.stringify(audit)).not.toContain(codes[0]);
      // the status never repeats them
      expect((await status(alice)).body).not.toContain(codes[0]);
    });

    it('need a signed-in browser from this site: no cookie or another origin is refused', async () => {
      const anonymous = await t.app.inject({
        method: 'POST',
        url: '/v1/me/recovery-codes',
        headers: { origin: t.origin },
        payload: { password: PASSWORD },
      });
      expect(anonymous.statusCode).toBe(401);
      const crossSite = await t.app.inject({
        method: 'POST',
        url: '/v1/me/recovery-codes',
        headers: { cookie: alice.cookie, origin: 'https://evil.test' },
        payload: { password: PASSWORD },
      });
      expect(crossSite.statusCode).toBe(403);
      // an agent credential cannot make them either
      const agent = await t.app.inject({
        method: 'POST',
        url: '/v1/me/recovery-codes',
        headers: hHeaders(aliceH.credential),
        payload: { password: PASSWORD },
      });
      // refused before any session is looked at: it is not a same-origin browser request
      expect(agent.statusCode).toBe(403);
    });

    it('one code with the email gives a reset link, works once, and leaves the others valid', async () => {
      const [first, second] = await codesFor(alice);
      if (!first || !second) throw new Error('no codes');
      // the email in another case, the code without dashes and in capitals
      const res = await redeem(`  ${alice.email.toUpperCase()} `, first.replace(/-/g, '').toUpperCase());
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect((await resetPassword(tokenOf(res.json().url))).statusCode).toBe(200);
      expect((await signIn(alice.email, NEW_PASSWORD)).statusCode).toBe(200);

      const again = await redeem(alice.email, first);
      expect(again.statusCode).toBe(400);
      expect(again.json().details).toEqual({ reason: 'recovery_code_invalid' });
      const fresh = await signIn(alice.email, NEW_PASSWORD);
      const cookie = (fresh.headers['set-cookie'] as string[] | string | undefined) ?? '';
      const freshUser = {
        ...alice,
        cookie: [cookie]
          .flat()
          .map((c) => c.split(';')[0])
          .join('; '),
      };
      expect((await status(freshUser)).json()).toMatchObject({ remaining: 9, total: 10 });
      expect((await redeem(alice.email, second)).statusCode).toBe(200);

      const audits = await auditOf('account.recovery_code_used');
      expect(audits).toHaveLength(2);
      expect(JSON.stringify(audits)).not.toContain(first);
    });

    it("answers alike for a wrong email, someone else's code, an unknown email and a malformed code", async () => {
      const [aliceCode] = await codesFor(alice);
      await codesFor(bob);
      if (!aliceCode) throw new Error('no codes');
      const answers = await Promise.all([
        redeem(bob.email, aliceCode, '10.2.0.1'),
        redeem('nobody@example.test', aliceCode, '10.2.0.2'),
        redeem(alice.email, 'zzzz-zzzz-zzzz', '10.2.0.3'),
        redeem(alice.email, 'not a code', '10.2.0.4'),
      ]);
      for (const a of answers) {
        expect(a.statusCode).toBe(400);
        expect(a.json()).toMatchObject({
          code: 'VALIDATION_FAILED',
          details: { reason: 'recovery_code_invalid' },
        });
        expect(a.json().message).toBe('the email or the recovery code is not valid');
      }
      // nothing was spent by the failures
      const unused = await t.db.drizzle
        .select()
        .from(accountRecoveryCodes)
        .where(eq(accountRecoveryCodes.userId, alice.userId));
      expect(unused.every((r) => r.usedAt === null)).toBe(true);
    });

    it('a new set replaces the old one', async () => {
      const [old] = await codesFor(alice);
      const [fresh] = await codesFor(alice);
      if (!old || !fresh) throw new Error('no codes');
      expect((await redeem(alice.email, old)).statusCode).toBe(400);
      expect((await redeem(alice.email, fresh)).statusCode).toBe(200);
      expect(
        await t.db.drizzle
          .select()
          .from(accountRecoveryCodes)
          .where(eq(accountRecoveryCodes.userId, alice.userId)),
      ).toHaveLength(10);
    });

    it('a closed account cannot be recovered; a suspended one is told so', async () => {
      const [code] = await codesFor(alice);
      if (!code) throw new Error('no codes');
      await t.db.drizzle
        .update(appUsers)
        .set({ suspendedAt: new Date() })
        .where(eq(appUsers.id, alice.userId));
      const suspended = await redeem(alice.email, code, '10.3.0.1');
      expect(suspended.statusCode).not.toBe(200);
      expect(suspended.json().code).toBe('ACCOUNT_SUSPENDED');
      await t.db.drizzle
        .update(appUsers)
        .set({ suspendedAt: null, deletedAt: new Date() })
        .where(eq(appUsers.id, alice.userId));
      const closed = await redeem(alice.email, code, '10.3.0.2');
      expect(closed.statusCode).toBe(400);
      expect(closed.json().details).toEqual({ reason: 'recovery_code_invalid' });
    });

    it('limits attempts per email', async () => {
      for (let i = 0; i < 5; i++)
        expect((await redeem(alice.email, 'zzzz-zzzz-zzzz', `10.4.0.${i}`)).statusCode).toBe(400);
      expect((await redeem(alice.email, 'zzzz-zzzz-zzzz', '10.4.0.9')).statusCode).toBe(429);
    });
  });

  it('the sign-in page learns both ways back in, and a web session lasts 60 days', async () => {
    const policy = await t.app.inject({ method: 'GET', url: '/v1/auth/signup-policy' });
    expect(policy.json()).toMatchObject({ recovery: ['device', 'code'] });
    const res = await signIn(alice.email, PASSWORD);
    expect(res.statusCode).toBe(200);
    const sessions = await t.db.drizzle
      .select()
      .from(authSessions)
      .where(
        and(
          eq(
            authSessions.userId,
            (await t.db.drizzle.query.appUsers.findFirst({ where: eq(appUsers.id, alice.userId) }))
              ?.authUserId ?? '',
          ),
        ),
      );
    const longest = Math.max(...sessions.map((s) => s.expiresAt.getTime())) - Date.now();
    expect(longest).toBeGreaterThan(59 * 24 * 3_600_000);
    expect(longest).toBeLessThanOrEqual(60 * 24 * 3_600_000 + 60_000);
  });
});
