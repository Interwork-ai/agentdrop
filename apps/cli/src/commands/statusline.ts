import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ApiClient } from '@agentdrop/client';
import { LIMITS } from '@agentdrop/contracts';
import { readEffectiveHookSettings } from '../client-preferences.js';
import { loadCredential } from '../credentials.js';
import { onlyNew, statusLineText } from '../hook-notifications.js';
import { readLanguage } from '../locale.js';
import { networkFetch } from '../network.js';
import { CLI_VERSION } from '../output.js';
import { configDir, stateDir } from '../paths.js';
import { acquireStateLock } from '../state-lock.js';
import { readDevice, readProfile, writePrivateFile } from '../store.js';
import { validateServerUrl } from './login.js';
import { fetchPending } from './pending.js';

/** Every Claude Code session on this machine refreshes about every 30 s; one shared cache keeps it to one query. */
const CACHE_MS = 30_000;

interface Cache {
  at: number;
  text: string;
}

function cachePath(profile: { server_url: string; user_id: string }): string {
  const server = new URL(profile.server_url).href.replace(/\/$/, '');
  const key = createHash('sha256')
    .update(JSON.stringify([server, profile.user_id, resolve(configDir())]))
    .digest('hex');
  return join(stateDir(), 'statusline', `${key}.json`);
}

function readCache(path: string): Cache | null {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as Partial<Cache>;
    return typeof c.at === 'number' && typeof c.text === 'string' ? { at: c.at, text: c.text } : null;
  } catch {
    return null;
  }
}

/**
 * `agentdrop statusline --profile X`, run by Claude Code for its status bar. Prints one line about what the person
 * has not seen in an agent yet (it clears once a prompt or session start has shown them), or nothing. It never
 * records anything as seen: a status bar is glanced at, not read. Any failure prints the last known line.
 */
export async function statuslineText(profileName: string, now = Date.now()): Promise<string> {
  try {
    const profile = readProfile(profileName);
    if (!profile || Date.parse(profile.credential_expires_at) <= now) return '';
    if (!readEffectiveHookSettings(profileName).notifications.enabled) return '';
    const path = cachePath(profile);
    const cached = readCache(path);
    if (cached && cached.at <= now && now - cached.at < CACHE_MS) return cached.text;
    mkdirSync(join(stateDir(), 'statusline'), { recursive: true, mode: 0o700 });
    const release = acquireStateLock(`${path}.lock`);
    // another session is refreshing right now: show what we have
    if (!release) return cached?.text ?? '';
    try {
      const summary = await fetchPending(profileName, 2000, 1000, LIMITS.LIST_LIMIT_MAX);
      const credential = loadCredential(profile.credential_ref, { timeoutMs: 1000 });
      if (!summary || !credential) return cached?.text ?? '';
      const baseUrl = validateServerUrl(profile.server_url, readDevice()?.allow_http === true);
      const client = new ApiClient({
        baseUrl,
        fetch: networkFetch(baseUrl),
        credential,
        timeoutMs: 2000,
        userAgent: `agentdrop-statusline/${CLI_VERSION}`,
      });
      // an older server has no "seen in an agent" record: its shared notice record is the closest thing
      const seen = await client
        .seenNoticeState()
        .then((r) => r.state)
        .catch(() => client.noticeState().then((r) => r.state));
      const text = statusLineText(onlyNew(summary, seen ?? undefined).fresh, readLanguage());
      writePrivateFile(path, `${JSON.stringify({ at: now, text } satisfies Cache)}\n`);
      return text;
    } finally {
      release();
    }
  } catch {
    return '';
  }
}

export async function statuslineCommand(opts: { profile: string }): Promise<void> {
  // Claude Code pipes session JSON on stdin; nothing in it is needed here
  process.stdin.resume();
  process.stdin.on('error', () => {});
  const text = await statuslineText(opts.profile);
  process.stdout.write(`${text}\n`);
  process.exit(0);
}
