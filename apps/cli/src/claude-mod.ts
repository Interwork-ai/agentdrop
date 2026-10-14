import { type ChildProcess, execFileSync, type SpawnOptions, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic-write.js';
import { defaultExecutable, whichBin } from './harnesses/shared.js';
import { CLI_VERSION } from './output.js';
import { configDir, dataDir } from './paths.js';
import { isPackagedCli } from './skill-lifecycle.js';

/*
 * The AgentDrop mod for Claude Code (apps/cli/claude-mod/agentdrop): the waiting list above the prompt and the
 * /agentdrop pane. Mods need Claude Code 2.1.287 or later; older versions keep the status line. The mod ships in this
 * package, is copied into AgentDrop's data directory as a local marketplace and installed from there at user scope.
 * Claude Code installs its own copy of the plugin (plugins/cache/<marketplace>/<plugin>/<version>) and loads that, so
 * after an upgrade the marketplace copy is rewritten and `claude plugin update` makes Claude Code take it, once for
 * every Claude Code config directory (CLAUDE_CONFIG_DIR) the mod was installed into: they share the one copy.
 */

export const MOD_MARKETPLACE = 'agentdrop-local';
export const MOD_PLUGIN = 'agentdrop';
export const MOD_ID = `${MOD_PLUGIN}@${MOD_MARKETPLACE}`;
const MIN_CLAUDE: readonly [number, number, number] = [2, 1, 287];
/** Written into the plugin copy: where claude-mod.json is, so the mod never guesses the config directory. */
const POINTER = 'config.json';
/**
 * In the marketplace root, per Claude Code config directory: the copy version Claude Code was last told to take
 * (`plugin install` / `plugin update`), or that the person removed the plugin in Claude Code themselves.
 */
const TAKEN = '.taken';
/** In the marketplace root: when the background worker last tried to have Claude Code take the copy. */
const ATTEMPT = '.take-attempt';
const ATTEMPT_EVERY_MS = 10 * 60 * 1000;
/** A claim being replaced by a process that died meanwhile stops blocking claims after this long. */
const ATTEMPT_LOCK_STALE_MS = 60 * 1000;
/** Staging directories a write left behind (a crash, a full disk) are removed by a later write after this long. */
const STAGING_STALE_MS = 60 * 60 * 1000;
/** `claude plugin update` of a local marketplace takes well under a second; never let it hang the worker. */
const TAKE_TIMEOUT_MS = 30_000;
/** What makes a copy of the mod complete: without any of these Claude Code would load half a mod. */
const MOD_FILES: ReadonlyArray<readonly string[]> = [
  ['hooks', 'register.js'],
  ['hooks', 'rows.js'],
  ['hooks', 'hooks.json'],
  ['.claude-plugin', 'plugin.json'],
];

/**
 * Runs a command and returns its exit status and output; never throws (tests stub it). `env` replaces the
 * environment (the worker names the Claude Code config directory this way).
 */
export type Run = (
  argv: readonly string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => { status: number | null; stdout: string; stderr?: string };

export const defaultRun: Run = (argv, opts) => runFor(argv, 60_000, opts?.env);

function runFor(argv: readonly string[], timeout: number, env?: NodeJS.ProcessEnv): ReturnType<Run> {
  try {
    const stdout = execFileSync(argv[0] ?? '', argv.slice(1), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      ...(env ? { env } : {}),
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number | null; stdout?: unknown; stderr?: unknown };
    return {
      status: e.status ?? 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
    };
  }
}

/**
 * Orders two versions (`0.5.9`, `0.6.0-rc.1`) as semver does: negative when `a` is older. Anything unreadable is
 * older than any version.
 */
export function compareVersions(a: string | null, b: string | null): number {
  const parse = (v: string | null) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec((v ?? '').trim());
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  // a release is newer than its prereleases
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** `2.1.287 (Claude Code)` → whether it has mods. Anything unreadable counts as no. */
export function claudeHasMods(versionOutput: string): boolean {
  // the version Claude Code names as its own, else the first version in the output
  const m =
    /(\d+)\.(\d+)\.(\d+)\s*\(Claude Code\)/.exec(versionOutput) ?? /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) > (MIN_CLAUDE[i] ?? 0)) return true;
    if ((v[i] ?? 0) < (MIN_CLAUDE[i] ?? 0)) return false;
  }
  return true;
}

