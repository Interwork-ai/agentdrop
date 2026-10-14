import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CLIENT_SETTINGS, type DeviceClientSettings } from '@agentdrop/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readEffectiveHookSettings, synchronizeClientSettings } from './client-preferences.js';
import { writeProfile } from './store.js';

let dir: string;
let now: number;
let data: DeviceClientSettings;
let calls: Array<{ method: string; body?: unknown }>;
let fail: 'none' | 'offline' | 'revoked' | 'old' | 'invalid' | 'ack';
const fakeFetch: typeof fetch = async (_input, init) => {
  calls.push({
    method: init?.method ?? 'GET',
    ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
  });
  if (fail === 'offline') throw new Error('network unavailable');
  if (fail === 'revoked' || fail === 'old')
    return Response.json(
      {
        code: fail === 'old' ? 'NOT_FOUND' : 'UNAUTHORIZED',
        message: 'unavailable',
        next_action: '',
        retryable: false,
      },
      { status: fail === 'old' ? 404 : 401 },
    );
  if (fail === 'invalid')
    return Response.json({
      ...data,
      settings: { ...data.settings, updates: { mode: 'off', interval_ms: 1, command: 'not allowed' } },
    });
  if (init?.method === 'POST') {
    if (fail === 'ack') throw new Error('ack offline');
    data = { ...data, applied: { ...JSON.parse(String(init.body)), synced_at: new Date(now).toISOString() } };
  }
  return Response.json(data);
};
const options = () => ({
  now: () => now,
  fetch: fakeFetch,
  skillReport: () => ({ cli_version: '0.4.3', skill_version: '0.4.3', error: null }),
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentdrop-policy-'));
  now = Date.now();
  calls = [];
  fail = 'none';
  vi.stubEnv('AGENTDROP_CONFIG_DIR', join(dir, 'config'));
  vi.stubEnv('AGENTDROP_STATE_DIR', join(dir, 'state'));
  mkdirSync(join(dir, 'config', 'credentials'), { recursive: true });
  writeFileSync(join(dir, 'config', 'credentials', 'test.token'), 'test-only', { mode: 0o600 });
  writeProfile({
    profile: 'test',
    server_url: 'https://drop.example.test',
    h_id: '11111111-1111-4111-8111-111111111111',
    user_id: '22222222-2222-4222-8222-222222222222',
    harness: 'codex',
    profile_key: 'default',
    handle: 'test',
    agent_name: 'test',
    credential_ref: { store: 'file', account: 'test' },
    credential_expires_at: '2099-01-01T00:00:00Z',
    paired_at: 'now',
    allowed_dirs: [],
    toolset: 'standard',
  });
  data = {
    device_id: '33333333-3333-4333-8333-333333333333',
    version: 1,
    settings: {
      ...structuredClone(DEFAULT_CLIENT_SETTINGS),
      updates: { mode: 'off', interval_ms: 7200000 },
    },
    updated_at: new Date(now).toISOString(),
    applied: null,
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

it('uses the dashboard policy, persists it before acknowledgement and keeps local settings separate', async () => {
  expect(await synchronizeClientSettings('test', options())).toBe('synced');
  expect(readEffectiveHookSettings('test').updates.mode).toBe('off');
  expect(calls).toHaveLength(2);
  expect(calls[1]?.body).toEqual({ version: 1, cli_version: '0.4.3', skill_version: '0.4.3', error: null });
  expect(await synchronizeClientSettings('test', options())).toBe('not_due');
  expect(calls).toHaveLength(2);
});
it('keeps last verified policy offline but falls back locally after credential revocation', async () => {
  await synchronizeClientSettings('test', options());
  now += 61000;
  fail = 'offline';
  expect(await synchronizeClientSettings('test', options())).toBe('offline');
  expect(readEffectiveHookSettings('test').updates.mode).toBe('off');
  fail = 'revoked';
  await synchronizeClientSettings('test', { ...options(), force: true });
  expect(readEffectiveHookSettings('test').updates.mode).toBe('auto');
});
it.each(['old', 'invalid'] as const)(
  'does not adopt untrusted/unsupported configuration: %s',
  async (kind) => {
    fail = kind;
    expect(await synchronizeClientSettings('test', options())).toBe('offline');
    expect(readEffectiveHookSettings('test').updates.mode).toBe('auto');
    expect(calls).toHaveLength(1);
  },
);
it('keeps a persisted new policy when its acknowledgement fails, and retries later', async () => {
  fail = 'ack';
  await synchronizeClientSettings('test', options());
  expect(readEffectiveHookSettings('test').updates.mode).toBe('off');
  fail = 'none';
  now += 300001;
  expect(await synchronizeClientSettings('test', options())).toBe('synced');
  expect(data.applied?.version).toBe(1);
});
it('coalesces simultaneous sync attempts and allows recovery from a clock rollback', async () => {
  const results = await Promise.all([
    synchronizeClientSettings('test', options()),
    synchronizeClientSettings('test', options()),
  ]);
  expect(results).toContain('busy');
  expect(calls).toHaveLength(2);
  now -= 60000;
  expect(await synchronizeClientSettings('test', options())).toBe('synced');
});
