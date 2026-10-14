import { AgentDropError, displayNameSchema, type HarnessKey } from '@agentdrop/contracts';
import {
  appUsers,
  auditEvents,
  devices,
  harnessEndpoints,
  hCredentials,
  recipientRoutes,
  type Tx,
} from '@agentdrop/db';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { syncAutoRouteLabel } from '../contacts/routes.js';
import { reconcileGroupsAfterAgentLoss } from '../groups/groups.js';
import { bumpDirectoryRevision } from './users.js';

export type { HarnessKey } from '@agentdrop/contracts';

export interface EndpointView {
  h_id: string;
  label: string;
  public_name: string | null;
  name_version: number;
  harness_key: HarnessKey;
  profile_key: string;
  device: { device_id: string; label: string; platform: string | null; revoked: boolean };
  is_default_receiver: boolean;
  created_at: string;
  revoked_at: string | null;
  /** The agent that took this one over (ADR 0011), if any. */
  taken_over_by: string | null;
}

function validateName(raw: string, field: string): string {
  const parsed = displayNameSchema.safeParse(raw);
  if (!parsed.success) throw new AgentDropError('VALIDATION_FAILED', `invalid ${field}`, { field });
  return parsed.data;
}

async function ownedEndpoint(tx: Tx, userId: string, hId: string) {
  const h = await tx.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, hId) });
  if (!h || h.userId !== userId) throw new AgentDropError('NOT_FOUND', 'endpoint not found');
  return h;
}

export async function listEndpoints(tx: Tx, userId: string): Promise<EndpointView[]> {
  const rows = await tx
    .select({ h: harnessEndpoints, d: devices })
    .from(harnessEndpoints)
    .innerJoin(devices, eq(devices.id, harnessEndpoints.deviceId))
    .where(eq(harnessEndpoints.userId, userId))
    .orderBy(asc(devices.createdAt), asc(harnessEndpoints.createdAt));
  const def = await getDefaultRoute(tx, userId);
  // take-overs are recorded in the audit log: old agent (target) -> the agent that took it over
  const takeOvers = rows.length
    ? await tx
        .select({ from: auditEvents.targetId, to: auditEvents.hId })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, 'endpoint.take_over'),
            eq(auditEvents.actorUserId, userId),
            inArray(
              auditEvents.targetId,
              rows.map(({ h }) => h.id),
            ),
          ),
        )
    : [];
  const takenOverBy = new Map(takeOvers.map((r) => [r.from, r.to]));
  return rows.map(({ h, d }) => ({
    h_id: h.id,
    label: h.label,
    public_name: h.publicName,
    name_version: h.nameVersion,
    harness_key: h.harnessKey,
    profile_key: h.profileKey,
    device: { device_id: d.id, label: d.label, platform: d.platform, revoked: d.revokedAt !== null },
    is_default_receiver: def?.destinationHId === h.id,
    created_at: h.createdAt.toISOString(),
    revoked_at: h.revokedAt ? h.revokedAt.toISOString() : null,
    taken_over_by: takenOverBy.get(h.id) ?? null,
  }));
}

/** Renames the agent. h_id, routes, history and pairing are untouched; only label/name_version change. */
export async function renameEndpoint(tx: Tx, userId: string, hId: string, rawLabel: string): Promise<void> {
  await ownedEndpoint(tx, userId, hId);
  const label = validateName(rawLabel, 'label');
  await tx
    .update(harnessEndpoints)
    .set({ label, nameVersion: sql`${harnessEndpoints.nameVersion} + 1` })
    .where(eq(harnessEndpoints.id, hId));
  await syncAutoRouteLabel(tx, hId, label);
  await bumpDirectoryRevision(tx, [userId]);
  await recordAudit(tx, { actorUserId: userId, hId, action: 'endpoint.rename', result: 'ok' });
}

/** Explicit public signature for outgoing drops. Never derived from device labels. */
export async function setEndpointPublicName(
  tx: Tx,
  userId: string,
  hId: string,
  rawName: string | null,
): Promise<void> {
  await ownedEndpoint(tx, userId, hId);
  const publicName = rawName === null || rawName.trim() === '' ? null : validateName(rawName, 'public_name');
  await tx
    .update(harnessEndpoints)
    .set({ publicName, nameVersion: sql`${harnessEndpoints.nameVersion} + 1` })
    .where(eq(harnessEndpoints.id, hId));
  await recordAudit(tx, { actorUserId: userId, hId, action: 'endpoint.public_name', result: 'ok' });
}

/** Revokes an endpoint: credentials stop working, routes pointing at it are revoked. Mailbox content stays. */
export async function revokeEndpoint(tx: Tx, userId: string, hId: string): Promise<void> {
  const h = await ownedEndpoint(tx, userId, hId);
  if (h.revokedAt) return;
  const now = new Date();
  await tx.update(harnessEndpoints).set({ revokedAt: now }).where(eq(harnessEndpoints.id, hId));
  await tx
    .update(hCredentials)
    .set({ revokedAt: now })
    .where(and(eq(hCredentials.hId, hId), isNull(hCredentials.revokedAt)));
  await tx
    .update(recipientRoutes)
    .set({ revokedAt: now, version: sql`${recipientRoutes.version} + 1` })
    .where(and(eq(recipientRoutes.destinationHId, hId), isNull(recipientRoutes.revokedAt)));
  // Groups first: every group operation locks the group before touching people's rows, so this does too.
  await reconcileGroupsAfterAgentLoss(tx, userId);
  // The person stays reachable (ADR 0015): if this was the one agent chosen for plain sends, plain sends go to all
  // of their remaining agents again instead of failing with NO_DELIVERY_ROUTE.
  if (!(await getDefaultRoute(tx, userId))) {
    await tx
      .update(appUsers)
      .set({ directReceiveAll: true, updatedAt: now })
      .where(and(eq(appUsers.id, userId), eq(appUsers.directReceiveAll, false)));
  }
  await bumpDirectoryRevision(tx, [userId]);
  await recordAudit(tx, { actorUserId: userId, hId, action: 'endpoint.revoke', result: 'ok' });
}

