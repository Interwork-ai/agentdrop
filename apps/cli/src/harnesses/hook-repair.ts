import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cursorHookCommand,
  cursorStopHookStatus,
  hookCommand,
  installedCursorHook,
  installedPendingHooks,
  pendingHooksPlan,
  upsertCursorStopHook,
  upsertPendingHooks,
} from '../commands/hooks.js';
import { recordedHookEvents, recordHookEvents } from '../hook-record.js';
import { defaultExecutable } from './shared.js';
import type { HookPlan, HookRepairAdapter } from './types.js';

/**
 * The executable to rebuild a hook with: the installed one while it exists (a `connect --executable` choice, and
 * with it Codex's hook trust hash, is kept), otherwise the running CLI.
 */
function keptExecutable(executable: string): string {
  return existsSync(executable) ? executable : resolve(defaultExecutable());
}

/** A hook file that is there but cannot be read or is not a JSON object: we cannot tell whether our hook is in it. */
function unreadableJson(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof value !== 'object' || value === null || Array.isArray(value);
  } catch {
    return true;
  }
}

/** Codex `hooks.json` and Claude Code `settings.json`: the Stop, UserPromptSubmit and SessionStart command hooks. */
export function pendingHooksRepair(path: () => string): HookRepairAdapter {
  return {
    path,
    plan(file, profiles) {
      const installed = installedPendingHooks(file);
      const base = {
        path: file,
        profile: installed?.profile ?? null,
        command: null,
        events: [],
        recorded: [],
      };
      if (!installed) return { ...base, status: unreadableJson(file) ? 'unreadable' : 'absent' };
      const { executable, profile } = installed;
      if (!executable || !profile || !profiles.has(profile)) return { ...base, status: 'orphaned' };
      const command = hookCommand(keptExecutable(executable), profile);
      const recorded = [...new Set([...(recordedHookEvents(file) ?? []), ...installed.events])];
      const plan = pendingHooksPlan(file, command, recorded);
      return { ...base, status: plan.status, command, events: plan.events, recorded };
    },
    apply(file, plan) {
      if (!plan.command) return false;
      // Seed the record on first sight, so a hook the user deletes after this upgrade is not re-added.
      if (plan.status === 'current') {
        recordHookEvents(file, plan.recorded);
        return false;
      }
      upsertPendingHooks(file, plan.command, plan.events);
      recordHookEvents(file, [...plan.recorded, ...plan.events]);
      return true;
    },
    describe: (plan) => `${plan.events.join(' + ')} in ${plan.path}`,
  };
}

/** Cursor `hooks.json`: one guarded `stop` hook. */
export function cursorHookRepair(path: () => string): HookRepairAdapter {
  return {
    path,
    plan(file, profiles): HookPlan {
      const installed = installedCursorHook(file);
      const base = {
        path: file,
        profile: installed?.profile ?? null,
        command: null,
        events: [],
        recorded: [],
      };
      if (!installed) return { ...base, status: unreadableJson(file) ? 'unreadable' : 'absent' };
      const { executable, profile } = installed;
      if (!executable || !profile || !profiles.has(profile)) return { ...base, status: 'orphaned' };
      const command = cursorHookCommand(keptExecutable(executable), profile);
      const status = cursorStopHookStatus(file, command) === 'current' ? 'current' : 'stale';
      return { ...base, status, command, events: ['stop'] };
    },
    apply(file, plan) {
      if (plan.status === 'current' || !plan.command) return false;
      upsertCursorStopHook(file, plan.command);
      return true;
    },
    describe: (plan) => plan.path,
  };
}
