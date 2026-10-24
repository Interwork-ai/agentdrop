import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectCommand, disconnectCommand } from '../commands/connect.js';
import { defaultSkillTargets } from '../commands/skill.js';
import { silent, writeTestProfile } from './test-fixture.js';
import { workbuddy, workbuddyHome } from './workbuddy.js';

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('workbuddy: which home directory is WorkBuddy’s', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-workbuddy-home-'));
    vi.stubEnv('HOME', dir);
    vi.stubEnv('WORKBUDDY_CONFIG_DIR', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is the China edition’s ~/.workbuddy unless only the international ~/.workbuddy-ai exists', () => {
    expect(workbuddyHome()).toBe(join(dir, '.workbuddy'));
    mkdirSync(join(dir, '.workbuddy-ai'));
    expect(workbuddyHome()).toBe(join(dir, '.workbuddy-ai'));
    mkdirSync(join(dir, '.workbuddy'));
    expect(workbuddyHome()).toBe(join(dir, '.workbuddy'));
  });

  it('follows WORKBUDDY_CONFIG_DIR, as WorkBuddy itself does', () => {
    vi.stubEnv('WORKBUDDY_CONFIG_DIR', join(dir, 'elsewhere'));
    expect(workbuddyHome()).toBe(join(dir, 'elsewhere'));
    expect(workbuddy.skillsRoot()).toBe(join(dir, 'elsewhere', 'skills'));
  });
});

describe('workbuddy: connect edits only its own entries', () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-workbuddy-'));
    home = join(dir, 'workbuddy');
    mkdirSync(home);
    vi.stubEnv('AGENTDROP_CONFIG_DIR', join(dir, 'config'));
    vi.stubEnv('AGENTDROP_STATE_DIR', join(dir, 'state'));
    vi.stubEnv('WORKBUDDY_CONFIG_DIR', home);
    writeTestProfile('workbuddy', 'workbuddy');
    // an executable that exists, so hook repair keeps it (with a space, to see it quoted)
    mkdirSync(join(dir, 'bin dir'));
    writeFileSync(join(dir, 'bin dir', 'agentdrop'), '');
    options = { ...options, executable: join(dir, 'bin dir', 'agentdrop') };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  let options = { harness: 'workbuddy' as const, profile: 'workbuddy', executable: '', which: () => null };

  it('keeps the person’s MCP servers, settings and hooks, and takes back only its own', async () => {
    writeFileSync(
      join(home, 'mcp.json'),
      JSON.stringify({
        mcpServers: { other: { type: 'stdio', command: 'other-mcp' } },
        disabledMcpServers: [],
      }),
    );
    const userStop = { hooks: [{ type: 'command', command: 'say done' }] };
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ model: 'kept', hooks: { Stop: [userStop] } }),
    );

    await connectCommand(silent, options);
    const mcp = readJson(join(home, 'mcp.json'));
    expect(mcp).toEqual({
      mcpServers: {
        other: { type: 'stdio', command: 'other-mcp' },
        agentdrop: { type: 'stdio', command: options.executable, args: ['mcp', '--profile', 'workbuddy'] },
      },
      disabledMcpServers: [],
    });
    // the embedded CLI's preferred file is not created; only an existing one is kept in step
    expect(existsSync(join(home, '.mcp.json'))).toBe(false);
    const settings = readJson(join(home, 'settings.json'));
    expect(settings.model).toBe('kept');
    expect(settings.hooks.Stop[0]).toEqual(userStop);
    const quoted = `'${options.executable}' pending --profile workbuddy --in-hook`;
    expect(settings.hooks.Stop[1].hooks[0].command).toBe(quoted);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      `${quoted} --hook-output prompt-context`,
    );
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(`${quoted} --hook-output session-start`);
    // no status line or mod: those are Claude Code's
    expect(settings.statusLine).toBeUndefined();
    expect(workbuddy.hookRepair.plan(join(home, 'settings.json'), new Set(['workbuddy'])).status).toBe(
      'current',
    );

    const first = readFileSync(join(home, 'mcp.json'), 'utf8');
    await connectCommand(silent, options);
    expect(readFileSync(join(home, 'mcp.json'), 'utf8')).toBe(first);
    expect(readJson(join(home, 'settings.json')).hooks.Stop).toHaveLength(2);

    await disconnectCommand(silent, options);
    expect(readJson(join(home, 'mcp.json'))).toEqual({
      mcpServers: { other: { type: 'stdio', command: 'other-mcp' } },
      disabledMcpServers: [],
    });
    expect(readJson(join(home, 'settings.json'))).toEqual({ model: 'kept', hooks: { Stop: [userStop] } });
  });

  it('also registers in .mcp.json when that file exists, since the embedded CLI reads it first', async () => {
    writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    await connectCommand(silent, options);
    expect(readJson(join(home, '.mcp.json')).mcpServers.agentdrop.args).toEqual([
      'mcp',
      '--profile',
      'workbuddy',
    ]);
    expect(readJson(join(home, 'mcp.json')).mcpServers.agentdrop.args).toEqual([
      'mcp',
      '--profile',
      'workbuddy',
    ]);
    await disconnectCommand(silent, options);
    expect(readJson(join(home, '.mcp.json')).mcpServers).toEqual({});
    expect(readJson(join(home, 'mcp.json')).mcpServers).toEqual({});
  });

  it('installs the companion skill into WorkBuddy’s skills directory', () => {
    expect(defaultSkillTargets()).toContainEqual({
      client: 'workbuddy',
      dir: join(home, 'skills', 'agentdrop'),
    });
  });
});
