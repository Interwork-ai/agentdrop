import { AgentDropError, type HarnessKey, type PairingStartInput } from '@agentdrop/contracts';
import { appUsers, devices, harnessEndpoints, pairingRequests, type Tx } from '@agentdrop/db';
import { and, eq, isNull } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { acceptInviteRequestsOnPairing } from '../contacts/invite-links.js';
import { ensureAutoRoute } from '../contacts/routes.js';
import { generateDeviceCode, generateUserCode, hashToken, normalizeUserCode } from '../crypto.js';
import { bindNewEndpointToGroups } from '../groups/groups.js';
import { issueCredential } from './credentials.js';
import { getDefaultRoute, pointDefaultRoute } from './endpoints.js';
import { getUserById } from './users.js';

export const PAIRING_POLL_INTERVAL_S = 3;

export interface StartPairingResult {
  deviceCode: string;
  userCode: string;
  expiresAt: Date;
}

export async function startPairing(
  tx: Tx,
  input: PairingStartInput,
  ttlSeconds: number,
): Promise<StartPairingResult> {
  const deviceCode = generateDeviceCode();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  // user codes are unique among live requests; retry a few times on the (rare) collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = generateUserCode();
    const clash = await tx.query.pairingRequests.findFirst({ where: eq(pairingRequests.userCode, userCode) });
    if (clash) continue;
    await tx.insert(pairingRequests).values({
      userCode,
      deviceCodeHash: hashToken(deviceCode),
      installationId: input.installation_id,
      deviceLabel: input.device_label,
      harnessKey: input.harness_key,
      profileKey: input.profile_key,
      endpointLabel: input.endpoint_label,
      bridgeVersion: input.bridge_version,
      platform: input.platform,
      expiresAt,
    });
    return { deviceCode, userCode, expiresAt };
  }
  throw new AgentDropError('INTERNAL', 'could not allocate a pairing code');
}

export interface PairingLookup {
  user_code: string;
  device_label: string;
  harness_key: HarnessKey;
  profile_key: string;
  endpoint_label: string;
  platform: string;
  bridge_version: string;
  expires_at: string;
  existing_endpoint: boolean;
  has_default_receiver: boolean;
}

/** Used by the browser approval page. Unknown or dead codes are indistinguishable (NOT_FOUND). */
export async function lookupPairing(tx: Tx, userId: string, rawUserCode: string): Promise<PairingLookup> {
  const req = await livePending(tx, rawUserCode);
  const existing = await findExistingEndpoint(tx, userId, req);
  const def = await getDefaultRoute(tx, userId);
  return {
    user_code: req.userCode,
    device_label: req.deviceLabel,
    harness_key: req.harnessKey,
    profile_key: req.profileKey,
    endpoint_label: req.endpointLabel,
    platform: req.platform,
    bridge_version: req.bridgeVersion,
    expires_at: req.expiresAt.toISOString(),
    existing_endpoint: existing !== null,
    has_default_receiver: def !== undefined,
  };
}

export interface DecidePairingInput {
  userCode: string;
  decision: 'approve' | 'deny';
  endpointLabel?: string | undefined;
  makeDefault?: boolean | undefined;
}

/**
 * Human approval in the browser. Approving registers the device (once per installation) and the endpoint
 * (once per user/device/harness/profile: re-pairing keeps the same H). The credential is NOT created here.
 */
