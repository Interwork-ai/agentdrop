import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser/lib/esm/main.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectCommand, disconnectCommand } from '../commands/connect.js';
import { silent, writeTestProfile } from './test-fixture.js';

describe('opencode: connect edits only its own entries', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-connect-'));
    process.env.AGENTDROP_CONFIG_DIR = join(dir, 'config');
    // connect records the hook events it wrote; keep that out of the real state directory.
    process.env.AGENTDROP_STATE_DIR = join(dir, 'state');
    writeTestProfile('codex', 'codex');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('opencode: preserves global config and installs/removes the session.idle plugin', async () => {
    const config = join(dir, 'opencode.json');
    const plugin = join(dir, 'plugins', 'agentdrop.js');
    writeFileSync(
      config,
      JSON.stringify({ theme: 'system', mcp: { other: { type: 'remote', url: 'https://example.test' } } }),
    );
    const options = {
      harness: 'opencode' as const,
      profile: 'codex',
      executable: '/path with spaces/agentdrop',
      opencodeConfigPath: config,
      opencodePluginPath: plugin,
    };
    await connectCommand(silent, options);
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({
      theme: 'system',
      mcp: {
        other: { type: 'remote', url: 'https://example.test' },
        agentdrop: {
          type: 'local',
          command: ['/path with spaces/agentdrop', 'mcp', '--profile', 'codex'],
          enabled: true,
        },
      },
    });
    const source = readFileSync(plugin, 'utf8');
    expect(source).toContain('event.type !== "session.idle"');
    expect(source).toContain('client.tui.showToast');
    await connectCommand(silent, options);
    expect(readFileSync(plugin, 'utf8')).toBe(source);
    await disconnectCommand(silent, options);
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({
      theme: 'system',
      mcp: { other: { type: 'remote', url: 'https://example.test' } },
    });
    expect(() => readFileSync(plugin, 'utf8')).toThrow();
  });

  it('opencode: preserves JSONC comments and trailing commas', async () => {
    const config = join(dir, 'opencode.jsonc');
    writeFileSync(config, '{\n  // keep this comment\n  "theme": "system",\n}\n');
    const options = {
      harness: 'opencode' as const,
      profile: 'codex',
      executable: '/bin/agentdrop',
      opencodeConfigPath: config,
      opencodePluginPath: join(dir, 'plugins', 'agentdrop.js'),
    };
    await connectCommand(silent, options);
    const installed = readFileSync(config, 'utf8');
    expect(installed).toContain('// keep this comment');
    expect((parseJsonc(installed) as { mcp: Record<string, unknown> }).mcp.agentdrop).toBeDefined();
    await disconnectCommand(silent, options);
    const removed = readFileSync(config, 'utf8');
    expect(removed).toContain('// keep this comment');
    expect((parseJsonc(removed) as { mcp?: Record<string, unknown> }).mcp?.agentdrop).toBeUndefined();
  });
});
