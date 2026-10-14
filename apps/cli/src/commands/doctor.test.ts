import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { synchronizeInstalledHooks } from '../hook-lifecycle.js';
import { hookCheck } from './doctor.js';

vi.mock('../skill-lifecycle.js', () => ({ isPackagedCli: () => true }));

describe('doctor: hook files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-doctor-'));
    vi.stubEnv('AGENTDROP_STATE_DIR', join(dir, 'state'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(dir, 'claude'));
    vi.stubEnv('CODEX_HOME', join(dir, 'codex'));
    vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'omp'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('says it cannot read a hook file that does not parse, instead of "not installed"', () => {
    const settings = join(dir, 'claude', 'settings.json');
    mkdirSync(join(dir, 'claude'), { recursive: true });
    writeFileSync(settings, '{ "hooks": { "Stop": [ }');
    expect(hookCheck('cc', 'claude-code', new Set(['cc']))).toEqual({
      name: 'profile cc: completion hooks',
      status: 'warn',
      detail: `cannot read ${settings}; fix that file, then run agentdrop connect claude-code --profile cc`,
    });
    const hooks = join(dir, 'codex', 'hooks.json');
    mkdirSync(join(dir, 'codex'), { recursive: true });
    writeFileSync(hooks, '[]');
    expect(hookCheck('codex', 'codex', new Set(['codex'])).detail).toBe(
      `cannot read ${hooks}; fix that file, then run agentdrop connect codex --profile codex`,
    );
    // an extension path that cannot be read (here a directory) is not "not installed" either
    const extension = join(dir, 'omp', 'extensions', 'agentdrop.js');
    mkdirSync(extension, { recursive: true });
    expect(hookCheck('omp', 'omp', new Set(['omp'])).detail).toMatch(/^cannot read /);
    // the startup repair leaves such files alone and does not fail
    expect(synchronizeInstalledHooks({ cursor: join(dir, 'none.json') })).toEqual({
      repaired: [],
      error: null,
    });
  });

  it('still says "not installed" when the file is missing or has no AgentDrop hook', () => {
    expect(hookCheck('cc', 'claude-code', new Set(['cc'])).detail).toBe(
      'not installed; run agentdrop connect claude-code --profile cc',
    );
    mkdirSync(join(dir, 'claude'), { recursive: true });
    writeFileSync(join(dir, 'claude', 'settings.json'), '{"theme":"dark"}');
    expect(hookCheck('cc', 'claude-code', new Set(['cc'])).detail).toBe(
      'not installed; run agentdrop connect claude-code --profile cc',
    );
  });
});
