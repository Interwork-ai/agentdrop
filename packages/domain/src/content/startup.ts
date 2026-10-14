import { approvals, attachments, contentKeyChecks, drops, type Tx } from '@agentdrop/db';
import { isNotNull, sql } from 'drizzle-orm';
import { ContentCipher } from './cipher.js';
import { KeyringError, type KeyringSource, loadKeyring } from './keyring.js';
import { configureContentEncryption, type EncryptionMode } from './state.js';

/*
 * Startup of content encryption for the API and the worker (docs/plan/CONTENT_ENCRYPTION.md §5.1). Fails closed:
 * a database that already holds ciphertext does not start without its keyring, whatever NODE_ENV says, and a
 * keyring whose key does not match the key check stored for its id is refused before anything is written.
 */

async function holdsEncryptedContent(tx: Tx): Promise<boolean> {
  const result = await tx.execute<{ yes: boolean }>(sql`select (
      exists (select 1 from ${contentKeyChecks})
      or exists (select 1 from ${drops} where ${isNotNull(drops.dek)})
      or exists (select 1 from ${attachments} where ${isNotNull(attachments.dek)})
      or exists (select 1 from ${approvals} where ${isNotNull(approvals.dek)})
    ) as yes`);
  return result.rows[0]?.yes === true;
}

export async function initContentEncryption(
  tx: Tx,
  opts: { source: KeyringSource; mode: EncryptionMode },
): Promise<{ mode: EncryptionMode; kid: string | null; missing_keys?: string[] }> {
  const keyring = loadKeyring(opts.source);
  if (!keyring) {
    if (opts.mode === 'on')
      throw new KeyringError('CONTENT_ENCRYPTION=on needs a keyring (CONTENT_KEYS_FILE)');
    if (await holdsEncryptedContent(tx))
      throw new KeyringError(
        'this database holds encrypted content: start with its keyring (CONTENT_KEYS_FILE) or nothing can be read',
      );
    configureContentEncryption({ cipher: null, mode: 'off' });
    return { mode: 'off', kid: null };
  }
  const cipher = new ContentCipher(keyring);
  const checks = await tx.select().from(contentKeyChecks);
  const master = checks.filter((c) => c.kid.startsWith('k-'));
  const hmac = checks.filter((c) => c.kid.startsWith('h-'));
  for (const check of master) {
    if (keyring.keys.has(check.kid) && !cipher.verifyKeyCheck(check.kid, check.check))
      throw new KeyringError(`key ${check.kid} is not the key this database was encrypted with`);
  }
  if (master.length > 0 && !master.some((c) => keyring.keys.has(c.kid)))
    throw new KeyringError(
      `this keyring holds none of the keys this database was encrypted with (${master.map((c) => c.kid).join(', ')})`,
    );
  for (const check of hmac) {
    if (keyring.hmacKeys.has(check.kid) && !cipher.hmacCheck(check.kid).equals(check.check))
      throw new KeyringError(`hmac key ${check.kid} is not the key this database used`);
  }
  const known = new Set(checks.map((c) => c.kid));
  for (const kid of keyring.keys.keys())
    if (!known.has(kid))
      await tx
        .insert(contentKeyChecks)
        .values({ kid, check: cipher.keyCheck(kid) })
        .onConflictDoNothing();
  for (const kid of keyring.hmacKeys.keys())
    if (!known.has(kid))
      await tx
        .insert(contentKeyChecks)
        .values({ kid, check: cipher.hmacCheck(kid) })
        .onConflictDoNothing();
  // keys this database used that the keyring no longer holds: content wrapped with them cannot be read, and
  // retries of requests hashed with a missing hmac key are reported as conflicts
  const missing = checks
    .map((c) => c.kid)
    .filter((kid) => !keyring.keys.has(kid) && !keyring.hmacKeys.has(kid));
  configureContentEncryption({ cipher, mode: opts.mode });
  return { mode: opts.mode, kid: keyring.active, ...(missing.length ? { missing_keys: missing } : {}) };
}
