import type { DrizzleDb } from '@agentdrop/db';
import { claimNoticeItem, releaseNoticeItem } from '@agentdrop/domain';
import type { DeliveryProgress } from './outbox.js';

/*
 * The person's shared "already shown" record (ADR 0007, 0009) as the server-side channels use it. Browser push and
 * Feishu both deliver the event that just happened; whichever of them reached the person records the item, so the
 * end-of-turn notice in every agent, and any later event for the same item, does not announce it again.
 */
export type NoticeList = 'drops' | 'contacts' | 'invitations' | 'join_requests';

/** Set in the event's progress when a channel of this very event reached the person with the item. */
export function announcedMarker(userId: string, key: string): string {
  return `announced:${userId}:${key}`;
}

/** True when an earlier channel of this event (or an earlier attempt of it) already reached the person. */
export function announcedInEvent(
  progress: DeliveryProgress | undefined,
  userId: string,
  key: string,
): boolean {
  return progress?.done(announcedMarker(userId, key)) === true;
}

/**
 * A channel reached the person: mark it in the event first, then record the item as shown. The order matters: a
 * concurrent channel that gives its own claim back re-claims when it sees the marker (see `releaseUnlessAnnounced`),
 * so the record never loses an item somebody was told about.
 */
export async function recordAnnounced(
  db: DrizzleDb,
  progress: DeliveryProgress | undefined,
  userId: string,
  list: NoticeList,
  key: string,
): Promise<void> {
  await progress?.markDone(announcedMarker(userId, key));
  await db.transaction((tx) => claimNoticeItem(tx, userId, list, key));
}

/** Gives a failed channel's claim back, unless another channel of this event reached the person meanwhile. */
export async function releaseUnlessAnnounced(
  db: DrizzleDb,
  progress: DeliveryProgress | undefined,
  userId: string,
  list: NoticeList,
  key: string,
): Promise<void> {
  if (announcedInEvent(progress, userId, key)) return;
  await db.transaction((tx) => releaseNoticeItem(tx, userId, list, key));
  // Push may have recorded it between the check above and the release: record it again.
  if (announcedInEvent(progress, userId, key))
    await db.transaction((tx) => claimNoticeItem(tx, userId, list, key));
}
