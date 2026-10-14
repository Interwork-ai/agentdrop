import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { readEffectiveHookSettings } from './client-preferences.js';
import { readHookSettings, type UpdateSettings } from './hook-settings.js';
import { type Language, readLanguage } from './locale.js';
import { CLI_VERSION } from './output.js';
import { stateDir } from './paths.js';

const REGISTRY = 'https://registry.npmjs.org';
const LATEST_URL = `${REGISTRY}/agentdrop-cli/latest`;
const CHECK_TIMEOUT_MS = 4_000;
const INSTALL_TIMEOUT_MS = 120_000;
const SKILL_SYNC_TIMEOUT_MS = 20_000;
const FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
const LOCK_ENV = 'AGENTDROP_UPDATE_LOCK_TOKEN';
const outcomeSchema = z.enum([
  'current',
  'available',
  'installed',
  'manual_required',
  'check_failed',
  'install_failed',
  'skills_failed',
]);
const cacheSchema = z.object({
  checked_at: z.number().finite().nonnegative(),
  retry_after: z.number().finite().nonnegative(),
  outcome: outcomeSchema,
  latest: z.string().optional(),
  acknowledged: z.array(z.string().max(120)).max(32).default([]),
});
type Cache = z.infer<typeof cacheSchema>;
export interface UpdateResult {
  status: Cache['outcome'] | 'disabled' | 'not_due' | 'busy';
  current_version: string;
  latest_version?: string;
  message: string;
}
export interface UpdateNotice {
  id: string;
  message: string;
}

