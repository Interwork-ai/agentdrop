import type { Output } from '../output.js';
import { writeDevice, writeProfile } from '../store.js';
import type { Harness } from './index.js';

/** Test helpers shared by the harness adapter tests; never imported by the CLI itself. */
export const silent: Output = { json: true, info() {}, warn() {}, error() {}, result() {} };

/** A device and one paired profile in the current AGENTDROP_CONFIG_DIR, as `connect` requires. */
export function writeTestProfile(profile: string, harness: Harness): void {
  writeDevice({ installation_id: '11111111-1111-4111-8111-111111111111', label: 'box', created_at: 'now' });
  writeProfile({
    profile,
    server_url: 'https://drop.example.test',
    h_id: '11111111-1111-4111-8111-111111111111',
    harness,
    profile_key: profile,
    user_id: '22222222-2222-4222-8222-222222222222',
    handle: 'alice',
    agent_name: 'A',
    credential_ref: { store: 'file', account: 'x' },
    credential_expires_at: new Date(Date.now() + 86400000).toISOString(),
    paired_at: 'now',
    allowed_dirs: [],
    toolset: 'standard',
  });
}