export async function decidePairing(
  tx: Tx,
  userId: string,
  input: DecidePairingInput,
): Promise<{ hId: string | null }> {
  // Take the account row lock first. Inserting the endpoint below takes a key-share lock on this row (foreign
  // key), and ensureAutoRoute locks it for update; two pairings of one account approved at the same moment
  // would otherwise each hold what the other waits for and deadlock.
  await tx.select({ id: appUsers.id }).from(appUsers).where(eq(appUsers.id, userId)).for('update');
  const req = await livePending(tx, input.userCode, true);
  const user = await getUserById(tx, userId);
  if (!user) throw new AgentDropError('UNAUTHORIZED');
  if (input.decision === 'deny') {
    const denied = await tx
      .update(pairingRequests)
      .set({ status: 'denied', decidedAt: new Date(), approvedByUserId: userId })
      .where(
        and(
          eq(pairingRequests.id, req.id),
          eq(pairingRequests.status, 'pending'),
          isNull(pairingRequests.decidedAt),
        ),
      )
      .returning({ id: pairingRequests.id });
    if (denied.length === 0) throw new AgentDropError('NOT_FOUND', 'pairing code not found or expired');
    await recordAudit(tx, { actorUserId: userId, action: 'pairing.deny', targetId: req.id, result: 'ok' });
    return { hId: null };
  }

  // Device: one row per (user, installation). Serialize concurrent approvals of the same installation.
  let device = await tx.query.devices.findFirst({
    where: and(eq(devices.userId, userId), eq(devices.installationId, req.installationId)),
  });
  if (!device) {
    const inserted = await tx
      .insert(devices)
      .values({ userId, installationId: req.installationId, label: req.deviceLabel, platform: req.platform })
      .onConflictDoNothing()
      .returning();
    device =
      inserted[0] ??
      (await tx.query.devices.findFirst({
        where: and(eq(devices.userId, userId), eq(devices.installationId, req.installationId)),
      }));
  }
  if (!device) throw new AgentDropError('INTERNAL', 'device registration failed');
  if (device.revokedAt)
    throw new AgentDropError(
      'VALIDATION_FAILED',
      'this device was revoked; run `agentdrop device rebind` to pair it as a new device, then in the dashboard (My agents) let the new agents take over the revoked ones to keep their addresses',
    );

  let h = await tx.query.harnessEndpoints.findFirst({
    where: and(
      eq(harnessEndpoints.userId, userId),
      eq(harnessEndpoints.deviceId, device.id),
      eq(harnessEndpoints.harnessKey, req.harnessKey),
      eq(harnessEndpoints.profileKey, req.profileKey),
    ),
  });
  let created = false;
  if (!h) {
    const inserted = await tx
      .insert(harnessEndpoints)
      .values({
        userId,
        deviceId: device.id,
        harnessKey: req.harnessKey,
        profileKey: req.profileKey,
        label: input.endpointLabel?.trim() || req.endpointLabel,
      })
      .onConflictDoNothing()
      .returning();
    h =
      inserted[0] ??
      (await tx.query.harnessEndpoints.findFirst({
        where: and(
          eq(harnessEndpoints.userId, userId),
          eq(harnessEndpoints.deviceId, device.id),
          eq(harnessEndpoints.harnessKey, req.harnessKey),
          eq(harnessEndpoints.profileKey, req.profileKey),
        ),
      }));
    created = inserted.length > 0;
  }
  if (!h) throw new AgentDropError('INTERNAL', 'endpoint registration failed');
  if (h.revokedAt)
    throw new AgentDropError(
      'VALIDATION_FAILED',
      'this agent was revoked and cannot be paired again; pair a new agent with another profile name (--profile), then in the dashboard (My agents) let it take over the revoked one to keep its address',
    );

  const approved = await tx
    .update(pairingRequests)
    .set({ status: 'approved', decidedAt: new Date(), approvedByUserId: userId, hId: h.id })
    .where(
      and(
        eq(pairingRequests.id, req.id),
        eq(pairingRequests.status, 'pending'),
        isNull(pairingRequests.decidedAt),
      ),
    )
    .returning({ id: pairingRequests.id });
  if (approved.length === 0) throw new AgentDropError('NOT_FOUND', 'pairing code not found or expired');

  await ensureAutoRoute(tx, userId, h.id);
  // Groups this account receives with "all agents" include the new agent from now on.
  await bindNewEndpointToGroups(tx, userId, h.id);
  // Contact requests left by invite links opened before there was an agent are accepted now (ADR 0034).
  await acceptInviteRequestsOnPairing(tx, userId);
  if (input.makeDefault) {
    const def = await getDefaultRoute(tx, userId);
    if (!def) await pointDefaultRoute(tx, userId, h.id);
  }
  await recordAudit(tx, {
    actorUserId: userId,
    hId: h.id,
    action: 'pairing.approve',
    targetId: req.id,
    result: 'ok',
    meta: { created_endpoint: created },
  });
  return { hId: h.id };
}

