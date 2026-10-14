import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLanguage } from './locale.js';
import { prefix } from './output.js';

describe('the label before an error or a warning', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-prefix-'));
    vi.stubEnv('AGENTDROP_CONFIG_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  it('is English by default and Chinese once the person chose Chinese', () => {
    expect(prefix('error')).toBe('error: ');
    expect(prefix('warning')).toBe('warning: ');
    writeLanguage('zh');
    expect(prefix('error')).toBe('错误：');
    expect(prefix('warning')).toBe('注意：');
  });
});
