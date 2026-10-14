import { DEFAULT_CLIENT_SETTINGS, deviceClientSettingsSchema } from '@agentdrop/contracts';
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

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL)
  console.warn('[client-settings.test] TEST_DATABASE_URL unset: PostgreSQL integration tests SKIPPED');

describeDb('device client settings ownership and synchronization', () => {
  let t: TestApp;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let a: PairedEndpoint;
  let sameDevice: PairedEndpoint;
  let otherDevice: PairedEndpoint;
  let deviceId: string;
  const settings = {
    notifications: { enabled: false, interval_ms: 0, detail: 'names' as const },
    updates: { mode: 'auto' as const, interval_ms: 60_000 },
  };
  const web = (user: BrowserUser, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: user.cookie, origin: t.origin },
      ...(payload ? { payload } : {}),
    });
  const h = (endpoint: PairedEndpoint, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { ...hHeaders(endpoint.credential), origin: t.origin },
      ...(payload ? { payload } : {}),
    });
  const path = () => `/v1/me/devices/${deviceId}/client-settings`;
  const save = (expectedVersion: number, desired = settings) =>
    web(alice, 'PUT', path(), { expected_version: expectedVersion, settings: desired });
  const receipt = (version: number) => ({
    version,
    cli_version: '0.4.2',
    skill_version: '0.4.2',
    error: null,
  });

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    alice = await signUp(t, 'alice');
    bob = await signUp(t, 'bob');
    a = await pair(t, alice, { harness: 'codex' });
    sameDevice = await pair(t, alice, { installationId: a.installationId, harness: 'claude-code' });
    otherDevice = await pair(t, alice, { harness: 'codex' });
    const list = await web(alice, 'GET', '/v1/me/endpoints');
    deviceId = list.json().endpoints.find((e: { h_id: string }) => e.h_id === a.hId).device.device_id;
  });

  it('starts unmanaged, shares desired settings only among H on the same device', async () => {
    const initial = await web(alice, 'GET', path());
    expect(initial.statusCode, initial.body).toBe(200);
    expect(deviceClientSettingsSchema.parse(initial.json())).toEqual({
      device_id: deviceId,
      version: 0,
      settings: DEFAULT_CLIENT_SETTINGS,
      updated_at: null,
      applied: null,
    });
    const saved = await save(0);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ version: 1, settings, applied: null });
    expect(saved.json().updated_at).toEqual(expect.any(String));
    for (const endpoint of [a, sameDevice]) {
      const got = await h(endpoint, 'GET', '/v1/h/client-settings');
      expect(got.statusCode, got.body).toBe(200);
      expect(got.json()).toEqual(saved.json());
    }
    const isolated = await h(otherDevice, 'GET', '/v1/h/client-settings');
    expect(isolated.json()).toMatchObject({ version: 0, settings: DEFAULT_CLIENT_SETTINGS, applied: null });
    expect(isolated.json().device_id).not.toBe(deviceId);
    const wrongDevice = await h(otherDevice, 'POST', '/v1/h/client-settings/applied', receipt(1));
    expect(wrongDevice.statusCode, wrongDevice.body).toBe(409);
    expect((await web(alice, 'GET', path())).json().applied).toBeNull();
  });

  it('hides other users devices and denies credentials control of desired settings', async () => {
    expect((await web(bob, 'GET', path())).statusCode).toBe(404);
    expect((await web(bob, 'PUT', path(), { expected_version: 0, settings })).statusCode).toBe(404);
    expect((await h(a, 'PUT', path(), { expected_version: 0, settings })).statusCode).toBe(401);
    expect((await h(a, 'PUT', '/v1/h/client-settings', { settings })).statusCode).toBe(404);
    expect((await h(a, 'GET', `/v1/h/client-settings?device_id=${deviceId}`)).statusCode).toBe(400);
    await save(0);
    expect(
      (await h(a, 'POST', '/v1/h/client-settings/applied', { ...receipt(1), settings })).statusCode,
    ).toBe(400);
    expect((await web(alice, 'GET', path())).json().settings).toEqual(settings);
  });

  it('uses compare-and-swap, including concurrent saves, and keeps the previous receipt visible', async () => {
    const results = await Promise.all([save(0), save(0)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { current_version: 1 },
    });
    const ack = await h(sameDevice, 'POST', '/v1/h/client-settings/applied', receipt(1));
    expect(ack.statusCode, ack.body).toBe(200);
    expect(ack.json().applied).toMatchObject(receipt(1));
    expect(ack.json().applied.synced_at).toEqual(expect.any(String));
    const changed = await save(1);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ version: 2, applied: { version: 1 } });
    const audit = await t.db.drizzle.query.auditEvents.findMany({
      where: (table, { like }) => like(table.action, 'device.client_settings.%'),
    });
    expect(audit).toHaveLength(3);
    for (const event of audit) expect(event.meta).toEqual({ version: expect.any(Number) });
  });

  it('rejects unmanaged, stale, and future receipts without changing desired configuration', async () => {
    expect((await h(a, 'POST', '/v1/h/client-settings/applied', receipt(0))).statusCode).toBe(409);
    await save(0);
    for (const version of [0, 2]) {
      const invalid = await h(a, 'POST', '/v1/h/client-settings/applied', receipt(version));
      expect(invalid.statusCode, invalid.body).toBe(409);
      expect(invalid.json().code).toBe('VERSION_CONFLICT');
    }
    const failed = await h(a, 'POST', '/v1/h/client-settings/applied', {
      ...receipt(1),
      error: 'SKILL_SYNC_FAILED',
    });
    expect(failed.statusCode, failed.body).toBe(200);
    expect(failed.json()).toMatchObject({ settings, version: 1, applied: { error: 'SKILL_SYNC_FAILED' } });
    const local = await h(a, 'POST', '/v1/h/client-settings/applied', {
      ...receipt(1),
      error: 'LOCAL_OVERRIDE',
    });
    expect(local.statusCode, local.body).toBe(200);
  });

  it('rejects unbounded intervals, unknown fields, arbitrary errors, and client-supplied timestamps', async () => {
    const tooLong = { ...settings, notifications: { ...settings.notifications, interval_ms: 2_592_000_001 } };
    const tooShort = { ...settings, updates: { ...settings.updates, interval_ms: 59_999 } };
    for (const value of [tooLong, tooShort, { ...settings, secret: 'not allowed' }]) {
      expect((await web(alice, 'PUT', path(), { expected_version: 0, settings: value })).statusCode).toBe(
        400,
      );
    }
    await save(0);
    for (const value of [
      { ...receipt(1), error: 'raw machine path or secret' },
      { ...receipt(1), synced_at: new Date().toISOString() },
      { ...receipt(1), cli_version: 'invalid\nversion' },
      { ...receipt(1), device_id: deviceId },
    ]) {
      expect((await h(a, 'POST', '/v1/h/client-settings/applied', value)).statusCode).toBe(400);
    }
  });

  it('revoked endpoints cannot read or report; revoked devices retain readable settings but cannot be edited', async () => {
    await save(0);
    const revoke = await web(alice, 'POST', `/v1/me/endpoints/${a.hId}/revoke`);
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect((await h(a, 'GET', '/v1/h/client-settings')).statusCode).toBe(401);
    expect((await h(a, 'POST', '/v1/h/client-settings/applied', receipt(1))).statusCode).toBe(401);
    expect((await h(sameDevice, 'GET', '/v1/h/client-settings')).statusCode).toBe(200);
    const deviceRevoke = await web(alice, 'POST', `/v1/me/devices/${deviceId}/revoke`);
    expect(deviceRevoke.statusCode, deviceRevoke.body).toBe(200);
    expect((await save(1)).statusCode).toBe(401);
    expect((await web(alice, 'GET', path())).json().version).toBe(1);
    expect((await h(sameDevice, 'GET', '/v1/h/client-settings')).statusCode).toBe(401);
  });
});
