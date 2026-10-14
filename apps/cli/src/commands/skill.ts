import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { whichBin } from '../harnesses/shared.js';
import { detectHarnesses, HARNESSES, type Harness, harness } from '../harnesses.js';
import { CLI_VERSION, type Output } from '../output.js';
import { stateDir } from '../paths.js';

export const SKILL_NAME = 'agentdrop';
const MANIFEST = '.agentdrop-manifest.json';
export interface SkillTarget {
  client: string;
  dir: string;
}
interface Manifest {
  version: string;
  digest: string;
  files: Record<string, string>;
}
interface Registration extends SkillTarget {
  disabled: boolean;
}
export interface SkillSyncResult {
  version: string;
  updated: boolean;
  installed: Array<
    SkillTarget & {
      status: 'installed' | 'updated' | 'unchanged' | 'disabled' | 'skipped';
      files: number;
      backup?: string;
    }
  >;
  errors: Array<{ client: string; code: string }>;
}

export function bundledSkillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'skill', SKILL_NAME),
    resolve(here, '..', '..', 'skill', SKILL_NAME),
  ];
  return candidates.find((c) => existsSync(join(c, 'SKILL.md'))) ?? candidates[1] ?? here;
}
/** The order targets were listed in before the harness registry; later harnesses follow in registry order. */
const TARGET_ORDER: readonly Harness[] = ['codex', 'claude-code', 'opencode', 'cursor'];

export function defaultSkillTargets(): SkillTarget[] {
  const first: readonly string[] = TARGET_ORDER;
  const adapters = [...TARGET_ORDER.map(harness), ...HARNESSES.filter((h) => !first.includes(h.key))];
  return adapters.map((h) => ({ client: h.key, dir: join(h.skillsRoot(), SKILL_NAME) }));
}

