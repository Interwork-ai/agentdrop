import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './paths.js';
import { acquireStateLock } from './state-lock.js';
import type { ProfileFile } from './store.js';
import { writePrivateFile } from './store.js';

/*
 * When this machine first recorded each drop as seen inside an agent (ADR 0025). The account's seen record on the
 * server (ADR 0017) says *whether* an item was seen, not when; the Claude Code band needs "seen before this session
 * started" to keep a new session from listing again what an earlier one already showed. Only the same 16-hex hashes
 * the seen record uses are kept, one file per account and server, newest MAX entries.
 */

const MAX = 1000;

/** The hash the seen record uses for a drop (hook-notifications.ts currentKeys). */
export function dropSeenKey(dropId: string): string {
  return createHash('sha256').update(`drop\u0000${dropId}`).digest('hex').slice(0, 16);
}

function logPath(profile: Pick<ProfileFile, 'server_url' | 'user_id'>): string {
  const account = createHash('sha256')
    .update(`${profile.server_url}\u0000${profile.user_id}`)
    .digest('hex')
    .slice(0, 16);
  return join(stateDir(), 'seen-log', `${account}.json`);
}

export function readSeenLog(profile: Pick<ProfileFile, 'server_url' | 'user_id'>): Record<string, number> {
  try {
    const path = logPath(profile);
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [key, at] of Object.entries(parsed as Record<string, unknown>))
      if (/^[0-9a-f]{16}$/.test(key) && typeof at === 'number' && Number.isFinite(at)) out[key] = at;
    return out;
  } catch {
    return {};
  }
}

/**
 * Records `keys` as seen at `at`, keeping the earliest time of any key already there. Best effort: a hook must never
 * fail or wait long because of it, so a lock held by another process means this record is skipped.
 */
export function recordSeenLocally(
  profile: Pick<ProfileFile, 'server_url' | 'user_id'>,
  keys: string[],
  at: number = Date.now(),
): void {
  if (keys.length === 0) return;
  try {
    const path = logPath(profile);
    mkdirSync(join(stateDir(), 'seen-log'), { recursive: true, mode: 0o700 });
    const release = acquireStateLock(`${path}.lock`);
    if (!release) return;
    try {
      const log = readSeenLog(profile);
      for (const key of keys) if (/^[0-9a-f]{16}$/.test(key) && log[key] === undefined) log[key] = at;
      const kept = Object.entries(log)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX);
      writePrivateFile(path, `${JSON.stringify(Object.fromEntries(kept))}\n`);
    } finally {
      release();
    }
  } catch {
    // a full disk or an unwritable state directory costs a re-listed row, nothing more
  }
}
