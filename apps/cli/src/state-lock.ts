import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const STALE_LOCK_MS = 10 * 60 * 1000;

export function acquireStateLock(path: string): (() => void) | undefined {
  const release = (token: string) => {
    try {
      unlinkSync(join(path, `owner-${token}.json`));
      rmdirSync(path); // A replacement owner's nonempty directory cannot be removed.
    } catch {
      /* Already released or owned by another process. */
    }
  };
  const attempt = (): (() => void) | undefined => {
    const token = randomUUID();
    const staging = `${path}.${token}.tmp`;
    try {
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, `owner-${token}.json`), JSON.stringify({ pid: process.pid, token }), {
        mode: 0o600,
      });
      // Every published lock is already nonempty; rename cannot replace an active lock directory.
      renameSync(staging, path);
      return () => release(token);
    } catch {
      return undefined;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  };
  const acquired = attempt();
  if (acquired) return acquired;
  try {
    const stat = statSync(path);
    if (stat.isFile()) {
      // Upgrade old file locks. Their owner record may still be mid-write, so only age makes them reapable.
      if (Date.now() - stat.mtimeMs < STALE_LOCK_MS) return undefined;
      if (liveOwner(path)) return undefined;
      unlinkSync(path);
    } else if (stat.isDirectory()) {
      /*
       * No age check here: owner files are written before the directory is published, so a live lock always
       * names a live process. A hook killed while holding the lock (a host timeout, Ctrl-C) leaves only dead
       * owners, and waiting ten minutes for that would silence every notice in between.
       */
      const files = readdirSync(path);
      for (const file of files) {
        if (!/^owner-[a-f0-9-]+\.json$/.test(file) || liveOwner(join(path, file))) return undefined;
      }
      // Only remove the observed unique tokens, never recurse into a replacement lock.
      for (const file of files) {
        try {
          unlinkSync(join(path, file));
        } catch {
          /* Another reaper already removed it. */
        }
      }
      try {
        rmdirSync(path);
      } catch {
        return undefined;
      }
    } else return undefined;
  } catch {
    return undefined;
  }
  return attempt();
}

function liveOwner(file: string): boolean {
  let pid: number;
  try {
    const owner = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number };
    if (!Number.isInteger(owner?.pid) || (owner.pid ?? 0) <= 0) return false;
    pid = owner.pid as number;
  } catch {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
