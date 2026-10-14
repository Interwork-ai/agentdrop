import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceRebindCommand } from './commands/device.js';
import { doctorCommand } from './commands/doctor.js';
import { endpointAddCommand, endpointListCommand } from './commands/endpoint.js';
import { loginCommand } from './commands/login.js';
import { loadCredential } from './credentials.js';
import type { Output } from './output.js';
import { devicePath, profilePath } from './paths.js';
import { readDevice, readProfile } from './store.js';

/** In-memory fake of the pairing API so CLI logic is tested without a server. */
function fakeServer() {
  let approved = false;
  let pollCount = 0;
  /** Approve once this many polls have been answered "pending": deterministic, unlike a timer. */
  let approveAfter = Number.POSITIVE_INFINITY;
  const server = {
    baseUrl: 'https://drop.example.test',
    approve() {
      approved = true;
    },
    approveAfterPolls(n: number) {
      approveAfter = n;
    },
    fetch: (async (input: URL | Request | string, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/health/live') return json(200, { status: 'ok', version: 'fake' });
      if (url.pathname === '/v1/pairing/start') {
        const body = JSON.parse(String(init?.body));
        expect(body.installation_id).toMatch(/[0-9a-f-]{36}/);
        return json(200, {
          device_code: 'd'.repeat(40),
          user_code: 'ABCD-EFGH',
          verification_url: 'https://web.example.test/pair',
          verification_url_complete: 'https://web.example.test/pair?code=ABCD-EFGH',
          expires_in: 600,
          interval: 1,
        });
      }
      if (url.pathname === '/v1/pairing/poll') {
        pollCount += 1;
        if (pollCount > approveAfter) approved = true;
        if (!approved) return json(200, { status: 'pending' });
        return json(200, {
          status: 'approved',
          h_id: '11111111-1111-4111-8111-111111111111',
          credential: 'adh_secret_token_value',
          credential_expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
          user_id: '22222222-2222-4222-8222-222222222222',
          handle: 'alice',
          agent_name: 'Alice Codex',
          server_version: 'fake',
        });
      }
      if (url.pathname === '/v1/h/identity') {
        const auth = (init?.headers as Record<string, string>)?.authorization;
        if (auth !== 'Bearer adh_secret_token_value')
          return json(401, { code: 'UNAUTHORIZED', message: 'x', next_action: 'y', retryable: false });
        return json(200, {
          viewer: {
            user_id: '22222222-2222-4222-8222-222222222222',
            handle: 'alice',
            display_name: 'Alice',
            h_id: '11111111-1111-4111-8111-111111111111',
            agent_name: 'Alice Codex',
            directory_revision: 0,
            mailbox_revision: 0,
          },
          device_label: 'box',
          harness_key: 'codex',
          profile_key: 'codex',
          credential_expires_at: null,
          toolsets: ['core', 'standard'],
          server_version: 'fake',
        });
      }
      return json(404, { code: 'NOT_FOUND', message: 'x', next_action: 'y', retryable: false });
    }) as typeof fetch,
    get pollCount() {
      return pollCount;
    },
  };
  return server;
}

function captureOutput(): Output & { results: unknown[]; logs: string[] } {
  const results: unknown[] = [];
  const logs: string[] = [];
  return {
    json: true,
    results,
    logs,
    info: (m) => logs.push(m),
    warn: (m) => logs.push(`warning: ${m}`),
    error: (m) => logs.push(`error: ${m}`),
    result: (v) => results.push(v),
  };
}

describe('CLI pairing flow (fake server)', () => {
  let dir: string;
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-cli-'));
    process.env.AGENTDROP_CONFIG_DIR = join(dir, 'config');
    process.env.AGENTDROP_DATA_DIR = join(dir, 'data');
    process.env.AGENTDROP_STATE_DIR = join(dir, 'state');
    process.env.AGENTDROP_CREDENTIAL_STORE = 'file';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it('login → endpoint add → list; the credential lives outside the profile with mode 0600', async () => {
    const server = fakeServer();
    globalThis.fetch = server.fetch;
    const out = captureOutput();
    await loginCommand(out, { server: server.baseUrl, deviceLabel: 'MacBook' });
    const device = readDevice();
    expect(device?.server_url).toBe(server.baseUrl);
    expect((statSync(devicePath()).mode & 0o777).toString(8)).toBe('600');

    // pending on the first poll, approved on the second: the CLI must keep polling
    server.approveAfterPolls(1);
    await endpointAddCommand(out, {
      harness: 'codex',
      profile: 'codex',
      label: 'Alice Codex',
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    });
    const profile = readProfile('codex');
    expect(profile?.h_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(readFileSync(profilePath('codex'), 'utf8')).not.toContain('adh_secret');
    expect(loadCredential(profile?.credential_ref ?? { store: 'file', account: '' })).toBe(
      'adh_secret_token_value',
    );
    expect(server.pollCount).toBeGreaterThan(1);
    expect(out.logs.join('\n')).not.toContain('adh_secret');

    await endpointListCommand(out, { check: true });
    const list = out.results.at(-1) as { endpoints: Array<{ status: string; agent_name: string }> };
    expect(list.endpoints[0]?.status).toBe('ok');
    expect(list.endpoints[0]?.agent_name).toBe('Alice Codex');

    const checks = await doctorCommand(out, {});
    expect(checks.find((c) => c.name === 'profile codex: identity')?.status).toBe('ok');
    // no folder allowed yet: the warning says what to run
    expect(checks.find((c) => c.name === 'profile codex: allowed dirs')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('agentdrop allow-dir add <folder> --profile codex'),
    });
    expect(JSON.stringify(checks)).not.toContain('adh_secret');
  });

  it('device rebind rotates the installation id and discards credentials', async () => {
    const server = fakeServer();
    globalThis.fetch = server.fetch;
    const out = captureOutput();
    await loginCommand(out, { server: server.baseUrl });
    server.approve();
    await endpointAddCommand(out, { harness: 'codex', profile: 'codex', sleep: async () => {} });
    const before = readDevice()?.installation_id;
    await expect(deviceRebindCommand(out, {})).rejects.toThrow(/--yes/);
    await deviceRebindCommand(out, { yes: true });
    expect(readDevice()?.installation_id).not.toBe(before);
    const profile = readProfile('codex');
    expect(profile).not.toBeNull();
    expect(loadCredential(profile?.credential_ref ?? { store: 'file', account: '' })).toBeNull();
    const checks = await doctorCommand(out, { profile: 'codex' });
    expect(checks.some((c) => c.name === 'profile codex: credential' && c.status === 'fail')).toBe(true);
  });

  it('refuses plain http servers except loopback', async () => {
    const out = captureOutput();
    await expect(loginCommand(out, { server: 'http://drop.example.test' })).rejects.toThrow(/https/);
  });
});

