import { resolve } from 'node:path';
import { defaultExecutable, whichBin } from '../harnesses/shared.js';
import type { Bridge, Host, HostOptions } from '../harnesses/types.js';
import { type Harness, harness } from '../harnesses.js';
import type { Output } from '../output.js';

export type { Harness } from '../harnesses.js';

import { readProfile } from '../store.js';

export interface ConnectOptions extends HostOptions {
  harness: Harness;
  profile: string;
  /** Absolute path of the agentdrop executable to put into the client config. */
  executable?: string;
  /** Skip the harness notification adapters, including next-prompt context where supported. */
  noHook?: boolean;
}

export { defaultExecutable, SERVER_KEY } from '../harnesses/shared.js';

/**
 * Idempotent client configuration. Preferred path: the client's own CLI (`codex mcp add`, `claude mcp add`).
 * Fallback: back up the config file, then add/replace only the `agentdrop` server entry; every other setting,
 * key or server stays untouched. `disconnect` removes only that entry.
 */
async function registerMcp(out: Output, opts: ConnectOptions): Promise<Bridge> {
  const profile = readProfile(opts.profile);
  if (!profile)
    throw new Error(`profile "${opts.profile}" not found; pair it first with agentdrop endpoint add`);
  const exe = resolve(opts.executable ?? defaultExecutable());
  const bridge: Bridge = { profile: opts.profile, exe, args: ['mcp', '--profile', opts.profile] };
  harness(opts.harness).registerMcp(host(out, opts), bridge);
  return bridge;
}

function host(out: Output, options: HostOptions): Host {
  return { out, options, which: options.which ?? whichBin };
}

/** connect = register the MCP server + install the harness notice adapter (unless --no-hook). */
export async function connectCommand(out: Output, opts: ConnectOptions): Promise<void> {
  const bridge = await registerMcp(out, opts);
  if (opts.noHook) return;
  harness(opts.harness).installNotices(host(out, opts), bridge);
}

export async function disconnectCommand(
  out: Output,
  opts: Omit<ConnectOptions, 'profile'> & { profile?: string },
): Promise<void> {
  const adapter = harness(opts.harness);
  adapter.removeNotices(host(out, opts));
  adapter.removeMcp(host(out, opts));
}

export { removeCodexSection, upsertCodexToml } from '../harnesses/codex.js';
