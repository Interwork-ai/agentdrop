import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEdits, modify, type ParseError, parse as parseJsonc } from 'jsonc-parser/lib/esm/main.js';
import { writeFileAtomic } from '../atomic-write.js';
import { backupConfigFile } from '../backups.js';
import {
  installOpencodeIdlePlugin,
  opencodeConfigPath,
  opencodeConfigRoot,
  opencodePluginPath,
  removeOpencodeIdlePlugin,
} from '../commands/hooks.js';
import type { Output } from '../output.js';
import { isRecord, SERVER_KEY } from './shared.js';
import type { HarnessAdapter } from './types.js';

export const opencode = {
  key: 'opencode',
  label: 'OpenCode',
  profile: 'opencode',
  binaries: ['opencode'],
  configRoot: opencodeConfigRoot,
  skillsRoot: () => join(opencodeConfigRoot(), 'skills'),

  registerMcp({ out, options }, { exe, args }) {
    writeOpencodeMcp(out, options.opencodeConfigPath ?? opencodeConfigPath(), {
      type: 'local',
      command: [exe, ...args],
      enabled: true,
    });
  },

  removeMcp({ out, options }) {
    writeOpencodeMcp(out, options.opencodeConfigPath ?? opencodeConfigPath(), null);
  },

  installNotices({ out, options }, { exe, profile }) {
    const res = installOpencodeIdlePlugin(options.opencodePluginPath ?? opencodePluginPath(), exe, profile);
    out.info(`hook:      OpenCode session.idle plugin written to ${res.path}`);
  },

  removeNotices({ options }) {
    removeOpencodeIdlePlugin(options.opencodePluginPath ?? opencodePluginPath());
  },
  // a managed plugin file rather than config entries; `connect` regenerates it
} as const satisfies HarnessAdapter;

/** OpenCode's documented local MCP shape is `mcp.<name> = {type:"local", command:[...], enabled:true}`. */
function writeOpencodeMcp(out: Output, path: string, entry: Record<string, unknown> | null): void {
  if (!entry && !existsSync(path)) {
    out.result({ harness: 'opencode', removed: false }, () => 'opencode: no config file');
    return;
  }
  const source = existsSync(path) ? readFileSync(path, 'utf8') : '{}\n';
  const errors: ParseError[] = [];
  const current: unknown = parseJsonc(source, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('Invalid OpenCode JSON/JSONC configuration; file was not changed');
  if (!isRecord(current) || (current.mcp !== undefined && !isRecord(current.mcp)))
    throw new Error(
      'Invalid OpenCode configuration: expected an object with an mcp object; file was not changed',
    );
  const edits = modify(source, ['mcp', SERVER_KEY], entry ?? undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  const next = applyEdits(source, edits);
  const backup = backupConfigFile(path);
  writeFileAtomic(path, next.endsWith('\n') ? next : `${next}\n`, { mode: 0o600 });
  out.result(
    { harness: 'opencode', path, backup, ...(entry ? entry : { removed: true }) },
    () => `opencode: ${entry ? 'registered' : 'removed'} agentdrop in ${path}`,
  );
}
