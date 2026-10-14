import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bundledSkillDir, bundledSkillVersion, ensureBundledSkills } from './commands/skill.js';
import { CLI_VERSION } from './output.js';
import { synchronizeInstalledSkills } from './skill-lifecycle.js';

vi.mock('./commands/skill.js', () => ({
  bundledSkillDir: vi.fn(),
  bundledSkillVersion: vi.fn(),
  ensureBundledSkills: vi.fn(),
}));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentdrop-skill-lifecycle-'));
  const bundle = join(root, 'skill', 'agentdrop');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agentdrop-cli', version: '99.0.0' }));
  vi.mocked(bundledSkillDir).mockReturnValue(bundle);
  vi.mocked(bundledSkillVersion).mockReturnValue('99.0.0');
  vi.mocked(ensureBundledSkills).mockReturnValue({
    version: '99.0.0',
    updated: true,
    installed: [{ client: 'codex', dir: join(root, 'target'), status: 'updated', files: 2 }],
    errors: [],
  });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.resetAllMocks();
});
it('reports running code separately from a newly installed CLI and verified skill', () => {
  expect(synchronizeInstalledSkills()).toEqual({
    cli_version: CLI_VERSION,
    installed_cli_version: '99.0.0',
    skill_version: '99.0.0',
    error: null,
  });
});
it('does not install development checkout skills automatically', () => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@agentdrop/cli' }));
  expect(synchronizeInstalledSkills()).toEqual({
    cli_version: CLI_VERSION,
    skill_version: null,
    error: null,
  });
  expect(ensureBundledSkills).not.toHaveBeenCalled();
});
