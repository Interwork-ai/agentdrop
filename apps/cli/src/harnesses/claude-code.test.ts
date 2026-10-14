import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectCommand, disconnectCommand } from '../commands/connect.js';
import { writeDevice, writeProfile } from '../store.js';
import { silent, writeTestProfile } from './test-fixture.js';

// the mod records the Claude Code config directory it was installed into: the default one, unless a test names one
const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;
beforeEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir;
});

describe('claude-code: connect edits only its own entries (file fallback)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-connect-'));
    process.env.AGENTDROP_CONFIG_DIR = join(dir, 'config');
    // connect records the hook events it wrote; keep that out of the real state directory.
    process.env.AGENTDROP_STATE_DIR = join(dir, 'state');
    writeTestProfile('codex', 'codex');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('claude-code: edits only mcpServers.agentdrop in ~/.claude.json', async () => {
    const path = join(dir, '.claude.json');
    writeFileSync(
      path,
      JSON.stringify({
        numStartups: 5,
        mcpServers: { drawio: { type: 'stdio', command: 'x' } },
        projects: { '/a': {} },
      }),
    );
    await connectCommand(silent, {
      harness: 'claude-code',
      profile: 'codex',
      executable: '/usr/local/bin/agentdrop',
      noCli: true,
      codexHooksPath: join(dir, 'hooks.json'),
      claudeSettingsPath: join(dir, 'settings.json'),
      claudeConfigPath: path,
    });
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    expect(cfg.numStartups).toBe(5);
    expect(cfg.projects).toEqual({ '/a': {} });
    expect(cfg.mcpServers.drawio).toEqual({ type: 'stdio', command: 'x' });
    expect(cfg.mcpServers.agentdrop).toEqual({
      type: 'stdio',
      command: '/usr/local/bin/agentdrop',
      args: ['mcp', '--profile', 'codex'],
    });
    await disconnectCommand(silent, {
      harness: 'claude-code',
      noCli: true,
      codexHooksPath: join(dir, 'hooks.json'),
      claudeSettingsPath: join(dir, 'settings.json'),
      claudeConfigPath: path,
    });
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).mcpServers)).toEqual(['drawio']);
  });
});

