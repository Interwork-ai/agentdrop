import type { ReplyProgress } from '@agentdrop/contracts';
import {
  appUsers,
  type DrizzleDb,
  deliveries,
  deliveryGrants,
  drops,
  groupMemberships,
  groups,
  harnessEndpoints,
  pushSubscriptions,
} from '@agentdrop/db';
import {
  historyViewer,
  noticeKey,
  openDropForList,
  readableDropIds,
  visibleEndpointIds,
} from '@agentdrop/domain';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import webPush from 'web-push';
import { type NoticeList, recordAnnounced } from './notice.js';
import type { DeliveryProgress } from './outbox.js';

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** Empty means disabled. Partial configuration is rejected without including any value in the error. */
export function loadWebPushConfig(env: NodeJS.ProcessEnv): WebPushConfig | null {
  const publicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY || undefined;
  const privateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY || undefined;
  const subject = env.WEB_PUSH_VAPID_SUBJECT || undefined;
  const fields = [publicKey, privateKey, subject];
  if (!fields.some(Boolean)) return null;
  if (!fields.every(Boolean)) {
    throw new Error(
      'WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_VAPID_SUBJECT must be set together',
    );
  }
  if (!publicKey || !privateKey || !subject) throw new Error('invalid Web Push configuration');
  return { publicKey, privateKey, subject };
}

export interface EligibleRecipient {
  userId: string;
  hId: string;
  /** The group this person got it through, or null when it was sent to them directly (direct wins). */
  group: { name: string; slug: string } | null;
  /** The author called on this person by @handle; a mention reaches them even in a group they muted. */
  mentioned: boolean;
  /**
   * The drop this one answers, only when this person may read it themselves (ADR 0016); `mine` when they wrote it.
   * Null when it answers nothing or the original is not theirs to see.
   */
  replyTo?: { title: string; mine: boolean } | null;
}

export interface DropNotificationAudience {
  sender: { handle: string; displayName: string };
  title: string;
  /** Where the answered drop's work stands, when this drop is a reply that says so (ADR 0038). */
  progress: ReplyProgress | null;
  recipients: EligibleRecipient[];
}

/**
 * Re-derives notification recipients from committed authorization state. Payload user_ids are deliberately ignored.
 * A user is eligible through an active direct grant, or an active group membership that is not muted (or muted,
 * but the drop @mentions them). The author is never notified of their own drop. One deterministic H
 * is selected per user so notification clicks work even when account-wide mailbox visibility is disabled.
 * A drop revoked or expired before the worker got to it notifies nobody (null), like a missing one.
 */
export async function resolveDropNotificationAudience(
  db: DrizzleDb,
  dropId: string,
): Promise<DropNotificationAudience | null> {
  const drop = await db.query.drops.findFirst({ where: eq(drops.id, dropId) });
  if (!drop || drop.revokedAt || (drop.expiresAt && drop.expiresAt.getTime() <= Date.now())) return null;
  const authorSnapshot = drop.authorSnapshot as { handle?: unknown; display_name?: unknown };
  const author = await db.query.appUsers.findFirst({ where: eq(appUsers.id, drop.authorUserId) });
  if (!author) return null;
  const rows = await db
    .select({
      userId: harnessEndpoints.userId,
      hId: harnessEndpoints.id,
      kind: deliveryGrants.kind,
      membershipStatus: groupMemberships.status,
      membershipMuted: groupMemberships.muted,
      membershipRevokedAt: groupMemberships.revokedAt,
      groupName: groups.displayName,
      groupSlug: groups.slug,
    })
    .from(deliveries)
    .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, deliveries.hId))
    .innerJoin(deliveryGrants, eq(deliveryGrants.deliveryId, deliveries.id))
    .leftJoin(groupMemberships, eq(groupMemberships.id, deliveryGrants.membershipId))
    .leftJoin(groups, eq(groups.id, groupMemberships.groupId))
    .where(
      and(
        eq(deliveries.dropId, dropId),
        isNull(harnessEndpoints.revokedAt),
        isNull(deliveryGrants.revokedAt),
      ),
    );
  const rawMentions = (drop.targetSnapshot as { mention_user_ids?: unknown } | null)?.mention_user_ids;
  const mentioned = new Set(
    Array.isArray(rawMentions) ? rawMentions.filter((x): x is string => typeof x === 'string') : [],
  );
  const eligible = rows.filter(
    (row) =>
      row.userId !== drop.authorUserId &&
      (row.kind === 'direct' ||
        (row.kind === 'group' &&
          row.membershipStatus === 'active' &&
          (row.membershipMuted === false || mentioned.has(row.userId)) &&
          row.membershipRevokedAt === null)),
  );
  // Per person: a direct grant wins; otherwise the eligible group with the smallest slug, the same group every
  // other surface names first (`group_labels` are sorted by slug).
  eligible.sort((a, b) => {
    if (a.userId !== b.userId) return a.userId.localeCompare(b.userId);
    if (a.kind !== b.kind) return a.kind === 'direct' ? -1 : 1;
    const slugs = (a.groupSlug ?? '').localeCompare(b.groupSlug ?? '');
    if (slugs !== 0) return slugs;
    return a.hId.localeCompare(b.hId);
  });
  const recipients = new Map<string, EligibleRecipient>();
  for (const row of eligible) {
    if (!recipients.has(row.userId))
      recipients.set(row.userId, {
        userId: row.userId,
        hId: row.hId,
        group:
          row.kind === 'group' && row.groupName && row.groupSlug
            ? { name: row.groupName, slug: row.groupSlug }
            : null,
        mentioned: mentioned.has(row.userId),
      });
  }
  if (drop.replyToDropId) {
    const original = await db.query.drops.findFirst({ where: eq(drops.id, drop.replyToDropId) });
    const content = original ? openDropForList(original) : null;
    if (original && content && !content.unreadable) {
      for (const recipient of recipients.values()) {
        // the same reading rule as the recipient's own mailbox view behind the notice's link
        const scope = { userId: recipient.userId, hId: recipient.hId, via: 'user_session' as const };
        const { endpointScope, hIds } = await visibleEndpointIds(db, scope);
        const viewer = historyViewer(scope, endpointScope);
        if ((await readableDropIds(db, hIds, [original.id], viewer)).has(original.id))
          recipient.replyTo = { title: content.title, mine: original.authorUserId === recipient.userId };
      }
    }
  }
  const recipientIds = [...recipients.keys()];
  const activeUsers = recipientIds.length
    ? await db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(
          and(inArray(appUsers.id, recipientIds), isNull(appUsers.suspendedAt), isNull(appUsers.deletedAt)),
        )
    : [];
  const activeIds = new Set(activeUsers.map((user) => user.id));
  return {
    title: openDropForList(drop).title,
    progress: drop.progress,
    sender: {
      handle: typeof authorSnapshot.handle === 'string' ? authorSnapshot.handle : author.handle,
      displayName:
        typeof authorSnapshot.display_name === 'string' ? authorSnapshot.display_name : author.displayName,
    },
    recipients: [...recipients.values()].filter((recipient) => activeIds.has(recipient.userId)),
  };
}

