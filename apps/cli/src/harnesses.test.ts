import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectHarnesses, parseHarnessList } from './harnesses.js';

/** Every config root absent, so the machine running the test cannot leak in; each case adds the one it needs. */
const absent = (dir: string) => ({
  cursor: join(dir, 'absent-cursor'),
  opencode: join(dir, 'absent-opencode'),
  omp: join(dir, 'absent-omp'),
});

describe('harness discovery and selection', () => {
  it('rejects typos instead of silently setting up an unrelated detected client', () => {
    for (const input of ['', 'curser', 'codex,invalid', 'cursor,'])
      expect(() => parseHarnessList(input)).toThrow();
    expect(parseHarnessList('cursor, opencode,codex,cursor')).toEqual(['cursor', 'opencode', 'codex']);
    expect(parseHarnessList('omp')).toEqual(['omp']);
  });
  it('detects a GUI-only Cursor installation through its user config root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-discovery-'));
    try {
      expect(detectHarnesses(() => null, { ...absent(dir), cursor: dir })).toEqual(['cursor']);
      expect(
        detectHarnesses((bin) => (bin === 'cursor-agent' ? '/bin/cursor-agent' : null), absent(dir)),
      ).toEqual(['cursor']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('detects OpenCode through either its binary or global config root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-discovery-'));
    try {
      expect(detectHarnesses(() => null, { ...absent(dir), opencode: dir })).toEqual(['opencode']);
      expect(detectHarnesses((bin) => (bin === 'opencode' ? '/bin/opencode' : null), absent(dir))).toEqual([
        'opencode',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('detects oh-my-pi through either its binary or its agent directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-discovery-'));
    try {
      expect(detectHarnesses(() => null, { ...absent(dir), omp: dir })).toEqual(['omp']);
      expect(detectHarnesses((bin) => (bin === 'omp' ? '/bin/omp' : null), absent(dir))).toEqual(['omp']);
      expect(detectHarnesses(() => null, absent(dir))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
