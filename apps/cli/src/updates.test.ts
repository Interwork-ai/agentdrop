import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateSettings } from './hook-settings.js';
import { createUpdateManager } from './updates.js';

function fakeChild() {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', { value: process.pid });
  child.unref = vi.fn();
  child.kill = vi.fn(() => true);
  return child;
}

describe('CLI update maintenance (offline)', () => {
  let root: string;
  let script: string;
  let prefix: string;
  let settings: UpdateSettings;
  let now: number;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let spawnMock: ReturnType<
    typeof vi.fn<(command: string, args: string[], options: SpawnOptions) => ChildProcess>
  >;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'agentdrop-updates-')));
    prefix = join(root, 'node prefix');
    script = join(prefix, 'lib/node_modules/agentdrop-cli/bin/agentdrop.mjs');
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, '');
    writeFileSync(
      join(dirname(dirname(script)), 'package.json'),
      JSON.stringify({ name: 'agentdrop-cli', version: '1.2.3' }),
    );
    settings = { mode: 'notify', interval_ms: 86_400_000 };
    now = Date.now();
    fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ version: '1.2.4' }));
    spawnMock = vi
      .fn<(command: string, args: string[], options: SpawnOptions) => ChildProcess>()
      .mockImplementation((command, args) => {
        const child = fakeChild();
        queueMicrotask(() => {
          if (command === 'npm') {
            const version = args
              .find((arg) => arg.startsWith('agentdrop-cli@'))
              ?.slice('agentdrop-cli@'.length);
            writeFileSync(
              join(dirname(dirname(script)), 'package.json'),
              JSON.stringify({ name: 'agentdrop-cli', version }),
            );
          }
          child.emit('close', 0);
        });
        return child;
      });
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });
  function manager(extra: Parameters<typeof createUpdateManager>[0] = {}) {
    return createUpdateManager({
      version: '1.2.3',
      script,
      execPath: '/node/bin/node',
      execArgs: [],
      platform: 'linux',
      env: {},
      stateRoot: () => join(root, 'state'),
      settings: () => settings,
      now: () => now,
      fetch: fetchMock,
      spawn: spawnMock,
      ...extra,
    });
  }

  it('honours disabling automatic installation while the registry request is in flight', async () => {
    settings.mode = 'auto';
    fetchMock.mockImplementation(async () => {
      settings.mode = 'off';
      return Response.json({ version: '1.2.4' });
    });
    expect((await manager().maintainUpdates()).status).toBe('available');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(manager().getUpdateNotice(settings)).toBeNull();
  });

  it('notifies daily, records acknowledgement across manager instances, and never installs in notify mode', async () => {
    const m = manager();
    expect((await m.maintainUpdates()).status).toBe('available');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.npmjs.org/agentdrop-cli/latest',
      expect.objectContaining({ redirect: 'error' }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
    const notice = m.getUpdateNotice(settings);
    expect(notice?.message).toContain('1.2.4');
    m.acknowledgeUpdateNotice(notice?.id ?? '');
    expect(manager().getUpdateNotice(settings)).toBeNull();
    expect((await manager().maintainUpdates()).status).toBe('not_due');
    now += settings.interval_ms;
    expect((await manager().maintainUpdates()).status).toBe('available');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(manager().getUpdateNotice(settings)).toBeNull();
  });

  it.each([
    '1.2.4-beta.1',
    '2.0.0; touch /tmp/x',
    'https://bad.test/secret',
    '01.2.3',
    '9007199254740992.0.0',
  ])('rejects untrusted release version %s without saving it', async (version) => {
    fetchMock.mockImplementation(async () => Response.json({ version }));
    const m = manager();
    expect((await m.maintainUpdates()).status).toBe('check_failed');
    const files = readdirSync(join(root, 'state/updates')).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(root, 'state/updates', files[0] ?? ''), 'utf8')).not.toContain(version);
    expect(spawnMock).not.toHaveBeenCalled();
    now += 60_000;
    expect((await m.maintainUpdates()).status).toBe('not_due');
    now += 3_600_000;
    await m.maintainUpdates();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds stalled registry requests and does not include thrown details in results', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = manager().maintainUpdates();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await pending).toMatchObject({ status: 'check_failed' });
    fetchMock.mockRejectedValue(new Error('secret credential in provider diagnostic'));
    expect(JSON.stringify(await manager().maintainUpdates({ force: true }))).not.toContain('secret');
  });

  it.each(['1.2.3', '1.2.2', '0.9.9'])('never installs equal or lower version %s', async (version) => {
    settings.mode = 'auto';
    fetchMock.mockImplementation(async () => Response.json({ version }));
    expect((await manager().maintainUpdates()).status).toBe('current');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('installs only the exact fixed version into the current verified global prefix', async () => {
    settings.mode = 'auto';
    const m = manager();
    expect((await m.maintainUpdates()).status).toBe('installed');
    expect(spawnMock).toHaveBeenCalledWith(
      'npm',
      [
        'install',
        '--global',
        '--prefix',
        prefix,
        'agentdrop-cli@1.2.4',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry',
        'https://registry.npmjs.org',
      ],
      { stdio: 'ignore', shell: false, env: {} },
    );
    expect(m.getUpdateNotice(settings)?.message).toContain('the current MCP session keeps running');
    expect(spawnMock).toHaveBeenLastCalledWith('/node/bin/node', [script, '_sync-skills'], {
      stdio: 'ignore',
      shell: false,
      env: {},
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    'checkout/apps/cli/src/main.ts',
    '_npx/hash/node_modules/agentdrop-cli/bin/agentdrop.mjs',
    'project/node_modules/agentdrop-cli/bin/agentdrop.mjs',
  ])('does not automatically install from %s', async (path) => {
    settings.mode = 'auto';
    const unsupported = join(root, path);
    mkdirSync(dirname(unsupported), { recursive: true });
    writeFileSync(unsupported, '');
    expect((await manager({ script: unsupported }).maintainUpdates()).status).toBe('manual_required');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects a package with the wrong identity even in the global directory layout', async () => {
    settings.mode = 'auto';
    writeFileSync(join(dirname(dirname(script)), 'package.json'), JSON.stringify({ name: 'not-agentdrop' }));
    expect((await manager().maintainUpdates()).status).toBe('manual_required');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('serializes overlapping maintenance calls and releases the installation lock', async () => {
    let finish: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = manager().maintainUpdates();
    expect((await manager().maintainUpdates({ force: true })).status).toBe('busy');
    finish?.(Response.json({ version: '1.2.4' }));
    expect((await pending).status).toBe('available');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await manager().maintainUpdates()).status).toBe('not_due');
  });

  it('off skips background work; explicit check and install override it', async () => {
    settings.mode = 'off';
    const m = manager();
    m.startUpdateMaintenance(settings);
    expect((await m.maintainUpdates()).status).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await m.maintainUpdates({ force: true, install: false })).status).toBe('available');
    expect(m.getUpdateNotice(settings)).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
    expect((await m.maintainUpdates({ force: true, install: true })).status).toBe('installed');
  });

  it('manual --check never installs even when auto updates are enabled', async () => {
    settings.mode = 'auto';
    expect((await manager().maintainUpdates({ force: true, install: false })).status).toBe('available');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('only schedules one detached worker and does no network activity in the hook', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    manager().startUpdateMaintenance(settings);
    manager().startUpdateMaintenance(settings);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      '/node/bin/node',
      [script, '_maintenance'],
      expect.objectContaining({ detached: true, stdio: 'ignore', shell: false }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
    const env = spawnMock.mock.calls[0]?.[2].env;
    expect(env?.AGENTDROP_UPDATE_LOCK_TOKEN).toBeTypeOf('string');
    expect((await manager({ env: env ?? {} }).maintainUpdates()).status).toBe('available');
    manager().startUpdateMaintenance(settings);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('cools down failed detached launches without propagating spawn errors', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const m = manager();
    m.startUpdateMaintenance(settings);
    child.emit('error', new Error('untrusted spawn diagnostic'));
    manager().startUpdateMaintenance(settings);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(m.getUpdateNotice(settings)).toBeNull();
  });

  it('records install failure without npm output and respects the failure cooldown', async () => {
    settings.mode = 'auto';
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.emit('error', new Error('npm diagnostic may contain credentials'));
        child.emit('close', 1);
      });
      return child;
    });
    const result = await manager().maintainUpdates();
    expect(result.status).toBe('install_failed');
    expect(JSON.stringify(result)).not.toContain('credentials');
    now += 60_000;
    expect((await manager().maintainUpdates()).status).toBe('not_due');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed cache data and never displays arbitrary cached registry text', async () => {
    const m = manager();
    await m.maintainUpdates();
    const cacheDir = join(root, 'state/updates');
    const path = join(cacheDir, readdirSync(cacheDir).find((name) => name.endsWith('.json')) ?? '');
    const cache = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...cache, latest: '1.2.4; malicious' }));
    expect(m.getUpdateNotice(settings)).toBeNull();
    expect((await m.maintainUpdates()).status).toBe('available');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not report an old installation notice after a newer CLI was installed separately', async () => {
    settings.mode = 'auto';
    await manager().maintainUpdates();
    expect(manager({ version: '2.0.0' }).getUpdateNotice(settings)).toBeNull();
  });

  it('waits for npm close and retains exclusivity when npm ignores SIGTERM', async () => {
    vi.useFakeTimers();
    settings.mode = 'auto';
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const pending = manager().maintainUpdates();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect((await manager().maintainUpdates({ force: true })).status).toBe('busy');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect((await manager().maintainUpdates({ force: true })).status).toBe('busy');
    child.emit('close', null, 'SIGKILL');
    expect((await pending).status).toBe('install_failed');
    expect((await manager().maintainUpdates()).status).toBe('not_due');
  });

  it('keeps the lock and npm PID if process exit cannot be confirmed', async () => {
    vi.useFakeTimers();
    settings.mode = 'auto';
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const pending = manager().maintainUpdates();
    await vi.advanceTimersByTimeAsync(123_000);
    expect((await pending).status).toBe('install_failed');
    expect((await manager().maintainUpdates({ force: true })).status).toBe('busy');
    const lock = readdirSync(join(root, 'state/updates')).find((name) => name.endsWith('.lock'));
    const lockDir = join(root, 'state/updates', lock ?? '');
    const lockOwner = readdirSync(lockDir).find((name) => name.startsWith('owner-')) ?? '';
    expect(JSON.parse(readFileSync(join(lockDir, lockOwner), 'utf8')).install_pid).toBe(process.pid);
    child.emit('close', null, 'SIGKILL');
    expect(readdirSync(join(root, 'state/updates')).some((name) => name.endsWith('.lock'))).toBe(false);
  });

  it('recovers an empty lock even when an obsolete recovery marker was abandoned', async () => {
    const m = manager();
    await m.maintainUpdates();
    const state = join(root, 'state/updates');
    const cache = readdirSync(state).find((name) => name.endsWith('.json')) ?? '';
    const lock = join(state, cache.replace(/\.json$/, '.lock'));
    mkdirSync(lock);
    const reaper = `${lock}.reaper`;
    mkdirSync(reaper);
    writeFileSync(join(reaper, 'owner.json'), JSON.stringify({ token: 'dead', pid: 2_147_483_647 }));
    utimesSync(lock, new Date(now - 60_000), new Date(now - 60_000));
    expect((await m.maintainUpdates({ force: true })).status).toBe('available');
  });

  it('only one contender recovers a dead owner and starts maintenance', async () => {
    const m = manager();
    await m.maintainUpdates();
    const state = join(root, 'state/updates');
    const cache = readdirSync(state).find((name) => name.endsWith('.json')) ?? '';
    const lock = join(state, cache.replace(/\.json$/, '.lock'));
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner-dead.json'), JSON.stringify({ token: 'dead', pid: 2_147_483_647 }));
    let finish: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = manager().maintainUpdates({ force: true });
    const contenders = await Promise.all(
      Array.from({ length: 5 }, () => manager().maintainUpdates({ force: true })),
    );
    expect(contenders.every((item) => item.status === 'busy')).toBe(true);
    finish?.(Response.json({ version: '1.2.4' }));
    expect((await first).status).toBe('available');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rebases clock rollback once and then resumes the configured check interval', async () => {
    const m = manager();
    await m.maintainUpdates();
    now -= 86_400_000;
    expect((await m.maintainUpdates()).status).toBe('available');
    expect((await m.maintainUpdates()).status).toBe('not_due');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now += settings.interval_ms;
    expect((await m.maintainUpdates()).status).toBe('available');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not let acknowledgement overwrite a concurrently maintained cache', async () => {
    const m = manager();
    await m.maintainUpdates();
    const notice = m.getUpdateNotice(settings);
    let finish: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = manager().maintainUpdates({ force: true });
    m.acknowledgeUpdateNotice(notice?.id ?? '');
    finish?.(Response.json({ version: '1.2.5' }));
    await pending;
    expect(m.getUpdateNotice(settings)?.message).toContain('1.2.5');
  });

  it.each(['unchanged', 'wrong-name', 'wrong-version', 'missing-bin'])(
    'does not trust npm exit zero when disk verification fails: %s',
    async (failure) => {
      settings.mode = 'auto';
      spawnMock.mockImplementation(() => {
        const child = fakeChild();
        queueMicrotask(() => {
          if (failure !== 'unchanged')
            writeFileSync(
              join(dirname(dirname(script)), 'package.json'),
              JSON.stringify({
                name: failure === 'wrong-name' ? 'wrong-package' : 'agentdrop-cli',
                version: failure === 'wrong-version' ? '1.2.5' : '1.2.4',
              }),
            );
          if (failure === 'missing-bin') rmSync(script);
          child.emit('close', 0);
        });
        return child;
      });
      expect((await manager().maintainUpdates()).status).toBe('install_failed');
      expect(spawnMock).toHaveBeenCalledTimes(1);
    },
  );

  it('reports skill failure separately and retries only skill sync from the updated CLI', async () => {
    settings.mode = 'auto';
    spawnMock.mockImplementation((command) => {
      const child = fakeChild();
      queueMicrotask(() => {
        if (command === 'npm')
          writeFileSync(
            join(dirname(dirname(script)), 'package.json'),
            JSON.stringify({ name: 'agentdrop-cli', version: '1.2.4' }),
          );
        child.emit('close', command === 'npm' ? 0 : 1);
      });
      return child;
    });
    const result = await manager().maintainUpdates();
    expect(result.status).toBe('skills_failed');
    expect(result.message).toContain('CLI 1.2.4 is installed');
    const updated = manager({ version: '1.2.4' });
    expect(updated.getUpdateNotice(settings)?.message).toContain(
      'syncing or verifying the skill did not finish',
    );
    expect((await updated.maintainUpdates()).status).toBe('not_due');
    expect((await updated.maintainUpdates({ force: true, install: false })).status).toBe('skills_failed');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    now += 3_600_000;
    expect((await updated.maintainUpdates()).status).toBe('installed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls.filter(([command]) => command === 'npm')).toHaveLength(1);
    expect(spawnMock).toHaveBeenLastCalledWith(
      '/node/bin/node',
      [script, '_sync-skills'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
  });

  it('allows explicit skill repair when already running the latest CLI, without npm', async () => {
    fetchMock.mockImplementation(async () => Response.json({ version: '1.2.3' }));
    settings.mode = 'off';
    expect((await manager().maintainUpdates({ force: true, install: true })).status).toBe('installed');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('/node/bin/node', [script, '_sync-skills'], expect.anything());
  });

  it('runs the newly installed real script rather than the original symlink launcher', async () => {
    settings.mode = 'auto';
    const launcher = join(root, 'agentdrop-launcher');
    symlinkSync(script, launcher);
    expect((await manager({ script: launcher }).maintainUpdates()).status).toBe('installed');
    expect(spawnMock).toHaveBeenLastCalledWith('/node/bin/node', [script, '_sync-skills'], expect.anything());
  });

  it('bounds skill sync and reports skills_failed while preserving the updated CLI', async () => {
    vi.useFakeTimers();
    settings.mode = 'auto';
    const syncChild = fakeChild();
    spawnMock.mockImplementation((command) => {
      if (command !== 'npm') return syncChild;
      const child = fakeChild();
      queueMicrotask(() => {
        writeFileSync(
          join(dirname(dirname(script)), 'package.json'),
          JSON.stringify({ name: 'agentdrop-cli', version: '1.2.4' }),
        );
        child.emit('close', 0);
      });
      return child;
    });
    const pending = manager().maintainUpdates();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(syncChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect((await manager().maintainUpdates({ force: true })).status).toBe('busy');
    syncChild.emit('close', null, 'SIGTERM');
    expect((await pending).status).toBe('skills_failed');
    expect(JSON.parse(readFileSync(join(dirname(dirname(script)), 'package.json'), 'utf8')).version).toBe(
      '1.2.4',
    );
  });

  it('passes the selected profile to background maintenance for effective web preferences', () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    manager().startUpdateMaintenance(settings, 'codex-work');
    expect(spawnMock.mock.calls[0]?.[2].env?.AGENTDROP_UPDATE_PROFILE).toBe('codex-work');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears only the matching skill failure after confirmed synchronization', async () => {
    settings.mode = 'auto';
    spawnMock.mockImplementation((command) => {
      const child = fakeChild();
      queueMicrotask(() => {
        if (command === 'npm')
          writeFileSync(
            join(dirname(dirname(script)), 'package.json'),
            JSON.stringify({ name: 'agentdrop-cli', version: '1.2.4' }),
          );
        child.emit('close', command === 'npm' ? 0 : 1);
      });
      return child;
    });
    await manager().maintainUpdates();
    const updated = manager({ version: '1.2.4' });
    updated.acknowledgeSkillSync('1.2.5');
    updated.acknowledgeSkillSync('1.2.4; invalid');
    expect(updated.getUpdateNotice(settings)?.id).toBe('skills_failed:1.2.4');
    now += 1_000;
    updated.acknowledgeSkillSync('1.2.4');
    expect(updated.getUpdateNotice(settings)?.id).toBe('installed:1.2.4');
    expect(updated.getUpdateNotice(settings)?.message).not.toContain('did not finish');
    expect((await updated.maintainUpdates()).status).toBe('not_due');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
