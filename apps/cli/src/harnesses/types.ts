import type { HarnessKey } from '@agentdrop/contracts';
import type { Run } from '../claude-mod.js';
import type { Output } from '../output.js';

/*
 * One host AgentDrop connects to. Everything a host does differently lives in its adapter
 * (apps/cli/src/harnesses/<key>.ts); everything else (the MCP bridge, mailbox rules, notice text, skill content,
 * network route) is shared and must not branch on the harness. See docs/HARNESSES.md and ADR 0024.
 */
export interface HarnessAdapter {
  /** The pairing identity's harness key; `other` is never connectable. */
  readonly key: Exclude<HarnessKey, 'other'>;
  /** Product name shown to people (setup's pairing label, help). */
  readonly label: string;
  /** Default local profile name `setup` pairs this harness as. */
  readonly profile: string;
  /** Executables whose presence on PATH means the harness is installed. */
  readonly binaries: readonly string[];
  /** A user config root whose presence alone means the harness is installed (GUI-only installs). */
  configRoot?(): string;
  /** The directory that holds user-scope skills; the companion skill goes into `<skillsRoot>/agentdrop`. */
  skillsRoot(): string;
  /** Registers `<exe> mcp --profile X` as the host's `agentdrop` MCP server, replacing an older entry. */
  registerMcp(host: Host, bridge: Bridge): void;
  /** Removes only the `agentdrop` MCP entry. */
  removeMcp(host: Host): void;
  /**
   * Installs what tells the person (and, where the host has a channel for it, the model) what is waiting: hooks,
   * plugin, extension, mod or status line. Prints one `info` line per artifact. Skipped by `connect --no-hook`.
   */
  installNotices(host: Host, bridge: Bridge): void;
  /** Removes only what `installNotices` wrote; every other hook, plugin or setting stays. */
  removeNotices(host: Host): void;
  /**
   * Notice configuration that ordinary CLI commands keep matching this version (docs/HARNESSES.md, "Hook repair
   * on ordinary commands") and that `doctor` reports. Absent for a host whose notices cannot be repaired in place.
   */
  readonly hookRepair?: HookRepairAdapter;
}

/** What one harness file holds and what repairing it would write. */
export interface HookPlan {
  /**
   * `orphaned`: our hook is there, but its profile is gone or its command unreadable; left for `connect`.
   * `unreadable`: the file exists but cannot be read or parsed, so whether our hook is in it is unknown; left alone.
   */
  status: 'absent' | 'current' | 'stale' | 'orphaned' | 'unreadable';
  path: string;
  profile: string | null;
  command: string | null;
  /** Events a repair writes (pending hooks only). */
  events: string[];
  /** Events AgentDrop has written into this file, including the ones present now. */
  recorded: string[];
}

export interface HookRepairAdapter {
  /** The file holding AgentDrop's notice configuration for this host. */
  path(): string;
  /** Read-only. */
  plan(path: string, profiles: ReadonlySet<string>): HookPlan;
  /** Brings a planned file up to date; whether it changed anything. Only called for `current` or `stale`. */
  apply(path: string, plan: HookPlan): boolean;
  /** `doctor`'s detail for an up-to-date file. */
  describe(plan: HookPlan): string;
}

/** Config locations a test may redirect; each adapter reads only its own. */
export interface HarnessPaths {
  codexConfigPath?: string;
  claudeConfigPath?: string;
  cursorConfigPath?: string;
  opencodeConfigPath?: string;
  codexHooksPath?: string;
  claudeSettingsPath?: string;
  cursorHooksPath?: string;
  opencodePluginPath?: string;
  ompConfigPath?: string;
  ompExtensionPath?: string;
}

export interface HostOptions extends HarnessPaths {
  /** Do not shell out to the host's own CLI (`codex mcp add`, `claude mcp add`); edit config files directly. */
  noCli?: boolean;
  which?: (bin: string) => string | null;
  /** Runs `claude plugin …` for the mod install (tests). */
  run?: Run;
}

export interface Host {
  out: Output;
  options: HostOptions;
  /** PATH lookup; `options.which` in tests. */
  which: (bin: string) => string | null;
}

/** What every host starts: `<exe> mcp --profile <profile>`. */
export interface Bridge {
  profile: string;
  /** Absolute path of the agentdrop executable. */
  exe: string;
  args: string[];
}
