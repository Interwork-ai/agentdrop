// Hermetic integration smoke: the packaged CLI must maintain the complete skill tree on normal startup.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const cli = realpathSync(process.argv[2] ?? 'apps/cli/pack/out/bin/agentdrop.mjs');
const pkgRoot = resolve(dirname(cli), '..');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'agentdrop-cli', 'requires a packaged CLI');
const sandbox = mkdtempSync(join(tmpdir(), 'agentdrop-skill-smoke-'));
const targets = [
  join(sandbox, 'codex', 'skills', 'agentdrop'),
  join(sandbox, 'claude', 'skills', 'agentdrop'),
  join(sandbox, 'xdg', 'opencode', 'skills', 'agentdrop'),
  join(sandbox, 'home', '.cursor', 'skills', 'agentdrop'),
  join(sandbox, 'omp', 'agent', 'skills', 'agentdrop'),
  join(sandbox, 'workbuddy', 'skills', 'agentdrop'),
];
const env = {
  ...process.env,
  HOME: join(sandbox, 'home'),
  CODEX_HOME: join(sandbox, 'codex'),
  CLAUDE_CONFIG_DIR: join(sandbox, 'claude'),
  XDG_CONFIG_HOME: join(sandbox, 'xdg'),
  PI_CODING_AGENT_DIR: join(sandbox, 'omp', 'agent'),
  WORKBUDDY_CONFIG_DIR: join(sandbox, 'workbuddy'),
  AGENTDROP_CONFIG_DIR: join(sandbox, 'config'),
  AGENTDROP_STATE_DIR: join(sandbox, 'state'),
  AGENTDROP_DATA_DIR: join(sandbox, 'data'),
};
const run = (...args) =>
  execFileSync(process.execPath, [cli, ...args], { env, stdio: 'pipe', timeout: 15_000 });
function verify() {
  for (const target of targets) {
    const manifest = JSON.parse(readFileSync(join(target, '.agentdrop-manifest.json'), 'utf8'));
    assert.equal(manifest.version, pkg.version);
    assert.ok(manifest.files['SKILL.md']);
    assert.ok(manifest.files['reference/workflows.md']);
    assert.ok(manifest.files['reference/groups.md']);
    for (const [file, hash] of Object.entries(manifest.files)) {
      assert.equal(
        createHash('sha256')
          .update(readFileSync(join(target, file)))
          .digest('hex'),
        hash,
      );
      assert.deepEqual(
        readFileSync(join(target, file)),
        readFileSync(join(pkgRoot, 'skill', 'agentdrop', file)),
      );
    }
  }
}
try {
  for (const target of targets) mkdirSync(dirname(dirname(target)), { recursive: true });
  run('settings');
  verify();
  for (const target of targets) {
    writeFileSync(join(target, 'reference/workflows.md'), 'changed old skill');
    writeFileSync(join(target, 'obsolete.txt'), 'old version file');
  }
  run('settings');
  verify();
  for (const target of targets) assert.equal(existsSync(join(target, 'obsolete.txt')), false);
  run('skill', 'remove');
  run('settings');
  for (const target of targets)
    assert.equal(existsSync(target), false, 'explicit uninstall must stay disabled');
  run('skill', 'install');
  verify();
  console.log(
    `[skills-smoke] ${pkg.version}: startup install, full-folder repair, uninstall and reinstall verified for ${targets.length} harnesses`,
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
