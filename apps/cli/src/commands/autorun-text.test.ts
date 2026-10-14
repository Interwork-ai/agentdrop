import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeLanguage } from '../locale.js';
import type { Output } from '../output.js';
import { autorunOffCommand, autorunStartHint, autorunStatusCommand } from './autorun.js';

function capture(): { out: Output; text: () => string } {
  let human = '';
  return {
    out: {
      json: false,
      info: () => {},
      warn: () => {},
      error: () => {},
      result: (_value, render) => {
        human = render();
      },
    },
    text: () => human,
  };
}

/* autorun's hints and status are read by a person: English by default, Chinese once they choose it. */
describe('agentdrop autorun: people text follows the language setting', () => {
  let dir: string;
  const saved = { config: process.env.AGENTDROP_CONFIG_DIR, state: process.env.AGENTDROP_STATE_DIR };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-autorun-text-'));
    process.env.AGENTDROP_CONFIG_DIR = join(dir, 'config');
    process.env.AGENTDROP_STATE_DIR = join(dir, 'state');
  });
  afterEach(() => {
    for (const [key, value] of [
      ['AGENTDROP_CONFIG_DIR', saved.config],
      ['AGENTDROP_STATE_DIR', saved.state],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('speaks English by default', () => {
    expect(autorunStartHint('codex', 'codex')).toMatch(/^Restart the Codex session/);
    expect(autorunStartHint('cursor', 'cursor')).toBe(
      'This client does not support autorun (codex, claude-code and opencode do).',
    );
    const off = capture();
    autorunOffCommand(off.out, { profile: 'codex' });
    expect(off.text()).toBe('autorun is off (codex).');
    const status = capture();
    autorunStatusCommand(status.out, { profile: 'codex' });
    expect(status.text()).toContain('autorun: off (codex)');
    expect(status.text()).toContain('Senders: any accepted contact');
  });

  it('and Chinese after the person chose it', () => {
    writeLanguage('zh');
    expect(autorunStartHint('codex', 'codex')).toMatch(/^重启 Codex 会话/);
    const off = capture();
    autorunOffCommand(off.out, { profile: 'codex' });
    expect(off.text()).toBe('autorun 已关闭（codex）。');
  });
});
