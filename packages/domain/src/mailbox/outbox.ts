import { outboxEvents, type Tx } from '@agentdrop/db';

export type OutboxEventType =
  | 'drop.delivered'
  | 'approval.created'
  | 'attachment.cleanup'
  | 'grant.revoked'
  | 'contact.requested'
  | 'contact.accepted'
  | 'group.invited'
  | 'group.join_requested'
  | 'content.backfill';

/** Derived side effects only (notifications, cleanup). Delivery itself never depends on the worker. */
export async function enqueueOutbox(
  tx: Tx,
  type: OutboxEventType,
  aggregateId: string,
  payload: Record<string, unknown> = {},
  /** Not before this moment (e.g. deleting an object a running download may still read). */
  availableAt?: Date,
): Promise<void> {
  await tx
    .insert(outboxEvents)
    .values({ type, aggregateId, payload, ...(availableAt ? { availableAt } : {}) });
}
