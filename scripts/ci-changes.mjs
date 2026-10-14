#!/usr/bin/env node
/**
 * Decides which CI jobs a push or pull request needs, from the files it changed (docs/QUALITY.md §3).
 *
 *   node scripts/ci-changes.mjs            → writes `verify=…`, `cli=…`, `e2e=…`, `cli_nodes=…` to $GITHUB_OUTPUT
 *
 * Environment: CI_FULL=true runs everything (manual runs and the release-tag gate); CI_BASE is the commit to compare
 * with (the push's `before`, or the pull request's base); CI_RELEASE_COMMIT=true marks a `release: vX.Y.Z` commit,
 * whose only changes are version numbers and the changelog: the tag pushed with it runs the full check, so the
 * branch run skips. When the base is missing or unknown (a new branch, a force-push), everything runs.
 *
 * Only Node built-ins: the job runs it before installing dependencies.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Files whose change can affect any job: the whole check runs. */
const EVERYTHING = [
  /^\.github\/workflows\//,
  /(^|\/)package\.json$/,
  /^pnpm-(lock|workspace)\.yaml$/,
  /^\.nvmrc$/,
  /^\.npmrc$/,
  /^tsconfig[^/]*\.json$/,
  /^biome\.jsonc?$/,
  /^vitest[^/]*\.ts$/,
  /^scripts\/ci-changes\.mjs$/,
];

/** Prose only: changes nothing a job builds or tests. The public-hygiene check still reads it. */
const PROSE = [/^docs\//, /^[^/]+\.md$/, /^\.github\/(ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)/, /^LICENSE$/];

/** What the standalone CLI package is built from (`pnpm verify:cli`). */
const CLI = [
  /^apps\/cli\//,
  /^packages\/(client|contracts|mcp|security)\//,
  /^scripts\/check-cli-boundary\.mjs$/,
  /^scripts\/release\.(mjs|test\.ts)$/,
];

/** What the dashboard journeys run against: the built dashboard, the API, and everything under them. */
const E2E = [
  /^apps\/(web|api)\//,
  /^packages\/(domain|db|contracts|storage|security)\//,
  /^scripts\/e2e\//,
  /^scripts\/lib\//,
];

const ALL_NODES = [22, 24];
/** The oldest supported Node: the newest is covered by `verify` (.nvmrc). */
const MIN_NODE = [22];

/**
 * @param {string[] | null} files changed paths, or null when they cannot be known
 * @param {{ full?: boolean, releaseCommit?: boolean }} [opts]
 */
export function plan(files, { full = false, releaseCommit = false } = {}) {
  const all = { verify: true, cli: true, e2e: true, cli_nodes: ALL_NODES };
  if (full || files === null) return all;
  if (releaseCommit) return { verify: false, cli: false, e2e: false, cli_nodes: MIN_NODE };
  if (files.some((f) => EVERYTHING.some((re) => re.test(f)))) return all;
  const code = files.filter((f) => !PROSE.some((re) => re.test(f)));
  return {
    verify: code.length > 0,
    cli: code.some((f) => CLI.some((re) => re.test(f))),
    e2e: code.some((f) => E2E.some((re) => re.test(f))),
    cli_nodes: MIN_NODE,
  };
}

/** The files changed since `base`, or null when `base` is missing or not in this clone. */
export function changedFiles(base, run = (args) => execFileSync('git', args, { encoding: 'utf8' })) {
  if (!base || /^0+$/.test(base)) return null;
  try {
    return run(['diff', '--name-only', `${base}...HEAD`])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = changedFiles(process.env.CI_BASE);
  const result = plan(files, {
    full: process.env.CI_FULL === 'true',
    releaseCommit: process.env.CI_RELEASE_COMMIT === 'true',
  });
  const lines = Object.entries(result).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  console.log(
    files === null ? 'changed files: unknown, running everything' : `changed files: ${files.length}`,
  );
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}
