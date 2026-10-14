import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Output } from '../output.js';
import { writeDevice, writeProfile } from '../store.js';
import { connectCommand } from './connect.js';

const silent: Output = { json: true, info() {}, warn() {}, error() {}, result() {} };

describe('connect: idempotent client configuration (file fallback)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-connect-'));
    process.env.AGENTDROP_CONFIG_DIR = join(dir, 'config');
    // connect records the hook events it wrote; keep that out of the real state directory.
    process.env.AGENTDROP_STATE_DIR = join(dir, 'state');
    writeDevice({ installation_id: '11111111-1111-4111-8111-111111111111', label: 'box', created_at: 'now' });
    writeProfile({
      profile: 'codex',
      server_url: 'https://drop.example.test',
      h_id: '11111111-1111-4111-8111-111111111111',
      harness: 'codex',
      profile_key: 'codex',
      user_id: '22222222-2222-4222-8222-222222222222',
      handle: 'alice',
      agent_name: 'A',
      credential_ref: { store: 'file', account: 'x' },
      credential_expires_at: new Date(Date.now() + 86400000).toISOString(),
      paired_at: 'now',
      allowed_dirs: [],
      toolset: 'standard',
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(['codex', 'claude-code'] as const)(
    '%s: --no-hook leaves both hook events untouched',
    async (harness) => {
      const hooksPath = join(dir, 'hooks.json');
      const original = JSON.stringify({ hooks: { Stop: [], UserPromptSubmit: [] } });
      writeFileSync(hooksPath, original);
      await connectCommand(silent, {
        harness,
        profile: 'codex',
        executable: '/opt/agentdrop',
        noCli: true,
        noHook: true,
        codexHooksPath: hooksPath,
        claudeSettingsPath: hooksPath,
        codexConfigPath: join(dir, 'config.toml'),
        claudeConfigPath: join(dir, '.claude.json'),
      });
      expect(readFileSync(hooksPath, 'utf8')).toBe(original);
    },
  );
});

describe('Stop hook install / remove', () => {
  it('installs both events idempotently with quoted paths and preserves shared user handlers', async () => {
    const { hookCommand, removePendingHooks, upsertPendingHooks } = await import('./hooks.js');
    const dir = mkdtempSync(join(tmpdir(), 'agentdrop-prompt-hooks-'));
    const settings = join(dir, 'settings.json');
    const userHook = { type: 'command', command: 'user-hook' };
    const command = hookCommand('/path with spaces/agentdrop', 'cc');
    const original = {
      model: 'sonnet',
      hooks: {
        Stop: [{ matcher: '', hooks: [userHook] }],
        UserPromptSubmit: [{ hooks: [userHook] }],
        SessionEnd: [],
      },
    };
    writeFileSync(settings, JSON.stringify(original));
    upsertPendingHooks(settings, command);
    // Users may place their own handler in the same group as ours.
    const mixed = JSON.parse(readFileSync(settings, 'utf8'));
    for (const event of ['Stop', 'UserPromptSubmit']) {
      mixed.hooks[event][0].hooks.push(...mixed.hooks[event].pop().hooks);
    }
    writeFileSync(settings, JSON.stringify(mixed));
    upsertPendingHooks(settings, command);
    upsertPendingHooks(settings, command);
    const doc = JSON.parse(readFileSync(settings, 'utf8'));
    for (const event of ['Stop', 'UserPromptSubmit']) {
      expect(doc.hooks[event]).toHaveLength(2);
      expect(doc.hooks[event][0]).toEqual(original.hooks[event as 'Stop' | 'UserPromptSubmit'][0]);
    }
    expect(doc.hooks.Stop[1].hooks[0].command).toBe(command);
    expect(doc.hooks.UserPromptSubmit[1].hooks[0].command).toBe(`${command} --hook-output prompt-context`);
    expect(removePendingHooks(settings)).toBe(true);
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(original);
    expect(removePendingHooks(settings)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds one agentdrop Stop hook next to existing hooks; disconnect removes only ours', async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { removeStopHook, upsertStopHook } = await import('./hooks.js');
    const dir = mkdtempSync(join(tmpdir(), 'agentdrop-hooks-'));
    const settings = join(dir, 'settings.json');
    writeFileSync(
      settings,
      JSON.stringify({
        model: 'x',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-hook' }] }], SessionEnd: [] },
      }),
    );
    upsertStopHook(settings, '/usr/local/bin/agentdrop pending --profile cc --in-hook');
    upsertStopHook(settings, '/usr/local/bin/agentdrop pending --profile cc --in-hook'); // idempotent
    const doc = JSON.parse(readFileSync(settings, 'utf8'));
    expect(doc.model).toBe('x');
    expect(doc.hooks.Stop).toHaveLength(2);
    expect(doc.hooks.Stop[0].hooks[0].command).toBe('other-hook');
    expect(doc.hooks.Stop[1].hooks[0].command).toContain('agentdrop pending --profile cc');
    expect(removeStopHook(settings)).toBe(true);
    expect(JSON.parse(readFileSync(settings, 'utf8')).hooks.Stop).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
