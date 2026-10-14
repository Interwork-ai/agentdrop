import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const releaseScript = resolve(import.meta.dirname, 'release.mjs');
const cliFiles = ['apps/cli/package.json', 'apps/cli/pkg/package.json', 'apps/cli/src/output.ts'];
const changelog = 'CHANGELOG.md';
const serverPackages = [
  'package.json',
  ...['apps/api', 'apps/worker', 'apps/web', 'packages/db', 'packages/domain', 'packages/storage'].map(
    (dir) => `${dir}/package.json`,
  ),
];
const serverFiles = [...serverPackages, 'apps/api/src/config.ts'];
const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'agentdrop-release-test-'));
  roots.push(cwd);
  function write(path: string, text: string) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  for (const path of [...serverPackages, ...cliFiles.slice(0, 2), 'packages/contracts/package.json'])
    write(path, `${JSON.stringify({ name: path, version: '1.2.3' }, null, 2)}\n`);
  write(cliFiles[2] ?? '', "export const CLI_VERSION = '1.2.3';\n");
  write('apps/api/src/config.ts', "const config = { APP_VERSION: z.string().default('1.2.3') };\n");
  write(
    'CHANGELOG.md',
    '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Something.\n\n## [1.2.3] - 2026-01-01\n\n- Old.\n',
  );
  git(cwd, 'init', '-q', '-b', 'test-release');
  git(cwd, 'config', 'user.name', 'Release Test');
  git(cwd, 'config', 'user.email', 'release@example.test');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'fixture');
  return cwd;
}
function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [releaseScript, ...args], { cwd, encoding: 'utf8' });
}
function unchanged(cwd: string) {
  expect(git(cwd, 'status', '--porcelain')).toBe('');
  expect(git(cwd, 'rev-list', '--count', 'HEAD')).toBe('1');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('scoped release preparation', () => {
  it.each([
    ['cli', cliFiles, serverFiles],
    ['server', serverFiles, cliFiles],
  ] as const)('prepares only %s versions without committing or tagging', (scope, changed, preserved) => {
    const cwd = fixture();
    const before = new Map(preserved.map((path) => [path, readFileSync(join(cwd, path), 'utf8')]));
    const result = run(cwd, '1.3.0', '--scope', scope, '--prepare');
    expect(result.status, result.stderr).toBe(0);
    expect(git(cwd, 'diff', '--name-only').split('\n').sort()).toEqual([...changed, changelog].sort());
    for (const path of changed) expect(readFileSync(join(cwd, path), 'utf8')).toContain('1.3.0');
    for (const [path, content] of before) expect(readFileSync(join(cwd, path), 'utf8')).toBe(content);
    expect(git(cwd, 'tag', '--list')).toBe('');
    expect(git(cwd, 'rev-list', '--count', 'HEAD')).toBe('1');
  });
  it('defaults to the legacy all scope', () => {
    const cwd = fixture();
    expect(run(cwd, '1.3.0', '--prepare').status).toBe(0);
    expect(readFileSync(join(cwd, 'packages/contracts/package.json'), 'utf8')).toContain('1.3.0');
    expect(git(cwd, 'diff', '--name-only').split('\n').sort()).toEqual(
      [...cliFiles, ...serverFiles, 'packages/contracts/package.json', changelog].sort(),
    );
  });
  it('turns the Unreleased notes into the release section and opens a fresh one', () => {
    const cwd = fixture();
    expect(run(cwd, '1.3.0', '--prepare').status).toBe(0);
    const text = readFileSync(join(cwd, changelog), 'utf8');
    expect(text).toMatch(
      /^## \[Unreleased\]\n\n## \[1\.3\.0\] - \d{4}-\d{2}-\d{2}\n\n### Fixed\n\n- Something\.\n\n## \[1\.2\.3\]/m,
    );
    const server = fixture();
    expect(run(server, '1.3.0', '--scope', 'server', '--prepare').status).toBe(0);
    expect(readFileSync(join(server, changelog), 'utf8')).toContain('## [server-1.3.0] - ');
  });
  it.each([
    ['an empty Unreleased section', '# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-01-01\n'],
    ['no Unreleased section', '# Changelog\n\n## [1.2.3] - 2026-01-01\n'],
  ])('refuses %s before editing anything', (_label, content) => {
    const cwd = fixture();
    writeFileSync(join(cwd, changelog), content);
    git(cwd, 'commit', '-qam', 'changelog');
    const result = run(cwd, '1.3.0', '--prepare');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/CHANGELOG\.md/);
    expect(git(cwd, 'status', '--porcelain')).toBe('');
  });
  it('refuses a dirty tree before editing versions', () => {
    const cwd = fixture();
    writeFileSync(join(cwd, 'untracked.txt'), 'preserve me');
    const result = run(cwd, '1.3.0', '--prepare');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not clean');
    expect(git(cwd, 'diff')).toBe('');
    expect(git(cwd, 'tag', '--list')).toBe('');
  });
  it.each(['1.2.3', '1.1.9', '01.3.0', '1.3.0-beta', 'not-a-version'])(
    'refuses invalid/non-increasing %s without writes',
    (version) => {
      const cwd = fixture();
      expect(run(cwd, version, '--prepare').status).toBe(1);
      unchanged(cwd);
      expect(git(cwd, 'tag', '--list')).toBe('');
    },
  );
  it.each([
    ['cli', 'v1.3.0'],
    ['server', 'server-v1.3.0'],
  ])('checks the %s tag namespace before editing', (scope, tag) => {
    const cwd = fixture();
    git(cwd, 'tag', tag ?? '');
    const result = run(cwd, '1.3.0', '--scope', scope ?? '', '--prepare');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already exists');
    unchanged(cwd);
    expect(git(cwd, 'tag', '--list')).toBe(tag);
  });
  it('rejects detached HEAD before editing', () => {
    const cwd = fixture();
    git(cwd, 'checkout', '--detach', '-q');
    expect(run(cwd, '1.3.0', '--prepare').stderr).toContain('detached HEAD');
    unchanged(cwd);
  });
});