interface Dependencies {
  version: string;
  script: string;
  execPath: string;
  execArgs: string[];
  platform: string;
  env: NodeJS.ProcessEnv;
  stateRoot: () => string;
  settings: () => UpdateSettings;
  now: () => number;
  fetch: typeof fetch;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/** Only plain stable releases are accepted; no tags, prereleases, paths, URLs or npm arguments. */
function stableVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 48 &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
    value.split('.').every((part) => Number.isSafeInteger(Number(part)))
  );
}
function newer(a: string, b: string): boolean {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return (left[i] ?? 0) > (right[i] ?? 0);
  }
  return false;
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Dependency injection keeps all tests offline and never invokes a real npm install. */
export function createUpdateManager(overrides: Partial<Dependencies> = {}) {
  const d: Dependencies = {
    version: CLI_VERSION,
    script: process.argv[1] ?? '',
    execPath: process.execPath,
    execArgs: process.execArgv,
    platform: process.platform,
    env: process.env,
    stateRoot: stateDir,
    settings: () => {
      const profile = d.env.AGENTDROP_UPDATE_PROFILE;
      return (profile ? readEffectiveHookSettings(profile) : readHookSettings()).updates;
    },
    now: Date.now,
    fetch: globalThis.fetch,
    spawn: (command, args, options) => spawn(command, args, options),
    ...overrides,
  };
  const scriptPath = () => {
    try {
      return realpathSync(d.script);
    } catch {
      return resolve(d.script);
    }
  };
  const installationKey = createHash('sha256').update(scriptPath()).digest('hex').slice(0, 24);
  const paths = () => {
    const root = join(d.stateRoot(), 'updates');
    const key = installationKey;
    return { root, cache: join(root, `${key}.json`), lock: join(root, `${key}.lock`) };
  };
  const readCache = (): Cache | null => {
    try {
      const path = paths().cache;
      if (statSync(path).size > 32_768) return null;
      const parsed = cacheSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (!parsed.success || (parsed.data.latest && !stableVersion(parsed.data.latest))) return null;
      return parsed.data;
    } catch {
      return null;
    }
  };
  const writeCache = (cache: Cache) => {
    const p = paths();
    mkdirSync(p.root, { recursive: true, mode: 0o700 });
    const tmp = `${p.cache}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, p.cache);
    } finally {
      rmSync(tmp, { force: true });
    }
  };
  const due = (settings: UpdateSettings, cache: Cache | null) =>
    !cache ||
    cache.checked_at > d.now() ||
    cache.retry_after > cache.checked_at + FAILURE_COOLDOWN_MS ||
    d.now() >= (cache.retry_after || cache.checked_at + Math.max(60_000, settings.interval_ms));
  type LockOwner = { token: string; pid: number; install_pid?: number; file: string };
  const owner = (): LockOwner | null => {
    try {
      const files = readdirSync(paths().lock).filter((file) => /^owner-[a-f0-9-]+\.json$/.test(file));
      if (files.length !== 1) return null;
      const file = files[0];
      if (!file) return null;
      const value = JSON.parse(readFileSync(join(paths().lock, file), 'utf8'));
      if (
        typeof value.token !== 'string' ||
        file !== `owner-${value.token}.json` ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        (value.install_pid !== undefined &&
          (!Number.isSafeInteger(value.install_pid) || value.install_pid <= 0))
      )
        return null;
      return { ...value, file };
    } catch {
      return null;
    }
  };
  const writeOwner = (token: string, pid: number, installPid?: number): boolean => {
    if (owner()?.token !== token) return false;
    const path = join(paths().lock, `owner-${token}.json`);
    // A crash before rename must not leave a stray file that prevents removing the lock directory.
    const tmp = join(paths().root, `owner-${token}.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify({ token, pid, ...(installPid ? { install_pid: installPid } : {}) }), {
        mode: 0o600,
        flag: 'wx',
      });
      // The token file is unique to this lock. Never recreate an owner after its worker has finished.
      if (owner()?.token !== token) return false;
      renameSync(tmp, path);
      return true;
    } finally {
      rmSync(tmp, { force: true });
    }
  };
  const release = (token: string): void => {
    try {
      // Unlink only our unique token, then remove the now-empty directory. A new owner's directory is nonempty.
      unlinkSync(join(paths().lock, `owner-${token}.json`));
      try {
        rmdirSync(paths().lock);
      } catch {
        /* another process has already acquired it */
      }
    } catch {
      /* already released, or a newer owner holds the lock */
    }
  };
  const acquire = (): string | null => {
    const p = paths();
    mkdirSync(p.root, { recursive: true, mode: 0o700 });
    const attempt = () => {
      const token = randomUUID();
      const staging = `${p.lock}.${token}.tmp`;
      try {
        mkdirSync(staging, { mode: 0o700 });
        writeFileSync(join(staging, `owner-${token}.json`), JSON.stringify({ token, pid: process.pid }), {
          mode: 0o600,
        });
        // POSIX rename cannot replace a nonempty directory: every visible new lock already has its owner.
        renameSync(staging, p.lock);
        return token;
      } catch {
        return null;
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    };
    const token = attempt();
    if (token) return token;
    const old = owner();
    if (old && !processAlive(old.pid) && !(old.install_pid && processAlive(old.install_pid))) {
      release(old.token);
      return attempt();
    }
    // Recovery needs no secondary lock. Empty remnants can be removed, never a new nonempty owner's lock.
    if (!old) {
      try {
        rmdirSync(p.lock);
      } catch {
        return null;
      }
      return attempt();
    }
    return null;
  };
  const result = (status: UpdateResult['status'], latest?: string): UpdateResult => {
    // Shown to people (the update command, the Stop notice), so it follows the user's language; English by default.
    const v = latest ?? '';
    const messages: Record<Language, Record<UpdateResult['status'], string>> = {
      en: {
        disabled: 'CLI update checks are off.',
        not_due: 'The next CLI update check is not due yet.',
        busy: 'Another process is checking or updating the CLI.',
        current: 'The CLI is on the current stable version.',
        available: `AgentDrop CLI ${v} is available; run agentdrop update in a terminal to install it.`,
        installed: `AgentDrop CLI ${v} and its skill are updated and verified; new processes use it, the current MCP session keeps running.`,
        manual_required: `AgentDrop CLI ${v} is available; this installation cannot update itself, so update it the way you installed it.`,
        check_failed:
          'The CLI update check failed for now and will retry later; you can also run agentdrop update --check.',
        install_failed:
          'The automatic CLI update did not finish; update it the way you installed it. AgentDrop never elevates privileges.',
        skills_failed: `AgentDrop CLI ${v} is installed, but syncing or verifying the skill did not finish; the next CLI run repairs it, or run agentdrop update again.`,
      },
      zh: {
        disabled: 'CLI 更新检查已关闭。',
        not_due: '尚未到下一次 CLI 更新检查时间。',
        busy: '另一个进程正在检查或更新 CLI。',
        current: 'CLI 已是当前稳定版本。',
        available: `AgentDrop CLI ${v} 已可用；在终端运行 agentdrop update 安装。`,
        installed: `AgentDrop CLI ${v} 与配套 skill 已更新并校验，新启动的进程生效；当前 MCP 会话继续运行。`,
        manual_required: `AgentDrop CLI ${v} 已可用；当前安装方式不支持自动更新，请通过原安装方式手动更新。`,
        check_failed: 'CLI 更新检查暂时失败，将稍后重试；也可运行 agentdrop update --check 手动检查。',
        install_failed: 'CLI 自动更新未完成；请通过原安装方式手动更新；AgentDrop 不会自动提权。',
        skills_failed: `AgentDrop CLI ${v} 已升级，但 skill 同步或校验未完成；下次运行 CLI 会自动修复，也可运行 agentdrop update 重试。`,
      },
    };
    const language = readLanguage();
    return {
      status,
      current_version: d.version,
      ...(latest ? { latest_version: latest } : {}),
      message: messages[language][status],
    };
  };
  const prefix = (): string | null => {
    if (d.platform === 'win32') return null;
    try {
      const script = realpathSync(d.script);
      const suffix = '/lib/node_modules/agentdrop-cli/bin/agentdrop.mjs';
      if (!script.endsWith(suffix)) return null;
      const root = script.slice(0, -suffix.length) || '/';
      const pkgRoot = join(root, 'lib/node_modules/agentdrop-cli');
      if (realpathSync(root) !== root || realpathSync(pkgRoot) !== pkgRoot) return null;
      if (JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).name !== 'agentdrop-cli')
        return null;
      return root;
    } catch {
      return null;
    }
  };
  const latestVersion = async () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout'));
      }, CHECK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await d.fetch(LATEST_URL, {
            signal: controller.signal,
            redirect: 'error',
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error('registry failed');
          const json = (await response.json()) as { version?: unknown };
          if (!stableVersion(json.version)) throw new Error('invalid version');
          return json.version;
        })(),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const runChild = (
    command: string,
    args: string[],
    token: string,
    timeoutMs: number,
  ): Promise<'succeeded' | 'failed' | 'unconfirmed'> =>
    new Promise((done) => {
      let child: ChildProcess;
      try {
        child = d.spawn(command, args, { stdio: 'ignore', shell: false, env: d.env });
      } catch {
        done('failed');
        return;
      }
      // Track both npm and the skill-sync child so a worker crash never releases an active writer.
      if (child.pid) writeOwner(token, process.pid, child.pid);
      let timedOut = false;
      let settled = false;
      let unconfirmed = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let confirmation: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: 'succeeded' | 'failed' | 'unconfirmed') => {
        if (settled) return;
        settled = true;
        unconfirmed = outcome === 'unconfirmed';
        clearTimeout(timer);
        clearTimeout(grace);
        clearTimeout(confirmation);
        done(outcome);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        grace = setTimeout(() => {
          child.kill('SIGKILL');
          // Keep the lock if exit cannot be confirmed; never allow a second npm installer to race it.
          confirmation = setTimeout(() => finish('unconfirmed'), 1_000);
        }, 2_000);
      }, timeoutMs);
      child.once('error', () => {
        if (!child.pid) finish('failed');
      });
      child.once('close', (code) => {
        if (unconfirmed) release(token);
        finish(!timedOut && code === 0 ? 'succeeded' : 'failed');
      });
    });

  const install = (version: string, root: string, token: string) =>
    runChild(
      'npm',
      [
        'install',
        '--global',
        '--prefix',
        root,
        `agentdrop-cli@${version}`,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry',
        REGISTRY,
      ],
      token,
      INSTALL_TIMEOUT_MS,
    );
  const installedVersion = (root: string): string | null => {
    try {
      const packageRoot = join(root, 'lib/node_modules/agentdrop-cli');
      const script = join(packageRoot, 'bin/agentdrop.mjs');
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
      if (
        manifest.name !== 'agentdrop-cli' ||
        !stableVersion(manifest.version) ||
        !statSync(script).isFile() ||
        realpathSync(script) !== script ||
        realpathSync(packageRoot) !== packageRoot
      )
        return null;
      return manifest.version;
    } catch {
      return null;
    }
  };
  const syncSkills = (root: string, token: string) =>
    runChild(
      d.execPath,
      [join(root, 'lib/node_modules/agentdrop-cli/bin/agentdrop.mjs'), '_sync-skills'],
      token,
      SKILL_SYNC_TIMEOUT_MS,
    );

  const maintainUpdates = async (
    opts: { force?: boolean; install?: boolean } = {},
  ): Promise<UpdateResult> => {
    const inherited = d.env[LOCK_ENV];
    let token: string | null = null;
    let retainLock = false;
    try {
      const settings = d.settings();
      if (inherited && owner()?.token === inherited) {
        token = inherited;
        writeOwner(token, process.pid);
      }
      if (settings.mode === 'off' && !opts.force && !opts.install) return result('disabled');
      if (!opts.force && !opts.install && !due(settings, readCache())) return result('not_due');
      token ??= acquire();
      if (!token) return result('busy');
      const lockToken = token;
      const previous = readCache();
      if (!opts.force && !opts.install && !due(settings, previous)) return result('not_due');
      let latest: string | undefined;
      let status: Cache['outcome'];
      const finishSkills = async (root: string): Promise<Cache['outcome']> => {
        try {
          const synced = await syncSkills(root, lockToken);
          retainLock = synced === 'unconfirmed';
          return synced === 'succeeded' ? 'installed' : 'skills_failed';
        } catch {
          retainLock = !!owner()?.install_pid;
          return 'skills_failed';
        }
      };
      try {
        const root = prefix();
        const onDisk = root ? installedVersion(root) : null;
        const pendingSkills = previous?.outcome === 'skills_failed' && previous.latest === onDisk;
        if (pendingSkills && root && onDisk) {
          latest = onDisk;
          // Finish the already authorized upgrade without reinstalling npm; --check stays read-only.
          status = opts.install === false ? 'skills_failed' : await finishSkills(root);
        } else {
          latest = await latestVersion();
          const current = onDisk && newer(onDisk, d.version) ? onDisk : d.version;
          if (!stableVersion(current) || !newer(latest, current)) {
            if (opts.install === true && root && onDisk) {
              latest = onDisk;
              status = await finishSkills(root);
            } else status = 'current';
            // A user may disable automatic installation while the registry request is in flight.
          } else if (opts.install ?? d.settings().mode === 'auto') {
            if (root) {
              const installed = await install(latest, root, token);
              retainLock = installed === 'unconfirmed';
              if (installed !== 'succeeded' || installedVersion(root) !== latest) status = 'install_failed';
              else status = await finishSkills(root);
            } else status = 'manual_required';
          } else status = 'available';
        }
      } catch {
        status = 'check_failed';
      }
      writeCache({
        checked_at: d.now(),
        retry_after:
          status === 'check_failed' || status === 'install_failed' || status === 'skills_failed'
            ? d.now() + FAILURE_COOLDOWN_MS
            : 0,
        outcome: status,
        ...(latest ? { latest } : {}),
        acknowledged: readCache()?.acknowledged ?? previous?.acknowledged ?? [],
      });
      return result(status, latest);
    } catch {
      return result('check_failed');
    } finally {
      if (token && !retainLock) release(token);
    }
  };
  const startUpdateMaintenance = (settings: UpdateSettings, profileName?: string): void => {
    if (settings.mode === 'off') return;
    let token: string | null = null;
    const failed = () => {
      if (!token || owner()?.token !== token) return;
      try {
        const old = readCache();
        writeCache({
          checked_at: d.now(),
          retry_after: d.now() + FAILURE_COOLDOWN_MS,
          outcome: 'check_failed',
          acknowledged: old?.acknowledged ?? [],
        });
      } catch {
        /* read-only state directory */
      }
      if (token) release(token);
    };
    try {
      if (!due(settings, readCache())) return;
      token = acquire();
      if (!token) return;
      const child = d.spawn(d.execPath, [...d.execArgs, d.script, '_maintenance'], {
        detached: true,
        stdio: 'ignore',
        shell: false,
        env: {
          ...d.env,
          [LOCK_ENV]: token,
          ...(profileName ? { AGENTDROP_UPDATE_PROFILE: profileName } : {}),
        },
      });
      child.once('error', failed);
      // Transfer ownership before this hook exits; a live detached worker keeps the lock exclusive.
      if (child.pid && owner()?.token === token) writeOwner(token, child.pid);
      child.unref();
    } catch {
      failed();
    }
  };
  const getUpdateNotice = (settings: UpdateSettings): UpdateNotice | null => {
    if (settings.mode === 'off') return null;
    const cache = readCache();
    if (!cache || cache.outcome === 'current' || cache.outcome === 'check_failed') return null;
    if (cache.latest && newer(d.version, cache.latest)) return null;
    if (
      !cache.latest ||
      (!newer(cache.latest, d.version) && cache.outcome !== 'installed' && cache.outcome !== 'skills_failed')
    )
      return null;
    const id = `${cache.outcome}:${cache.latest ?? d.version}`;
    if (cache.acknowledged.includes(id)) return null;
    return { id, message: result(cache.outcome, cache.latest).message };
  };
  const acknowledgeUpdateNotice = (id: string): void => {
    let token: string | null = null;
    try {
      token = acquire();
      if (!token) return;
      const cache = readCache();
      if (!cache) return;
      const expected = `${cache.outcome}:${cache.latest ?? d.version}`;
      if (id !== expected || cache.acknowledged.includes(id)) return;
      writeCache({ ...cache, acknowledged: [...cache.acknowledged, id].slice(-32) });
    } catch {
      /* Notifications and update maintenance never prevent a Stop hook from finishing. */
    } finally {
      if (token) release(token);
    }
  };
  const acknowledgeSkillSync = (version: string): void => {
    if (!stableVersion(version)) return;
    const previous = readCache();
    if (previous?.outcome !== 'skills_failed' || previous.latest !== version) return;
    let token: string | null = null;
    try {
      token = acquire();
      if (!token) return;
      const cache = readCache();
      if (cache?.outcome !== 'skills_failed' || cache.latest !== version) return;
      writeCache({ ...cache, outcome: 'installed', retry_after: 0, checked_at: d.now() });
    } catch {
      /* Successful skill synchronization must not fail because update metadata is unavailable. */
    } finally {
      if (token) release(token);
    }
  };
  /**
   * The CLI version installed where this process was started from, read from disk only (no network): the npm
   * package an update writes over, else what the update record says it installed. A long-running process (the MCP
   * bridge) compares it with its own version to tell that a newer one replaced it on disk. Null when unknown.
   */
  const installedCliVersion = (): string | null => {
    try {
      const root = prefix();
      const onDisk = root ? installedVersion(root) : null;
      if (onDisk) return onDisk;
      const cache = readCache();
      return cache?.latest && (cache.outcome === 'installed' || cache.outcome === 'skills_failed')
        ? cache.latest
        : null;
    } catch {
      return null;
    }
  };
  return {
    startUpdateMaintenance,
    getUpdateNotice,
    acknowledgeUpdateNotice,
    acknowledgeSkillSync,
    maintainUpdates,
    installedCliVersion,
  };
}

export const startUpdateMaintenance = (settings: UpdateSettings, profileName?: string): void =>
  createUpdateManager().startUpdateMaintenance(settings, profileName);
export const getUpdateNotice = (settings: UpdateSettings): UpdateNotice | null =>
  createUpdateManager().getUpdateNotice(settings);
export const acknowledgeUpdateNotice = (id: string): void =>
  createUpdateManager().acknowledgeUpdateNotice(id);
export const acknowledgeSkillSync = (version: string): void =>
  createUpdateManager().acknowledgeSkillSync(version);
export const maintainUpdates = (opts?: { force?: boolean; install?: boolean }): Promise<UpdateResult> =>
  createUpdateManager().maintainUpdates(opts);
export const installedCliVersion = (): string | null => createUpdateManager().installedCliVersion();
