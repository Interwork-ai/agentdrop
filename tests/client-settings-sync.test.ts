/**
 * Dashboard API → real CLI policy cache → device receipt, against PostgreSQL.
 * Skill filesystem verification lives in skill.test.ts; the injected receipt here is not evidence of an
 * actual machine-wide skill upgrade. No npm process or user skill directory is accessed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ClientSettings, deviceClientSettingsSchema } from '@agentdrop/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestApp,
  hHeaders,
  type PairedEndpoint,
  pair,
  signUp,
  TEST_DATABASE_URL,
  type TestApp,
} from '../apps/api/src/testing/harness.js';
import { readEffectiveHookSettings, synchronizeClientSettings } from '../apps/cli/src/client-preferences.js';
import { storeCredential } from '../apps/cli/src/credentials.js';
import { hookSettingsPath, writeHookSettings } from '../apps/cli/src/hook-settings.js';
import { writeDevice, writeProfile } from '../apps/cli/src/store.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL)
  console.warn('[client-settings-sync.test] TEST_DATABASE_URL unset: end-to-end settings tests SKIPPED');
const local: ClientSettings = {
  notifications: { enabled: false, interval_ms: 60_000, detail: 'names' },
  updates: { mode: 'off', interval_ms: 86_400_000 },
};
const managed: ClientSettings = {
  notifications: { enabled: true, interval_ms: 7_200_000, detail: 'counts' },
  updates: { mode: 'auto', interval_ms: 7_200_000 },
};
const skillSnapshot = { cli_version: '0.4.2', skill_version: '0.4.2', error: null };

describeDb('dashboard-to-CLI device preference synchronization', () => {
  let t: TestApp;
  let root: string;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    root = mkdtempSync(join(tmpdir(), 'agentdrop-settings-sync-'));
    vi.stubEnv('AGENTDROP_CONFIG_DIR', join(root, 'config'));
    vi.stubEnv('AGENTDROP_STATE_DIR', join(root, 'state'));
    vi.stubEnv('AGENTDROP_CREDENTIAL_STORE', 'file');
    writeHookSettings(local);
  });
  afterEach(async () => {
    try {
      await t.reset();
    } finally {
      vi.unstubAllEnvs();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies a browser-saved policy to both device profiles and reports the verified snapshot, leaving another device local', async () => {
    const user = await signUp(t, 'settingsuser');
    const codex = await pair(t, user, { harness: 'codex' });
    const claude = await pair(t, user, { installationId: codex.installationId, harness: 'claude-code' });
    const other = await pair(t, user, { harness: 'codex' });
    writeDevice({
      installation_id: codex.installationId,
      label: 'Isolated sync test',
      allow_http: true,
      created_at: new Date().toISOString(),
    });
    const pairs = new Map<string, PairedEndpoint>([
      ['codex', codex],
      ['claude', claude],
      ['other', other],
    ]);
    for (const [name, endpoint] of pairs) {
      writeProfile({
        profile: name,
        server_url: 'http://api.test',
        h_id: endpoint.hId,
        harness: name === 'claude' ? 'claude-code' : 'codex',
        profile_key: 'default',
        user_id: user.userId,
        handle: user.handle,
        agent_name: `Test ${name}`,
        credential_ref: storeCredential(name, endpoint.credential, () => {}),
        credential_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        paired_at: new Date().toISOString(),
        allowed_dirs: [],
        toolset: 'standard',
      });
    }
    const endpoints = await t.app.inject({
      method: 'GET',
      url: '/v1/me/endpoints',
      headers: { cookie: user.cookie },
    });
    expect(endpoints.statusCode).toBe(200);
    const deviceFor = (hId: string): string =>
      endpoints.json().endpoints.find((endpoint: { h_id: string }) => endpoint.h_id === hId).device.device_id;
    const deviceId = deviceFor(codex.hId);
    expect(deviceFor(claude.hId)).toBe(deviceId);
    expect(deviceFor(other.hId)).not.toBe(deviceId);
    const settingsFile = readFileSync(hookSettingsPath(), 'utf8');
    const webPath = `/v1/me/devices/${deviceId}/client-settings`;
    const save = await t.app.inject({
      method: 'PUT',
      url: webPath,
      headers: { cookie: user.cookie, origin: t.origin },
      payload: { expected_version: 0, settings: managed },
    });
    expect(save.statusCode, save.body).toBe(200);
    expect(deviceClientSettingsSchema.parse(save.json())).toMatchObject({
      version: 1,
      settings: managed,
      applied: null,
    });
    expect(readEffectiveHookSettings('codex')).toEqual(local); // saving alone has not reached this CLI

    const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
    const injectedFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      const method = init?.method ?? 'GET';
      requests.push({
        method,
        path: `${url.pathname}${url.search}`,
        authorization: headers.get('authorization'),
      });
      expect(url.origin).toBe('http://api.test');
      expect(url.search).toBe('');
      expect(['/v1/h/client-settings', '/v1/h/client-settings/applied']).toContain(url.pathname);
      const response = await t.app.inject({
        method: method as 'GET' | 'POST',
        url: url.pathname,
        headers: Object.fromEntries(headers),
        ...(init?.body ? { payload: String(init.body) } : {}),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    };
    const skillReport = vi.fn(() => ({ ...skillSnapshot }));
    const now = () => 1_800_000_000_000;
    const opts = { now, fetch: injectedFetch, skillReport };
    expect(await synchronizeClientSettings('codex', opts)).toBe('synced');
    expect(readEffectiveHookSettings('codex')).toEqual(managed);
    expect(readEffectiveHookSettings('claude')).toEqual(local); // per-H cache, even on the same device
    expect(await synchronizeClientSettings('claude', opts)).toBe('synced');
    expect(readEffectiveHookSettings('claude')).toEqual(managed);
    expect(await synchronizeClientSettings('other', opts)).toBe('local');
    expect(readEffectiveHookSettings('other')).toEqual(local);
    expect(skillReport).toHaveBeenCalledTimes(2);
    expect(readFileSync(hookSettingsPath(), 'utf8')).toBe(settingsFile);
    for (const endpoint of [codex, claude, other]) {
      expect(
        requests.some(
          (request) =>
            request.method === 'GET' && request.authorization === hHeaders(endpoint.credential).authorization,
        ),
      ).toBe(true);
    }
    expect(
      requests.filter((request) => request.method === 'POST').map((request) => request.authorization),
    ).toEqual([hHeaders(codex.credential).authorization]);
    const applied = await t.app.inject({ method: 'GET', url: webPath, headers: { cookie: user.cookie } });
    expect(deviceClientSettingsSchema.parse(applied.json())).toMatchObject({
      version: 1,
      settings: managed,
      applied: { version: 1, ...skillSnapshot, synced_at: expect.any(String) },
    });
    const untouched = await t.app.inject({
      method: 'GET',
      url: `/v1/me/devices/${deviceFor(other.hId)}/client-settings`,
      headers: { cookie: user.cookie },
    });
    expect(untouched.json()).toMatchObject({ version: 0, applied: null });
    const count = requests.length;
    expect(await synchronizeClientSettings('codex', opts)).toBe('not_due');
    expect(requests).toHaveLength(count);
  });
});