/*
 * Publishing through a pull request: the default branch takes no direct pushes (repository ruleset), so the version
 * commit goes to release/<tag>, a pull request is squash-merged, and only then is the merged commit tagged. A local
 * bare repository stands in for GitHub; fake `gh` and `pnpm` on PATH merge the pull request and skip verification.
 */
describe('publishing through a pull request', () => {
  function published(extraOnMerge = '') {
    const cwd = fixture();
    const remote = mkdtempSync(join(tmpdir(), 'agentdrop-release-remote-'));
    const bin = mkdtempSync(join(tmpdir(), 'agentdrop-release-bin-'));
    roots.push(remote, bin);
    git(remote, 'init', '-q', '--bare', '-b', 'test-release');
    git(cwd, 'remote', 'add', 'origin', remote);
    git(cwd, 'push', '-q', 'origin', 'test-release');
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // `gh pr merge <branch> --squash`: squash the branch onto the base in a scratch clone, push, delete the branch
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh
set -e
echo "gh $*" >> "${join(bin, 'calls.log')}"
[ "$1 $2" = "pr create" ] && exit 0
if [ "$1 $2" = "pr merge" ]; then
  tmp=$(mktemp -d); git clone -q "${remote}" "$tmp"; cd "$tmp"
  git -c user.name=gh -c user.email=gh@example.test merge -q --squash "origin/$3"
  ${extraOnMerge}
  git -c user.name=gh -c user.email=gh@example.test commit -qm "release: squashed"
  git push -q origin HEAD:test-release
  git push -q origin --delete "$3"
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );
    const result = spawnSync(process.execPath, [releaseScript, '1.3.0'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const calls = readFileSync(join(bin, 'calls.log'), 'utf8');
    return { cwd, remote, result, calls };
  }

  it('merges the version commit by pull request and tags the merged commit', () => {
    const { cwd, remote, result, calls } = published();
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('gh pr create --base test-release --head release/v1.3.0 --title release: v1.3.0');
    expect(calls).toContain('gh pr merge release/v1.3.0 --squash --delete-branch --subject release: v1.3.0');
    // the tag on the remote points at the merged commit of the default branch, which has the new version
    const main = git(remote, 'rev-parse', 'test-release');
    expect(git(remote, 'rev-parse', 'v1.3.0^{commit}')).toBe(main);
    expect(git(remote, 'show', `${main}:apps/cli/package.json`)).toContain('"version": "1.3.0"');
    // the release branch is gone and the local branch sits on the merged commit
    expect(git(remote, 'branch', '--list', 'release/*')).toBe('');
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(main);
    expect(git(cwd, 'status', '--porcelain')).toBe('');
  });

  it('does not tag when something else reached the default branch with the merge', () => {
    const { remote, result } = published('echo extra > extra.txt; git add extra.txt');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('differs from the verified release commit');
    expect(git(remote, 'tag', '--list')).toBe('');
  });
});
