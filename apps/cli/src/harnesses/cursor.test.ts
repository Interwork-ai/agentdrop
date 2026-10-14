import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectCommand, disconnectCommand } from '../commands/connect.js';
import { silent, writeTestProfile } from './test-fixture.js';

describe('cursor: connect edits only its own entries', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-connect-'));
    process.env.AGENTDROP_CONFIG_DIR = join(dir, 'config');
    // connect records the hook events it wrote; keep that out of the real state directory.
    process.env.AGENTDROP_STATE_DIR = join(dir, 'state');
    writeTestProfile('codex', 'codex');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('cursor: preserves MCP entries and user hooks while installing one guarded stop hook', async () => {
    const path = join(dir, 'cursor-mcp.json');
    const hooks = join(dir, 'cursor-hooks.json');
    const originalHooks = '{"version":1,"hooks":{"stop":[{"command":"user-hook"}]}}';
    writeFileSync(hooks, originalHooks);
    writeFileSync(
      path,
      JSON.stringify({ extra: 'keep', mcpServers: { other: { url: 'https://example.test/mcp' } } }),
    );
    const options = {
      harness: 'cursor' as const,
      profile: 'codex',
      executable: '/path with spaces/agentdrop',
      cursorConfigPath: path,
      cursorHooksPath: hooks,
      which: () => {
        throw new Error('Cursor should use its documented JSON config');
      },
    };
    await connectCommand(silent, options);
    const first = readFileSync(path, 'utf8');
    expect(JSON.parse(first)).toEqual({
      extra: 'keep',
      mcpServers: {
        other: { url: 'https://example.test/mcp' },
        agentdrop: { command: options.executable, args: ['mcp', '--profile', 'codex'] },
      },
    });
    let hookConfig = JSON.parse(readFileSync(hooks, 'utf8'));
    expect(hookConfig.hooks.stop).toHaveLength(2);
    expect(hookConfig.hooks.stop[0]).toEqual({ command: 'user-hook' });
    expect(hookConfig.hooks.stop[1].command).toContain(
      "'/path with spaces/agentdrop' pending --profile codex --in-hook --hook-output cursor",
    );
    expect(hookConfig.hooks.stop[1].loop_limit).toBe(1);
    await connectCommand(silent, options);
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(JSON.parse(readFileSync(hooks, 'utf8')).hooks.stop).toHaveLength(2);
    await disconnectCommand(silent, options);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      extra: 'keep',
      mcpServers: { other: { url: 'https://example.test/mcp' } },
    });
    hookConfig = JSON.parse(readFileSync(hooks, 'utf8'));
    expect(hookConfig.hooks.stop).toEqual([{ command: 'user-hook' }]);
  });

  it.each(['{broken', '[]', '{"mcpServers":[]}', '{"mcpServers":null}'])(
    'cursor refuses malformed config without overwriting: %s',
    async (content) => {
      const path = join(dir, 'invalid-cursor.json');
      writeFileSync(path, content);
      await expect(
        connectCommand(silent, { harness: 'cursor', profile: 'codex', cursorConfigPath: path }),
      ).rejects.toThrow();
      expect(readFileSync(path, 'utf8')).toBe(content);
      await expect(
        disconnectCommand(silent, { harness: 'cursor', cursorConfigPath: path }),
      ).rejects.toThrow();
      expect(readFileSync(path, 'utf8')).toBe(content);
    },
  );
});
