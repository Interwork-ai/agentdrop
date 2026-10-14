import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readLanguage } from './locale.js';

const main = resolve(import.meta.dirname, 'main.ts');
const tsx = resolve(import.meta.dirname, '../../../node_modules/.bin/tsx');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentdrop-locale-'));
  vi.stubEnv('AGENTDROP_CONFIG_DIR', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

it('defaults notices to English and switches with agentdrop settings --language', () => {
  const run = (...args: string[]) =>
    spawnSync(tsx, [main, '--json', 'settings', ...args], {
      env: { ...process.env, AGENTDROP_CONFIG_DIR: dir, AGENTDROP_STATE_DIR: join(dir, 'state') },
      encoding: 'utf8',
    });
  expect(readLanguage()).toBe('en');
  expect(JSON.parse(run().stdout).language).toBe('en');
  const zh = run('--language', 'zh');
  expect(zh.status, zh.stderr).toBe(0);
  expect(JSON.parse(zh.stdout).language).toBe('zh');
  expect(readLanguage()).toBe('zh');
  const bad = run('--language', 'fr');
  expect(bad.stderr).toContain('--language must be en or zh');
  expect(readLanguage()).toBe('zh');
}, 60_000);