function hasMod(dir: string): boolean {
  return MOD_FILES.every((parts) => existsSync(join(dir, ...parts)));
}

export function bundledModDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'claude-mod', MOD_PLUGIN),
    resolve(here, '..', '..', 'claude-mod', MOD_PLUGIN),
  ];
  return candidates.find(hasMod) ?? candidates[1] ?? here;
}

/** The local marketplace Claude Code loads the mod from. */
export function installedModRoot(): string {
  return join(dataDir(), 'claude-mod');
}

/** What the mod runs: the agentdrop command and the profile. Read by the mod from the config directory. */
export function modConfigPath(): string {
  return join(configDir(), 'claude-mod.json');
}

/**
 * The Claude Code config directory a `claude` command run from here works on: CLAUDE_CONFIG_DIR, resolved, or null
 * for Claude Code's default (`~/.claude`).
 */
export function currentClaudeDir(): string | null {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? resolve(dir) : null;
}

/** The environment that makes `claude` work on `dir` (null: the default config directory). */
function claudeEnv(dir: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (dir === null) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface ModConfig {
  argv: string[];
  profile: string;
  /** Every Claude Code config directory the mod was installed into (null: the default one). */
  claude_dirs: Array<string | null>;
}

function readModConfig(): ModConfig | null {
  const raw = readJson(modConfigPath());
  const argv = raw?.argv;
  if (!Array.isArray(argv) || typeof argv[0] !== 'string' || typeof raw?.profile !== 'string') return null;
  // written before the list existed: the config directory this command works on, as the worker then assumed
  const dirs = Array.isArray(raw.claude_dirs)
    ? raw.claude_dirs.filter((d): d is string | null => d === null || (typeof d === 'string' && d !== ''))
    : [currentClaudeDir()];
  return {
    argv: argv.filter((a): a is string => typeof a === 'string'),
    profile: raw.profile,
    claude_dirs: [...new Set(dirs)],
  };
}

function writeModConfig(argv: string[], profile: string, dirs: Array<string | null>): void {
  writeFileAtomic(modConfigPath(), `${JSON.stringify({ argv, profile, claude_dirs: dirs }, null, 2)}\n`, {
    mode: 0o600,
  });
}

function installedVersion(): string | null {
  const manifest = readJson(join(installedModRoot(), MOD_PLUGIN, '.claude-plugin', 'plugin.json'));
  return typeof manifest?.version === 'string' ? manifest.version : null;
}

function installedPointer(): string | null {
  const pointer = readJson(join(installedModRoot(), MOD_PLUGIN, POINTER));
  return typeof pointer?.config === 'string' ? pointer.config : null;
}

/** What one Claude Code config directory did with the copy. */
interface Taken {
  dir: string | null;
  /** The copy version Claude Code took. */
  version?: string;
  /** The person removed the plugin in Claude Code: no update is tried again until connect installs it. */
  removed?: true;
}

function readTaken(): Taken[] {
  const raw = readJson(join(installedModRoot(), TAKEN));
  const list = Array.isArray(raw?.dirs) ? (raw.dirs as unknown[]) : [];
  const out: Taken[] = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const { dir, version, removed } = e as Record<string, unknown>;
    if (dir !== null && typeof dir !== 'string') continue;
    out.push({
      dir,
      ...(typeof version === 'string' ? { version } : {}),
      ...(removed === true ? { removed: true as const } : {}),
    });
  }
  return out;
}

/**
 * Writes one file into an existing directory by rename, never creating a directory: when the marketplace was
 * removed meanwhile (a disconnect), the write fails instead of bringing a piece of it back.
 */