export async function getDefaultRoute(tx: Tx, userId: string) {
  return tx.query.recipientRoutes.findFirst({
    where: and(
      eq(recipientRoutes.userId, userId),
      eq(recipientRoutes.isDefault, true),
      isNull(recipientRoutes.revokedAt),
    ),
  });
}

/**
 * Plain sends to me reach all of my agents (the default, ADR 0008). Choosing one agent with
 * setDefaultReceivingEndpoint turns this off; this turns it back on. Only future personal sends are affected.
 */
export async function setDirectReceiveAll(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(appUsers)
    .set({ directReceiveAll: true, updatedAt: new Date() })
    .where(eq(appUsers.id, userId));
  await bumpDirectoryRevision(tx, [userId]);
  await recordAudit(tx, { actorUserId: userId, action: 'route.default.all', result: 'ok' });
}

/**
 * A person choosing one agent to receive plain sends (@me → this H only). Turns "all agents" off. Only affects
 * future personal sends; existing group bindings and history never move.
 */
export async function setDefaultReceivingEndpoint(tx: Tx, userId: string, hId: string): Promise<void> {
  await tx
    .update(appUsers)
    .set({ directReceiveAll: false, updatedAt: new Date() })
    .where(eq(appUsers.id, userId));
  await pointDefaultRoute(tx, userId, hId);
  await bumpDirectoryRevision(tx, [userId]);
}

/**
 * Points the default route at this H without changing whether plain sends reach all agents. Pairing uses it for
 * the first agent: the route is the fallback and the provenance for single-agent receiving, not a choice.
 */
export async function pointDefaultRoute(tx: Tx, userId: string, hId: string): Promise<void> {
  const h = await ownedEndpoint(tx, userId, hId);
  if (h.revokedAt) throw new AgentDropError('VALIDATION_FAILED', 'endpoint is revoked');
  const current = await getDefaultRoute(tx, userId);
  if (current?.destinationHId === hId) return;
  const now = new Date();
  if (current) {
    await tx
      .update(recipientRoutes)
      .set({ revokedAt: now, version: sql`${recipientRoutes.version} + 1` })
      .where(eq(recipientRoutes.id, current.id));
  }
  await tx.insert(recipientRoutes).values({
    userId,
    alias: null,
    label: 'default',
    destinationHId: hId,
    isDefault: true,
    visibility: 'contacts',
  });
  await bumpDirectoryRevision(tx, [userId]);
  await recordAudit(tx, { actorUserId: userId, hId, action: 'route.default.set', result: 'ok' });
}

export interface DeviceView {
  device_id: string;
  label: string;
  platform: string | null;
  created_at: string;
  revoked_at: string | null;
  endpoint_count: number;
}

export async function listDevices(tx: Tx, userId: string): Promise<DeviceView[]> {
  const rows = await tx
    .select({
      d: devices,
      count: sql<number>`(select count(*)::int from ${harnessEndpoints} where ${harnessEndpoints.deviceId} = ${devices.id})`,
    })
    .from(devices)
    .where(eq(devices.userId, userId))
    .orderBy(desc(devices.createdAt));
  return rows.map(({ d, count }) => ({
    device_id: d.id,
    label: d.label,
    platform: d.platform,
    created_at: d.createdAt.toISOString(),
    revoked_at: d.revokedAt ? d.revokedAt.toISOString() : null,
    endpoint_count: count,
  }));
}

export async function renameDevice(
  tx: Tx,
  userId: string,
  deviceId: string,
  rawLabel: string,
): Promise<void> {
  const d = await tx.query.devices.findFirst({ where: eq(devices.id, deviceId) });
  if (!d || d.userId !== userId) throw new AgentDropError('NOT_FOUND', 'device not found');
  await tx
    .update(devices)
    .set({ label: validateName(rawLabel, 'label') })
    .where(eq(devices.id, deviceId));
}

/** Lost device: revoke the device and every endpoint on it. Content stays visible to the account. */
export async function revokeDevice(tx: Tx, userId: string, deviceId: string): Promise<void> {
  const d = await tx.query.devices.findFirst({ where: eq(devices.id, deviceId) });
  if (!d || d.userId !== userId) throw new AgentDropError('NOT_FOUND', 'device not found');
  // Acquire every H before revoking any routes. Sends lock their origin H before resolving routes;
  // interleaving H1 → route1 → H2 here would deadlock with a send from H2 targeting route1.
  // NO KEY UPDATE still excludes sender SHARE locks, but allows the KEY SHARE locks taken by
  // delivery foreign keys. FOR UPDATE would deadlock when H2 sends to H1 while we wait for H2.
  const hs = await tx
    .select()
    .from(harnessEndpoints)
    .where(eq(harnessEndpoints.deviceId, deviceId))
    .orderBy(asc(harnessEndpoints.id))
    .for('no key update');
  for (const h of hs) await revokeEndpoint(tx, userId, h.id);
  await tx.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, deviceId));
  await recordAudit(tx, { actorUserId: userId, action: 'device.revoke', targetId: deviceId, result: 'ok' });
}
