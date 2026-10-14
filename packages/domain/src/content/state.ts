import { type ContentCipher, ContentCryptoError } from './cipher.js';

/*
 * Process-wide content encryption setup (docs/plan/CONTENT_ENCRYPTION.md §11, §12), registered once at startup by
 * the API, the worker and the test harness. Reads decrypt whenever a row carries a data key, whatever the mode;
 * the mode only decides whether new content is written encrypted.
 *
 *   off (default in R1): new content is written in plaintext
 *   on:                  new content is encrypted; plaintext columns are written as NULL
 */
export type EncryptionMode = 'off' | 'on';

let current: { cipher: ContentCipher | null; mode: EncryptionMode } = { cipher: null, mode: 'off' };

export function configureContentEncryption(setup: {
  cipher: ContentCipher | null;
  mode: EncryptionMode;
}): void {
  if (setup.mode === 'on' && !setup.cipher)
    throw new ContentCryptoError('CONTENT_ENCRYPTION=on needs a keyring (CONTENT_KEYS_FILE)');
  current = setup;
}

/** The cipher, when content has to be read or written encrypted. Fails closed without a keyring. */
export function contentCipher(): ContentCipher {
  if (!current.cipher)
    throw new ContentCryptoError(
      'this content is encrypted but no keyring is configured (CONTENT_KEYS_FILE)',
    );
  return current.cipher;
}

export function writesEncrypted(): boolean {
  return current.mode === 'on';
}

export function contentEncryptionStatus(): { mode: EncryptionMode; kid: string | null } {
  return { mode: current.mode, kid: current.cipher?.activeKid ?? null };
}
