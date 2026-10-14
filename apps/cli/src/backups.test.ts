import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { backupConfigFile } from './backups.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

it('keeps the newest three backups it made and never touches hand-made ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdrop-backups-'));
  roots.push(dir);
  const file = join(dir, 'hooks.json');
  writeFileSync(file, '{}');
  for (const stamp of ['2026-09-17T09-19-06-687Z', '2026-09-17T09-19-06-689Z', '2026-09-18T04-19-37-958Z'])
    writeFileSync(`${file}.bak-${stamp}`, '{}');
  writeFileSync(`${file}.backup-20260920-by-hand`, '{}');
  writeFileSync(`${file}.bak-20260803-before-edit`, '{}');
  writeFileSync(join(dir, 'other.json.bak-2026-09-17T09-19-06-687Z'), '{}');

  const made = backupConfigFile(file);
  expect(made && existsSync(made)).toBe(true);
  const ours = readdirSync(dir).filter((f) => /^hooks\.json\.bak-\d{4}-/.test(f));
  expect(ours).toHaveLength(3);
  // three old ones plus the new one: only the oldest goes
  expect(ours).not.toContain('hooks.json.bak-2026-09-17T09-19-06-687Z');
  expect(ours).toContain('hooks.json.bak-2026-09-17T09-19-06-689Z');
  expect(existsSync(`${file}.backup-20260920-by-hand`)).toBe(true);
  expect(existsSync(`${file}.bak-20260803-before-edit`)).toBe(true);
  expect(existsSync(join(dir, 'other.json.bak-2026-09-17T09-19-06-687Z'))).toBe(true);
});

it('does nothing for a file that does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdrop-backups-'));
  roots.push(dir);
  expect(backupConfigFile(join(dir, 'missing.json'))).toBeNull();
  expect(readdirSync(dir)).toEqual([]);
});
