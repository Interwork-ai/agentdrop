import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.js';
import { backupConfigFile } from '../backups.js';
import { PENDING_HOOK_EVENTS } from '../commands/hooks.js';
import { recordHookEvents } from '../hook-record.js';
import type { Output } from '../output.js';

/** The one name AgentDrop's entry has in every host's MCP configuration. */
export const SERVER_KEY = 'agentdrop';

export function defaultExecutable(): string {
  // When running from the built package, argv[1] is bin/agentdrop.js; in dev it is src/main.ts (tsx).
  const argv1 = process.argv[1];
  if (argv1 && /agentdrop(\.m?js)?$/.test(argv1)) return argv1;
  return join(homedir(), '.local', 'bin', 'agentdrop');
}

export function whichBin(bin: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split('\n')[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Hosts that keep MCP servers as `mcpServers.<name>` in a JSON file (Claude Code's `.claude.json`, Cursor) share
 * this writer; only the path and the entry's fields differ. `entry: null` removes ours and nothing else.
 */
export function writeJsonMcp(
  out: Output,
  harness: string,
  path: string,
  entry: Record<string, unknown> | null,
): void {
  if (!entry && !existsSync(path)) {
    out.result({ harness, removed: false }, () => `${harness}: no config file`);
    return;
  }
  const current: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (!isRecord(current) || (current.mcpServers !== undefined && !isRecord(current.mcpServers)))
    throw new Error(
      'Invalid MCP configuration: expected an object with an mcpServers object; file was not changed',
    );
  const servers = { ...((current.mcpServers ?? {}) as Record<string, unknown>) };
  if (entry) servers[SERVER_KEY] = entry;
  else delete servers[SERVER_KEY];
  const backup = backupConfigFile(path);
  writeFileAtomic(path, `${JSON.stringify({ ...current, mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
  out.result(
    { harness, path, backup, ...(entry ? entry : { removed: true }) },
    () => `${harness}: ${entry ? 'registered' : 'removed'} agentdrop in ${path}`,
  );
}

/**
 * Hook repair adds a missing event only if AgentDrop never wrote it into that file; connect is where it is written.
 * Best effort: a read-only state directory must not fail a connect that already succeeded.
 */
export function rememberHookEvents(path: string): void {
  try {
    recordHookEvents(path, PENDING_HOOK_EVENTS);
  } catch {
    /* Without the record, repair treats the events present in the file as the record. */
  }
}
