import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('fails the migration gate when the schema generator fails without changing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdrop-drift-'));
  try {
    mkdirSync(join(dir, 'bin'));
    const pnpm = join(dir, 'bin/pnpm');
    writeFileSync(pnpm, '#!/bin/sh\necho "schema generator failed" >&2\nexit 42\n');
    chmodSync(pnpm, 0o755);
    const result = spawnSync('bash', [resolve('packages/db/scripts/check-drift.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('schema generator failed');
    expect(result.stdout + result.stderr).not.toContain('migrations are in sync');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
