import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bundledSkillVersion,
  defaultSkillTargets,
  ensureBundledSkills,
  getInstalledSkillVersion,
  skillInstallCommand,
  skillRemoveCommand,
} from './skill.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const renameImplementation = vi.mocked(renameSync).getMockImplementation();
if (!renameImplementation) throw new Error('missing filesystem mock');
const originalRename = renameImplementation;
const output = { json: true, info() {}, warn() {}, error() {}, result() {} };

describe('complete bundled skill synchronization', () => {
  let root: string;
  let source: string;
  let target: { client: string; dir: string };
  function write(relative: string, content: string) {
    const path = join(source, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  function sync(version = '1.0.0') {
    return ensureBundledSkills({ targets: [target], source, version, force: true });
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentdrop-skill-sync-'));
    source = join(root, 'bundle');
    mkdirSync(source);
    vi.stubEnv('AGENTDROP_STATE_DIR', join(root, 'state'));
    vi.stubEnv('CODEX_HOME', join(root, 'codex'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
    vi.stubEnv('HOME', join(root, 'home'));
    vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'omp', 'agent'));
    target = { client: 'codex', dir: join(root, 'codex', 'skills', 'agentdrop') };
    write('SKILL.md', 'original');
    write('reference/workflows.md', 'workflow');
    write('scripts/check.sh', 'echo okay');
    write('assets/icon.svg', '<svg/>');
    vi.mocked(renameSync).mockImplementation(originalRename);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(renameSync).mockImplementation(originalRename);
    rmSync(root, { recursive: true, force: true });
  });

  it('installs the full directory and does not rewrite an unchanged bundle', () => {
    expect(sync().errors).toEqual([]);
    for (const path of ['SKILL.md', 'reference/workflows.md', 'scripts/check.sh', 'assets/icon.svg'])
      expect(readFileSync(join(target.dir, path), 'utf8')).toBe(readFileSync(join(source, path), 'utf8'));
    const before = statSync(join(target.dir, 'SKILL.md')).mtimeMs;
    expect(sync().installed[0]?.status).toBe('unchanged');
    expect(statSync(join(target.dir, 'SKILL.md')).mtimeMs).toBe(before);
    expect(getInstalledSkillVersion(target.dir)).toBe('1.0.0');
  });
  it('repairs missing files even at the same version', () => {
    sync();
    rmSync(join(target.dir, 'reference'), { recursive: true });
    expect(sync().updated).toBe(true);
    expect(readFileSync(join(target.dir, 'reference/workflows.md'), 'utf8')).toBe('workflow');
  });
  it('upgrades all files and preserves previous custom content in a private backup', () => {
    sync();
    writeFileSync(join(target.dir, 'custom.txt'), 'user work');
    writeFileSync(join(target.dir, 'SKILL.md'), 'user modified');
    write('SKILL.md', 'new official');
    rmSync(join(source, 'scripts'), { recursive: true });
    const result = sync('2.0.0');
    expect(result.errors).toEqual([]);
    expect(readFileSync(join(target.dir, 'SKILL.md'), 'utf8')).toBe('new official');
    expect(existsSync(join(target.dir, 'scripts/check.sh'))).toBe(false);
    const backup = result.installed[0]?.backup;
    expect(backup).toBeTruthy();
    expect(readFileSync(join(backup ?? '', 'custom.txt'), 'utf8')).toBe('user work');
    expect(readFileSync(join(backup ?? '', 'SKILL.md'), 'utf8')).toBe('user modified');
    expect(statSync(backup ?? '').mode & 0o777).toBe(0o700);
  });
  it('backs up unmanaged legacy directories before installing the bundle', () => {
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(join(target.dir, 'SKILL.md'), 'legacy');
    const result = sync();
    expect(readFileSync(join(result.installed[0]?.backup ?? '', 'SKILL.md'), 'utf8')).toBe('legacy');
  });
  it('does not follow symlinks from a bundle, target, or skills parent', () => {
    symlinkSync(join(root, 'outside'), join(source, 'shortcut'));
    expect(sync().errors).not.toHaveLength(0);
    unlinkSync(join(source, 'shortcut'));
    expect(readdirSync(source)).not.toContain('shortcut');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'safe');
    mkdirSync(dirname(target.dir), { recursive: true });
    symlinkSync(outside, target.dir);
    expect(sync().errors[0]?.code).toBe('SYMLINK_TARGET');
    unlinkSync(target.dir);
    rmdirSync(dirname(target.dir));
    symlinkSync(outside, dirname(target.dir));
    expect(sync().errors[0]?.code).toBe('SYMLINK_TARGET');
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('safe');
  });
  it('rolls the original directory back when publishing the staged bundle fails', () => {
    sync();
    write('SKILL.md', 'next version');
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(from).endsWith('.stage') && to === target.dir) throw new Error('injected failure');
      return originalRename(from, to);
    });
    expect(sync('2.0.0').errors).toEqual([{ client: 'codex', code: 'SKILL_SYNC_FAILED' }]);
    expect(readFileSync(join(target.dir, 'SKILL.md'), 'utf8')).toBe('original');
    expect(getInstalledSkillVersion(target.dir)).toBe('1.0.0');
    expect(readdirSync(dirname(target.dir))).toEqual(['agentdrop']);
  });
  it('honors every harness root and leaves unrelated skills alone', () => {
    const targets = defaultSkillTargets();
    expect(targets.map((t) => t.dir)).toEqual([
      join(root, 'codex/skills/agentdrop'),
      join(root, 'claude/skills/agentdrop'),
      join(root, 'config/opencode/skills/agentdrop'),
      join(root, 'home/.cursor/skills/agentdrop'),
      join(root, 'omp/agent/skills/agentdrop'),
    ]);
    for (const item of targets) mkdirSync(dirname(dirname(item.dir)), { recursive: true });
    const unrelated = join(root, 'codex/skills/other');
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(unrelated, 'SKILL.md'), 'leave alone');
    const result = ensureBundledSkills({ source, version: '1.0.0' });
    expect(result.installed.filter((i) => i.status === 'installed')).toHaveLength(5);
    for (const item of targets) {
      for (const path of ['SKILL.md', 'reference/workflows.md', 'scripts/check.sh', 'assets/icon.svg'])
        expect(readFileSync(join(item.dir, path), 'utf8')).toBe(readFileSync(join(source, path), 'utf8'));
    }
    expect(readFileSync(join(unrelated, 'SKILL.md'), 'utf8')).toBe('leave alone');
  });
  it('does not create undetected harness roots on automatic startup', () => {
    expect(ensureBundledSkills({ source }).installed.every((i) => i.status === 'skipped')).toBe(true);
    expect(existsSync(join(root, 'codex'))).toBe(false);
    expect(existsSync(join(root, 'home/.cursor'))).toBe(false);
    expect(existsSync(join(root, 'omp'))).toBe(false);
  });
  it('skill install without --only installs only for harnesses on this machine, creating no other roots', async () => {
    mkdirSync(join(root, 'codex'), { recursive: true });
    await skillInstallCommand(output, { which: (bin) => (bin === 'claude' ? '/usr/bin/claude' : null) });
    expect(existsSync(join(root, 'codex/skills/agentdrop/SKILL.md'))).toBe(true);
    // on PATH: the person has it even before its config folder exists
    expect(existsSync(join(root, 'claude/skills/agentdrop/SKILL.md'))).toBe(true);
    for (const absent of ['omp', 'home/.cursor', 'config/opencode'])
      expect(existsSync(join(root, absent))).toBe(false);
    // --only is an explicit choice and still installs where asked
    await skillInstallCommand(output, { only: ['omp'], which: () => null });
    expect(existsSync(join(root, 'omp/agent/skills/agentdrop/SKILL.md'))).toBe(true);
  });
  it('skill remove creates no directory for a harness that is not there, and still keeps it removed', async () => {
    await skillRemoveCommand(output, {});
    for (const absent of ['codex', 'claude', 'omp', 'home/.cursor', 'config/opencode'])
      expect(existsSync(join(root, absent))).toBe(false);
    mkdirSync(join(root, 'omp', 'agent'), { recursive: true });
    const omp = defaultSkillTargets().find((t) => t.client === 'omp');
    expect(omp && ensureBundledSkills({ targets: [omp], source }).installed[0]?.status).toBe('disabled');
  });
  it('removal disables rediscovery until explicit installation reenables it', async () => {
    sync();
    await skillRemoveCommand(output, { targets: [target] });
    expect(ensureBundledSkills({ targets: [target], source }).installed[0]?.status).toBe('disabled');
    expect(existsSync(target.dir)).toBe(false);
    await skillInstallCommand(output, { targets: [target] });
    expect(existsSync(join(target.dir, 'reference/workflows.md'))).toBe(true);
    expect(ensureBundledSkills({ targets: [target], source }).installed[0]?.status).not.toBe('disabled');
  });
  it('reads a valid current bundled package version', () => {
    expect(bundledSkillVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
  it('two CLI processes do not delete or partially overwrite one another', async () => {
    const script = `import { ensureBundledSkills } from ${JSON.stringify(resolve('apps/cli/src/commands/skill.ts'))}; process.stdout.write(JSON.stringify(ensureBundledSkills(${JSON.stringify({ targets: [target], source, version: '1.0.0', force: true })})));`;
    const results = await Promise.all(
      [1, 2].map(() =>
        promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
          env: process.env,
        }),
      ),
    );
    for (const result of results) {
      const parsed = JSON.parse(result.stdout);
      expect(parsed.errors.every((e: { code: string }) => e.code === 'BUSY')).toBe(true);
    }
    expect(readFileSync(join(target.dir, 'SKILL.md'), 'utf8')).toBe('original');
    expect(readFileSync(join(target.dir, 'scripts/check.sh'), 'utf8')).toBe('echo okay');
    expect(readdirSync(dirname(target.dir))).toEqual(['agentdrop']);
  });
});
