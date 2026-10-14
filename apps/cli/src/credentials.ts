import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { credentialsDir } from './paths.js';
import { writePrivateFile } from './store.js';

export type CredentialStoreKind = 'keychain' | 'file';

const SERVICE = 'agentdrop';

export interface CredentialRef {
  store: CredentialStoreKind;
  account: string;
}

/**
 * Credentials live in the OS keychain when available (macOS `security`); otherwise in a 0600 file under the
 * private config directory with an explicit degradation warning. Never in profiles, logs or MCP output.
 */
export function preferredStore(): CredentialStoreKind {
  const forced = process.env.AGENTDROP_CREDENTIAL_STORE;
  if (forced === 'file' || forced === 'keychain') return forced;
  return process.platform === 'darwin' ? 'keychain' : 'file';
}

export function storeCredential(account: string, token: string, warn: (msg: string) => void): CredentialRef {
  const kind = preferredStore();
  if (kind === 'keychain') {
    try {
      execFileSync('security', ['add-generic-password', '-a', account, '-s', SERVICE, '-w', token, '-U'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return { store: 'keychain', account };
    } catch {
      warn('keychain unavailable; falling back to a 0600 credential file');
    }
  } else if (process.platform !== 'darwin') {
    warn('no OS keychain integration on this platform; credential stored in a 0600 file (directory 0700)');
  }
  writePrivateFile(join(credentialsDir(), `${account}.token`), token);
  return { store: 'file', account };
}

export function loadCredential(ref: CredentialRef, opts: { timeoutMs?: number } = {}): string | null {
  if (ref.store === 'keychain') {
    try {
      const out = execFileSync(
        'security',
        ['find-generic-password', '-a', ref.account, '-s', SERVICE, '-w'],
        {
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf8',
          ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
        },
      );
      return out.trim() || null;
    } catch {
      return null;
    }
  }
  const p = join(credentialsDir(), `${ref.account}.token`);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').trim() || null;
}

export function deleteCredential(ref: CredentialRef): void {
  if (ref.store === 'keychain') {
    try {
      execFileSync('security', ['delete-generic-password', '-a', ref.account, '-s', SERVICE], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      /* already gone */
    }
    return;
  }
  const p = join(credentialsDir(), `${ref.account}.token`);
  if (existsSync(p)) unlinkSync(p);
}
