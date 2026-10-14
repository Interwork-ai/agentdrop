/**
 * The fixed QA accounts that post-deploy checks sign in with on each live server (docs/QUALITY.md §5).
 *
 * Neither the servers nor the credentials enter the repository (docs/PUBLIC_REPOSITORY.md): both live in one private
 * file, `$AGENTDROP_QA_ACCOUNTS`, else `$AGENTDROP_OPS_DIR/qa-accounts.json` (either may be set in the git-ignored
 * `.env`). Shape:
 *   { "targets": { "<name>": { "base": "https://…", "accounts": { "a": { handle, email, password }, "b": {…} } } } }
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { localSetting } from './local-env.mjs';

/** Handles are chosen so nobody mistakes them for people; emails use the reserved example.com domain. */
export const QA_HANDLES = { a: 'qa_smoke_a', b: 'qa_smoke_b' };
/** A group with only the two QA accounts, so the group pages are checked without touching anyone's group. */
export const QA_GROUP_SLUG = 'qa-smoke';

export function qaAccountsPath() {
  const explicit = localSetting('AGENTDROP_QA_ACCOUNTS');
  if (explicit) return explicit;
  const ops = localSetting('AGENTDROP_OPS_DIR');
  if (!ops) throw new Error('set AGENTDROP_OPS_DIR (or AGENTDROP_QA_ACCOUNTS) in the environment or in .env');
  return join(ops, 'qa-accounts.json');
}

export function readQaAccounts() {
  const path = qaAccountsPath();
  if (!existsSync(path)) return { targets: {} };
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeQaAccounts(data) {
  const path = qaAccountsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Resolves a target name to its base URL and accounts, or explains what is missing. */
export function qaTarget(name) {
  const entry = readQaAccounts().targets[name];
  if (!entry?.accounts?.a || !entry?.accounts?.b)
    throw new Error(
      `no QA accounts for "${name}" in ${qaAccountsPath()}; run: node scripts/qa-provision.mjs ${name} <base-url>`,
    );
  return entry;
}
