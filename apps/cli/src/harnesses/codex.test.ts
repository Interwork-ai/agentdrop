import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectCommand, disconnectCommand } from '../commands/connect.js';
import { removeCodexSection, upsertCodexToml } from './codex.js';
import { silent, writeTestProfile } from './test-fixture.js';

describe('codex: connect edits only its own entries (file fallback)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-connect-'));
    process.env.AGENTDROP_CONFIG_DIR = join(dir, 'config');
    // connect records the hook events it wrote; keep that out of the real state directory.
    process.env.AGENTDROP_STATE_DIR = join(dir, 'state');
    writeTestProfile('codex', 'codex');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('codex: keeps other servers, comments and keys; replaces only our table; disconnect removes only it', async () => {
    const path = join(dir, 'config.toml');
    const original = [
      '# my codex config',
      'model = "gpt-5"',
      'approval_policy = "never"',
      '',
      '[mcp_servers.notion]',
      'command = "npx"',
      'args = ["-y", "notion-mcp"]',
      '',
      '[mcp_servers.agentdrop]',
      'command = "/old/agentdrop"',
      'args = ["mcp", "--profile", "old"]',
      '',
      '[mcp_servers.figma]',
      'url = "https://mcp.figma.com/mcp"',
      '',
    ].join('\n');
    writeFileSync(path, original);
    await connectCommand(silent, {
      harness: 'codex',
      profile: 'codex',
      executable: '/usr/local/bin/agentdrop',
      noCli: true,
      codexHooksPath: join(dir, 'hooks.json'),
      claudeSettingsPath: join(dir, 'settings.json'),
      codexConfigPath: path,
    });
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('# my codex config');
    const parsed = parseToml(text) as {
      model: string;
      mcp_servers: Record<string, { command?: string; args?: string[]; url?: string }>;
    };
    expect(parsed.model).toBe('gpt-5');
    expect(parsed.mcp_servers.notion?.args).toEqual(['-y', 'notion-mcp']);
    expect(parsed.mcp_servers.figma?.url).toBe('https://mcp.figma.com/mcp');
    expect(parsed.mcp_servers.agentdrop?.command).toBe('/usr/local/bin/agentdrop');
    expect(parsed.mcp_servers.agentdrop?.args).toEqual(['mcp', '--profile', 'codex']);
    expect(text).not.toContain('/old/agentdrop');
    // running twice is a no-op in content
    await connectCommand(silent, {
      harness: 'codex',
      profile: 'codex',
      executable: '/usr/local/bin/agentdrop',
      noCli: true,
      codexHooksPath: join(dir, 'hooks.json'),
      claudeSettingsPath: join(dir, 'settings.json'),
      codexConfigPath: path,
    });
    expect(readFileSync(path, 'utf8')).toBe(text);
    await disconnectCommand(silent, {
      harness: 'codex',
      noCli: true,
      codexHooksPath: join(dir, 'hooks.json'),
      claudeSettingsPath: join(dir, 'settings.json'),
      codexConfigPath: path,
    });
    const after = parseToml(readFileSync(path, 'utf8')) as { mcp_servers: Record<string, unknown> };
    expect(Object.keys(after.mcp_servers).sort()).toEqual(['figma', 'notion']);
  });

  it('toml helpers handle empty and trailing content', () => {
    expect(upsertCodexToml('', '/x', ['mcp'])).toMatch(
      /^\[mcp_servers\.agentdrop\]\ncommand = "\/x"\nargs = \["mcp"\]/,
    );
    expect(removeCodexSection('[mcp_servers.agentdrop]\ncommand="x"\n')).toBe('');
  });
});

/*
 * With `codex` on PATH, connect registers through `codex mcp add`. A stand-in `codex` records its argv; its
 * `mcp remove` exits 1, as a Codex build that treats a missing entry as an error, or one that cannot read its config,
 * would; `add` is what decides whether connect succeeded.
 */
