import { harness, isConnectableHarness } from './harnesses.js';

/*
 * The MCP bridge runs for as long as the agent client keeps it, while the CLI may update itself on disk in the
 * meantime (`updates: auto`). Hooks start the new binary every time; only the bridge keeps running the old one. The
 * bridge notices it from disk (never the network), at most once every few minutes, and tells the model once, in the
 * next tool result, so the model can tell the user to restart their client when convenient.
 */

/** How often a tool call may look at the installed version on disk. */
export const STALE_CHECK_MS = 5 * 60 * 1000;

const STABLE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** `a` is a newer plain release than `b`; anything that is not a plain release is never newer. */
export function newerRelease(a: string, b: string): boolean {
  if (!STABLE.test(a) || !STABLE.test(b)) return false;
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return (left[i] ?? 0) > (right[i] ?? 0);
  return false;
}

/** What the person calls the client this bridge was connected for, or null for an unknown one. */
export function clientLabel(harnessKey: string | null | undefined): string | null {
  return harnessKey && isConnectableHarness(harnessKey) ? harness(harnessKey).label : null;
}

/** The model-facing line (English, ADR 0002): names both versions and what to tell the user. */
export function staleBridgeLine(installed: string, running: string, client: string | null): string {
  return `AgentDrop ${installed} is installed but this session still runs ${running}; tell the user to restart ${client ?? 'their agent client'} when convenient.`;
}

/**
 * A notice source for the bridge's tool results: returns the line once, the first time a check finds a newer
 * release installed, and null on every other call. Checks at most every `everyMs` (the first call checks at once).
 */
export function createStaleBridgeNotice(deps: {
  running: string;
  installed: () => string | null;
  client: string | null;
  now?: () => number;
  everyMs?: number;
  onFound?: (installed: string) => void;
}): () => string | null {
  const now = deps.now ?? Date.now;
  const every = deps.everyMs ?? STALE_CHECK_MS;
  let checkedAt: number | null = null;
  let told = false;
  return () => {
    if (told) return null;
    const t = now();
    if (checkedAt !== null && t >= checkedAt && t - checkedAt < every) return null;
    checkedAt = t;
    let installed: string | null;
    try {
      installed = deps.installed();
    } catch {
      return null;
    }
    if (!installed || !newerRelease(installed, deps.running)) return null;
    told = true;
    try {
      deps.onFound?.(installed);
    } catch {
      /* logging never stops the notice */
    }
    return staleBridgeLine(installed, deps.running, deps.client);
  };
}
