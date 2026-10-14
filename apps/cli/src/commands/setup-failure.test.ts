import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDropError } from '@agentdrop/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeLanguage } from '../locale.js';
import { harnessFailure } from './setup.js';

/* What setup tells the person when one client could not be set up: their language, never a server's message. */
describe('setup: why a client was not set up', () => {
  let dir: string;
  const saved = process.env.AGENTDROP_CONFIG_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-setup-failure-'));
    process.env.AGENTDROP_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTDROP_CONFIG_DIR;
    else process.env.AGENTDROP_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it('names a known failure in the person words, in English and Chinese', () => {
    const offline = new AgentDropError('NETWORK_ERROR', 'fetch failed: ECONNREFUSED 10.0.0.1:443');
    expect(harnessFailure('codex', offline)).toBe(
      "Codex: not set up (can't reach the server). The other clients are set up as usual.",
    );
    writeLanguage('zh');
    expect(harnessFailure('codex', offline)).toBe(
      'Codex：没有设置成功（连不上服务器）。其他客户端照常设置。',
    );
  });

  it("never shows a server's own message; points to doctor for anything else", () => {
    const odd = new AgentDropError('QUOTA_EXCEEDED', 'internal detail the person need not read');
    expect(harnessFailure('codex', odd)).not.toContain('internal detail');
    expect(harnessFailure('codex', odd)).toContain('agentdrop doctor');
  });
});
