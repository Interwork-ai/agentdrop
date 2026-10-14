import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultExecutable } from './commands/connect.js';
import {
  cursorHookCommand,
  cursorStopHookStatus,
  hookCommand,
  isAgentDropHookCommand,
  pendingHooksStatus,
  removePendingHooks,
  upsertCursorStopHook,
  upsertPendingHooks,
} from './commands/hooks.js';
import { synchronizeInstalledHooks } from './hook-lifecycle.js';
import { recordHookEvents } from './hook-record.js';
import { writeProfile } from './store.js';

vi.mock('./skill-lifecycle.js', () => ({ isPackagedCli: () => true }));

let dir: string;
const COMMAND = '/usr/local/bin/agentdrop pending --profile codex --in-hook';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentdrop-hook-sync-'));
  vi.stubEnv('AGENTDROP_CONFIG_DIR', join(dir, 'config'));
  vi.stubEnv('AGENTDROP_STATE_DIR', join(dir, 'state'));
  // Harness files not passed explicitly resolve here, never in the real home directory.
  vi.stubEnv('HOME', join(dir, 'home'));
  vi.stubEnv('CODEX_HOME', join(dir, 'home', '.codex'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(dir, 'home', '.claude'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, doc: unknown) => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(doc, null, 2));
  return path;
};
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, never>;

describe('pendingHooksStatus', () => {
  it('reports a file with no AgentDrop hook as absent, so repair never re-adds a removed hook', () => {
    // Someone who ran `connect --no-hook` or `disconnect` must not get it back on the next upgrade.
    expect(pendingHooksStatus(join(dir, 'missing.json'), COMMAND)).toBe('absent');
    const other = write('other.json', {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/opt/something-else --flag' }] }] },
    });
    expect(pendingHooksStatus(other, COMMAND)).toBe('absent');
  });

  it('reports the exact 0.4.8 shape as stale: Stop installed, UserPromptSubmit never written', () => {
    const path = write('codex.json', {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: COMMAND, timeout: 10 }] }] },
    });
    expect(pendingHooksStatus(path, COMMAND)).toBe('stale');
  });

  it('reports what this version writes as current', () => {
    const path = join(dir, 'fresh.json');
    upsertPendingHooks(path, COMMAND);
    expect(pendingHooksStatus(path, COMMAND)).toBe('current');
  });

  it('treats a changed command as stale even when both events exist', () => {
    const path = join(dir, 'renamed.json');
    upsertPendingHooks(path, '/old/path/agentdrop pending --profile codex --in-hook');
    expect(pendingHooksStatus(path, COMMAND)).toBe('stale');
  });

  it('survives a corrupt config instead of throwing into the caller', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ not json');
    expect(pendingHooksStatus(path, COMMAND)).toBe('absent');
  });
});

describe('repairing a stale config', () => {
  it('adds the missing event and leaves every other tool alone', () => {
    const path = write('codex.json', {
      model: 'gpt-5',
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: COMMAND, timeout: 10 }] },
          { hooks: [{ type: 'command', command: '/opt/other-tool notify' }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/opt/other-tool context' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: '/opt/third --start' }] }],
      },
    });
    expect(pendingHooksStatus(path, COMMAND)).toBe('stale');

    upsertPendingHooks(path, COMMAND);

    const doc = read(path) as unknown as {
      model: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const commands = (event: string) => doc.hooks[event]?.flatMap((g) => g.hooks.map((h) => h.command)) ?? [];
    expect(pendingHooksStatus(path, COMMAND)).toBe('current');
    // Ours is present exactly once per event…
    expect(commands('Stop').filter((c) => c === COMMAND)).toHaveLength(1);
    expect(commands('UserPromptSubmit')).toContain(`${COMMAND} --hook-output prompt-context`);
    // …and nothing else in the file moved.
    expect(commands('Stop')).toContain('/opt/other-tool notify');
    expect(commands('UserPromptSubmit')).toContain('/opt/other-tool context');
    expect(commands('SessionStart')).toContain('/opt/third --start');
    expect(doc.model).toBe('gpt-5');
  });

  it('is idempotent, so repeated startups do not pile up duplicate entries', () => {
    const path = join(dir, 'repeat.json');
    upsertPendingHooks(path, COMMAND);
    upsertPendingHooks(path, COMMAND);
    upsertPendingHooks(path, COMMAND);
    const doc = read(path) as unknown as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    for (const event of ['Stop', 'UserPromptSubmit']) {
      const ours = doc.hooks[event]
        ?.flatMap((g) => g.hooks.map((h) => h.command))
        .filter((c) => c.includes('agentdrop pending'));
      expect(ours, event).toHaveLength(1);
    }
  });
});

