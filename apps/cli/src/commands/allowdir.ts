import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Output } from '../output.js';
import { readProfile, writeProfile } from '../store.js';

/**
 * Explicit upload allowlist per profile. Whole home directories are refused; the user names project or export
 * directories one by one. Sensitive-file rules still apply inside allowed directories.
 */
export async function allowDirCommand(
  out: Output,
  opts: { profile: string; action: 'add' | 'remove' | 'list'; dir?: string },
): Promise<void> {
  const profile = readProfile(opts.profile);
  if (!profile) throw new Error(`profile "${opts.profile}" not found`);
  if (opts.action === 'list') {
    out.result({ profile: opts.profile, allowed_dirs: profile.allowed_dirs }, () =>
      profile.allowed_dirs.length
        ? profile.allowed_dirs.join('\n')
        : '(no allowed directories: upload_file is disabled)',
    );
    return;
  }
  if (!opts.dir) throw new Error('directory required');
  const real = realpathSync.native(resolve(opts.dir));
  if (opts.action === 'add') {
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
    const home = realpathSync.native(homedir());
    if (real === home || real === '/')
      throw new Error(
        'refusing to allow the whole home directory or filesystem root; pick a project or export folder',
      );
    const next = profile.allowed_dirs.includes(real) ? profile.allowed_dirs : [...profile.allowed_dirs, real];
    writeProfile({ ...profile, allowed_dirs: next });
    out.result({ profile: opts.profile, allowed_dirs: next }, () => `allowed for ${opts.profile}: ${real}`);
    return;
  }
  const next = profile.allowed_dirs.filter((d) => d !== real);
  writeProfile({ ...profile, allowed_dirs: next });
  out.result({ profile: opts.profile, allowed_dirs: next }, () => `removed from ${opts.profile}: ${real}`);
}
