// Stable releases only. --prepare leaves reviewable version edits without publishing.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const usage =
  'usage: pnpm release X.Y.Z [--scope cli|server|all] [--prepare] (stable versions only; default scope: all)';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });

function newer(next, previous) {
  if (!stable.test(previous)) throw new Error(`current version ${previous} is not a stable X.Y.Z version`);
  const a = next.split('.').map(BigInt);
  const b = previous.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function main() {
  const [version, ...args] = process.argv.slice(2);
  if (!version || !stable.test(version)) throw new Error(usage);
  let scope = 'all';
  let prepare = false;
  let scopeSeen = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prepare' && !prepare) prepare = true;
    else if (args[i] === '--scope' && !scopeSeen && ['cli', 'server', 'all'].includes(args[i + 1])) {
      scope = args[++i];
      scopeSeen = true;
    } else throw new Error(usage);
  }
  if (resolve(git('rev-parse', '--show-toplevel')) !== resolve(process.cwd()))
    throw new Error('run release from the repository root');
  const branch = git('branch', '--show-current');
  if (!branch) throw new Error('cannot release from detached HEAD');
  if (git('status', '--porcelain')) throw new Error('working tree not clean; commit or stash first');
  const tag = `${scope === 'server' ? 'server-v' : 'v'}${version}`;
  if (git('tag', '--list', tag)) throw new Error(`tag ${tag} already exists`);
  if (!prepare) {
    git('remote', 'get-url', 'origin');
    if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`))
      throw new Error(`remote tag ${tag} already exists`);
  }

  const packages =
    scope === 'cli'
      ? ['apps/cli/package.json', 'apps/cli/pkg/package.json']
      : scope === 'server'
        ? [
            'package.json',
            ...[
              'apps/api',
              'apps/worker',
              'apps/web',
              'packages/db',
              'packages/domain',
              'packages/storage',
            ].map((dir) => `${dir}/package.json`),
          ]
        : [
            'package.json',
            'apps/cli/pkg/package.json',
            ...['apps', 'packages'].flatMap((dir) =>
              readdirSync(dir)
                .map((name) => join(dir, name, 'package.json'))
                .filter(existsSync),
            ),
          ];
  const edits = new Map();
  function checkVersion(previous, path) {
    if (!newer(version, previous)) throw new Error(`${path}: ${version} must be newer than ${previous}`);
  }
  for (const path of packages) {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    checkVersion(json.version, path);
    json.version = version;
    edits.set(path, `${JSON.stringify(json, null, 2)}\n`);
  }
  function sourceVersion(path, pattern) {
    const source = readFileSync(path, 'utf8');
    const match = pattern.exec(source);
    if (!match) throw new Error(`${path}: version declaration not found`);
    checkVersion(match[2], path);
    edits.set(
      path,
      source.replace(pattern, (_whole, prefix, _old, suffix) => `${prefix}${version}${suffix}`),
    );
  }
  if (scope !== 'server') sourceVersion('apps/cli/src/output.ts', /(CLI_VERSION = ')([^']+)(')/);
  if (scope !== 'cli')
    sourceVersion('apps/api/src/config.ts', /(APP_VERSION: z\.string\(\)\.default\(')([^']+)('\))/);
  // Keep a Changelog: the Unreleased notes become this release's section; an empty section blocks the release.
  {
    const path = 'CHANGELOG.md';
    if (!existsSync(path))
      throw new Error('CHANGELOG.md not found; add one with a "## [Unreleased]" section');
    const text = readFileSync(path, 'utf8');
    const match = /^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m.exec(text);
    if (!match) throw new Error('CHANGELOG.md: no "## [Unreleased]" section');
    if (!(match[1] ?? '').trim())
      throw new Error('CHANGELOG.md: the Unreleased section is empty; describe what this release changes');
    const label = scope === 'server' ? `server-${version}` : version;
    const date = new Date().toISOString().slice(0, 10);
    edits.set(path, text.replace(match[0], `## [Unreleased]\n\n## [${label}] - ${date}\n${match[1]}`));
  }
  // Every precondition and file read is complete before the first version edit.
  for (const [path, content] of edits) writeFileSync(path, content);
  if (prepare) {
    console.log(
      `Prepared ${scope} ${version} (${edits.size} files). Review and verify before committing; no commit, tag or push performed.`,
    );
    return;
  }
  run('pnpm', [scope === 'cli' ? 'verify:cli' : 'verify']);
  run('git', ['add', '--', ...edits.keys()]);
  run('git', ['commit', '-m', `release: ${tag}`]);
  // The default branch only takes pull requests (repository ruleset), so the version commit goes in through one:
  // push it to release/<tag>, open and squash-merge the pull request, then tag the merged commit. CI skips a
  // release commit's own run; the tag runs the full check.
  const releaseBranch = `release/${tag}`;
  run('git', ['push', 'origin', `HEAD:refs/heads/${releaseBranch}`]);
  run('gh', [
    'pr',
    'create',
    '--base',
    branch,
    '--head',
    releaseBranch,
    '--title',
    `release: ${tag}`,
    '--body',
    `Version files and CHANGELOG for ${tag} (\`pnpm release\`).`,
  ]);
  run('gh', ['pr', 'merge', releaseBranch, '--squash', '--delete-branch', '--subject', `release: ${tag}`]);
  run('git', ['fetch', 'origin', branch]);
  // the merged commit must hold exactly what was verified; anything else merged meanwhile stops the release untagged
  if (git('rev-parse', `origin/${branch}^{tree}`) !== git('rev-parse', 'HEAD^{tree}'))
    throw new Error(
      `${branch} on origin differs from the verified release commit (something else was merged); ${tag} was not tagged. Update ${branch}, then tag the release commit by hand after checking it.`,
    );
  run('git', ['reset', '--keep', `origin/${branch}`]);
  run('git', ['tag', '-a', tag, '-m', tag]);
  run('git', ['push', 'origin', `refs/tags/${tag}`]);
  console.log(`Released ${scope} ${version} as ${tag}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