describe('cursorStopHookStatus', () => {
  it('distinguishes absent, current and a changed command', () => {
    const cursorCommand = '/usr/local/bin/agentdrop pending --profile cur --in-hook --hook-output cursor';
    expect(cursorStopHookStatus(join(dir, 'nope.json'), cursorCommand)).toBe('absent');
    const foreign = write('cursor-other.json', {
      version: 1,
      hooks: { stop: [{ command: '/opt/other stop' }] },
    });
    expect(cursorStopHookStatus(foreign, cursorCommand)).toBe('absent');
    const current = write('cursor.json', {
      version: 1,
      hooks: { stop: [{ command: cursorCommand, loop_limit: 1 }] },
    });
    expect(cursorStopHookStatus(current, cursorCommand)).toBe('current');
    const moved = write('cursor-old.json', {
      version: 1,
      hooks: { stop: [{ command: '/old/agentdrop pending --profile cur --in-hook --hook-output cursor' }] },
    });
    expect(cursorStopHookStatus(moved, cursorCommand)).toBe('stale');
  });
});

function profile(name: string, harness: 'codex' | 'claude-code' | 'cursor' = 'codex') {
  writeProfile({
    profile: name,
    server_url: 'https://drop.example.test',
    h_id: '11111111-1111-4111-8111-111111111111',
    harness,
    profile_key: name,
    user_id: '22222222-2222-4222-8222-222222222222',
    handle: 'alice',
    agent_name: 'A',
    credential_ref: { store: 'file', account: name },
    credential_expires_at: new Date(Date.now() + 86400000).toISOString(),
    paired_at: 'now',
    allowed_dirs: [],
    toolset: 'standard',
  });
}

