import { HARNESSES, type HarnessAdapter } from './harnesses.js';
import { isPackagedCli } from './skill-lifecycle.js';
import { listProfiles } from './store.js';

export type { HookPlan } from './harnesses/types.js';

/**
 * Keep installed completion hooks matching the running CLI.
 *
 * The skill folder already repairs itself on every invocation, but hooks were only ever written by `connect`.
 * That asymmetry is a silent-failure machine: 0.4.9 added a `UserPromptSubmit` hook beside the existing `Stop`
 * one, and every existing install kept running with just the old hook, because upgrading an npm package does not
 * revisit the harness config. Any future change to a hook command, timeout or event would land the same way.
 *
 * The unit of repair is a config FILE, not a profile. A harness file holds one AgentDrop hook set (connect replaces
 * it wholesale), so the file itself says what to rebuild: the executable and `--profile` recovered from the
 * installed command. Rebuilding per profile instead made two profiles on one harness overwrite each other on every
 * command, and substituting the running executable undid `connect --executable` (and with it Codex's hook trust).
 *
 * Rules that keep this safe:
 *
 *   - **Repair, never install.** A file with no AgentDrop hook is left alone. That is someone who never connected
 *     this harness, or who ran `connect --no-hook` or `disconnect` on purpose.
 *   - **Never re-add what a person removed.** A missing event is added only if AgentDrop never wrote it into that
 *     file (hook-record.ts). An install from before an event existed gets it once; a deletion after that sticks.
 *   - **Never switch profile or executable.** The installed executable is kept while it exists on disk; only a
 *     vanished one falls back to the running CLI. A profile that no longer exists is not repaired at all.
 *   - **Touch only our own entries.** `upsertPendingHooks` rewrites the AgentDrop handler and preserves every
 *     other handler in the same event, including ones sharing a group with ours.
 */

export interface HookRepair {
  profile: string;
  harness: string;
  path: string;
}

export interface HookReport {
  repaired: HookRepair[];
  error: 'HOOK_SYNC_FAILED' | null;
}

/** Paths are resolved lazily so tests can point them elsewhere without touching a real home directory. */
export type HookSyncPaths = Partial<Record<HarnessAdapter['key'], string>> & {
  /** Older name of the `claude-code` entry. */
  claudeCode?: string;
};

export function synchronizeInstalledHooks(paths: HookSyncPaths = {}): HookReport {
  const repaired: HookRepair[] = [];
  // A source checkout must not rewrite the user's harness configuration, same guard the skill sync uses.
  if (!isPackagedCli()) return { repaired, error: null };
  let error: HookReport['error'] = null;
  let profiles: ReadonlySet<string>;
  try {
    profiles = new Set(listProfiles().map((p) => p.profile));
  } catch {
    return { repaired, error: 'HOOK_SYNC_FAILED' };
  }
  for (const adapter of HARNESSES) {
    const repair = adapter.hookRepair;
    if (!repair) continue;
    try {
      const target =
        paths[adapter.key] ?? (adapter.key === 'claude-code' ? paths.claudeCode : undefined) ?? repair.path();
      const plan = repair.plan(target, profiles);
      if (plan.status !== 'current' && plan.status !== 'stale') continue;
      if (!plan.profile || !plan.command) continue;
      if (repair.apply(target, plan))
        repaired.push({ profile: plan.profile, harness: adapter.key, path: target });
    } catch {
      error = 'HOOK_SYNC_FAILED';
    }
  }
  return { repaired, error };
}
