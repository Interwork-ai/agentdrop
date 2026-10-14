import { ContentCipher, configureContentEncryption, generateKeyring, parseKeyring } from '@agentdrop/domain';

/*
 * `AGENTDROP_TEST_ENCRYPTION=on` (pnpm test:encrypted) runs every test with content encryption switched on, under
 * a fixed test keyring, so each behaviour is checked in both modes (docs/plan/CONTENT_ENCRYPTION.md §15).
 */
export const TEST_KEYRING = generateKeyring((n) => Buffer.alloc(n, 0x5a));

if (process.env.AGENTDROP_TEST_ENCRYPTION === 'on') {
  configureContentEncryption({ cipher: new ContentCipher(parseKeyring(TEST_KEYRING)), mode: 'on' });
}
