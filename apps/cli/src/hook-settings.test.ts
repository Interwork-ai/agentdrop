import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsCommand } from './commands/settings.js';
import { hookSettingsPath, parseInterval, readHookSettings } from './hook-settings.js';
import type { Output } from './output.js';

const out: Output = { json: true, info() {}, warn() {}, error() {}, result() {} };

describe('local hook preferences', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-settings-'));
    vi.stubEnv('AGENTDROP_CONFIG_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  it('defaults to checking at every turn end and daily update checks', () => {
    expect(readHookSettings()).toEqual({
      notifications: { enabled: true, interval_ms: 0, detail: 'counts' },
      updates: { mode: 'auto', interval_ms: 86400000 },
    });
  });
  it('persists explicit choices privately and merges unrelated preferences', async () => {
    await settingsCommand(out, { notifyInterval: '30m', updates: 'auto', noticeDetail: 'names' });
    await settingsCommand(out, { notifications: 'off', updateCheckInterval: '2h' });
    expect(readHookSettings()).toEqual({
      notifications: { enabled: false, interval_ms: 1800000, detail: 'names' },
      updates: { mode: 'auto', interval_ms: 7200000 },
    });
    expect(statSync(hookSettingsPath()).mode & 0o777).toBe(0o600);
  });
  it('rejects invalid or too-large intervals without changing settings', async () => {
    await settingsCommand(out, { notifyInterval: '0' });
    const original = readFileSync(hookSettingsPath(), 'utf8');
    for (const raw of ['-1h', '2hours', 'NaN', 'Infinity', '31d', '99999999999999999999h'])
      expect(() => parseInterval(raw)).toThrow();
    await expect(settingsCommand(out, { updateCheckInterval: '0' })).rejects.toThrow();
    await expect(settingsCommand(out, { notifications: 'bad' })).rejects.toThrow();
    expect(readFileSync(hookSettingsPath(), 'utf8')).toBe(original);
  });
  it('prints the summary in the chosen language, English by default', async () => {
    let text = '';
    const capture: Output = {
      json: false,
      info() {},
      warn() {},
      error() {},
      result(_data, human) {
        text = human();
      },
    };
    await settingsCommand(capture, {});
    expect(text).toContain('End-of-turn notices: on');
    expect(text).toContain('Notice language: English');
    expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    await settingsCommand(capture, { language: 'zh' });
    expect(text).toContain('通知语言：中文');
    expect(text).toContain('Hook 通知：开启');
  });
  it('fails closed on corrupt config instead of opting into installation', () => {
    writeFileSync(hookSettingsPath(), '{broken');
    expect(() => readHookSettings()).toThrow(/Invalid AgentDrop settings/);
  });
});
