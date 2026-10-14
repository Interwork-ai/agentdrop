import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { acquireStateLock } from './state-lock.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentdrop-state-lock-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A directory lock exactly as `acquireStateLock` publishes it, owned by `pid`. */
function lockOwnedBy(pid: number): string {
  const lock = join(dir, 'state.json.lock');
  const token = '00000000-0000-4000-8000-000000000000';
  mkdirSync(lock);
  writeFileSync(join(lock, `owner-${token}.json`), JSON.stringify({ pid, token }));
  return lock;
}

it('reaps a fresh lock left by a killed hook instead of waiting ten minutes', () => {
  const exited = spawnSync(process.execPath, ['-e', '']);
  const lock = lockOwnedBy(exited.pid as number);
  const release = acquireStateLock(lock);
  expect(release).toBeTypeOf('function');
  release?.();
});

it('never takes a lock from a live owner, however old it is', () => {
  const lock = lockOwnedBy(process.pid);
  expect(acquireStateLock(lock)).toBeUndefined();
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(lock, old, old);
  expect(acquireStateLock(lock)).toBeUndefined();
});

it('releases and re-acquires cleanly', () => {
  const lock = join(dir, 'other.lock');
  const release = acquireStateLock(lock);
  expect(release).toBeTypeOf('function');
  expect(acquireStateLock(lock)).toBeUndefined();
  release?.();
  const again = acquireStateLock(lock);
  expect(again).toBeTypeOf('function');
  again?.();
});