export type PollOutcome =
  | { status: 'pending' | 'denied' | 'expired' }
  | {
      status: 'approved';
      hId: string;
      credential: string;
      credentialExpiresAt: Date;
      userId: string;
      handle: string;
      agentName: string;
    };

/** CLI polling. The credential is issued exactly once, on the first poll after approval. */
export async function pollPairing(
  tx: Tx,
  deviceCode: string,
  credentialMaxDays: number,
): Promise<PollOutcome> {
  const rows = await tx
    .select()
    .from(pairingRequests)
    .where(eq(pairingRequests.deviceCodeHash, hashToken(deviceCode)))
    .for('update');
  const req = rows[0];
  if (!req) return { status: 'expired' };
  const now = new Date();
  if (req.lastPolledAt && now.getTime() - req.lastPolledAt.getTime() < (PAIRING_POLL_INTERVAL_S - 1) * 1000) {
    throw new AgentDropError('RATE_LIMITED', 'slow down');
  }
  await tx.update(pairingRequests).set({ lastPolledAt: now }).where(eq(pairingRequests.id, req.id));
  if (req.status === 'pending') {
    if (req.expiresAt.getTime() <= now.getTime()) {
      await tx.update(pairingRequests).set({ status: 'expired' }).where(eq(pairingRequests.id, req.id));
      return { status: 'expired' };
    }
    return { status: 'pending' };
  }
  if (req.status === 'denied') return { status: 'denied' };
  if (req.status !== 'approved' || !req.hId || !req.approvedByUserId) return { status: 'expired' };

  const issued = await issueCredential(tx, req.hId, credentialMaxDays);
  await tx.update(pairingRequests).set({ status: 'consumed' }).where(eq(pairingRequests.id, req.id));
  const user = await getUserById(tx, req.approvedByUserId);
  const h = await tx.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, req.hId) });
  if (!user || !h) throw new AgentDropError('INTERNAL', 'pairing state inconsistent');
  await recordAudit(tx, {
    actorUserId: user.id,
    hId: h.id,
    action: 'credential.issue',
    targetId: issued.credentialId,
    result: 'ok',
  });
  return {
    status: 'approved',
    hId: h.id,
    credential: issued.token,
    credentialExpiresAt: issued.expiresAt,
    userId: user.id,
    handle: user.handle,
    agentName: h.label,
  };
}

async function livePending(tx: Tx, rawUserCode: string, lock = false) {
  const userCode = normalizeUserCode(rawUserCode);
  const base = tx
    .select()
    .from(pairingRequests)
    .where(and(eq(pairingRequests.userCode, userCode), isNull(pairingRequests.decidedAt)));
  // decisions lock the row so two approvers cannot both observe "pending"
  const rows = lock ? await base.for('update') : await base;
  const req = rows[0];
  if (req?.status !== 'pending' || req.expiresAt.getTime() <= Date.now()) {
    throw new AgentDropError('NOT_FOUND', 'pairing code not found or expired');
  }
  return req;
}

async function findExistingEndpoint(tx: Tx, userId: string, req: typeof pairingRequests.$inferSelect) {
  const device = await tx.query.devices.findFirst({
    where: and(eq(devices.userId, userId), eq(devices.installationId, req.installationId)),
  });
  if (!device) return null;
  const h = await tx.query.harnessEndpoints.findFirst({
    where: and(
      eq(harnessEndpoints.userId, userId),
      eq(harnessEndpoints.deviceId, device.id),
      eq(harnessEndpoints.harnessKey, req.harnessKey),
      eq(harnessEndpoints.profileKey, req.profileKey),
    ),
  });
  return h ?? null;
}
