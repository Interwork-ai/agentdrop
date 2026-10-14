import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  cursorHookCommand,
  cursorHooksPath,
  removeCursorStopHook,
  upsertCursorStopHook,
} from '../commands/hooks.js';
import { cursorHookRepair } from './hook-repair.js';
import { writeJsonMcp } from './shared.js';
import type { HarnessAdapter } from './types.js';

const cursorMcpPath = () => join(homedir(), '.cursor', 'mcp.json');

export const cursor = {
  key: 'cursor',
  label: 'Cursor',
  profile: 'cursor',
  binaries: ['cursor', 'cursor-agent'],
  // the editor alone installs no binary on PATH
  configRoot: () => join(homedir(), '.cursor'),
  skillsRoot: () => join(homedir(), '.cursor', 'skills'),

  registerMcp({ out, options }, { exe, args }) {
    writeJsonMcp(out, 'cursor', options.cursorConfigPath ?? cursorMcpPath(), { command: exe, args });
  },

  removeMcp({ out, options }) {
    writeJsonMcp(out, 'cursor', options.cursorConfigPath ?? cursorMcpPath(), null);
  },

  installNotices({ out, options }, { exe, profile }) {
    const res = upsertCursorStopHook(
      options.cursorHooksPath ?? cursorHooksPath(),
      cursorHookCommand(exe, profile),
    );
    out.info(`hook:      Cursor stop hook written to ${res.path}`);
  },

  removeNotices({ options }) {
    removeCursorStopHook(options.cursorHooksPath ?? cursorHooksPath());
  },

  hookRepair: cursorHookRepair(cursorHooksPath),
} as const satisfies HarnessAdapter;
