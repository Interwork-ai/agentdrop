import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { hookCommand, removePendingHooks, upsertPendingHooks } from '../commands/hooks.js';
import { pendingHooksRepair } from './hook-repair.js';
import { rememberHookEvents, writeJsonMcp } from './shared.js';
import type { HarnessAdapter } from './types.js';

/*
 * Tencent WorkBuddy, a desktop agent app that runs an embedded CodeBuddy Code CLI with its home directory moved.
 * Read from the macOS bundles of WorkBuddy 5.8.3 and WorkBuddy AI 5.8.4 (static inspection, docs/HARNESSES.md):
 *
 * - Home: `WORKBUDDY_CONFIG_DIR`, else `~/<dataFolderName>` from the bundle's product.json: `.workbuddy` for the
 *   China edition, `.workbuddy-ai` for the international one. The edition decides it, not the version.
 * - MCP servers: `mcpServers.<name>` in `<home>/mcp.json` (the app's own provider reads and writes that file); the
 *   embedded CLI prefers `<home>/.mcp.json` when it exists, so ours goes there too in that case. A server added in
 *   the file stays untrusted until the person allows it in WorkBuddy; that consent is the host's and is not written.
 * - Skills: `<home>/skills/<name>/SKILL.md`.
 * - Hooks: Claude Code's format in `<home>/settings.json`. A hook's `systemMessage` is shown in the conversation and
 *   kept out of the model; `additionalContext` from SessionStart and UserPromptSubmit reaches the model.
 */
export function workbuddyHome(): string {
  const override = process.env.WORKBUDDY_CONFIG_DIR;
  if (override) return resolve(override);
  const china = join(homedir(), '.workbuddy');
  const international = join(homedir(), '.workbuddy-ai');
  // with both editions installed, the China edition is connected; WORKBUDDY_CONFIG_DIR picks the other
  return !existsSync(china) && existsSync(international) ? international : china;
}
const mcpPaths = (): string[] => {
  const preferred = join(workbuddyHome(), '.mcp.json');
  return [join(workbuddyHome(), 'mcp.json'), ...(existsSync(preferred) ? [preferred] : [])];
};
export const workbuddySettingsPath = () => join(workbuddyHome(), 'settings.json');

export const workbuddy = {
  key: 'workbuddy',
  label: 'WorkBuddy',
  profile: 'workbuddy',
  // a desktop app: its CLI is inside the bundle, not on PATH
  binaries: [],
  configRoot: workbuddyHome,
  skillsRoot: () => join(workbuddyHome(), 'skills'),

  registerMcp({ out }, { exe, args }) {
    for (const path of mcpPaths())
      writeJsonMcp(out, 'workbuddy', path, { type: 'stdio', command: exe, args });
    out.info(
      'mcp:       WorkBuddy holds a server added this way until you trust it: when WorkBuddy asks about agentdrop (or in its MCP settings), allow it once',
    );
  },

  removeMcp({ out }) {
    for (const path of mcpPaths()) writeJsonMcp(out, 'workbuddy', path, null);
  },

  installNotices({ out }, { exe, profile }) {
    const res = upsertPendingHooks(workbuddySettingsPath(), hookCommand(exe, profile));
    rememberHookEvents(res.path);
    out.info(
      `hook:      Stop, UserPromptSubmit and SessionStart hooks written to ${res.path}; WorkBuddy shows the notices in the conversation`,
    );
  },

  removeNotices() {
    removePendingHooks(workbuddySettingsPath());
  },

  hookRepair: pendingHooksRepair(workbuddySettingsPath),
} as const satisfies HarnessAdapter;
