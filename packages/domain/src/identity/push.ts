import { createHash } from 'node:crypto';
import { AgentDropError, type PushSubscriptionInput, type PushSubscriptionView } from '@agentdrop/contracts';
import { pushSubscriptions, type Tx } from '@agentdrop/db';
import { and, asc, eq, isNull } from 'drizzle-orm';

const endpointHash = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex');

function view(row: typeof pushSubscriptions.$inferSelect): PushSubscriptionView {
  return {
    id: row.id,
    device_label: row.deviceLabel,
    user_agent: row.userAgent,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    last_success_at: row.lastSuccessAt?.toISOString() ?? null,
    failure_count: row.failureCount,
  };
}

export async function listPushSubscriptions(tx: Tx, userId: string): Promise<PushSubscriptionView[]> {
  const rows = await tx
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt)))
    .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id));
  return rows.map(view);
}

export async function upsertPushSubscription(
  tx: Tx,
  userId: string,
  input: PushSubscriptionInput,
  userAgent: string | null,
): Promise<PushSubscriptionView> {
  const hash = endpointHash(input.endpoint);
  const existing = await tx.query.pushSubscriptions.findFirst({
    where: eq(pushSubscriptions.endpointHash, hash),
  });
  if (existing && existing.userId !== userId) {
    const provesPossession =
      existing.endpoint === input.endpoint &&
      existing.p256dh === input.keys.p256dh &&
      existing.auth === input.keys.auth;
    if (!provesPossession) {
      throw new AgentDropError('VALIDATION_FAILED', 'push subscription is already registered');
    }
    const [transferred] = await tx
      .update(pushSubscriptions)
      .set({
        userId,
        deviceLabel: input.device_label,
        userAgent,
        updatedAt: new Date(),
        revokedAt: null,
        failureCount: 0,
      })
      .where(and(eq(pushSubscriptions.id, existing.id), eq(pushSubscriptions.userId, existing.userId)))
      .returning();
    if (!transferred) throw new AgentDropError('INTERNAL');
    return view(transferred);
  }
  const now = new Date();
  if (existing) {
    const [updated] = await tx
      .update(pushSubscriptions)
      .set({
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        deviceLabel: input.device_label,
        userAgent,
        updatedAt: now,
        revokedAt: null,
        failureCount: 0,
      })
      .where(and(eq(pushSubscriptions.id, existing.id), eq(pushSubscriptions.userId, userId)))
      .returning();
    if (!updated) throw new AgentDropError('INTERNAL');
    return view(updated);
  }
  const [inserted] = await tx
    .insert(pushSubscriptions)
    .values({
      userId,
      endpoint: input.endpoint,
      endpointHash: hash,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      deviceLabel: input.device_label,
      userAgent,
    })
    .returning();
  if (!inserted) throw new AgentDropError('INTERNAL');
  return view(inserted);
}

export async function revokePushSubscription(tx: Tx, userId: string, id: string): Promise<void> {
  const rows = await tx
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.id, id),
        eq(pushSubscriptions.userId, userId),
        isNull(pushSubscriptions.revokedAt),
      ),
    )
    .returning({ id: pushSubscriptions.id });
  if (rows.length === 0) throw new AgentDropError('NOT_FOUND', 'push subscription not found');
}
