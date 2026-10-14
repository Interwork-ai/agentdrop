import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { writeFileAtomic } from '../atomic-write.js';
import { backupConfigFile } from '../backups.js';
import {
  codexConfigPath,
  codexHome,
  codexHooksPath,
  hookCommand,
  removePendingHooks,
  repairCodexHooksFlag,
  upsertPendingHooks,
} from '../commands/hooks.js';
import { pendingHooksRepair } from './hook-repair.js';
import { rememberHookEvents, SERVER_KEY } from './shared.js';
import type { HarnessAdapter } from './types.js';

export const codex = {
  key: 'codex',
  label: 'Codex',
  profile: 'codex',
  binaries: ['codex'],
  skillsRoot: () => join(codexHome(), 'skills'),

  registerMcp({ out, options, which }, { exe, args }) {
    const cli = options.noCli ? null : which('codex');
    if (cli) {
      try {
        // only clears an older entry; whether it fails (no entry, another Codex build) is not ours to decide, `add` is
        execFileSync(cli, ['mcp', 'remove', SERVER_KEY], { stdio: 'ignore' });
      } catch {
        /* not present */
      }
      execFileSync(cli, ['mcp', 'add', SERVER_KEY, '--', exe, ...args], { stdio: 'ignore' });
      out.result(
        { harness: 'codex', method: 'codex mcp add', command: exe, args },
        () => `codex: registered ${SERVER_KEY} via \`codex mcp add\` → ${exe} ${args.join(' ')}`,
      );
      return;
    }
    const path = options.codexConfigPath ?? codexConfigPath();
    const backup = backupConfigFile(path);
    const next = upsertCodexToml(existsSync(path) ? readFileSync(path, 'utf8') : '', exe, args);
    parseToml(next); // validate before writing
    writeFileAtomic(path, next);
    out.result(
      { harness: 'codex', method: 'config.toml', path, backup, command: exe, args },
      () =>
        `codex: wrote [mcp_servers.${SERVER_KEY}] in ${path}${backup ? ` (backup ${backup})` : ''}\nequivalent: codex mcp add ${SERVER_KEY} -- ${exe} ${args.join(' ')}`,
    );
  },

  removeMcp({ out, options, which }) {
    const cli = options.noCli ? null : which('codex');
    if (cli) {
      try {
        execFileSync(cli, ['mcp', 'remove', SERVER_KEY], { stdio: 'ignore' });
      } catch {
        /* not present */
      }
      out.result(
        { harness: 'codex', removed: true },
        () => `codex: removed ${SERVER_KEY} via \`codex mcp remove\``,
      );
      return;
    }
    const path = options.codexConfigPath ?? codexConfigPath();
    if (!existsSync(path))
      return out.result({ harness: 'codex', removed: false }, () => 'codex: no config file');
    const backup = backupConfigFile(path);
    writeFileAtomic(path, removeCodexSection(readFileSync(path, 'utf8')));
    out.result(
      { harness: 'codex', removed: true, path, backup },
      () => `codex: removed [mcp_servers.${SERVER_KEY}] from ${path}`,
    );
  },

  installNotices({ out, options }, { exe, profile }) {
    const res = upsertPendingHooks(options.codexHooksPath ?? codexHooksPath(), hookCommand(exe, profile));
    rememberHookEvents(res.path);
    // hooks need no switch in config.toml; older builds of this CLI wrote one that broke it, so undo that here
    const repaired = repairCodexHooksFlag(options.codexConfigPath ?? codexConfigPath());
    out.info(
      `hook:      Stop, UserPromptSubmit and SessionStart hooks written to ${res.path}; Codex asks you to trust them on first run${
        repaired ? ' (removed an invalid `hooks = true` line an older AgentDrop added to config.toml)' : ''
      }`,
    );
  },

  removeNotices({ options }) {
    removePendingHooks(options.codexHooksPath ?? codexHooksPath());
  },

  hookRepair: pendingHooksRepair(codexHooksPath),
} as const satisfies HarnessAdapter;

const SECTION_HEADER = `[mcp_servers.${SERVER_KEY}]`;

/** Replaces or appends only our TOML table; comments and other tables are preserved verbatim. */
export function upsertCodexToml(content: string, exe: string, args: string[]): string {
  const block = [
    SECTION_HEADER,
    `command = ${JSON.stringify(exe)}`,
    `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 120',
  ].join('\n');
  const stripped = removeCodexSection(content);
  const sep =
    stripped.length === 0 ? '' : stripped.endsWith('\n\n') ? '' : stripped.endsWith('\n') ? '\n' : '\n\n';
  return `${stripped}${sep}${block}\n`;
}

export function removeCodexSection(content: string): string {
  parseToml(content); // refuse malformed input before changing a host-owned configuration
  const lines = content.split('\n');
  const out: string[] = [];
  let skipping = false;
  let quote = '';
  let arrayDepth = 0;
  for (const line of lines) {
    if (!quote && arrayDepth === 0 && /^\s*\[/.test(line)) {
      // Parse the header itself, including quoted keys, child tables and trailing comments.
      try {
        const table = parseToml(line);
        const servers = table.mcp_servers;
        skipping = !!servers && typeof servers === 'object' && Object.hasOwn(servers, SERVER_KEY);
      } catch {
        // A nested array value can start with '[' too. The complete document was validated above.
      }
    }
    if (!skipping) out.push(line);
    // A header-looking line inside a multiline string is ordinary content, never a table.
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quote) {
        if (quote.startsWith('"') && char === '\\') {
          i++;
          continue;
        }
        if (line.startsWith(quote, i)) {
          const end = quote[0];
          i += quote.length - 1;
          if (quote.length === 3) while (line[i + 1] === end) i++;
          quote = '';
        }
      } else {
        if (char === '#') break;
        if (char === '[') arrayDepth++;
        if (char === ']') arrayDepth--;
        if (char === '"' || char === "'") {
          quote = line.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
          i += quote.length - 1;
        }
      }
    }
  }
  return out.join('\n').replace(/\n{3,}$/, '\n\n');
}
