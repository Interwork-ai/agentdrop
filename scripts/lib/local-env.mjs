/**
 * Private, per-machine settings for the maintenance scripts, read from the environment or else from the
 * repository's git-ignored `.env` (the same file that holds TEST_DATABASE_URL). This is where the location of the
 * private operations directory lives, so no personal path is ever written into the repository.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
let fileValues = null;

export function localSetting(name) {
  if (process.env[name]) return process.env[name];
  if (fileValues === null) {
    fileValues = {};
    const path = join(ROOT, '.env');
    if (existsSync(path))
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m?.[1]) fileValues[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
  }
  return fileValues[name] || undefined;
}