export type SendNotification = typeof webPush.sendNotification;

export class PushDeliveryError extends Error {
  constructor() {
    super('web push delivery failed');
    this.name = 'PushDeliveryError';
  }
}

export function configureWebPush(config: WebPushConfig | null): void {
  if (config) webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
}

/** web-push's `timeout` is a socket idle timeout; this also bounds a push service that trickles its response. */
export const PUSH_TIMEOUT_MS = 10_000;
/** Consecutive failures (reset by any success) after which a subscription is revoked instead of retried forever. */
export const PUSH_REVOKE_AFTER_FAILURES = 20;

function withDeadline<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('PUSH_TIMEOUT')), ms);
    onAbort = () => reject(new Error('LEASE_LOST'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, stop]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

/**
 * 404/410: the subscription is gone. 429 and 5xx/network errors are worth retrying. Any other 4xx (bad payload,
 * VAPID/auth mismatch) will fail the same way on every retry, so it never holds the event open.
 */
function classifyPushFailure(statusCode: number | null): 'gone' | 'transient' | 'permanent' {
  if (statusCode === 404 || statusCode === 410) return 'gone';
  if (statusCode !== null && statusCode >= 400 && statusCode < 500 && statusCode !== 429) return 'permanent';
  return 'transient';
}

/**
 * One browser notification for one person. The payload is end-to-end encrypted to the person's browser (RFC 8291),
 * so it may carry what Feishu shows: titles, names, handles and the group, never a body. `notice` is the item's
 * key in the person's "already shown" record: once a push reached them it is recorded, so the end-of-turn notice
 * and later channels do not announce it again (ADR 0009).
 */
export interface PushTarget {
  userId: string;
  payload: Record<string, unknown>;
  notice?: { list: NoticeList; key: string };
  /** Distinguishes several items for one person in one event (join requests); part of the progress key. */
  progressSuffix?: string;
}

/** Drop notices for everyone in the audience, one deterministic H per person so a click opens the right mailbox. */
export async function sendDropWebPush(
  db: DrizzleDb,
  config: WebPushConfig | null,
  dropId: string,
  eventId: string,
  signal: AbortSignal,
  send: SendNotification = webPush.sendNotification.bind(webPush),
  resolvedAudience?: DropNotificationAudience | null,
  progress?: DeliveryProgress,
): Promise<void> {
  if (!config) return;
  const audience =
    resolvedAudience === undefined ? await resolveDropNotificationAudience(db, dropId) : resolvedAudience;
  if (!audience || audience.recipients.length === 0) return;
  await sendWebPush(
    db,
    config,
    audience.recipients.map((recipient) => ({
      userId: recipient.userId,
      notice: { list: 'drops', key: noticeKey('drop', dropId) },
      payload: {
        kind: 'drop',
        drop_id: dropId,
        h_id: recipient.hId,
        from_handle: audience.sender.handle,
        from_display_name: audience.sender.displayName,
        // null: a direct message. Otherwise the group it reached this person through, so the notice can say so.
        group_name: recipient.group?.name ?? null,
        group_slug: recipient.group?.slug ?? null,
        mentioned: recipient.mentioned,
        // set only when this person may read the drop it answers: the notice then says it is a reply
        reply_to_title: recipient.replyTo?.title ?? null,
        reply_to_mine: recipient.replyTo?.mine ?? false,
        // what the reply says about the answered drop's work (ADR 0038); only with reply_to_title
        reply_progress: recipient.replyTo ? audience.progress : null,
        title: audience.title,
        url: `/app/inbox/${encodeURIComponent(dropId)}?h=${encodeURIComponent(recipient.hId)}`,
      },
    })),
    eventId,
    signal,
    send,
    progress,
  );
}

export async function sendWebPush(
  db: DrizzleDb,
  config: WebPushConfig | null,
  targets: PushTarget[],
  eventId: string,
  signal: AbortSignal,
  send: SendNotification = webPush.sendNotification.bind(webPush),
  progress?: DeliveryProgress,
): Promise<void> {
  if (!config || targets.length === 0) return;
  const byUser = new Map<string, PushTarget[]>();
  for (const target of targets) byUser.set(target.userId, [...(byUser.get(target.userId) ?? []), target]);
  // Keep the first pass secret-free. Account closure or explicit revocation can happen after audience resolution,
  // so every candidate is reloaded together with current account state immediately before the network boundary.
  const candidates = await db
    .select({ id: pushSubscriptions.id, userId: pushSubscriptions.userId })
    .from(pushSubscriptions)
    .where(and(inArray(pushSubscriptions.userId, [...byUser.keys()]), isNull(pushSubscriptions.revokedAt)));
  let transientFailure = false;
  for (const candidate of candidates) {
    for (const target of byUser.get(candidate.userId) ?? []) {
      if (signal.aborted) throw new Error('LEASE_LOST');
      const progressKey = `push:${candidate.id}${target.progressSuffix ?? ''}`;
      if (progress?.done(progressKey)) continue;
      const [subscription] = await db
        .select({
          id: pushSubscriptions.id,
          userId: pushSubscriptions.userId,
          endpoint: pushSubscriptions.endpoint,
          p256dh: pushSubscriptions.p256dh,
          auth: pushSubscriptions.auth,
        })
        .from(pushSubscriptions)
        .innerJoin(appUsers, eq(appUsers.id, pushSubscriptions.userId))
        .where(
          and(
            eq(pushSubscriptions.id, candidate.id),
            eq(pushSubscriptions.userId, candidate.userId),
            isNull(pushSubscriptions.revokedAt),
            isNull(appUsers.suspendedAt),
            isNull(appUsers.deletedAt),
          ),
        )
        .limit(1);
      if (!subscription) break;
      const payload = JSON.stringify({ event_id: eventId, ...target.payload });
      let sent = false;
      try {
        await withDeadline(
          send(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            payload,
            { TTL: 3600, urgency: 'normal', timeout: PUSH_TIMEOUT_MS },
          ),
          PUSH_TIMEOUT_MS + 5_000,
          signal,
        );
        sent = true;
      } catch (error) {
        if (signal.aborted) throw new Error('LEASE_LOST');
        const statusCode =
          typeof error === 'object' && error !== null && 'statusCode' in error
            ? Number((error as { statusCode?: unknown }).statusCode)
            : null;
        const kind = classifyPushFailure(statusCode);
        if (kind === 'gone') {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
          await progress?.markDone(progressKey);
          break;
        }
        const [counted] = await db
          .update(pushSubscriptions)
          .set({
            failureCount: sql`least(${pushSubscriptions.failureCount} + 1, 1000)`,
            revokedAt: sql`case when ${pushSubscriptions.failureCount} + 1 >= ${PUSH_REVOKE_AFTER_FAILURES} then now() else ${pushSubscriptions.revokedAt} end`,
            updatedAt: new Date(),
          })
          .where(eq(pushSubscriptions.id, subscription.id))
          .returning({ revokedAt: pushSubscriptions.revokedAt });
        if (kind === 'transient' && !counted?.revokedAt) transientFailure = true;
        else await progress?.markDone(progressKey);
      }
      if (sent) {
        await db
          .update(pushSubscriptions)
          .set({ lastSuccessAt: new Date(), failureCount: 0, updatedAt: new Date() })
          .where(eq(pushSubscriptions.id, subscription.id));
        if (target.notice)
          await recordAnnounced(db, progress, target.userId, target.notice.list, target.notice.key);
        await progress?.markDone(progressKey);
      }
    }
  }
  if (transientFailure) throw new PushDeliveryError();
}
