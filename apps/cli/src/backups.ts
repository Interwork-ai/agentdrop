import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Backups of one client config file that AgentDrop keeps; older ones it made are removed. */
export const KEPT_BACKUPS = 3;

/** Only the names this module writes: `<file>.bak-2026-09-17T09-19-06-687Z`. Hand-made backups never match. */
const STAMP = /^\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/**
 * Copy a client config file before AgentDrop rewrites it, and keep only the newest few of these copies. Every
 * connect, reconnect and upgrade rewrites the same files, so unbounded copies piled up (hundreds next to
 * `~/.codex/hooks.json` and `~/.claude/settings.json`).
 */
export function backupConfigFile(path: string, keep = KEPT_BACKUPS): string | null {
  if (!existsSync(path)) return null;
  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(path, backup);
  try {
    const name = basename(path);
    const dir = dirname(path);
    const ours = readdirSync(dir)
      .filter((f) => f.startsWith(name) && STAMP.test(f.slice(name.length)))
      .sort(); // ISO stamps sort by time
    for (const old of ours.slice(0, Math.max(0, ours.length - keep))) rmSync(join(dir, old), { force: true });
  } catch {
    /* Pruning is housekeeping; the backup just written is what matters. */
  }
  return backup;
}