describe('codex: connect through the codex CLI', () => {
  let dir: string;
  let log: string;
  let cli: string;
  const calls = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
  function fakeCodex(failAdd = false) {
    writeFileSync(
      cli,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[1] === 'remove') { process.stderr.write('No MCP server named agentdrop\\n'); process.exit(1); }
process.exit(${failAdd ? 1 : 0});
`,
    );
    chmodSync(cli, 0o755);
  }
  const options = () => ({
    harness: 'codex' as const,
    profile: 'codex',
    executable: '/usr/local/bin/agentdrop',
    which: (bin: string) => (bin === 'codex' ? cli : null),
    codexHooksPath: join(dir, 'hooks.json'),
    codexConfigPath: join(dir, 'config.toml'),
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-codex-cli-'));
    process.env.AGENTDROP_CONFIG_DIR = join(dir, 'config');
    process.env.AGENTDROP_STATE_DIR = join(dir, 'state');
    writeTestProfile('codex', 'codex');
    log = join(dir, 'calls.jsonl');
    cli = join(dir, 'codex');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a failing `codex mcp remove` does not stop `codex mcp add`', async () => {
    fakeCodex();
    await connectCommand(silent, options());
    expect(calls()).toEqual([
      ['mcp', 'remove', 'agentdrop'],
      ['mcp', 'add', 'agentdrop', '--', '/usr/local/bin/agentdrop', 'mcp', '--profile', 'codex'],
    ]);
    // the CLI owns config.toml in this path; we only wrote the hooks
    expect(existsSync(join(dir, 'config.toml'))).toBe(false);
    expect(readFileSync(join(dir, 'hooks.json'), 'utf8')).toContain('--profile codex');
  });

  it('a failing `codex mcp add` fails connect', async () => {
    fakeCodex(true);
    await expect(connectCommand(silent, options())).rejects.toThrow();
  });
});

/**
 * We edit files the user's agent depends on to start at all. A bad edit does not degrade AgentDrop, it bricks
 * Codex. So every writer is checked by parsing the result with a real parser and asserting the
 * host's documented schema, not by matching the text we just wrote.
 */
describe('codex configs stay loadable by codex', () => {
  it('never turns codex `hooks` into a boolean: that key is the hook table, and hooks need no switch', async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { parse } = await import('smol-toml');
    const { repairCodexHooksFlag } = await import('../commands/hooks.js');
    const dir = mkdtempSync(join(tmpdir(), 'agentdrop-codextoml-'));
    const cfg = join(dir, 'config.toml');

    // exactly what Codex keeps in config.toml once it has asked the user to trust a hook
    const codexOwned = [
      'model = "gpt-5"',
      '',
      '[hooks.state]',
      '',
      '[hooks.state."/home/u/.codex/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:abc"',
      '',
      '[mcp_servers.x]',
      'command = "y"',
      '',
    ].join('\n');
    writeFileSync(cfg, codexOwned);

    // a machine an older AgentDrop already damaged: `hooks` is a boolean *and* a table, which Codex cannot load
    writeFileSync(cfg, `hooks = true\n\n${codexOwned}`);
    expect(() => parse(readFileSync(cfg, 'utf8'))).toThrow();
    expect(repairCodexHooksFlag(cfg)).toBe(true);
    const repaired = parse(readFileSync(cfg, 'utf8')) as Record<string, unknown>;
    expect(typeof repaired.hooks).toBe('object'); // the trust table survived
    expect((repaired.model as string) === 'gpt-5').toBe(true);
    expect(repairCodexHooksFlag(cfg)).toBe(false); // nothing left to repair
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a codex hooks.json in the shape codex documents', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { upsertStopHook } = await import('../commands/hooks.js');
    const dir = mkdtempSync(join(tmpdir(), 'agentdrop-hooksjson-'));
    const file = join(dir, 'hooks.json');
    upsertStopHook(file, '/bin/agentdrop pending --profile codex --in-hook');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    // event -> matcher group -> handlers, with a handler type codex accepts
    const groups = doc.hooks.Stop;
    expect(Array.isArray(groups)).toBe(true);
    const handler = groups[0].hooks[0];
    expect(handler.type).toBe('command');
    expect(typeof handler.command).toBe('string');
    expect(typeof handler.timeout).toBe('number');
    expect(handler.statusMessage).toBeUndefined(); // Quiet hooks must not show a per-turn checking label.
    rmSync(dir, { recursive: true, force: true });
  });
});

it('removes all AgentDrop TOML tables, including child tables, quoted keys and trailing comments', () => {
  const original =
    '[mcp_servers."agentdrop"] # managed\ncommand="old"\n[mcp_servers.agentdrop.env]\nEXAMPLE="yes"\n[mcp_servers.other]\ncommand="keep"\n';
  expect(parseToml(removeCodexSection(original))).toEqual({ mcp_servers: { other: { command: 'keep' } } });
  const replaced = parseToml(upsertCodexToml(original, 'new', ['mcp'])) as {
    mcp_servers: Record<string, unknown>;
  };
  expect(replaced.mcp_servers.agentdrop).toMatchObject({ command: 'new', args: ['mcp'] });
  expect(replaced.mcp_servers.agentdrop).not.toHaveProperty('env');
});

it('preserves table-looking text inside multiline strings in other host settings', () => {
  const unrelated =
    'matrix = [\n[1, 2],\n[3, 4]\n]\nnotes = """\n[mcp_servers.agentdrop]\nnot a table\n"""\n';
  const original = `${unrelated}[mcp_servers.agentdrop] # comment\ncommand="old"\n`;
  expect(removeCodexSection(original).trimEnd()).toBe(unrelated.trimEnd());
});

it('does not mistake a one-item nested array for a table while removing AgentDrop', () => {
  const original = '[mcp_servers.agentdrop]\nitems = [\n [1]\n]\ncommand = "agentdrop"\n[other]\nvalue = 1\n';
  expect(parseToml(removeCodexSection(original))).toEqual({ other: { value: 1 } });
});
