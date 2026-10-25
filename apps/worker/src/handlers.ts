import { appUsers, type Database, groupJoinRequests, withTx } from '@agentdrop/db';
import { backfillStep, noticeKey, requestBackfill } from '@agentdrop/domain';
import type { StorageProvider } from '@agentdrop/storage';
import { and, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { runAssistantEcho } from './assistant.js';
import { sendFeishuNotices } from './feishu.js';
import type { Handler } from './outbox.js';
import {
  type PushTarget,
  resolveDropNotificationAudience,
  type SendNotification,
  sendDropWebPush,
  sendWebPush,
  type WebPushConfig,
} from './push.js';
import { type NotifyContext, notifyUsers as postToUsers, type WebhookOptions } from './webhook.js';

/*
 * Titles in notices (webhook, Web Push, Feishu) come from the drop itself through the notification audience, never
 * from the outbox payload, so events do not have to carry content (docs/plan/CONTENT_ENCRYPTION.md §8).
 */
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export interface HandlerDeps {
  db: Database;
  storage: StorageProvider;
  log: Logger;
  webPushConfig: WebPushConfig | null;
  webhookOptions: WebhookOptions;
  /** Dashboard origin for links in notices (WEB_ORIGIN, else PUBLIC_BASE_URL); null means no link. */
  dashboard: string | null;
  fetch: typeof fetch;
  /** Web Push transport; tests replace it. */
  sendPush?: SendNotification;
}

/**
 * The outbox handlers, built from their dependencies so they can be tested without the worker's process setup.
 * Handlers must be idempotent: an event may be processed more than once after a crash.
 */
export function createHandlers(deps: HandlerDeps): Record<string, Handler> {
  const { db, storage, log, webPushConfig, webhookOptions } = deps;
  const dashboard = deps.dashboard?.replace(/\/$/, '') ?? null;
  const link = (path: string) => (dashboard ? `${dashboard}${path}` : null);
  const notifyUsers = (userIds: string[], event: Record<string, unknown>, context: NotifyContext) =>
    postToUsers(db.drizzle, userIds, event, context, webhookOptions);
  const push = (targets: PushTarget[], context: NotifyContext) =>
    sendWebPush(
      db.drizzle,
      webPushConfig,
      targets,
      context.eventId,
      context.signal,
      deps.sendPush,
      context.progress,
    );
  /** Browser push and Feishu say the same thing to the same person; every success is recorded before failing. */
  const settle = async (work: Promise<unknown>[]) => {
    for (const result of await Promise.allSettled(work))
      if (result.status === 'rejected') throw result.reason;
  };

  /** The still-pending requests among these invitees, with who asked, read from committed state (not the payload). */
  const pendingJoinRequests = async (
    groupId: string,
    handles: string[],
  ): Promise<Array<{ invitee: string; invitedBy: string | null }>> => {
    if (!groupId || handles.length === 0) return [];
    const invitees = await db.drizzle
      .select({ id: appUsers.id, handle: appUsers.handle })
      .from(appUsers)
      .where(inArray(appUsers.handle, handles));
    if (invitees.length === 0) return [];
    const rows = await db.drizzle
      .select({ invitee: groupJoinRequests.inviteeUserId, by: groupJoinRequests.invitedByUserId })
      .from(groupJoinRequests)
      .where(
        and(
          eq(groupJoinRequests.groupId, groupId),
          eq(groupJoinRequests.status, 'pending'),
          inArray(
            groupJoinRequests.inviteeUserId,
            invitees.map((u) => u.id),
          ),
        ),
      );
    const inviters = rows.length
      ? await db.drizzle
          .select({ id: appUsers.id, handle: appUsers.handle })
          .from(appUsers)
          .where(
            inArray(
              appUsers.id,
              rows.map((r) => r.by),
            ),
          )
      : [];
    const handleOf = new Map([...invitees, ...inviters].map((u) => [u.id, u.handle]));
    const pending = new Map(rows.map((r) => [r.invitee, r.by]));
    // Payload order, one per invitee still waiting.
    return invitees
      .filter((u) => pending.has(u.id))
      .sort((a, b) => handles.indexOf(a.handle) - handles.indexOf(b.handle))
      .map((u) => ({ invitee: u.handle, invitedBy: handleOf.get(pending.get(u.id) ?? '') ?? null }));
  };

  return {
    'drop.delivered': async (payload, dropId, context) => {
      log.info({ dropId, endpoints: payload.endpoint_count }, 'drop delivered');
      const audience = await resolveDropNotificationAudience(db.drizzle, dropId);
      const userIds = audience?.recipients.map((r) => r.userId) ?? [];
      // Settle both channels before failing so every success is recorded in the event's progress first.
      const results = await Promise.allSettled([
        notifyUsers(
          userIds,
          {
            type: 'drop.delivered',
            drop_id: dropId,
            from_handle: audience?.sender.handle,
            from_display_name: audience?.sender.displayName,
            title: audience?.title,
          },
          context,
        ),
        sendDropWebPush(
          db.drizzle,
          webPushConfig,
          dropId,
          context.eventId,
          context.signal,
          deps.sendPush,
          audience,
          context.progress,
        ),
        sendFeishuNotices(
          db,
          (audience?.recipients ?? []).map((r) => ({
            userId: r.userId,
            list: 'drops' as const,
            key: noticeKey('drop', dropId),
            item: {
              kind: 'drop' as const,
              fromName: audience?.sender.displayName ?? '',
              group: r.group,
              mentioned: r.mentioned,
              replyTo: r.replyTo ?? null,
              progress: r.replyTo ? (audience?.progress ?? null) : null,
              fromHandle: audience?.sender.handle ?? '',
              title: audience?.title ?? '',
              link: link(`/app/inbox/${encodeURIComponent(dropId)}?h=${encodeURIComponent(r.hId)}`),
            },
          })),
          context,
          deps.fetch,
          log,
        ),
        runAssistantEcho(db, dropId, payload, context.progress).then((outcome) => {
          if (outcome?.replied) log.info({ dropId, replyId: outcome.dropId }, 'assistant receipt sent');
        }),
      ]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    },
    'approval.created': async (payload, approvalId, context) => {
      log.info({ approvalId, userId: payload.user_id }, 'approval pending');
      await notifyUsers(
        typeof payload.user_id === 'string' ? [payload.user_id] : [],
        {
          type: 'approval.created',
          approval_id: approvalId,
        },
        context,
      );
    },
    'contact.requested': async (payload, _aggregateId, context) => {
      const userId = typeof payload.user_id === 'string' ? payload.user_id : null;
      const key = noticeKey('contact', str(payload.from_handle));
      await settle([
        userId
          ? sendFeishuNotices(
              db,
              [
                {
                  userId,
                  list: 'contacts',
                  key,
                  item: {
                    kind: 'contact',
                    fromName: str(payload.from_display_name),
                    fromHandle: str(payload.from_handle),
                    link: link('/app/contacts'),
                  },
                },
              ],
              context,
              deps.fetch,
              log,
            )
          : Promise.resolve(),
        userId
          ? push(
              [
                {
                  userId,
                  notice: { list: 'contacts', key },
                  payload: {
                    kind: 'contact',
                    from_handle: str(payload.from_handle),
                    from_display_name: str(payload.from_display_name),
                    url: '/app/contacts',
                  },
                },
              ],
              context,
            )
          : Promise.resolve(),
        notifyUsers(
          userId ? [userId] : [],
          {
            type: 'contact.requested',
            from_handle: payload.from_handle,
            from_display_name: payload.from_display_name,
          },
          context,
        ),
      ]);
    },
    'contact.accepted': async (payload, _aggregateId, context) => {
      await notifyUsers(
        typeof payload.user_id === 'string' ? [payload.user_id] : [],
        {
          type: 'contact.accepted',
          from_handle: payload.from_handle,
          from_display_name: payload.from_display_name,
        },
        context,
      );
    },
    'group.invited': async (payload, _aggregateId, context) => {
      const userId = typeof payload.user_id === 'string' ? payload.user_id : null;
      const key = noticeKey('invitation', str(payload.group_slug));
      const path = `/app/groups/${encodeURIComponent(str(payload.group_id))}`;
      await settle([
        userId
          ? sendFeishuNotices(
              db,
              [
                {
                  userId,
                  list: 'invitations',
                  key,
                  item: {
                    kind: 'invitation',
                    groupName: str(payload.group_name),
                    groupSlug: str(payload.group_slug),
                    link: link(path),
                  },
                },
              ],
              context,
              deps.fetch,
              log,
            )
          : Promise.resolve(),
        userId
          ? push(
              [
                {
                  userId,
                  notice: { list: 'invitations', key },
                  payload: {
                    kind: 'invitation',
                    group_name: str(payload.group_name),
                    group_slug: str(payload.group_slug),
                    url: path,
                  },
                },
              ],
              context,
            )
          : Promise.resolve(),
        notifyUsers(
          userId ? [userId] : [],
          {
            type: 'group.invited',
            group_id: payload.group_id,
            group_name: payload.group_name,
            group_slug: payload.group_slug,
          },
          context,
        ),
      ]);
    },
    /*
     * One event per admin: a member asked to bring somebody in and only a human may decide it. One notice per
     * invitee, keyed like the agents' notice (`slug\0invitee`), naming who asked; requests decided before the worker
     * got here are not announced.
     */
    'group.join_requested': async (payload, _aggregateId, context) => {
      const userId = typeof payload.user_id === 'string' ? payload.user_id : null;
      const handles = Array.isArray(payload.invitee_handles)
        ? payload.invitee_handles.filter((h): h is string => typeof h === 'string')
        : [];
      const requests = userId ? await pendingJoinRequests(str(payload.group_id), handles) : [];
      const slug = str(payload.group_slug);
      const path = `/app/groups/${encodeURIComponent(str(payload.group_id))}`;
      const items = requests.map((r) => ({ ...r, key: noticeKey('join', `${slug}\u0000${r.invitee}`) }));
      await settle([
        userId && items.length
          ? sendFeishuNotices(
              db,
              items.map((r) => ({
                userId,
                list: 'join_requests' as const,
                key: r.key,
                item: {
                  kind: 'join' as const,
                  groupName: str(payload.group_name),
                  groupSlug: slug,
                  inviteeHandle: r.invitee,
                  invitedByHandle: r.invitedBy,
                  link: link(path),
                },
              })),
              context,
              deps.fetch,
              log,
            )
          : Promise.resolve(),
        userId && items.length
          ? push(
              items.map((r) => ({
                userId,
                notice: { list: 'join_requests' as const, key: r.key },
                progressSuffix: `:${r.key}`,
                payload: {
                  kind: 'join',
                  group_name: str(payload.group_name),
                  group_slug: slug,
                  invitee_handle: r.invitee,
                  invited_by_handle: r.invitedBy,
                  url: path,
                },
              })),
              context,
            )
          : Promise.resolve(),
        notifyUsers(
          userId ? [userId] : [],
          {
            type: 'group.join_requested',
            group_id: payload.group_id,
            group_name: payload.group_name,
            group_slug: payload.group_slug,
            count: payload.count,
          },
          context,
        ),
      ]);
    },
    'attachment.cleanup': async (payload) => {
      const key = typeof payload.storage_key === 'string' ? payload.storage_key : null;
      if (!key) return;
      await storage.delete(key);
      log.info({ key }, 'deleted stale object');
    },
    'grant.revoked': async () => {},
    /* Encrypts pre-switch content one batch at a time (docs/plan/CONTENT_ENCRYPTION.md §13.1). */
    'content.backfill': async (_payload, _aggregateId, context) => {
      const step = await backfillStep(db, storage);
      if (step.rows > 0 || step.done || step.skipped?.length) log.info(step, 'content backfill');
      if (step.skipped?.length)
        log.warn({ attachment_ids: step.skipped }, 'content backfill could not encrypt these attachments');
      if (step.done || step.step === 'off') return;
      // the next batch, unless one is already queued; later while uploads from before the switch are in flight
      await withTx(db, (tx) =>
        requestBackfill(tx, {
          excludeEventId: context.eventId,
          ...(step.waitMs ? { delayMs: step.waitMs } : {}),
        }),
      );
    },
  };
}
