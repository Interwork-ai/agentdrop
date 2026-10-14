import { AgentDropError } from '@agentdrop/contracts';
import {
  appUsers,
  groupBindings,
  groupMemberships,
  harnessEndpoints,
  recipientRoutes,
  type Tx,
} from '@agentdrop/db';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { bumpGroupVersion } from '../groups/groups.js';
import { revokeEndpoint } from './endpoints.js';
import { bumpDirectoryRevision } from './users.js';

/*
 * One agent takes over another of the same account (ADR 0011): typically the new agent on a replacement machine
 * takes over one on a machine that is gone. Its addresses move to the new agent, so contacts who remembered them
 * keep reaching the person without doing anything; its group bindings move too; then the old agent is revoked.
 * Delivered history stays where it is and remains readable account-wide (ADR 0007).
 */

export interface TakeOverResult {
  from_h_id: string;
  to_h_id: string;
  routes_moved: number;
  bindings_moved: number;
}

export async function takeOverEndpoint(
  tx: Tx,
  userId: string,
  fromHId: string,
  toHId: string,
): Promise<TakeOverResult> {
  if (fromHId === toHId) throw new AgentDropError('VALIDATION_FAILED', 'an agent cannot take over itself');
  // the same lock that serializes address allocation for this person
  await tx.select({ id: appUsers.id }).from(appUsers).where(eq(appUsers.id, userId)).for('update');
  const [from, to] = await Promise.all(
    [fromHId, toHId].map((id) => tx.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, id) })),
  );
  if (!from || from.userId !== userId || !to || to.userId !== userId)
    throw new AgentDropError('NOT_FOUND', 'endpoint not found');
  if (to.revokedAt) throw new AgentDropError('VALIDATION_FAILED', 'the agent taking over is revoked');
  const now = new Date();

  // The old agent's addresses: live ones, or, if it was already revoked, exactly those revoked together with it
  // (revokeEndpoint stamps both with the same instant), never ones the person removed separately.
  const routes = await tx
    .select()
    .from(recipientRoutes)
    .where(
      and(
        eq(recipientRoutes.destinationHId, from.id),
        from.revokedAt ? eq(recipientRoutes.revokedAt, from.revokedAt) : isNull(recipientRoutes.revokedAt),
      ),
    );
  const oldAuto = routes.find((r) => r.auto);
  let newAutoWasDefault = false;
  if (oldAuto) {
    // one automatic address per agent: the new agent's own gives way to the one contacts already know
    const retired = await tx
      .update(recipientRoutes)
      .set({ revokedAt: now, version: sql`${recipientRoutes.version} + 1` })
      .where(
        and(
          eq(recipientRoutes.destinationHId, to.id),
          eq(recipientRoutes.auto, true),
          isNull(recipientRoutes.revokedAt),
        ),
      )
      .returning({ isDefault: recipientRoutes.isDefault });
    newAutoWasDefault = retired.some((r) => r.isDefault);
  }
  let routesMoved = 0;
  for (const route of routes) {
    // an address coming back from revocation must not collide with a default or alias that is live meanwhile
    const clash = await tx.query.recipientRoutes.findFirst({
      where: and(
        eq(recipientRoutes.userId, userId),
        isNull(recipientRoutes.revokedAt),
        ne(recipientRoutes.id, route.id),
        or(
          route.isDefault ? eq(recipientRoutes.isDefault, true) : sql`false`,
          route.alias ? eq(recipientRoutes.alias, route.alias) : sql`false`,
        ),
      ),
    });
    if (clash?.alias && clash.alias === route.alias) continue; // alias reused since: leave this one revoked
    await tx
      .update(recipientRoutes)
      .set({
        destinationHId: to.id,
        revokedAt: null,
        // the destination moved: approvals previewed against the old one must be previewed again
        version: sql`${recipientRoutes.version} + 1`,
        ...(route.auto ? { label: to.label } : {}),
        isDefault: route.isDefault && !clash,
      })
      .where(eq(recipientRoutes.id, route.id));
    routesMoved++;
  }
  if (oldAuto && newAutoWasDefault) {
    const live = await tx.query.recipientRoutes.findFirst({
      where: and(
        eq(recipientRoutes.userId, userId),
        eq(recipientRoutes.isDefault, true),
        isNull(recipientRoutes.revokedAt),
      ),
    });
    if (!live)
      await tx.update(recipientRoutes).set({ isDefault: true }).where(eq(recipientRoutes.id, oldAuto.id));
  }

  // Group bindings: the new agent receives wherever the old one did (unless it already does).
  const bindings = await tx
    .select({ b: groupBindings, m: groupMemberships })
    .from(groupBindings)
    .innerJoin(groupMemberships, eq(groupMemberships.id, groupBindings.membershipId))
    .where(and(eq(groupBindings.hId, from.id), isNull(groupBindings.revokedAt)));
  const alreadyBound = new Set(
    (
      await tx
        .select({ membershipId: groupBindings.membershipId })
        .from(groupBindings)
        .where(and(eq(groupBindings.hId, to.id), isNull(groupBindings.revokedAt)))
    ).map((r) => r.membershipId),
  );
  let bindingsMoved = 0;
  for (const { b, m } of bindings) {
    if (alreadyBound.has(b.membershipId)) {
      await tx.update(groupBindings).set({ revokedAt: now }).where(eq(groupBindings.id, b.id));
    } else {
      await tx.update(groupBindings).set({ hId: to.id, enabledAt: now }).where(eq(groupBindings.id, b.id));
      bindingsMoved++;
    }
    await tx
      .update(groupMemberships)
      .set({ version: sql`${groupMemberships.version} + 1` })
      .where(eq(groupMemberships.id, m.id));
    await bumpGroupVersion(tx, m.groupId);
  }

  // Retire the old agent (its credentials stop working); nothing points at it any more.
  if (!from.revokedAt) await revokeEndpoint(tx, userId, from.id);
  await bumpDirectoryRevision(tx, [userId]);
  await recordAudit(tx, {
    actorUserId: userId,
    hId: to.id,
    action: 'endpoint.take_over',
    targetId: from.id,
    result: 'ok',
    meta: { routes: routesMoved, bindings: bindingsMoved },
  });
  return { from_h_id: from.id, to_h_id: to.id, routes_moved: routesMoved, bindings_moved: bindingsMoved };
}