/** A real file, so repair treats it as the executable `connect --executable` chose and keeps it. */
function executable(name = 'agentdrop'): string {
  const path = join(dir, 'custom bin', name);
  mkdirSync(join(dir, 'custom bin'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n');
  return path;
}

const commandsIn = (path: string, event: string): string[] =>
  (
    (read(path) as unknown as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }).hooks[
      event
    ] ?? []
  ).flatMap((g) => g.hooks.map((h) => h.command));

const stopOnly = (command: string) => ({
  hooks: { Stop: [{ hooks: [{ type: 'command', command, timeout: 10 }] }] },
});

describe('synchronizeInstalledHooks repairs per file', () => {
  it('keeps the installed profile when two profiles share one harness, so repeated runs change nothing', () => {
    profile('work');
    profile('home');
    const exe = executable();
    const codex = join(dir, 'hooks.json');
    upsertPendingHooks(codex, hookCommand(exe, 'home'));
    const before = readFileSync(codex, 'utf8');
    for (let i = 0; i < 3; i++) {
      expect(synchronizeInstalledHooks({ codex, claudeCode: join(dir, 'none.json') }).repaired).toEqual([]);
    }
    expect(readFileSync(codex, 'utf8')).toBe(before);
  });

  it('repairs a stale file with its own profile and executable, then settles', () => {
    profile('work');
    profile('home');
    const exe = executable();
    const codex = write('codex.json', stopOnly(hookCommand(exe, 'work')));
    const first = synchronizeInstalledHooks({ codex });
    expect(first.repaired).toEqual([{ profile: 'work', harness: 'codex', path: codex }]);
    expect(commandsIn(codex, 'Stop')).toEqual([hookCommand(exe, 'work')]);
    expect(commandsIn(codex, 'UserPromptSubmit')).toEqual([
      `${hookCommand(exe, 'work')} --hook-output prompt-context`,
    ]);
    expect(synchronizeInstalledHooks({ codex }).repaired).toEqual([]);
  });

  it('keeps a custom executable that still exists and replaces only a vanished one', () => {
    profile('codex');
    const exe = executable();
    const kept = write('kept.json', stopOnly(`${hookCommand(exe, 'codex')} --stale-flag`));
    synchronizeInstalledHooks({ codex: kept });
    expect(commandsIn(kept, 'Stop')).toEqual([hookCommand(exe, 'codex')]);

    const gone = write('gone.json', stopOnly(hookCommand(join(dir, 'deleted', 'agentdrop'), 'codex')));
    synchronizeInstalledHooks({ codex: gone });
    expect(commandsIn(gone, 'Stop')).toEqual([hookCommand(resolve(defaultExecutable()), 'codex')]);
  });

  it('leaves a hook whose profile no longer exists alone', () => {
    profile('codex');
    const exe = executable();
    const path = write('orphan.json', stopOnly(hookCommand(exe, 'deleted-profile')));
    const before = readFileSync(path, 'utf8');
    expect(synchronizeInstalledHooks({ codex: path }).repaired).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('recognises pnpm/Volta/Windows script names as ours everywhere', () => {
    profile('codex');
    const exe = executable('agentdrop.mjs');
    const command = hookCommand(exe, 'codex');
    for (const name of ['agentdrop.mjs', 'agentdrop.js', 'agentdrop.cjs', 'agentdrop.cmd'])
      expect(isAgentDropHookCommand(`/x/${name} pending --profile p --in-hook`), name).toBe(true);
    expect(isAgentDropHookCommand('/x/agentdropper pending')).toBe(false);

    const path = write('mjs.json', stopOnly(command));
    expect(pendingHooksStatus(path, command)).toBe('stale');
    synchronizeInstalledHooks({ codex: path });
    expect(commandsIn(path, 'Stop')).toEqual([command]);
    expect(commandsIn(path, 'UserPromptSubmit')).toEqual([`${command} --hook-output prompt-context`]);
    // connect again does not append a duplicate, and disconnect removes it.
    upsertPendingHooks(path, command);
    expect(commandsIn(path, 'Stop')).toHaveLength(1);
    expect(removePendingHooks(path)).toBe(true);
    expect(commandsIn(path, 'Stop')).toEqual([]);
  });

  it('does not re-add a UserPromptSubmit hook the user removed after connect', () => {
    profile('codex');
    const exe = executable();
    const command = hookCommand(exe, 'codex');
    const path = join(dir, 'settings.json');
    upsertPendingHooks(path, command);
    recordHookEvents(path, ['Stop', 'UserPromptSubmit']); // what connect records
    const doc = read(path) as unknown as { hooks: Record<string, unknown> };
    delete doc.hooks.UserPromptSubmit;
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const before = readFileSync(path, 'utf8');
    expect(synchronizeInstalledHooks({ claudeCode: path }).repaired).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('adds UserPromptSubmit to a 0.4.8 Stop-only install once, and a later deletion sticks', () => {
    profile('codex');
    const exe = executable();
    const command = hookCommand(exe, 'codex');
    const path = write('legacy.json', stopOnly(command));
    expect(synchronizeInstalledHooks({ codex: path }).repaired).toHaveLength(1);
    expect(commandsIn(path, 'UserPromptSubmit')).toEqual([`${command} --hook-output prompt-context`]);

    const doc = read(path) as unknown as { hooks: Record<string, unknown> };
    delete doc.hooks.UserPromptSubmit;
    writeFileSync(path, JSON.stringify(doc, null, 2));
    expect(synchronizeInstalledHooks({ codex: path }).repaired).toEqual([]);
    expect(commandsIn(path, 'UserPromptSubmit')).toEqual([]);
  });

  it('seeds the record from a current install, so deleting an event right after an upgrade also sticks', () => {
    profile('codex');
    const exe = executable();
    const command = hookCommand(exe, 'codex');
    const path = join(dir, 'current.json');
    upsertPendingHooks(path, command); // written by 0.4.9, before any record existed
    expect(synchronizeInstalledHooks({ codex: path }).repaired).toEqual([]);
    const doc = read(path) as unknown as { hooks: Record<string, unknown> };
    delete doc.hooks.UserPromptSubmit;
    writeFileSync(path, JSON.stringify(doc, null, 2));
    expect(synchronizeInstalledHooks({ codex: path }).repaired).toEqual([]);
    expect(commandsIn(path, 'UserPromptSubmit')).toEqual([]);
  });

  it('repairs Cursor with the installed executable and profile', () => {
    profile('cur', 'cursor');
    profile('other', 'cursor');
    const exe = executable();
    const path = join(dir, 'cursor.json');
    upsertCursorStopHook(path, `${cursorHookCommand(exe, 'cur')} --old`);
    expect(synchronizeInstalledHooks({ cursor: path }).repaired).toEqual([
      { profile: 'cur', harness: 'cursor', path },
    ]);
    expect(cursorStopHookStatus(path, cursorHookCommand(exe, 'cur'))).toBe('current');
    expect(synchronizeInstalledHooks({ cursor: path }).repaired).toEqual([]);
  });
});