function writeInto(dir: string, name: string, content: string): boolean {
  const temp = join(dir, `.${name}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(temp, content, { flag: 'wx' });
    renameSync(temp, join(dir, name));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Records what Claude Code did, only while the mod is still installed: a disconnect meanwhile wins. */
function writeTaken(entries: Taken[]): boolean {
  const root = installedModRoot();
  if (!existsSync(root) || !existsSync(modConfigPath())) return false;
  return writeInto(root, TAKEN, `${JSON.stringify({ dirs: entries })}\n`);
}

function recordTake(dir: string | null, entry: { version: string } | { removed: true }): boolean {
  return writeTaken([...readTaken().filter((e) => e.dir !== dir), { dir, ...entry }]);
}

/** Claude Code 2.1.287 says so on a failed `plugin update` when the plugin (or its marketplace) was removed. */
function notInstalled(res: ReturnType<Run>): boolean {
  return /Plugin "[^"]*" (?:is not installed|not found)/.test(`${res.stdout}\n${res.stderr ?? ''}`);
}

type Take = 'taken' | 'failed' | 'removed' | 'gone';

/**
 * Has Claude Code (for config directory `dir`) take the current marketplace copy; records the version only when it
 * did. `removed`: the person uninstalled the plugin in Claude Code, recorded so nobody retries; `gone`: the mod was
 * removed here meanwhile, and nothing was written.
 */
function takeCopy(claude: string, run: Run, dir: string | null): Take {
  // what Claude Code takes is what is there now; a rewrite meanwhile stays pending
  const version = installedVersion();
  const res = run([claude, 'plugin', 'update', MOD_ID, '--scope', 'user'], { env: claudeEnv(dir) });
  if (res.status !== 0) {
    if (!notInstalled(res)) return 'failed';
    return recordTake(dir, { removed: true }) ? 'removed' : 'gone';
  }
  if (!version) return 'gone';
  return recordTake(dir, { version }) ? 'taken' : 'gone';
}

/** The Claude Code config directories that have yet to take the current copy. */
function pendingDirs(): Array<string | null> {
  const config = readModConfig();
  const version = installedVersion();
  if (!config || !version) return [];
  const taken = readTaken();
  return config.claude_dirs.filter((dir) => {
    const entry = taken.find((e) => e.dir === dir);
    return !entry?.removed && entry?.version !== version;
  });
}

/** Claude Code writes type declarations beside a mod it loads from a folder during development: never shipped. */
export function shippedModFile(src: string): boolean {
  return !/[\\/]\.claude-plugin[\\/]types([\\/]|$)/.test(src) && !/(^|[\\/])tsconfig\.json$/.test(src);
}

/** Staging directories of an earlier write that never finished (`.agentdrop-*`, `.agentdrop-*.previous`). */
export function removeOldStaging(root: string, now = Date.now()): void {
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(`.${MOD_PLUGIN}-`)) continue;
    try {
      const st = statSync(join(root, name));
      // a rename counts as a change: a writer that is swapping right now is never disturbed
      if (now - Math.max(st.mtimeMs, st.ctimeMs) > STAGING_STALE_MS)
        rmSync(join(root, name), { recursive: true, force: true });
    } catch {
      /* gone meanwhile */
    }
  }
}

/**
 * Copies the bundled mod into the local marketplace, stamped with this CLI's version and pointing to
 * claude-mod.json. Built beside the installed copy and renamed into place, so a session never loads half a copy and
 * a failure leaves the previous one as it was. Throws when the bundled mod is missing, before touching anything.
 * Only `create` (connect) makes the marketplace directory; otherwise a marketplace removed meanwhile stays removed.
 */
function writeMarketplace(source: string = bundledModDir(), create = false): void {
  if (!hasMod(source)) throw new Error('the bundled Claude Code mod is missing');
  const root = installedModRoot();
  if (create) mkdirSync(root, { recursive: true });
  else if (!existsSync(root)) throw new Error('the Claude Code mod was removed');
  removeOldStaging(root);
  // a rewritten copy is one Claude Code has not taken yet; a plugin the person removed in Claude Code stays removed
  const removed = readTaken().filter((e) => e.removed);
  if (removed.length) writeInto(root, TAKEN, `${JSON.stringify({ dirs: removed })}\n`);
  else rmSync(join(root, TAKEN), { force: true });
  const plugin = join(root, MOD_PLUGIN);
  const market = join(root, '.claude-plugin');
  try {
    mkdirSync(market);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  }
  const staging = mkdtempSync(join(root, `.${MOD_PLUGIN}-`));
  let previous: string | null = null;
  try {
    cpSync(source, staging, { recursive: true, filter: shippedModFile });
    const manifestPath = join(staging, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version: CLI_VERSION }, null, 2)}\n`);
    writeFileSync(
      join(staging, POINTER),
      `${JSON.stringify({ config: resolve(modConfigPath()) }, null, 2)}\n`,
    );
    if (existsSync(plugin)) {
      previous = `${staging}.previous`;
      renameSync(plugin, previous);
    }
    try {
      renameSync(staging, plugin);
    } catch (error) {
      if (previous) renameSync(previous, plugin);
      previous = null;
      throw error;
    }
    const listed = writeInto(
      market,
      'marketplace.json',
      `${JSON.stringify(
        {
          name: MOD_MARKETPLACE,
          owner: { name: 'AgentDrop' },
          plugins: [{ name: MOD_PLUGIN, source: `./${MOD_PLUGIN}`, description: manifest.description }],
        },
        null,
        2,
      )}\n`,
    );
    if (!listed) throw new Error('could not write the marketplace listing');
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (previous) rmSync(previous, { recursive: true, force: true });
  }
}

