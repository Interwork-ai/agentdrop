import { AgentDropError, displayNameSchema, type HarnessKey, routeAliasSchema } from '@agentdrop/contracts';
import { appUsers, harnessEndpoints, recipientRoutes, type Tx } from '@agentdrop/db';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { bumpDirectoryRevision } from '../identity/users.js';

export interface RouteView {
  route_id: string;
  alias: string | null;
  label: string;
  is_default: boolean;
  visibility: 'private' | 'contacts';
  /** Only the owner sees where a route points. */
  destination_h_id: string;
  harness_key: HarnessKey;
  /** System-managed address of one endpoint: created at pairing, follows the agent's name, revoked with it. */
  auto: boolean;
  version: number;
  created_at: string;
  revoked_at: string | null;
}

const AUTO_ALIAS_BASE: Record<HarnessKey, string> = {
  codex: 'codex',
  'claude-code': 'claude',
  other: 'agent',
  opencode: 'opencode',
  cursor: 'cursor',
  omp: 'omp',
};

/**
 * Every endpoint owns exactly one automatic address (@me/codex, @me/claude, @me/codex-2 …) that contacts can pick
 * explicitly, so a sender always knows which agent a drop lands on. Idempotent; also re-syncs the label.
 */
export async function ensureAutoRoute(tx: Tx, userId: string, hId: string): Promise<RouteView | null> {
  const h = await tx.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, hId) });
  if (!h || h.userId !== userId || h.revokedAt) return null;
  // one allocation at a time per user: concurrent approvals or manual entries cannot race on the same alias,
  // and the existence check below runs after the lock so a second approval of the same H finds the first route
  await lockUserRoutes(tx, userId);
  const existing = await tx.query.recipientRoutes.findFirst({
    where: and(
      eq(recipientRoutes.destinationHId, hId),
      eq(recipientRoutes.auto, true),
      isNull(recipientRoutes.revokedAt),
    ),
  });
  if (existing) {
    if (existing.label === h.label) return toView(existing, h.harnessKey);
    // label only: the destination is unchanged, so pending approvals that snapshot route versions stay valid
    const [row] = await tx
      .update(recipientRoutes)
      .set({ label: h.label })
      .where(eq(recipientRoutes.id, existing.id))
      .returning();
    await bumpDirectoryRevision(tx, [userId]);
    return row ? toView(row, h.harnessKey) : null;
  }
  const taken = new Set(
    (
      await tx
        .select({ alias: recipientRoutes.alias })
        .from(recipientRoutes)
        .where(
          and(
            eq(recipientRoutes.userId, userId),
            isNotNull(recipientRoutes.alias),
            isNull(recipientRoutes.revokedAt),
          ),
        )
    ).map((r) => r.alias),
  );
  const base = AUTO_ALIAS_BASE[h.harnessKey] ?? 'agent';
  let alias = base;
  for (let n = 2; taken.has(alias); n++) alias = `${base}-${n}`;
  const [row] = await tx
    .insert(recipientRoutes)
    .values({ userId, alias, label: h.label, destinationHId: hId, visibility: 'contacts', auto: true })
    .returning();
  if (!row) throw new AgentDropError('INTERNAL');
  await bumpDirectoryRevision(tx, [userId]);
  await recordAudit(tx, {
    actorUserId: userId,
    hId,
    action: 'route.auto.create',
    targetId: row.id,
    result: 'ok',
  });
  return toView(row, h.harnessKey);
}

/** Serializes alias allocation for one user (row lock on app_users, released with the transaction). */
async function lockUserRoutes(tx: Tx, userId: string): Promise<void> {
  await tx.select({ id: appUsers.id }).from(appUsers).where(eq(appUsers.id, userId)).for('update');
}

/**
 * Keeps the automatic address in step with a renamed agent (contacts see the new name immediately). The route
 * version is untouched: the destination did not move, so approvals snapshotted against it must not go stale.
 */
export async function syncAutoRouteLabel(tx: Tx, hId: string, label: string): Promise<void> {
  await tx
    .update(recipientRoutes)
    .set({ label })
    .where(
      and(
        eq(recipientRoutes.destinationHId, hId),
        eq(recipientRoutes.auto, true),
        isNull(recipientRoutes.revokedAt),
      ),
    );
}

/** Publishes a named receiving entry (@me/alias → one of my endpoints). Aliases are not renamed in v1. */
export async function createNamedRoute(
  tx: Tx,
  userId: string,
  input: { alias: string; label: string; hId: string; visibility: 'private' | 'contacts' },
): Promise<RouteView> {
  const alias = routeAliasSchema.safeParse(input.alias.trim().toLowerCase());
  if (!alias.success) throw new AgentDropError('VALIDATION_FAILED', 'invalid alias', { field: 'alias' });
  if (alias.data === 'default')
    throw new AgentDropError('VALIDATION_FAILED', 'alias is reserved', { field: 'alias' });
  const label = displayNameSchema.safeParse(input.label);
  if (!label.success) throw new AgentDropError('VALIDATION_FAILED', 'invalid label', { field: 'label' });
  const h = await tx.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, input.hId) });
  if (!h || h.userId !== userId || h.revokedAt) throw new AgentDropError('NOT_FOUND', 'endpoint not found');
  await lockUserRoutes(tx, userId);
  const clash = await tx.query.recipientRoutes.findFirst({
    where: and(
      eq(recipientRoutes.userId, userId),
      eq(recipientRoutes.alias, alias.data),
      isNull(recipientRoutes.revokedAt),
    ),
  });
  if (clash) throw new AgentDropError('VALIDATION_FAILED', 'alias already in use', { field: 'alias' });
  const [row] = await tx
    .insert(recipientRoutes)
    .values({
      userId,
      alias: alias.data,
      label: label.data,
      destinationHId: h.id,
      visibility: input.visibility,
    })
    .returning();
  if (!row) throw new AgentDropError('INTERNAL');
  await bumpDirectoryRevision(tx, [userId]);
  await recordAudit(tx, {
    actorUserId: userId,
    hId: h.id,
    action: 'route.create',
    targetId: row.id,
    result: 'ok',
  });
  return toView(row, h.harnessKey);
}

