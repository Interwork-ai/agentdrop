import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { claudeModPresent, installClaudeMod, MOD_ID, removeClaudeMod } from '../claude-mod.js';
import {
  claudeConfigHome,
  claudeJsonPath,
  claudeSettingsPath,
  hookCommand,
  removeClaudeStatusLine,
  removePendingHooks,
  statusLineCommand,
  upsertClaudeStatusLine,
  upsertPendingHooks,
} from '../commands/hooks.js';
import { pendingHooksRepair } from './hook-repair.js';
import { rememberHookEvents, SERVER_KEY, writeJsonMcp } from './shared.js';
import type { HarnessAdapter, Host } from './types.js';

/** A test's stub runner stands in for `claude` even with noCli. */
function claudeForMod({ options, which }: Host): { claude: string | null } & Pick<Host['options'], 'run'> {
  return {
    claude: options.noCli && !options.run ? null : which('claude'),
    ...(options.run ? { run: options.run } : {}),
  };
}

/** The mod is removed here, but its plugin entry could not be (no `claude`, or it refused): say so. */
function leftoverNote({ out }: Host, result: { pluginLeft: boolean; claudeMissing: boolean }): void {
  if (result.pluginLeft)
    out.info(
      `mod:       removed the AgentDrop mod; ${result.claudeMissing ? 'Claude Code was not found' : 'Claude Code did not remove the plugin'}, so its plugin list may still show ${MOD_ID} (\`claude plugin uninstall ${MOD_ID}\` removes it)`,
    );
}

export const claudeCode = {
  key: 'claude-code',
  label: 'Claude Code',
  profile: 'cc',
  binaries: ['claude'],
  skillsRoot: () => join(claudeConfigHome(), 'skills'),

  registerMcp({ out, options, which }, { exe, args }) {
    const cli = options.noCli ? null : which('claude');
    if (cli) {
      try {
        execFileSync(cli, ['mcp', 'remove', '--scope', 'user', SERVER_KEY], { stdio: 'ignore' });
      } catch {
        /* not present */
      }
      execFileSync(
        cli,
        ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', SERVER_KEY, '--', exe, ...args],
        { stdio: 'ignore' },
      );
      out.result(
        { harness: 'claude-code', method: 'claude mcp add', command: exe, args },
        () => `claude-code: registered ${SERVER_KEY} via \`claude mcp add\` → ${exe} ${args.join(' ')}`,
      );
      return;
    }
    writeJsonMcp(out, 'claude-code', options.claudeConfigPath ?? claudeJsonPath(), {
      type: 'stdio',
      command: exe,
      args,
    });
  },

  removeMcp({ out, options, which }) {
    const cli = options.noCli ? null : which('claude');
    if (cli) {
      try {
        execFileSync(cli, ['mcp', 'remove', '--scope', 'user', SERVER_KEY], { stdio: 'ignore' });
      } catch {
        /* not present */
      }
      out.result(
        { harness: 'claude-code', removed: true },
        () => `claude-code: removed ${SERVER_KEY} via \`claude mcp remove\``,
      );
      return;
    }
    writeJsonMcp(out, 'claude-code', options.claudeConfigPath ?? claudeJsonPath(), null);
  },

  installNotices(host, { exe, profile }) {
    const { out, options } = host;
    const settings = options.claudeSettingsPath ?? claudeSettingsPath();
    const res = upsertPendingHooks(settings, hookCommand(exe, profile));
    rememberHookEvents(res.path);
    out.info(`hook:      Stop, UserPromptSubmit and SessionStart hooks written to ${res.path}`);
    // Claude Code 2.1.287+ has mods: the waiting list above the prompt replaces the status line
    const mod = installClaudeMod({ exe, profile, ...claudeForMod(host) });
    if (mod.status === 'installed') {
      removeClaudeStatusLine(settings);
      out.info(
        'mod:       what is waiting for you shows above the prompt in every Claude Code session; /agentdrop reads it',
      );
      return;
    }
    if (mod.status === 'failed') {
      out.info('mod:       could not install the Claude Code mod; using the status line instead');
      // the cleanup after the failure may itself have left the plugin entry behind
      leftoverNote(host, mod);
    }
    // no mod this time (older Claude Code, none found, --no-cli): nothing of an earlier one may keep running
    else if (claudeModPresent()) leftoverNote(host, removeClaudeMod(claudeForMod(host)));
    const line = statusLineCommand(exe, profile);
    const status = upsertClaudeStatusLine(settings, line);
    out.info(
      status === 'yours'
        ? `status line: you already have one; to see new AgentDrop messages in it, add the output of \`${line}\``
        : 'status line: new AgentDrop messages show at the bottom of every Claude Code session',
    );
  },

  removeNotices(host) {
    const settings = host.options.claudeSettingsPath ?? claudeSettingsPath();
    removePendingHooks(settings);
    removeClaudeStatusLine(settings);
    leftoverNote(host, removeClaudeMod(claudeForMod(host)));
  },

  hookRepair: pendingHooksRepair(claudeSettingsPath),
} as const satisfies HarnessAdapter;