describe('server URL validation', () => {
  it('accepts https and loopback http; rejects cleartext, credentials, query strings', async () => {
    const { validateServerUrl } = await import('./commands/login.js');
    expect(validateServerUrl('https://drop.example.com/')).toBe('https://drop.example.com');
    expect(validateServerUrl('http://localhost:3210')).toBe('http://localhost:3210');
    expect(() => validateServerUrl('http://drop.example.com')).toThrow(/https/);
    expect(() => validateServerUrl('https://user:pw@drop.example.com')).toThrow(/credentials/);
    expect(() => validateServerUrl('https://drop.example.com/?x=1')).toThrow(/query/);
    expect(() => validateServerUrl('not a url')).toThrow(/valid URL/);
  });
});

describe('skill install', () => {
  it('copies SKILL.md and references into each client skills directory and can remove them', async () => {
    const { mkdtempSync, existsSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { skillInstallCommand, skillRemoveCommand } = await import('./commands/skill.js');
    const dir = mkdtempSync(join(tmpdir(), 'agentdrop-skill-'));
    const targets = [
      { client: 'codex', dir: join(dir, 'codex', 'skills', 'agentdrop') },
      { client: 'claude-code', dir: join(dir, 'claude', 'skills', 'agentdrop') },
    ];
    const results: unknown[] = [];
    const out = { json: true, info() {}, warn() {}, error() {}, result: (v: unknown) => results.push(v) };
    await skillInstallCommand(out, { targets });
    for (const t of targets) {
      expect(existsSync(join(t.dir, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(t.dir, 'reference', 'workflows.md'))).toBe(true);
      expect(readFileSync(join(t.dir, 'SKILL.md'), 'utf8')).toMatch(/^---\nname: agentdrop\n/);
    }
    await skillInstallCommand(out, { targets, only: ['codex'] });
    await skillRemoveCommand(out, { targets });
    expect(existsSync(targets[0]?.dir ?? '')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('pending summary', () => {
  it('formats in the chosen language (English by default) and stays silent when nothing is waiting', async () => {
    const { formatPending } = await import('./commands/pending.js');
    expect(
      formatPending({
        unread: 0,
        unread_drops: [],
        contact_requests: [],
        group_invitations: [],
        approvals: 0,
        agent_name: '小码',
      }),
    ).toBeNull();
    const summary = {
      unread: 3,
      unread_drops: [
        {
          drop_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          title: '实验结果',
          author: { handle: 'li', display_label: '小李' },
          attachment_count: 1,
        },
        {
          drop_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          title: 'Chatter',
          author: { handle: 'zhao', display_label: 'Zhao' },
          attachment_count: 0,
          group: { name: 'Core team', slug: 'core' },
          muted: true,
        },
      ],
      contact_requests: [{ handle: 'wang', display_name: '王同学' }],
      group_invitations: [{ slug: 'paper', display_name: '论文讨论组' }],
      approvals: 1,
      agent_name: '小码',
    };
    const en = formatPending(summary, 'en');
    expect(en).toContain('Unread messages: 3');
    expect(en).toContain('Direct messages:\n- aaaaaaaa · 小李 @li · 实验结果 · 1 attachment');
    // The full view keeps muted-group drops, marked as such.
    expect(en).toContain('In group “Core team” #core:\n- bbbbbbbb · Zhao @zhao · Chatter · muted group');
    expect(en).toContain('- 1 more not listed');
    expect(en).toContain('Contact requests: 1\n- 王同学 @wang');
    expect(en).toContain('Pending approvals: 1');
    expect(en).toContain('(add --profile when several agents are paired)');
    expect(en).not.toMatch(/[\u4e00-\u9fff]{2,}：/);
    const msg = formatPending(summary, 'zh');
    expect(msg).toContain('王同学 @wang');
    expect(msg).toContain('群 「Core team」#core：');
    expect(msg).toContain('Chatter · 已免打扰');
    expect(msg).toContain('论文讨论组 #paper');
    expect(msg).toContain('未读消息：3 条');
    expect(msg).toContain('实验结果');
    expect(msg).toContain('审批');
  });
});
