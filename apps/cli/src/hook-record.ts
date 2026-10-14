import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stateDir } from './paths.js';
import { writePrivateFile } from './store.js';

/**
 * Which hook events AgentDrop has ever written into each harness config file.
 *
 * Repair adds an event that is missing only when AgentDrop never wrote it into that file. Without this record a
 * missing `UserPromptSubmit` is ambiguous — an install from before the event existed, or a person who deleted it
 * on purpose — and guessing "install it" would bring back a hook on every command after somebody removed it.
 */
function recordPath(): string {
  return join(stateDir(), 'hook-events.json');
}

function readAll(): Record<string, string[]> {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [],
      ]),
    );
  } catch {
    return {};
  }
}

/** `null` means no record for this file: an install from before the record existed. */
export function recordedHookEvents(path: string): string[] | null {
  return readAll()[resolve(path)] ?? null;
}

/** Adds to the record; an event once written stays recorded even after the user removes it. */
export function recordHookEvents(path: string, events: readonly string[]): void {
  const all = readAll();
  const key = resolve(path);
  const before = all[key] ?? [];
  const next = [...new Set([...before, ...events])].sort();
  if (all[key] && next.length === before.length) return;
  all[key] = next;
  writePrivateFile(recordPath(), `${JSON.stringify(all, null, 2)}\n`);
}
