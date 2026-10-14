import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claudeJsonPath,
  claudeSettingsPath,
  codexConfigPath,
  codexHooksPath,
  cursorHookCommand,
  hookCommand,
  installOpencodeIdlePlugin,
  removeCursorStopHook,
  removeOpencodeIdlePlugin,
  repairCodexHooksFlag,
  upsertCursorStopHook,
  upsertPendingHooks,
} from './hooks.js';

describe('harness config locations and writes', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('follows CODEX_HOME and CLAUDE_CONFIG_DIR, like the skill install does', () => {
    vi.stubEnv('CODEX_HOME', '/tmp/codex-home');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/tmp/claude-home');
    expect(codexHooksPath()).toBe(join('/tmp/codex-home', 'hooks.json'));
    expect(codexConfigPath()).toBe(join('/tmp/codex-home', 'config.toml'));
    expect(claudeSettingsPath()).toBe(join('/tmp/claude-home', 'settings.json'));
    expect(claudeJsonPath()).toBe(join('/tmp/claude-home', '.claude.json'));
  });

  it('replaces a symlinked settings file through its target and keeps the link and the mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdrop-atomic-'));
    try {
      mkdirSync(join(dir, 'dotfiles'));
      const real = join(dir, 'dotfiles', 'settings.json');
      writeFileSync(real, '{"model":"x"}', { mode: 0o640 });
      const link = join(dir, 'settings.json');
      symlinkSync(real, link);
      upsertPendingHooks(link, hookCommand('/usr/local/bin/agentdrop', 'cc'));
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(real, 'utf8')).model).toBe('x');
      expect(JSON.parse(readFileSync(real, 'utf8')).hooks.Stop).toHaveLength(1);
      expect(statSync(real).mode & 0o777).toBe(0o640);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Codex legacy hook repair preserves user choices', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-hook-repair-'));
    file = join(dir, 'config.toml');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it.each([true, false])('preserves [features] hooks = %s byte-for-byte', (enabled) => {
    const source = `model = "example"\n[features]\nhooks = ${enabled}\n`;
    writeFileSync(file, source);
    expect(repairCodexHooksFlag(file)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(source);
  });
  it('removes only the root legacy flag, including comments, while retaining opt-out and trust tables', () => {
    writeFileSync(
      file,
      'hooks = true # old AgentDrop\n[features]\nhooks = false\n[hooks.state]\ntrusted = "value"\n',
    );
    expect(repairCodexHooksFlag(file)).toBe(true);
    const doc = parse(readFileSync(file, 'utf8'));
    expect(doc.features).toEqual({ hooks: false });
    expect(doc.hooks).toEqual({ state: { trusted: 'value' } });
    expect(repairCodexHooksFlag(file)).toBe(false);
  });
  it('does not change hook-looking text in multiline strings', () => {
    const source =
      'instructions = """\nhooks = false\n[features]\n"""\nhooks = true\n[features]\nhooks = false\n';
    writeFileSync(file, source);
    expect(repairCodexHooksFlag(file)).toBe(true);
    expect(parse(readFileSync(file, 'utf8'))).toEqual({
      instructions: 'hooks = false\n[features]\n',
      features: { hooks: false },
    });
  });
  it('does not overwrite a config when the proposed repair is still invalid', () => {
    const source = 'hooks = true\nnot valid toml\n';
    writeFileSync(file, source);
    expect(() => repairCodexHooksFlag(file)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(source);
  });
});

describe('Cursor and OpenCode completion adapters', () => {
  it('preserves Cursor hooks and idempotently installs/removes only AgentDrop stop', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdrop-cursor-hook-'));
    const file = join(dir, 'hooks.json');
    try {
      writeFileSync(file, JSON.stringify({ version: 1, hooks: { stop: [{ command: 'user-hook' }] } }));
      const command = cursorHookCommand('/path with spaces/agentdrop', 'cursor');
      upsertCursorStopHook(file, command);
      upsertCursorStopHook(file, command);
      const installed = JSON.parse(readFileSync(file, 'utf8'));
      expect(installed.hooks.stop).toHaveLength(2);
      expect(installed.hooks.stop[0]).toEqual({ command: 'user-hook' });
      expect(installed.hooks.stop[1]).toMatchObject({ command, loop_limit: 1 });
      expect(removeCursorStopHook(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf8')).hooks.stop).toEqual([{ command: 'user-hook' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a global OpenCode session.idle plugin with quiet AgentDrop polling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdrop-opencode-hook-'));
    const file = join(dir, 'plugins', 'agentdrop.js');
    try {
      installOpencodeIdlePlugin(file, '/path with spaces/agentdrop', 'opencode');
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('event.type !== "session.idle"');
      expect(source).toContain('client.tui.showToast');
      expect(source).toContain('--hook-output opencode');
      expect(source).toContain('const executable = "/path with spaces/agentdrop"');
      installOpencodeIdlePlugin(file, '/next/agentdrop', 'opencode');
      expect(readFileSync(file, 'utf8')).toContain('const executable = "/next/agentdrop"');
      expect(removeOpencodeIdlePlugin(file)).toBe(true);
      expect(() => readFileSync(file, 'utf8')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to replace or remove an unmanaged OpenCode plugin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdrop-opencode-unmanaged-'));
    const file = join(dir, 'agentdrop.js');
    try {
      writeFileSync(file, 'export const userPlugin = true;\n');
      expect(() => installOpencodeIdlePlugin(file, '/bin/agentdrop', 'opencode')).toThrow(/unmanaged/);
      expect(removeOpencodeIdlePlugin(file)).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe('export const userPlugin = true;\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
