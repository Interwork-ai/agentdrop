/*
 * Prints a fresh content keyring (docs/plan/CONTENT_ENCRYPTION.md §14). Run on the server that will use it and
 * write straight into the key file; the output holds secret keys.
 *   node packages/domain/dist/content/keygen.js > /tmp/k.json
 */
import { generateKeyring } from './keyring.js';

process.stdout.write(generateKeyring());
