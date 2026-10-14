import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUp, TEST_DATABASE_URL, type TestApp } from './testing/harness.js';

/*
 * Better Auth limits sign-in to 3 attempts in 10 s per client address. The address it uses must be the one the
 * server determined (Fastify's req.ip, which trusts forwarding headers only with TRUST_PROXY), never a header the
 * client wrote: a forged X-Forwarded-For per attempt used to give every attempt a fresh address and a fresh limit.
 */

const WRONG = 'not-the-password-0000';

describe.skipIf(!TEST_DATABASE_URL)('sign-in rate limit and the client address', () => {
  describe('without a trusted proxy', () => {
    let t: TestApp;
    let email: string;
    beforeAll(async () => {
      // NODE_ENV=development turns Better Auth's own rate limiter on (it is off under test)
      t = await createTestApp({ env: { NODE_ENV: 'development', TRUST_PROXY: 'false' } });
    });
    afterAll(async () => {
      await t.close();
    });
    beforeEach(async () => {
      await t.reset();
      email = (await signUp(t, 'alice', 'Alice')).email;
    });

    const attempt = (headers: Record<string, string>, remoteAddress: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { origin: t.origin, ...headers },
        payload: { email, password: WRONG },
        remoteAddress,
      });

    it('a forged X-Forwarded-For per attempt does not get past the limit', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++)
        codes.push((await attempt({ 'x-forwarded-for': `203.0.113.${i + 1}` }, '198.51.100.7')).statusCode);
      expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
      expect(codes.slice(3)).toEqual([429, 429]);
    });

    it("nor does writing the server's own client-address header", async () => {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++)
        codes.push(
          (await attempt({ 'x-agentdrop-client-ip': `203.0.113.${i + 1}` }, '198.51.100.8')).statusCode,
        );
      expect(codes.slice(3)).toEqual([429, 429]);
    });

    it('another address has its own limit', async () => {
      for (let i = 0; i < 3; i++) await attempt({}, '198.51.100.9');
      expect((await attempt({}, '198.51.100.9')).statusCode).toBe(429);
      expect((await attempt({}, '198.51.100.10')).statusCode).toBe(401);
    });
  });

  describe('behind a trusted proxy (TRUST_PROXY=true)', () => {
    let t: TestApp;
    let email: string;
    beforeAll(async () => {
      t = await createTestApp({ env: { NODE_ENV: 'development', TRUST_PROXY: 'true' } });
    });
    afterAll(async () => {
      await t.close();
    });
    beforeEach(async () => {
      await t.reset();
      email = (await signUp(t, 'alice', 'Alice')).email;
    });

    it('the address the proxy forwards is the one limited, so people behind it are told apart', async () => {
      const attempt = (forwardedFor: string) =>
        t.app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: { origin: t.origin, 'x-forwarded-for': forwardedFor },
          payload: { email, password: WRONG },
          remoteAddress: '10.0.0.2',
        });
      for (let i = 0; i < 3; i++) await attempt('203.0.113.50');
      expect((await attempt('203.0.113.50')).statusCode).toBe(429);
      expect((await attempt('203.0.113.51')).statusCode).toBe(401);
    });
  });
});