describe('claude-code configs stay loadable by Claude Code', () => {
  it('leaves an unrelated claude settings file valid and intact', async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { removeStopHook, upsertStopHook } = await import('../commands/hooks.js');
    const dir = mkdtempSync(join(tmpdir(), 'agentdrop-claude-'));
    const settings = join(dir, 'settings.json');
    const original = {
      model: 'sonnet',
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'someone-elses-hook' }] }],
      },
    };
    writeFileSync(settings, JSON.stringify(original, null, 2));
    upsertStopHook(settings, '/bin/agentdrop pending --profile cc --in-hook');
    removeStopHook(settings);
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(original);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Claude Code status line', () => {
  it('fills an empty status line, never replaces one the person set, and removes only its own', async () => {
    const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { upsertClaudeStatusLine, removeClaudeStatusLine, statusLineCommand } = await import(
      '../commands/hooks.js'
    );
    const dir = mkdtempSync(join(tmpdir(), 'agentdrop-statusline-'));
    const path = join(dir, 'settings.json');
    const ours = statusLineCommand('/opt/agent drop/agentdrop', 'cc');
    expect(ours).toBe("'/opt/agent drop/agentdrop' statusline --profile cc");
    expect(upsertClaudeStatusLine(path, ours)).toBe('added');
    expect(upsertClaudeStatusLine(path, ours)).toBe('current');
    expect(upsertClaudeStatusLine(path, statusLineCommand('/usr/bin/agentdrop', 'cc'))).toBe('updated');
    expect(removeClaudeStatusLine(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).statusLine).toBeUndefined();

    const mine = { type: 'command', command: '~/.claude/statusline.sh', padding: 0 };
    writeFileSync(path, JSON.stringify({ statusLine: mine, theme: 'dark' }));
    expect(upsertClaudeStatusLine(path, ours)).toBe('yours');
    expect(removeClaudeStatusLine(path)).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ statusLine: mine, theme: 'dark' });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Claude Code 2.1.287+: the mod instead of the status line', () => {
  it('installs the mod for a Claude Code with mods, keeps the status line for older ones', async () => {
    const { mkdtempSync, existsSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'agentdrop-mod-connect-'));
    process.env.AGENTDROP_CONFIG_DIR = join(dir, 'config');
    process.env.AGENTDROP_STATE_DIR = join(dir, 'state');
    process.env.AGENTDROP_DATA_DIR = join(dir, 'data');
    writeDevice({ installation_id: '11111111-1111-4111-8111-111111111111', label: 'box', created_at: 'now' });
    writeProfile({
      profile: 'cc',
      server_url: 'https://drop.example.test',
      h_id: '11111111-1111-4111-8111-111111111111',
      harness: 'claude-code',
      profile_key: 'cc',
      user_id: '22222222-2222-4222-8222-222222222222',
      handle: 'alice',
      agent_name: 'A',
      credential_ref: { store: 'file', account: 'x' },
      credential_expires_at: new Date(Date.now() + 86400000).toISOString(),
      paired_at: 'now',
      allowed_dirs: [],
      toolset: 'standard',
    });
    const calls: string[][] = [];
    const runFor = (version: string) => (argv: readonly string[]) => {
      calls.push([...argv]);
      return argv[1] === '--version'
        ? { status: 0, stdout: `${version} (Claude Code)` }
        : { status: 0, stdout: '' };
    };
    const paths = {
      claudeConfigPath: join(dir, '.claude.json'),
      claudeSettingsPath: join(dir, 'claude', 'settings.json'),
      which: () => '/usr/local/bin/claude',
    };
    const settings = () => JSON.parse(readFileSync(paths.claudeSettingsPath, 'utf8'));

    await connectCommand(silent, {
      harness: 'claude-code',
      profile: 'cc',
      executable: '/opt/agentdrop',
      noCli: true,
      run: runFor('2.1.200'),
      ...paths,
    });
    expect(settings().statusLine.command).toBe('/opt/agentdrop statusline --profile cc');
    expect(existsSync(join(dir, 'config', 'claude-mod.json'))).toBe(false);

    calls.length = 0;
    await connectCommand(silent, {
      harness: 'claude-code',
      profile: 'cc',
      executable: '/opt/agentdrop',
      noCli: true,
      run: runFor('2.1.287'),
      ...paths,
    });
    expect(calls.map((c) => c.slice(1, 3).join(' '))).toEqual([
      '--version',
      'plugin marketplace',
      'plugin install',
      'plugin update',
    ]);
    // the band above the prompt replaces our status line; the hooks stay
    expect(settings().statusLine).toBeUndefined();
    expect(settings().hooks.UserPromptSubmit).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'config', 'claude-mod.json'), 'utf8'))).toEqual({
      argv: ['/opt/agentdrop'],
      profile: 'cc',
      claude_dirs: [null],
    });

    calls.length = 0;
    await disconnectCommand(silent, {
      harness: 'claude-code',
      noCli: true,
      run: runFor('2.1.287'),
      ...paths,
    });
    expect(calls.map((c) => c.slice(1, 3).join(' '))).toEqual(['plugin uninstall', 'plugin marketplace']);
    expect(existsSync(join(dir, 'config', 'claude-mod.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Claude Code mod: nothing of it stays when connect does not install it', () => {
  it('removes an earlier mod when Claude Code is now older, missing, or the install fails', async () => {
    const { existsSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'agentdrop-mod-leftover-'));
    process.env.AGENTDROP_CONFIG_DIR = join(dir, 'config');
    process.env.AGENTDROP_STATE_DIR = join(dir, 'state');
    process.env.AGENTDROP_DATA_DIR = join(dir, 'data');
    writeTestProfile('cc', 'claude-code');
    const calls: string[][] = [];
    const runFor =
      (version: string, fail: string | string[] = []) =>
      (argv: readonly string[]): { status: number; stdout: string } => {
        calls.push([...argv]);
        if (argv[1] === '--version') return { status: 0, stdout: `${version} (Claude Code)` };
        return { status: [fail].flat().includes(argv.slice(1, 3).join(' ')) ? 1 : 0, stdout: '' };
      };
    const lines: string[] = [];
    const out = { ...silent, info: (m: string) => lines.push(m) };
    const base = {
      harness: 'claude-code' as const,
      profile: 'cc',
      executable: '/opt/agentdrop',
      noCli: true,
      claudeConfigPath: join(dir, '.claude.json'),
      claudeSettingsPath: join(dir, 'claude', 'settings.json'),
    };
    const installed = () => existsSync(join(dir, 'config', 'claude-mod.json'));
    const copy = () => existsSync(join(dir, 'data', 'claude-mod'));
    const connect = async (version: string, fail?: string | string[]) => {
      calls.length = 0;
      lines.length = 0;
      await connectCommand(out, {
        ...base,
        run: runFor(version, fail),
        which: () => '/usr/local/bin/claude',
      });
    };

    await connect('2.1.287');
    expect(installed() && copy()).toBe(true);
    // Claude Code went back to a version without mods: the mod goes, the status line comes back
    await connect('2.1.200');
    expect(installed() || copy()).toBe(false);
    expect(calls.map((c) => c.slice(1, 3).join(' '))).toEqual([
      '--version',
      'plugin uninstall',
      'plugin marketplace',
    ]);

    await connect('2.1.287');
    // the plugin install fails: no claude-mod.json and no copy left for a session to load
    await connect('2.1.287', 'plugin install');
    expect(installed() || copy()).toBe(false);
    expect(lines.some((l) => l.includes('using the status line instead'))).toBe(true);
    expect(lines.some((l) => l.includes('plugin list may still show'))).toBe(false);

    // the install fails and so does the cleanup's uninstall: the person is told the plugin entry may remain
    await connect('2.1.287', ['plugin install', 'plugin uninstall']);
    expect(installed() || copy()).toBe(false);
    expect(lines.some((l) => l.includes('using the status line instead'))).toBe(true);
    expect(
      lines.some((l) =>
        l.includes('Claude Code did not remove the plugin, so its plugin list may still show'),
      ),
    ).toBe(true);

    await connect('2.1.287');
    // Claude Code is not on PATH (and no stub runner): files go, and the person is told the entry may remain
    lines.length = 0;
    await connectCommand(out, { ...base, which: () => null });
    expect(installed() || copy()).toBe(false);
    expect(lines.some((l) => l.includes('plugin list may still show agentdrop@agentdrop-local'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

/*
 * With `claude` on PATH, connect registers through `claude mcp add`. A stand-in `claude` records its argv; its
 * `mcp remove` exits 1 (no entry yet), which must not stop the add; a failing add fails connect.
 */
describe('claude-code: connect through the claude CLI', () => {
  let dir: string;
  let log: string;
  let cli: string;
  const calls = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
  function fakeClaudeBin(failAdd = false) {
    writeFileSync(
      cli,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[1] === 'remove') { process.stderr.write('No MCP server found\\n'); process.exit(1); }
process.exit(${failAdd ? 1 : 0});
`,
    );
    chmodSync(cli, 0o755);
  }
  const options = () => ({
    harness: 'claude-code' as const,
    profile: 'cc',
    executable: '/usr/local/bin/agentdrop',
    which: (bin: string) => (bin === 'claude' ? cli : null),
    claudeConfigPath: join(dir, '.claude.json'),
    claudeSettingsPath: join(dir, 'claude', 'settings.json'),
    // a Claude Code without mods, so only the MCP registration goes through the stand-in
    run: (argv: readonly string[]) =>
      argv[1] === '--version' ? { status: 0, stdout: '2.1.200 (Claude Code)' } : { status: 0, stdout: '' },
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-claude-cli-'));
    process.env.AGENTDROP_CONFIG_DIR = join(dir, 'config');
    process.env.AGENTDROP_STATE_DIR = join(dir, 'state');
    process.env.AGENTDROP_DATA_DIR = join(dir, 'data');
    writeTestProfile('cc', 'claude-code');
    log = join(dir, 'calls.jsonl');
    cli = join(dir, 'claude-bin');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a failing `claude mcp remove` does not stop `claude mcp add`', async () => {
    fakeClaudeBin();
    await connectCommand(silent, options());
    expect(calls()).toEqual([
      ['mcp', 'remove', '--scope', 'user', 'agentdrop'],
      [
        'mcp',
        'add',
        '--transport',
        'stdio',
        '--scope',
        'user',
        'agentdrop',
        '--',
        '/usr/local/bin/agentdrop',
        'mcp',
        '--profile',
        'cc',
      ],
    ]);
    // the CLI owns ~/.claude.json in this path; we only wrote the hooks
    expect(existsSync(join(dir, '.claude.json'))).toBe(false);
    expect(readFileSync(join(dir, 'claude', 'settings.json'), 'utf8')).toContain('--profile cc');
  });

  it('a failing `claude mcp add` fails connect', async () => {
    fakeClaudeBin(true);
    await expect(connectCommand(silent, options())).rejects.toThrow();
  });
});
