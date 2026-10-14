import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLanguage } from './locale.js';
import { buildProgram, defaultProfile } from './main.js';
import { type ProfileFile, writeProfile } from './store.js';

/* `--profile` may be left out of a command a person types when only one profile is paired on this computer. */
const profile = (name: string): ProfileFile => ({
  profile: name,
  harness: 'codex',
  server_url: 'https://drop.example.com',
  h_id: '11111111-1111-4111-8111-111111111111',
  profile_key: name,
  user_id: '22222222-2222-4222-8222-222222222222',
  handle: 'alice',
  agent_name: 'Codex',
  credential_ref: { store: 'file', account: name },
  credential_expires_at: '2099-01-01T00:00:00Z',
  paired_at: '2026-01-01T00:00:00Z',
  allowed_dirs: ['/tmp/the-ablation-run'],
  toolset: 'standard',
});

describe('the profile a command uses', () => {
  let dir: string;
  let stdout: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-profile-default-'));
    vi.stubEnv('AGENTDROP_CONFIG_DIR', join(dir, 'config'));
    vi.stubEnv('AGENTDROP_STATE_DIR', join(dir, 'state'));
    vi.stubEnv('AGENTDROP_DATA_DIR', join(dir, 'data'));
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (...args: string[]) => {
    const program = buildProgram();
    const quiet = (cmd: Command) => {
      cmd.exitOverride();
      cmd.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
      for (const sub of cmd.commands) quiet(sub);
    };
    quiet(program);
    return program.parseAsync(['node', 'agentdrop', ...args]);
  };

  it('is the only one paired, otherwise the person is told which exist', () => {
    expect(defaultProfile(['codex'])).toBe('codex');
    expect(() => defaultProfile([])).toThrow(/no agent is paired on this computer yet/);
    expect(() => defaultProfile(['codex', 'cc'])).toThrow(
      '2 profiles are paired on this computer (codex, cc); add --profile <name> to say which one',
    );
    writeLanguage('zh');
    expect(() => defaultProfile(['codex', 'cc'])).toThrow('这台电脑上有 2 个配置（codex、cc）');
  });

  it('lets a person leave out --profile when there is exactly one', async () => {
    writeProfile(profile('codex'));
    await run('allow-dir', 'list');
    expect(stdout.join('')).toContain('/tmp/the-ablation-run');
  });

  it('still asks for it, listing them, when there are several', async () => {
    writeProfile(profile('codex'));
    writeProfile(profile('cc'));
    await expect(run('allow-dir', 'list')).rejects.toThrow('(cc, codex)');
    // an explicit profile works as before
    await run('allow-dir', 'list', '--profile', 'cc');
    expect(stdout.join('')).toContain('/tmp/the-ablation-run');
  });

  it('keeps it required where hooks and clients always pass it, or where it names what to forget', async () => {
    writeProfile(profile('codex'));
    for (const args of [['mcp'], ['endpoint', 'remove'], ['statusline']]) {
      await expect(run(...args)).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
    }
  });
});