export type ModInstall =
  | { status: 'installed' | 'unsupported' | 'no-claude' }
  /** What cleaning up after the failure left: the plugin entry may remain (see {@link removeClaudeMod}). */
  | { status: 'failed'; pluginLeft: boolean; claudeMissing: boolean };

/**
 * Installs (or refreshes) the mod for `profile` into the Claude Code config directory this command works on
 * (CLAUDE_CONFIG_DIR, else the default), when Claude Code has mods, and records that directory. Idempotent: adding a
 * marketplace or installing a plugin that is already there succeeds. A failed install leaves nothing of it behind for
 * this directory (no marketplace entry; no copy and no claude-mod.json unless another directory still uses them).
 */
export function installClaudeMod(opts: {
  exe: string;
  profile: string;
  claude: string | null;
  run?: Run;
}): ModInstall {
  const run = opts.run ?? defaultRun;
  if (!opts.claude) return { status: 'no-claude' };
  const version = run([opts.claude, '--version']);
  if (version.status !== 0 || !claudeHasMods(version.stdout)) return { status: 'unsupported' };
  const dir = currentClaudeDir();
  try {
    writeMarketplace(bundledModDir(), true);
    const others = (readModConfig()?.claude_dirs ?? []).filter((d) => d !== dir);
    writeModConfig([opts.exe], opts.profile, [...others, dir]);
    const added = run([opts.claude, 'plugin', 'marketplace', 'add', installedModRoot()]);
    if (
      added.status === 0 &&
      run([opts.claude, 'plugin', 'install', MOD_ID, '--scope', 'user']).status === 0
    ) {
      // already installed at an earlier version: install keeps that one, update takes this copy
      takeCopy(opts.claude, run, dir);
      return { status: 'installed' };
    }
  } catch {
    /* removed below */
  }
  const cleanup = removeClaudeMod({ claude: opts.claude, run });
  return { status: 'failed', pluginLeft: cleanup.pluginLeft, claudeMissing: cleanup.claudeMissing };
}

/** Whether anything of the mod is on this machine: its copy or its claude-mod.json. */
export function claudeModPresent(): boolean {
  return existsSync(modConfigPath()) || existsSync(installedModRoot());
}

/**
 * Uninstalls the plugin and removes the marketplace from the Claude Code config directory this command works on
 * (when `claude` is there), and forgets that directory. The copy and claude-mod.json are deleted only when no other
 * directory still uses them. `pluginLeft`: the mod was installed here and Claude Code was not found, or refused the
 * uninstall or the marketplace removal, so its plugin list may still name the mod; `claudeMissing` says which.
 */