export function bundledSkillVersion(): string {
  try {
    const value = JSON.parse(
      readFileSync(resolve(bundledSkillDir(), '..', '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    if (
      typeof value.version === 'string' &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version)
    )
      return value.version;
  } catch {
    /* Standalone bundle may omit package metadata. */
  }
  return CLI_VERSION;
}

/** Complete bundled directory, never a remote source. Callers control whether source checkouts auto-sync. */
export function ensureBundledSkills(
  options: { targets?: SkillTarget[]; source?: string; version?: string; force?: boolean } = {},
): SkillSyncResult {
  const version = options.version ?? bundledSkillVersion();
  let release: (() => void) | undefined;
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    release = acquireLock(join(stateDir(), 'skill-registry.lock'));
    if (!release)
      return { version, updated: false, installed: [], errors: [{ client: 'all', code: 'BUSY' }] };
    return syncSkills(options);
  } catch {
    return { version, updated: false, installed: [], errors: [{ client: 'all', code: 'SKILL_SYNC_FAILED' }] };
  } finally {
    release?.();
  }
}
function syncSkills(options: {
  targets?: SkillTarget[];
  source?: string;
  version?: string;
  force?: boolean;
}): SkillSyncResult {
  const version = options.version ?? bundledSkillVersion();
  const result: SkillSyncResult = { version, updated: false, installed: [], errors: [] };
  let registrations: Registration[];
  let official: Record<string, string>;
  const source = options.source ?? bundledSkillDir();
  try {
    registrations = readRegistrations();
    official = hashes(source);
    if (!official['SKILL.md'] || official[MANIFEST]) throw new Error('INVALID_BUNDLE');
  } catch {
    result.errors.push({ client: 'all', code: 'INVALID_SKILL_STATE_OR_BUNDLE' });
    return result;
  }
  const manifest: Manifest = { version, digest: digest(official), files: official };
  const targets = options.targets ?? [...defaultSkillTargets(), ...registrations];
  const seen = new Set<string>();
  for (const raw of targets) {
    const target = { client: raw.client, dir: resolve(raw.dir) };
    if (seen.has(target.dir)) continue;
    seen.add(target.dir);
    const registration = registrations.find((r) => r.dir === target.dir);
    if (registration?.disabled && !options.force) {
      result.installed.push({ ...target, status: 'disabled', files: 0 });
      continue;
    }
    if (!options.force && !registration && !existsSync(dirname(dirname(target.dir)))) {
      result.installed.push({ ...target, status: 'skipped', files: 0 });
      continue;
    }
    let release: (() => void) | undefined;
    let staging: string | undefined;
    let displaced: string | undefined;
    try {
      for (const path of [dirname(dirname(target.dir)), dirname(target.dir), target.dir]) {
        if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('SYMLINK_TARGET');
      }
      mkdirSync(dirname(target.dir), { recursive: true, mode: 0o700 });
      release = acquireLock(`${target.dir}.sync-lock`);
      if (!release) throw new Error('BUSY');
      const current = existsSync(target.dir) ? hashes(target.dir, true) : null;
      const old = readManifest(target.dir);
      if (
        current &&
        old?.version === version &&
        old.digest === manifest.digest &&
        digest(current) === manifest.digest
      ) {
        result.installed.push({ ...target, status: 'unchanged', files: Object.keys(official).length });
      } else {
        staging = `${target.dir}.${randomUUID()}.stage`;
        mkdirSync(staging, { mode: 0o700 });
        cpSync(source, staging, { recursive: true, dereference: false });
        writeFileSync(join(staging, MANIFEST), JSON.stringify(manifest), { mode: 0o600 });
        if (digest(hashes(staging, true)) !== manifest.digest) throw new Error('BUNDLE_CHANGED');
        let backup: string | undefined;
        if (current) {
          // Copy to private state first: the target and state directory may be on different filesystems.
          const backups = join(stateDir(), 'skill-backups');
          mkdirSync(backups, { recursive: true, mode: 0o700 });
          backup = join(backups, randomUUID());
          mkdirSync(backup, { mode: 0o700 });
          cpSync(target.dir, backup, { recursive: true, dereference: false });
          chmodSync(backup, 0o700);
          displaced = `${target.dir}.${randomUUID()}.previous`;
          renameSync(target.dir, displaced);
        }
        try {
          renameSync(staging, target.dir);
          staging = undefined;
        } catch (error) {
          if (displaced) {
            renameSync(displaced, target.dir);
            displaced = undefined;
          }
          throw error;
        }
        if (displaced) {
          rmSync(displaced, { recursive: true });
          displaced = undefined;
        }
        result.updated = true;
        result.installed.push({
          ...target,
          status: current ? 'updated' : 'installed',
          files: Object.keys(official).length,
          ...(backup ? { backup } : {}),
        });
      }
      const next = readRegistrations().filter((r) => r.dir !== target.dir);
      next.push({ ...target, disabled: false });
      saveRegistrations(next);
      registrations = next;
    } catch (error) {
      const code =
        error instanceof Error &&
        ['BUSY', 'SYMLINK_TARGET', 'SYMLINK_ENTRY', 'BUNDLE_CHANGED'].includes(error.message)
          ? error.message
          : 'SKILL_SYNC_FAILED';
      result.errors.push({ client: target.client, code });
    } finally {
      if (staging) rmSync(staging, { recursive: true, force: true });
      // If rollback failed, keep the displaced directory for recovery rather than deleting it.
      try {
        release?.();
      } catch {
        /* Quiet on CLI startup. */
      }
    }
  }
  return result;
}

export function getInstalledSkillVersion(targetDir: string): string | null {
  return readManifest(targetDir)?.version ?? null;
}
/**
 * `skill install` without `--only` covers the harnesses on this machine: a binary on PATH, or the directory the
 * skills folder lives in (`~/.codex`, `~/.omp/agent`…) already there. Creating that directory for a harness that is
 * not installed would make detection (setup, `connect`) believe it is.
 */
function installedTargets(targets: SkillTarget[], which: (bin: string) => string | null): SkillTarget[] {
  const detected: readonly string[] = detectHarnesses(which);
  return targets.filter((t) => detected.includes(t.client) || existsSync(dirname(dirname(t.dir))));
}