/** Repoints or re-publishes a named route. Senders' remembered preferences keep pointing at the route id. */
export async function updateNamedRoute(
  tx: Tx,
  userId: string,
  routeId: string,
  input: { label?: string; hId?: string; visibility?: 'private' | 'contacts' },
): Promise<RouteView> {
  const route = await tx.query.recipientRoutes.findFirst({ where: eq(recipientRoutes.id, routeId) });
  if (!route || route.userId !== userId || route.revokedAt || route.isDefault)
    throw new AgentDropError('NOT_FOUND', 'route not found');
  if (route.auto)
    throw new AgentDropError(
      'VALIDATION_FAILED',
      'automatic addresses follow their agent; rename the agent instead',
    );
  const patch: Partial<typeof recipientRoutes.$inferInsert> = {};
  if (input.label !== undefined) {
    const label = displayNameSchema.safeParse(input.label);
    if (!label.success) throw new AgentDropError('VALIDATION_FAILED', 'invalid label', { field: 'label' });
    patch.label = label.data;
  }
  if (input.hId !== undefined) {
    const h = await tx.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, input.hId) });
    if (!h || h.userId !== userId || h.revokedAt) throw new AgentDropError('NOT_FOUND', 'endpoint not found');
    patch.destinationHId = h.id;
  }
  if (input.visibility !== undefined) patch.visibility = input.visibility;
  const [row] = await tx
    .update(recipientRoutes)
    .set({ ...patch, version: sql`${recipientRoutes.version} + 1` })
    .where(eq(recipientRoutes.id, routeId))
    .returning();
  if (!row) throw new AgentDropError('INTERNAL');
  await bumpDirectoryRevision(tx, [userId]);
  await recordAudit(tx, { actorUserId: userId, action: 'route.update', targetId: routeId, result: 'ok' });
  return toView(row, (await harnessOf(tx, row.destinationHId)) ?? 'other');
}

export async function revokeNamedRoute(tx: Tx, userId: string, routeId: string): Promise<void> {
  const route = await tx.query.recipientRoutes.findFirst({ where: eq(recipientRoutes.id, routeId) });
  if (!route || route.userId !== userId || route.isDefault)
    throw new AgentDropError('NOT_FOUND', 'route not found');
  if (route.auto)
    throw new AgentDropError(
      'VALIDATION_FAILED',
      'automatic addresses are revoked together with their agent',
    );
  if (route.revokedAt) return;
  await tx
    .update(recipientRoutes)
    .set({ revokedAt: new Date(), version: sql`${recipientRoutes.version} + 1` })
    .where(eq(recipientRoutes.id, routeId));
  await bumpDirectoryRevision(tx, [userId]);
  await recordAudit(tx, { actorUserId: userId, action: 'route.revoke', targetId: routeId, result: 'ok' });
}

export async function listMyRoutes(tx: Tx, userId: string): Promise<RouteView[]> {
  const rows = await tx
    .select({ r: recipientRoutes, harnessKey: harnessEndpoints.harnessKey })
    .from(recipientRoutes)
    .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, recipientRoutes.destinationHId))
    .where(and(eq(recipientRoutes.userId, userId), isNull(recipientRoutes.revokedAt)))
    .orderBy(asc(recipientRoutes.isDefault), asc(recipientRoutes.createdAt));
  return rows.map(({ r, harnessKey }) => toView(r, harnessKey));
}

async function harnessOf(tx: Tx, hId: string): Promise<HarnessKey | null> {
  const h = await tx.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, hId) });
  return h?.harnessKey ?? null;
}

/**
 * The named entries a person chose to publish to their contacts (`@bob/work`). Automatic per-agent addresses are
 * never among them: other people see a person, not their agents (ADR 0013).
 */
export async function publishedRoutesOf(tx: Tx, ownerUserId: string) {
  return tx
    .select({
      id: recipientRoutes.id,
      alias: recipientRoutes.alias,
      label: recipientRoutes.label,
      version: recipientRoutes.version,
      auto: recipientRoutes.auto,
      harnessKey: harnessEndpoints.harnessKey,
      destinationHId: recipientRoutes.destinationHId,
    })
    .from(recipientRoutes)
    .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, recipientRoutes.destinationHId))
    .where(
      and(
        eq(recipientRoutes.userId, ownerUserId),
        eq(recipientRoutes.isDefault, false),
        eq(recipientRoutes.auto, false),
        eq(recipientRoutes.visibility, 'contacts'),
        isNull(recipientRoutes.revokedAt),
      ),
    )
    .orderBy(asc(recipientRoutes.createdAt));
}

function toView(row: typeof recipientRoutes.$inferSelect, harnessKey: HarnessKey): RouteView {
  return {
    route_id: row.id,
    alias: row.alias,
    label: row.label,
    is_default: row.isDefault,
    visibility: row.visibility,
    destination_h_id: row.destinationHId,
    harness_key: harnessKey,
    auto: row.auto,
    version: row.version,
    created_at: row.createdAt.toISOString(),
    revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}