export function removeClaudeMod(opts: { claude: string | null; run?: Run }): {
  removed: boolean;
  pluginLeft: boolean;
  claudeMissing: boolean;
} {
  const run = opts.run ?? defaultRun;
  const dir = currentClaudeDir();
  const config = readModConfig();
  // where the person removed the plugin in Claude Code, nothing of it is installed any more
  const removedByPerson = new Set(
    readTaken()
      .filter((e) => e.removed)
      .map((e) => e.dir),
  );
  // installed here: recorded for this directory, or files without a readable record of where
  const had =
    claudeModPresent() && (!config || (config.claude_dirs.includes(dir) && !removedByPerson.has(dir)));
  let refused = false;
  if (opts.claude) {
    const uninstalled = run([opts.claude, 'plugin', 'uninstall', MOD_ID, '--scope', 'user']);
    const unlisted = run([opts.claude, 'plugin', 'marketplace', 'remove', MOD_MARKETPLACE]);
    refused = uninstalled.status !== 0 || unlisted.status !== 0;
  }
  const remaining = config ? config.claude_dirs.filter((d) => d !== dir) : [];
  if (config && remaining.some((d) => !removedByPerson.has(d)) && existsSync(installedModRoot())) {
    // another Claude Code config directory still loads the copy
    writeModConfig(config.argv, config.profile, remaining);
    writeTaken(readTaken().filter((e) => e.dir !== dir));
  } else {
    rmSync(modConfigPath(), { force: true });
    rmSync(installedModRoot(), { recursive: true, force: true });
  }
  // without our files there was nothing of ours to remove: a refusal then only means "not installed"
  return { removed: had, pluginLeft: had && (!opts.claude || refused), claudeMissing: !opts.claude };
}

/**
 * The Claude Code config directories (null: the default one) where the person removed the mod in Claude Code
 * itself; `agentdrop connect claude-code` there puts it back.
 */
export function claudeModRemovedIn(): Array<string | null> {
  const config = readModConfig();
  if (!config || !existsSync(installedModRoot())) return [];
  const removed = new Set(
    readTaken()
      .filter((e) => e.removed)
      .map((e) => e.dir),
  );
  return config.claude_dirs.filter((d) => removed.has(d));
}

/**
 * The executable the mod runs, kept where it is while it exists; after the CLI moved (a reinstall elsewhere), the
 * running CLI, as hook repair does for hooks (harnesses/hook-repair.ts). Only from an installed package: a source
 * checkout must not point the person's mod at itself.
 */
function repairModExecutable(opts: { packaged?: boolean; executable?: () => string }): boolean {
  const current = readModConfig();
  const argv0 = current?.argv[0];
  if (!current || !argv0) return false;
  if (existsSync(argv0)) return false;
  if (!(opts.packaged ?? isPackagedCli())) return false;
  const exe = resolve((opts.executable ?? defaultExecutable)());
  if (exe === argv0 || !existsSync(exe)) return false;
  writeModConfig([exe], current.profile, current.claude_dirs);
  return true;
}

export type ModSync = 'current' | 'pending' | 'absent' | 'no-source' | 'write-failed';

/**
 * After an upgrade of this CLI, bring the mod's marketplace copy up to date. Local file work only, cheap enough for
 * every invocation (hooks, the mod's own polling). Only a newer CLI replaces the copy: another CLI of an older
 * version on the same machine (`npx` of an earlier release, a source checkout) leaves it alone, and the same version
 * only repairs a copy that is incomplete or points to another claude-mod.json. Claude Code loads its own copy of
 * the plugin, so the copy is `pending` until `claude plugin update` ran for every config directory it was
 * installed into ({@link takeClaudeMod}, in a background worker: it must never hold up the command that is
 * running). Only when the mod was installed, and only from a complete bundled copy: without one the installed copy
 * stays as it is (`no-source`). `write-failed`: the rewrite failed and is tried again by the next command.
 */
export function syncClaudeMod(
  opts: { packaged?: boolean; executable?: () => string; source?: string } = {},
): ModSync {
  if (!existsSync(modConfigPath()) || !existsSync(installedModRoot())) return 'absent';
  repairModExecutable(opts);
  const order = compareVersions(CLI_VERSION, installedVersion());
  const repair =
    order === 0 &&
    (installedPointer() !== resolve(modConfigPath()) || !hasMod(join(installedModRoot(), MOD_PLUGIN)));
  if (order > 0 || repair) {
    const bundled = opts.source ?? bundledModDir();
    if (!hasMod(bundled)) return 'no-source';
    try {
      writeMarketplace(bundled);
    } catch {
      return 'write-failed';
    }
  }
  return pendingDirs().length ? 'pending' : 'current';
}

