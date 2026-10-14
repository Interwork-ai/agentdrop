import {
  AgentDropError,
  clientSettingsAppliedInputSchema,
  clientSettingsUpdateInputSchema,
  DEFAULT_CLIENT_SETTINGS,
  type DeviceClientSettings,
} from '@agentdrop/contracts';
import { devices, harnessEndpoints, type Tx } from '@agentdrop/db';
import { eq } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { HPrincipal } from '../principals.js';

function view(device: typeof devices.$inferSelect): DeviceClientSettings {
  return {
    device_id: device.id,
    ...(device.clientPreferences ?? {
      version: 0,
      settings: DEFAULT_CLIENT_SETTINGS,
      updated_at: null,
      applied: null,
    }),
  };
}

async function ownedDevice(tx: Tx, userId: string, deviceId: string, lock = false) {
  const query = tx.select().from(devices).where(eq(devices.id, deviceId));
  const [device] = lock ? await query.for('no key update') : await query;
  if (!device || device.userId !== userId) throw new AgentDropError('NOT_FOUND', 'device not found');
  return device;
}

export async function getDeviceClientSettings(tx: Tx, userId: string, deviceId: string) {
  return view(await ownedDevice(tx, userId, deviceId));
}

export async function updateDeviceClientSettings(tx: Tx, userId: string, deviceId: string, raw: unknown) {
  const input = clientSettingsUpdateInputSchema.parse(raw);
  const device = await ownedDevice(tx, userId, deviceId, true);
  if (device.revokedAt) throw new AgentDropError('ENDPOINT_REVOKED');
  const current = view(device);
  if (current.version !== input.expected_version) {
    throw new AgentDropError('VERSION_CONFLICT', undefined, { current_version: current.version });
  }
  const next: Omit<DeviceClientSettings, 'device_id'> = {
    version: current.version + 1,
    settings: input.settings,
    updated_at: new Date().toISOString(),
    applied: current.applied,
  };
  await tx.update(devices).set({ clientPreferences: next }).where(eq(devices.id, device.id));
  await recordAudit(tx, {
    actorUserId: userId,
    action: 'device.client_settings.update',
    targetId: device.id,
    result: 'ok',
    meta: { version: next.version },
  });
  return { device_id: device.id, ...next };
}

/** Lock H before device, matching device revocation. The credential cannot choose another H/device. */
async function deviceForH(tx: Tx, principal: HPrincipal, lockDevice: boolean) {
  const [h] = await tx
    .select()
    .from(harnessEndpoints)
    .where(eq(harnessEndpoints.id, principal.hId))
    .for('share');
  if (!h || h.userId !== principal.userId) throw new AgentDropError('UNAUTHORIZED');
  if (h.revokedAt) throw new AgentDropError('ENDPOINT_REVOKED');
  const device = await ownedDevice(tx, principal.userId, h.deviceId, lockDevice);
  if (device.revokedAt) throw new AgentDropError('ENDPOINT_REVOKED');
  return device;
}

export async function getHClientSettings(tx: Tx, principal: HPrincipal) {
  return view(await deviceForH(tx, principal, false));
}

/** This is a device diagnostic, not independent proof of the local installation. Desired settings stay human-owned. */
export async function reportHClientSettingsApplied(tx: Tx, principal: HPrincipal, raw: unknown) {
  const input = clientSettingsAppliedInputSchema.parse(raw);
  const device = await deviceForH(tx, principal, true);
  const current = view(device);
  if (!device.clientPreferences || input.version !== current.version) {
    throw new AgentDropError('VERSION_CONFLICT', undefined, { current_version: current.version });
  }
  const next = { ...device.clientPreferences, applied: { ...input, synced_at: new Date().toISOString() } };
  await tx.update(devices).set({ clientPreferences: next }).where(eq(devices.id, device.id));
  await recordAudit(tx, {
    actorUserId: principal.userId,
    hId: principal.hId,
    action: 'device.client_settings.applied',
    targetId: device.id,
    result: input.error ? 'error' : 'ok',
    meta: { version: input.version },
  });
  return { device_id: device.id, ...next };
}