export async function skillInstallCommand(
  out: Output,
  opts: { targets?: SkillTarget[]; only?: string[]; which?: (bin: string) => string | null },
): Promise<void> {
  const targets = opts.only
    ? (opts.targets ?? defaultSkillTargets()).filter((t) => opts.only?.includes(t.client))
    : (opts.targets ?? installedTargets(defaultSkillTargets(), opts.which ?? whichBin));
  const result = ensureBundledSkills({ targets, force: true });
  out.result({ skill: SKILL_NAME, ...result }, () =>
    [
      ...result.installed.map(
        (i) =>
          `${i.client.padEnd(12)} ${i.dir} (${i.files} files; ${i.status})${i.backup ? `; previous copy: ${i.backup}` : ''}`,
      ),
      ...result.errors.map((e) => `${e.client}: ${e.code}`),
    ].join('\n'),
  );
}
export async function skillRemoveCommand(out: Output, opts: { targets?: SkillTarget[] }): Promise<void> {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const releaseRegistry = acquireLock(join(stateDir(), 'skill-registry.lock'));
  if (!releaseRegistry) throw new Error('skill synchronization is busy; retry shortly');
  try {
    let registrations = readRegistrations();
    const removed: string[] = [];
    for (const raw of opts.targets ?? defaultSkillTargets()) {
      const target = { client: raw.client, dir: resolve(raw.dir) };
      for (const path of [dirname(dirname(target.dir)), dirname(target.dir)]) {
        if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('SYMLINK_TARGET');
      }
      const disable = () => {
        registrations = [...registrations.filter((r) => r.dir !== target.dir), { ...target, disabled: true }];
        saveRegistrations(registrations);
      };
      // No skills folder: nothing to remove and nothing to race over. Record the choice, create nothing.
      if (!existsSync(dirname(target.dir))) {
        disable();
        continue;
      }
      const release = acquireLock(`${target.dir}.sync-lock`);
      if (!release) continue;
      try {
        disable();
        if (existsSync(target.dir)) {
          rmSync(target.dir, { recursive: true, force: true });
          removed.push(target.dir);
        }
      } finally {
        release();
      }
    }
    out.result({ removed }, () => (removed.length ? removed.join('\n') : 'nothing to remove'));
  } finally {
    releaseRegistry();
  }
}
function hashes(root: string, ignoreManifest = false): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(path: string, prefix: string) {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('SYMLINK_ENTRY');
    if (!info.isDirectory()) throw new Error('INVALID_SKILL_DIRECTORY');
    for (const name of readdirSync(path).sort()) {
      if (!prefix && ignoreManifest && name === MANIFEST) continue;
      const file = join(path, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('SYMLINK_ENTRY');
      if (stat.isDirectory()) walk(file, relative);
      else if (stat.isFile()) files[relative] = createHash('sha256').update(readFileSync(file)).digest('hex');
      else throw new Error('UNSUPPORTED_ENTRY');
    }
  }
  walk(root, '');
  return files;
}
function digest(files: Record<string, string>): string {
  return createHash('sha256')
    .update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
}
function readManifest(dir: string): Manifest | null {
  try {
    const path = join(dir, MANIFEST);
    if (lstatSync(path).isSymbolicLink()) return null;
    const value = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    return typeof value.version === 'string' && typeof value.digest === 'string' ? value : null;
  } catch {
    return null;
  }
}
function registryPath() {
  return join(stateDir(), 'skill-targets.json');
}
function readRegistrations(): Registration[] {
  if (!existsSync(registryPath())) return [];
  const value: unknown = JSON.parse(readFileSync(registryPath(), 'utf8'));
  if (
    !Array.isArray(value) ||
    value.some(
      (v) => typeof v?.client !== 'string' || typeof v?.dir !== 'string' || typeof v?.disabled !== 'boolean',
    )
  )
    throw new Error('INVALID_REGISTRY');
  return value as Registration[];
}
function saveRegistrations(value: Registration[]) {
  const ordered = [...value].sort((a, b) => a.dir.localeCompare(b.dir));
  if (JSON.stringify(readRegistrations()) === JSON.stringify(ordered)) return;
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const temp = `${registryPath()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(ordered), { flag: 'wx', mode: 0o600 });
    renameSync(temp, registryPath());
  } finally {
    rmSync(temp, { force: true });
  }
}
function acquireLock(path: string): (() => void) | undefined {
  function release(token: string) {
    try {
      unlinkSync(join(path, token));
      rmdirSync(path);
    } catch {
      /* A newer lock must not be removed. */
    }
  }
  function attempt() {
    const token = randomUUID();
    const temp = `${path}.${token}`;
    try {
      mkdirSync(temp, { mode: 0o700 });
      writeFileSync(join(temp, token), String(process.pid), { mode: 0o600 });
      renameSync(temp, path);
      return () => release(token);
    } catch {
      return undefined;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  const acquired = attempt();
  if (acquired) return acquired;
  try {
    const entries = readdirSync(path);
    if (entries.length !== 1) return undefined;
    const token = entries[0];
    if (!token || !/^[a-f0-9-]{36}$/.test(token)) return undefined;
    const pid = Number(readFileSync(join(path, token), 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return undefined;
    }
    release(token);
    return attempt();
  } catch {
    return undefined;
  }
}