/** Whether a claim file's time (or, while it is being written, its age) is older than the window. */
function claimStale(path: string, now: number): boolean {
  try {
    const last = Number(readFileSync(path, 'utf8').trim());
    // a claim written a moment after this process read the clock looks slightly in the future: that is a fresh claim,
    // not a clock set back (two processes starting at once would both take it); only far in the future is stale
    if (Number.isFinite(last) && last > 0) return Math.abs(now - last) >= ATTEMPT_EVERY_MS;
    return now - statSync(path).mtimeMs >= ATTEMPT_EVERY_MS;
  } catch {
    // gone meanwhile: the next command claims it
    return false;
  }
}

/**
 * Whether to start the background worker now: at most once every ten minutes per copy, so a missing `claude` or a
 * failing update costs one try per window, not one per hook. Exclusive across processes: the claim is created with
 * `wx`, and a stale one is replaced under a lock directory, so of many hooks starting at once one starts the worker.
 */
export function claimTakeAttempt(now: number = Date.now()): boolean {
  const root = installedModRoot();
  const path = join(root, ATTEMPT);
  try {
    writeFileSync(path, `${now}\n`, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') return false;
  }
  if (!claimStale(path, now)) return false;
  const lock = `${path}.lock`;
  try {
    mkdirSync(lock);
  } catch {
    // another process is replacing the claim; a lock left by one that died goes after a minute
    try {
      if (Date.now() - statSync(lock).mtimeMs > ATTEMPT_LOCK_STALE_MS) rmdirSync(lock);
    } catch {
      /* released meanwhile */
    }
    return false;
  }
  try {
    // replaced while we took the lock
    if (!claimStale(path, now)) return false;
    return writeInto(root, ATTEMPT, `${now}\n`);
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/**
 * The background worker: has Claude Code take the current copy, once per recorded config directory with that
 * directory's environment. `true` when every directory took it (or nothing was pending). Stops, writing nothing, as
 * soon as the mod was removed meanwhile (a disconnect while it ran).
 */
export function takeClaudeMod(opts: { claude?: string | null; run?: Run } = {}): boolean {
  const state = syncClaudeMod();
  if (state === 'write-failed') return false;
  if (state !== 'pending') return true;
  const claude = opts.claude === undefined ? whichBin('claude') : opts.claude;
  if (!claude) return false;
  const run: Run = opts.run ?? ((argv, o) => runFor(argv, TAKE_TIMEOUT_MS, o?.env));
  let ok = true;
  for (const dir of pendingDirs()) {
    if (!existsSync(installedModRoot()) || !existsSync(modConfigPath())) return true;
    const took = takeCopy(claude, run, dir);
    if (took === 'gone') return true;
    if (took === 'failed') ok = false;
  }
  return ok;
}

/**
 * Commands that never start the worker: connect and setup install the mod themselves, disconnect removes it (a
 * worker started then could race the removal), `mcp` is a long-lived protocol server, and the worker itself.
 */
const NO_TAKE_WORKER = new Set(['connect', 'disconnect', 'setup', 'mcp', '_take-claude-mod']);

/** The worker needs none of this process's debugger flags: two processes on one inspector port fail. */
export function workerExecArgv(execArgv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i] ?? '';
    if (/^--(inspect|debug)(-[a-z]+)?(=|$)/.test(arg)) {
      // `--inspect-port 9229`: the value is the next argument
      if (/^--(inspect|debug)-port$/.test(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/**
 * After an upgrade, the Claude Code mod follows this CLI: the copy is rewritten here (local files only), and a
 * detached worker (`agentdrop _take-claude-mod`) tells Claude Code to take it, so no hook or poll waits on `claude`.
 * Returns whether a worker was started.
 */
export function maybeStartTakeWorker(
  command: string,
  opts: { spawn?: SpawnFn; script?: string; execArgv?: readonly string[]; execPath?: string } = {},
): boolean {
  if (NO_TAKE_WORKER.has(command)) return false;
  try {
    if (syncClaudeMod() !== 'pending' || !claimTakeAttempt()) return false;
    const script = opts.script ?? process.argv[1];
    if (!script) return false;
    const child = (opts.spawn ?? spawn)(
      opts.execPath ?? process.execPath,
      [...workerExecArgv(opts.execArgv ?? process.execArgv), script, '_take-claude-mod'],
      { detached: true, stdio: 'ignore', shell: false },
    );
    child.once('error', () => {});
    child.unref();
    return true;
  } catch {
    // the next invocation tries again
    return false;
  }
}
