import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLanguage } from '../locale.js';
import type { Output } from '../output.js';
import { writeProfile } from '../store.js';
import { connectCommand } from './connect.js';
import { endpointAddCommand } from './endpoint.js';
import { loginCommand } from './login.js';
import { feishuSuggestion, setupCommand, setupDone } from './setup.js';
import { skillInstallCommand } from './skill.js';

vi.mock('./login.js', () => ({
  loginCommand: vi.fn(),
  validateServerUrl: (s: string) => s,
  normalizeServerInput: (s: string) => (s.includes('://') ? s : `https://${s}`),
}));
vi.mock('./connect.js', () => ({ connectCommand: vi.fn() }));
vi.mock('./endpoint.js', () => ({ endpointAddCommand: vi.fn() }));
vi.mock('./skill.js', () => ({ skillInstallCommand: vi.fn() }));
vi.mock('./doctor.js', () => ({ doctorCommand: vi.fn().mockResolvedValue([]) }));
const identity = vi.fn();
vi.mock('./mail.js', () => ({ clientFor: () => ({ client: { identity } }) }));
const out: Output = { json: true, info() {}, warn() {}, error() {}, result() {} };

describe('setup shared workflow', () => {
  let dir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'setup-cursor-'));
    vi.stubEnv('AGENTDROP_CONFIG_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  it('pairs Cursor, registers the same bridge and installs its shared skill', async () => {
    await setupCommand(out, {
      server: 'https://example.test',
      harnesses: ['cursor'],
      noBrowser: true,
      noCli: true,
    });
    expect(endpointAddCommand).toHaveBeenCalledWith(
      out,
      expect.objectContaining({ harness: 'cursor', profile: 'cursor' }),
    );
    expect(connectCommand).toHaveBeenCalledWith(out, { harness: 'cursor', profile: 'cursor', noCli: true });
    expect(skillInstallCommand).toHaveBeenCalledWith(out, { only: ['cursor'] });
  });
  it('pairs OpenCode, registers its bridge and installs the global plugin and shared skill', async () => {
    await setupCommand(out, {
      server: 'https://example.test',
      harnesses: ['opencode'],
      noBrowser: true,
      noCli: true,
    });
    expect(endpointAddCommand).toHaveBeenCalledWith(
      out,
      expect.objectContaining({ harness: 'opencode', profile: 'opencode' }),
    );
    expect(connectCommand).toHaveBeenCalledWith(out, {
      harness: 'opencode',
      profile: 'opencode',
      noCli: true,
    });
    expect(skillInstallCommand).toHaveBeenCalledWith(out, { only: ['opencode'] });
  });
  it('does not silently replace a pre-existing different harness identity', async () => {
    writeProfile({
      profile: 'cursor',
      harness: 'other',
      server_url: 'https://example.test',
      h_id: '11111111-1111-4111-8111-111111111111',
      profile_key: 'cursor',
      user_id: '22222222-2222-4222-8222-222222222222',
      handle: 'alice',
      agent_name: 'Existing agent',
      credential_ref: { store: 'file', account: 'x' },
      credential_expires_at: new Date(Date.now() + 86400000).toISOString(),
      paired_at: 'now',
      allowed_dirs: [],
      toolset: 'standard',
    });
    const errors: string[] = [];
    await setupCommand(
      { ...out, error: (m) => errors.push(m) },
      { server: 'https://example.test', harnesses: ['cursor'] },
    );
    expect(errors).toEqual([expect.stringContaining('already belongs to other')]);
    expect(endpointAddCommand).not.toHaveBeenCalled();
    expect(connectCommand).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('suggests Feishu once at the end of setup only with lark-cli and no Feishu bot yet', async () => {
    writeProfile({
      profile: 'codex',
      harness: 'codex',
      server_url: 'https://example.test',
      h_id: '11111111-1111-4111-8111-111111111111',
      profile_key: 'codex',
      user_id: '22222222-2222-4222-8222-222222222222',
      handle: 'alice',
      agent_name: 'Codex',
      credential_ref: { store: 'file', account: 'x' },
      credential_expires_at: new Date(Date.now() + 86400000).toISOString(),
      paired_at: 'now',
      allowed_dirs: [],
      toolset: 'standard',
    });
    const withLark = (bin: string) => (bin === 'lark-cli' ? '/usr/local/bin/lark-cli' : null);
    identity.mockResolvedValue({ notifications: { feishu: false } });
    expect(await feishuSuggestion(withLark, ['codex'])).toMatch(/lark-cli/);
    expect(await feishuSuggestion(() => null, ['codex'])).toBeNull();
    identity.mockResolvedValue({ notifications: { feishu: true } });
    expect(await feishuSuggestion(withLark, ['codex'])).toBeNull();
    // An older server that does not report it: say nothing rather than guess.
    identity.mockResolvedValue({});
    expect(await feishuSuggestion(withLark, ['codex'])).toBeNull();
    identity.mockRejectedValue(new Error('offline'));
    expect(await feishuSuggestion(withLark, ['codex'])).toBeNull();
  });

  it('takes the address as typed and lets login (not a probe of its own) check it', async () => {
    await setupCommand(out, { server: 'drop.example.com', harnesses: ['codex'], noBrowser: true });
    expect(loginCommand).toHaveBeenCalledWith(out, {
      server: 'https://drop.example.com',
      allowHttp: false,
      fromSetup: true,
    });
    expect(endpointAddCommand).toHaveBeenCalledWith(out, expect.objectContaining({ fromSetup: true }));
  });

  it('with --no-browser does not promise that a browser opens', async () => {
    const info: string[] = [];
    await setupCommand(
      { ...out, info: (m) => info.push(m) },
      {
        server: 'https://example.test',
        harnesses: ['codex'],
        noBrowser: true,
      },
    );
    const pairing = info.find((l) => l.startsWith('pairing'));
    expect(pairing).toMatch(/open the link below/);
    expect(pairing).not.toMatch(/will open/);
  });

  it('ends with three lines: what is set up for whom, how to try it, how to add people', async () => {
    writeProfile({
      profile: 'codex',
      harness: 'codex',
      server_url: 'https://drop.example.com',
      h_id: '11111111-1111-4111-8111-111111111111',
      profile_key: 'codex',
      user_id: '22222222-2222-4222-8222-222222222222',
      handle: 'alice',
      agent_name: 'Codex',
      credential_ref: { store: 'file', account: 'x' },
      credential_expires_at: new Date(Date.now() + 86400000).toISOString(),
      paired_at: 'now',
      allowed_dirs: [],
      toolset: 'standard',
    });
    const info: string[] = [];
    await setupCommand(
      { ...out, info: (m) => info.push(m) },
      {
        server: 'https://drop.example.com',
        harnesses: ['codex'],
      },
    );
    expect(info.slice(-3)).toEqual([
      'Done: Codex set up as @alice on drop.example.com.',
      'Try it: restart Codex, then ask your agent "send a test message to @agentdrop"; the built-in assistant answers with a receipt.',
      'Add people: open https://drop.example.com/app/contacts, create an invite link and send it to a colleague.',
    ]);
    expect(info.join('\n')).not.toMatch(/[\u4e00-\u9fff]/);
    writeLanguage('zh');
    expect(setupDone('https://drop.example.com', ['codex'])).toEqual([
      '完成：已设置 Codex，账号 @alice，服务器 drop.example.com。',
      '试一下：重启 Codex，然后对 Agent 说「发一条测试消息给 @agentdrop」，内置助手会回一条回执。',
      '加人：打开 https://drop.example.com/app/contacts，生成邀请链接发给同事。',
    ]);
  });
});
