import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AgentDropError, ApiClient } from '@agentdrop/client';
import { deviceClientSettingsSchema, z } from '@agentdrop/contracts';
import { validateServerUrl } from './commands/login.js';
import { loadCredential } from './credentials.js';
import { type HookSettings, readHookSettings } from './hook-settings.js';
import { networkFetch } from './network.js';
import { configDir, stateDir } from './paths.js';
import { type SkillReport, synchronizeInstalledSkills } from './skill-lifecycle.js';
import { acquireStateLock } from './state-lock.js';
import { readDevice, readProfile, writePrivateFile } from './store.js';

const POLL_MS = 60_000;
const FAILURE_MS = 5 * 60_000;
const cacheSchema = z.object({
  checked_at: z.number().finite(),
  retry_at: z.number().finite(),
  remote: deviceClientSettingsSchema.nullable(),
});
type Cache = z.infer<typeof cacheSchema>;
function cachePath(profileName: string): string | null {
  const profile = readProfile(profileName);
  if (!profile) return null;
  const server = new URL(profile.server_url).href.replace(/\/$/, '');
  const key = createHash('sha256')
    .update(JSON.stringify([server, profile.h_id, resolve(configDir())]))
    .digest('hex');
  return join(stateDir(), 'client-settings', `${key}.json`);
}
function readCache(path: string): Cache | null {
  try {
    if (statSync(path).size > 65_536) return null;
    const result = cacheSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
function saveCache(path: string, cache: Cache) {
  writePrivateFile(path, `${JSON.stringify(cache)}\n`);
}

/** Saved dashboard policy is authoritative for this profile's device; unconfigured/old servers use local settings. */
export function readEffectiveHookSettings(profileName: string): HookSettings {
  try {
    const path = cachePath(profileName);
    const remote = path ? readCache(path)?.remote : null;
    if (remote && remote.version > 0) return remote.settings;
  } catch {
    /* Local/manual configuration remains usable when profile metadata is unavailable. */
  }
  return readHookSettings();
}

export interface PreferenceSyncOptions {
  force?: boolean;
  now?: () => number;
  fetch?: typeof fetch;
  skillReport?: () => SkillReport;
}

/** Bounded, credential-scoped read/ack; no endpoint/device selector is sent by the client. */
export async function synchronizeClientSettings(
  profileName: string,
  opts: PreferenceSyncOptions = {},
): Promise<'synced' | 'local' | 'not_due' | 'busy' | 'offline'> {
  let release: (() => void) | undefined;
  try {
    const profile = readProfile(profileName);
    const path = cachePath(profileName);
    if (!profile || !path) return 'local';
    const now = (opts.now ?? Date.now)();
    const cached = readCache(path);
    if (!opts.force && cached && cached.checked_at <= now && now < cached.retry_at) return 'not_due';
    mkdirSync(join(stateDir(), 'client-settings'), { recursive: true, mode: 0o700 });
    release = acquireStateLock(`${path}.lock`);
    if (!release) return 'busy';
    const current = readCache(path);
    if (!opts.force && current && current.checked_at <= now && now < current.retry_at) return 'not_due';
    const previous = current?.remote ?? null;
    const baseUrl = validateServerUrl(profile.server_url, readDevice()?.allow_http === true);
    const credential = loadCredential(profile.credential_ref, { timeoutMs: 1000 });
    if (!credential) return 'local';
    const client = new ApiClient({
      baseUrl,
      credential,
      timeoutMs: 1000,
      fetch: opts.fetch ?? networkFetch(baseUrl),
    });
    try {
      const response = deviceClientSettingsSchema.parse(
        await client.request<unknown>('GET', '/v1/h/client-settings'),
      );
      // Save before ack: only persisted, validated preferences may be reported as applied.
      saveCache(path, { checked_at: now, retry_at: now + POLL_MS, remote: response });
      if (response.version === 0) return 'local';
      const report = (opts.skillReport ?? synchronizeInstalledSkills)();
      const applied = response.applied;
      if (
        !applied ||
        applied.version !== response.version ||
        applied.cli_version !== report.cli_version ||
        applied.installed_cli_version !== report.installed_cli_version ||
        applied.skill_version !== report.skill_version ||
        applied.error !== report.error
      ) {
        const ack = deviceClientSettingsSchema.parse(
          await client.request<unknown>('POST', '/v1/h/client-settings/applied', {
            body: { version: response.version, ...report },
          }),
        );
        saveCache(path, { checked_at: now, retry_at: now + POLL_MS, remote: ack });
      }
      return 'synced';
    } catch (error) {
      const code = error instanceof AgentDropError ? error.code : null;
      const noPolicy = [
        'NOT_FOUND',
        'UNAUTHORIZED',
        'FORBIDDEN',
        'ENDPOINT_REVOKED',
        'ACCOUNT_SUSPENDED',
      ].includes(code ?? '');
      // Keep any newer GET that was persisted before an ack failed (e.g. a concurrent dashboard edit).
      const latest = existsSync(path) ? (readCache(path)?.remote ?? previous) : previous;
      saveCache(path, { checked_at: now, retry_at: now + FAILURE_MS, remote: noPolicy ? null : latest });
      return 'offline';
    }
  } catch {
    return 'offline';
  } finally {
    try {
      release?.();
    } catch {
      /* Optional sync never interrupts the user or MCP stream. */
    }
  }
}
