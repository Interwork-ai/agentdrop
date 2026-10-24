import { existsSync } from 'node:fs';
import { claudeCode } from './claude-code.js';
import { codex } from './codex.js';
import { cursor } from './cursor.js';
import { omp } from './omp.js';
import { opencode } from './opencode.js';
import type { HarnessAdapter } from './types.js';
import { workbuddy } from './workbuddy.js';

export type { HarnessAdapter } from './types.js';

/** Every connectable harness, in the order setup detects, pairs and lists them. Adding one starts here. */
const REGISTRY = [
  codex,
  claudeCode,
  cursor,
  opencode,
  omp,
  workbuddy,
] as const satisfies readonly HarnessAdapter[];
export type Harness = (typeof REGISTRY)[number]['key'];
export const HARNESSES: readonly HarnessAdapter[] = REGISTRY;
export const connectableHarnesses: readonly Harness[] = REGISTRY.map((h) => h.key);

export function harness(key: Harness): HarnessAdapter {
  const adapter = HARNESSES.find((h) => h.key === key);
  if (!adapter) throw new Error(`unknown harness ${key}`);
  return adapter;
}

export function isConnectableHarness(value: string): value is Harness {
  return connectableHarnesses.some((h) => h === value);
}

/** The registered harness keys joined for help text and errors: `codex, claude-code, cursor, opencode, omp or workbuddy`. */
export function harnessChoices(separator: string, last = separator): string {
  const keys = [...connectableHarnesses];
  return keys.length < 2 ? keys.join('') : `${keys.slice(0, -1).join(separator)}${last}${keys.at(-1)}`;
}

export function parseHarnessList(value: string): Harness[] {
  const values = value.split(',').map((h) => h.trim());
  if (!values.length || values.some((h) => !isConnectableHarness(h)))
    throw new Error(`--harness must contain only ${connectableHarnesses.join(', ')}`);
  return [...new Set(values)] as Harness[];
}

/** Installed harnesses: a binary on PATH, or the harness's own config root (`roots` overrides it in tests). */
export function detectHarnesses(
  which: (bin: string) => string | null,
  roots: Partial<Record<Harness, string>> = {},
): Harness[] {
  return REGISTRY.filter((h) => {
    const root = roots[h.key] ?? ('configRoot' in h ? h.configRoot() : undefined);
    return h.binaries.some((bin) => which(bin)) || (root !== undefined && existsSync(root));
  }).map((h) => h.key);
}

/** `Codex, Claude Code, Cursor, OpenCode, oh-my-pi (omp) and WorkBuddy` — for help text. */
export function harnessLabels(): string {
  const labels = REGISTRY.map((h) => h.label);
  return labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}
