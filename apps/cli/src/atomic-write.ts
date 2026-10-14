import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Replace a harness config file in one step: a temp file in the same directory, then rename.
 *
 * These files belong to the user and are now rewritten by ordinary commands (hook repair), not only by an explicit
 * `connect`; a crash or a full disk halfway through a plain `writeFileSync` would leave Codex or Claude Code with a
 * truncated settings file. A symlinked dotfile (a dotfiles repo, a stow farm) is resolved first so the rename
 * replaces its target and the link survives. An existing file keeps its mode; `mode` only applies to a new file.
 */
export function writeFileAtomic(path: string, content: string, opts: { mode?: number } = {}): void {
  let target = path;
  try {
    target = realpathSync(path);
  } catch {
    /* Not there yet (or a dangling link): write the path as given. */
  }
  let mode = opts.mode;
  try {
    mode = statSync(target).mode & 0o7777;
  } catch {
    /* New file. */
  }
  mkdirSync(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(temp, content, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    // The umask narrows the create mode; an existing file's mode has to come back exactly.
    if (mode !== undefined) chmodSync(temp, mode);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}
