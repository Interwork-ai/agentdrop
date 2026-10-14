import { pushSubscriptions } from '@agentdrop/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type BrowserUser,
  createTestApp,
  signUp,
  TEST_DATABASE_URL,
  type TestApp,
} from './testing/harness.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'Abcdefghijklmnop_123', auth: 'Zyxwvutsrqponmlk_456' },
  device_label: 'Work browser',
};

describeDb('browser push subscriptions', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice');
    bob = await signUp(t, 'bob');
  });

  const request = (user: BrowserUser, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: user.cookie, origin: t.origin, 'user-agent': 'Test Browser/1' },
      ...(payload ? { payload } : {}),
    });

  it('reports disabled server config and returns only sanitized owned subscriptions', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/v1/me/push' })).statusCode).toBe(401);
    const before = await request(alice, 'GET', '/v1/me/push');
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ available: false, vapid_public_key: null, subscriptions: [] });

    const first = await request(alice, 'POST', '/v1/me/push/subscriptions', subscription);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.body).not.toContain(subscription.endpoint);
    expect(first.body).not.toContain(subscription.keys.p256dh);
    expect(first.json().user_agent).toBe('Test Browser/1');
    const mine = await request(alice, 'GET', '/v1/me/push');
    expect(mine.body).not.toContain(subscription.endpoint);
    expect(mine.body).not.toContain(subscription.keys.auth);

    const second = await request(alice, 'POST', '/v1/me/push/subscriptions', {
      ...subscription,
      device_label: 'Renamed browser',
    });
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().device_label).toBe('Renamed browser');
    expect(await t.db.drizzle.select().from(pushSubscriptions)).toHaveLength(1);

    expect((await request(bob, 'GET', '/v1/me/push')).json().subscriptions).toEqual([]);
    expect((await request(bob, 'DELETE', `/v1/me/push/subscriptions/${first.json().id}`)).statusCode).toBe(
      404,
    );
    expect((await request(alice, 'DELETE', `/v1/me/push/subscriptions/${first.json().id}`)).statusCode).toBe(
      200,
    );
    const [stored] = await t.db.drizzle
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.id, first.json().id));
    expect(stored).toBeUndefined();
  });

  it('validates https endpoints, base64url keys and label bounds', async () => {
    expect(
      (
        await request(alice, 'POST', '/v1/me/push/subscriptions', {
          ...subscription,
          endpoint: 'http://fcm.googleapis.com/nope',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request(alice, 'POST', '/v1/me/push/subscriptions', {
          ...subscription,
          endpoint: 'https://127.0.0.1/internal',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request(alice, 'POST', '/v1/me/push/subscriptions', {
          ...subscription,
          endpoint: 'https://push.example.test/untrusted',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request(alice, 'POST', '/v1/me/push/subscriptions', {
          ...subscription,
          keys: { ...subscription.keys, auth: 'not valid padding=' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request(alice, 'POST', '/v1/me/push/subscriptions', {
          ...subscription,
          device_label: 'x'.repeat(81),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request(alice, 'POST', '/v1/me/push/subscriptions', {
          ...subscription,
          device_label: 'bad\u0000label',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('lets a signed-in browser reclaim the exact subscription but rejects changed secrets', async () => {
    const owned = await request(alice, 'POST', '/v1/me/push/subscriptions', subscription);
    const reclaimed = await request(bob, 'POST', '/v1/me/push/subscriptions', {
      ...subscription,
      device_label: 'Bob browser',
    });
    expect(reclaimed.statusCode, reclaimed.body).toBe(200);
    expect(reclaimed.json().id).toBe(owned.json().id);
    expect((await request(alice, 'GET', '/v1/me/push')).json().subscriptions).toEqual([]);
    expect((await request(bob, 'GET', '/v1/me/push')).json().subscriptions).toHaveLength(1);

    const rejected = await request(alice, 'POST', '/v1/me/push/subscriptions', {
      ...subscription,
      keys: { ...subscription.keys, auth: 'different_auth_key' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).not.toContain(subscription.endpoint);
  });
});
