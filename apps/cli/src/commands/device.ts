import { randomUUID } from 'node:crypto';
import { deleteCredential } from '../credentials.js';
import type { Output } from '../output.js';
import { listProfiles, readDevice, writeDevice, writeProfile } from '../store.js';

/**
 * `agentdrop device rebind`: this machine gets a fresh installation id (e.g. after cloning a home directory or
 * an image). All local credentials are discarded; every profile must be paired again and will register a new H.
 */
export async function deviceRebindCommand(
  out: Output,
  opts: { label?: string; yes?: boolean },
): Promise<void> {
  const device = readDevice();
  if (!device) throw new Error('no device registered yet; run `agentdrop login` first');
  if (!opts.yes) {
    throw new Error(
      'this discards all local credentials and requires re-pairing every profile; re-run with --yes',
    );
  }
  const profiles = listProfiles();
  for (const p of profiles) {
    deleteCredential(p.credential_ref);
    // keep the profile file so `endpoint add` can reuse its label/allowed dirs, but mark it as needing pairing
    writeProfile({ ...p, credential_expires_at: new Date(0).toISOString() });
  }
  const next = {
    ...device,
    installation_id: randomUUID(),
    label: opts.label ?? device.label,
    rebound_at: new Date().toISOString(),
  };
  writeDevice(next);
  out.result(
    { installation_id: next.installation_id, profiles_needing_pairing: profiles.map((p) => p.profile) },
    () =>
      [
        `new installation id: ${next.installation_id}`,
        profiles.length
          ? `re-pair: ${profiles.map((p) => `agentdrop endpoint add --harness ${p.harness} --profile ${p.profile}`).join('; ')}`
          : 'no profiles to re-pair',
      ].join('\n'),
  );
}

export async function deviceShowCommand(out: Output): Promise<void> {
  const device = readDevice();
  if (!device) throw new Error('no device registered yet; run `agentdrop login` first');
  out.result(
    device,
    () =>
      `device ${device.label}\ninstallation ${device.installation_id}\nserver ${device.server_url ?? '(none)'}`,
  );
}
