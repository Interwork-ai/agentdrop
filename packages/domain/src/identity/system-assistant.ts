import { AgentDropError, LIMITS, type SendEnvelopeInput } from '@agentdrop/contracts';
import {
  appUsers,
  attachments,
  authUsers,
  contacts,
  deliveries,
  devices,
  dropAttachments,
  drops,
  harnessEndpoints,
  recipientRoutes,
  sendRequests,
  type Tx,
} from '@agentdrop/db';
import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { canSendTo } from '../contacts/contacts.js';
import { ensureAutoRoute } from '../contacts/routes.js';
import { openAttachmentMeta, openDrop } from '../content/codec.js';
import { EVENTS_CHANNEL } from '../mailbox/revision.js';
import { SYSTEM_DROP_TTL_MS, sendDrop } from '../mailbox/send.js';
import { bumpDirectoryRevision } from './users.js';

/**
 * The built-in test contact @agentdrop ("AgentDrop Assistant"). Every account starts with it as an accepted contact
 * so a first send works before any real person has been added; it answers each direct drop with one receipt.
 *
 * It is an ordinary app user with `is_system = true`: a placeholder auth user without any credential account (it
 * can never sign in), one device, one H and a default receiving route. No H credential is ever issued for it.
 */
export const SYSTEM_ASSISTANT_HANDLE = 'agentdrop';
export type AssistantLanguage = 'en' | 'zh';
/**
 * Its name in each language a person can choose. The stored display name is the English one (the product's default
 * language), the same for every viewer; a surface that knows its viewer's language may show the other one by the
 * handle (`systemAssistantName`).
 */
export const SYSTEM_ASSISTANT_NAMES: Record<AssistantLanguage, string> = {
  en: 'AgentDrop Assistant',
  zh: 'AgentDrop 助手',
};
export const SYSTEM_ASSISTANT_NAME = SYSTEM_ASSISTANT_NAMES.en;
/** The name it was created with before it had an English one; renamed once by ensureSystemAssistant. */
const LEGACY_ASSISTANT_NAME = SYSTEM_ASSISTANT_NAMES.zh;

export function systemAssistantName(language: AssistantLanguage): string {
  return SYSTEM_ASSISTANT_NAMES[language];
}
const SYSTEM_AUTH_USER_ID = 'agentdrop-system-assistant';
const SYSTEM_AUTH_EMAIL = 'assistant@agentdrop.invalid';
const SYSTEM_INSTALLATION_ID = '00000000-0000-4000-8000-00000000a61d';
/** Arbitrary constant key for pg_advisory_xact_lock: two API processes booting together create it once. */
const CREATE_LOCK_KEY = 0x61676400;

export interface SystemAssistant {
  userId: string;
  hId: string;
}

/** The assistant's user and receiving H, or null if it was never created on this server. */
export async function getSystemAssistant(tx: Tx): Promise<SystemAssistant | null> {
  const [row] = await tx
    .select({ userId: appUsers.id, hId: recipientRoutes.destinationHId })
    .from(appUsers)
    .innerJoin(
      recipientRoutes,
      and(
        eq(recipientRoutes.userId, appUsers.id),
        eq(recipientRoutes.isDefault, true),
        isNull(recipientRoutes.revokedAt),
      ),
    )
    .where(and(eq(appUsers.isSystem, true), eq(appUsers.handle, SYSTEM_ASSISTANT_HANDLE)))
    .limit(1);
  return row ?? null;
}

export async function isSystemUser(tx: Tx, userId: string): Promise<boolean> {
  const row = await tx.query.appUsers.findFirst({
    where: eq(appUsers.id, userId),
    columns: { isSystem: true },
  });
  return row?.isSystem ?? false;
}

/**
 * Idempotent. Creates whatever part of the assistant is missing; on first creation every existing account gets it
 * as an accepted contact (later accounts get it from ensureAppUser). Never re-adds it for someone who removed it.
 * Returns null only if a non-system account already owns the handle (a legacy server), in which case the
 * feature stays off rather than hijacking that person.
 */
export async function ensureSystemAssistant(tx: Tx): Promise<SystemAssistant | null> {
  const ready = await getSystemAssistant(tx);
  if (ready) {
    await renameLegacyAssistant(tx, ready);
    // Assistants created before it had one: without an address, directory_lookup reports "no receiving agent yet".
    // Also carries a renamed agent label over to that address.
    await ensureAutoRoute(tx, ready.userId, ready.hId);
    return ready;
  }
  await tx.execute(sql`select pg_advisory_xact_lock(${CREATE_LOCK_KEY})`);
  const again = await getSystemAssistant(tx);
  if (again) return again;

  let user = await tx.query.appUsers.findFirst({ where: eq(appUsers.handle, SYSTEM_ASSISTANT_HANDLE) });
  if (user && !user.isSystem) return null;
  let created = false;
  if (!user) {
    // no credential account row: Better Auth has no password to check, so this user can never sign in
    await tx
      .insert(authUsers)
      .values({ id: SYSTEM_AUTH_USER_ID, name: SYSTEM_ASSISTANT_NAME, email: SYSTEM_AUTH_EMAIL })
      .onConflictDoNothing();
    const [row] = await tx
      .insert(appUsers)
      .values({
        authUserId: SYSTEM_AUTH_USER_ID,
        handle: SYSTEM_ASSISTANT_HANDLE,
        displayName: SYSTEM_ASSISTANT_NAME,
        isSystem: true,
      })
      .returning();
    if (!row) throw new AgentDropError('INTERNAL', 'failed to create the assistant');
    user = row;
    created = true;
  }
  const userId = user.id;

  let device = await tx.query.devices.findFirst({
    where: and(eq(devices.userId, userId), eq(devices.installationId, SYSTEM_INSTALLATION_ID)),
  });
  if (!device) {
    [device] = await tx
      .insert(devices)
      .values({ userId, installationId: SYSTEM_INSTALLATION_ID, label: 'AgentDrop', platform: 'server' })
      .returning();
  }
  if (!device) throw new AgentDropError('INTERNAL', 'failed to create the assistant device');

  let h = await tx.query.harnessEndpoints.findFirst({
    where: and(eq(harnessEndpoints.userId, userId), eq(harnessEndpoints.deviceId, device.id)),
  });
  if (!h) {
    [h] = await tx
      .insert(harnessEndpoints)
      .values({ userId, deviceId: device.id, harnessKey: 'other', label: SYSTEM_ASSISTANT_NAME })
      .returning();
  }
  if (!h) throw new AgentDropError('INTERNAL', 'failed to create the assistant endpoint');
  if (h.revokedAt)
    await tx.update(harnessEndpoints).set({ revokedAt: null }).where(eq(harnessEndpoints.id, h.id));

  await tx.insert(recipientRoutes).values({
    userId,
    alias: null,
    label: 'default',
    destinationHId: h.id,
    isDefault: true,
    visibility: 'contacts',
  });

  // The published address (@agentdrop/agent) is what directory_lookup shows as the agent a send lands on.
  await ensureAutoRoute(tx, userId, h.id);
  if (created) await backfillAssistantContacts(tx, userId);
  await recordAudit(tx, { action: 'system.assistant.ensure', targetId: userId, result: 'ok' });
  return { userId, hId: h.id };
}

/**
 * An assistant created while its only name was Chinese gets the English one (the product's default language), once:
 * the profile and every account's directory revision move, so cached contact lists pick up the new name. Nothing
 * happens when the name is already something else.
 */
async function renameLegacyAssistant(tx: Tx, assistant: SystemAssistant): Promise<void> {
  const renamed = await tx
    .update(appUsers)
    .set({
      displayName: SYSTEM_ASSISTANT_NAME,
      profileVersion: sql`${appUsers.profileVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(appUsers.id, assistant.userId), eq(appUsers.displayName, LEGACY_ASSISTANT_NAME)))
    .returning({ id: appUsers.id });
  if (renamed.length === 0) return;
  await bumpDirectoryRevision(tx, [assistant.userId]);
  await tx
    .update(harnessEndpoints)
    .set({ label: SYSTEM_ASSISTANT_NAME })
    .where(and(eq(harnessEndpoints.id, assistant.hId), eq(harnessEndpoints.label, LEGACY_ASSISTANT_NAME)));
  await tx
    .update(authUsers)
    .set({ name: SYSTEM_ASSISTANT_NAME })
    .where(eq(authUsers.id, SYSTEM_AUTH_USER_ID));
  await bumpDirectoryRevisionWhere(
    tx,
    sql`id in (select owner_user_id from ${contacts} where peer_user_id = ${assistant.userId}::uuid)`,
  );
}

/**
 * The bulk form of bumpDirectoryRevision for every account at once: one update, and one notification per moved row
 * from its own `returning` set, so the event streams of everyone affected wake (ADR 0040).
 */
async function bumpDirectoryRevisionWhere(tx: Tx, where: SQL): Promise<void> {
  await tx.execute(sql`
    with moved as (
      update ${appUsers} set directory_revision = directory_revision + 1 where ${where} returning id)
    select pg_notify(${EVENTS_CHANNEL}, moved.id::text) from moved`);
}

/** Adds the assistant as an accepted contact (both directions) of every open account. Skips existing rows. */
export async function backfillAssistantContacts(tx: Tx, assistantUserId: string): Promise<number> {
  const inserted = await tx.execute<{ owner_user_id: string }>(sql`
    insert into ${contacts} (owner_user_id, peer_user_id, status)
    select u.id, ${assistantUserId}::uuid, 'accepted'::contact_status from ${appUsers} u
      where u.id <> ${assistantUserId} and not u.is_system and u.deleted_at is null
    union all
    select ${assistantUserId}::uuid, u.id, 'accepted'::contact_status from ${appUsers} u
      where u.id <> ${assistantUserId} and not u.is_system and u.deleted_at is null
    on conflict (owner_user_id, peer_user_id) do nothing
    returning owner_user_id`);
  const owners = [...new Set(inserted.rows.map((r) => r.owner_user_id))];
  if (owners.length > 0) await bumpDirectoryRevisionWhere(tx, inArray(appUsers.id, owners));
  return inserted.rows.length;
}

/** Makes the assistant an accepted contact of one user (new account, or someone re-adding it). */
export async function addAssistantContact(tx: Tx, userId: string, assistantUserId: string): Promise<void> {
  if (userId === assistantUserId) return;
  for (const [ownerUserId, peerUserId] of [
    [userId, assistantUserId],
    [assistantUserId, userId],
  ] as const) {
    await tx
      .insert(contacts)
      .values({ ownerUserId, peerUserId, status: 'accepted' })
      .onConflictDoUpdate({
        target: [contacts.ownerUserId, contacts.peerUserId],
        set: { status: 'accepted', updatedAt: new Date(), version: sql`${contacts.version} + 1` },
      });
  }
}

export type AssistantReplyOutcome =
  | { replied: true; dropId: string }
  | {
      replied: false;
      reason:
        | 'no_assistant'
        | 'not_found'
        | 'own_drop'
        | 'not_addressed'
        | 'already_replied'
        | 'not_allowed'
        | 'undeliverable';
    };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatUtc(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/**
 * The language of a receipt, which is read by the person who sent the test message (through their agent).
 *
 * The server stores no general language preference for a person: the dashboard keeps its choice in the browser and
 * the CLI in its own config directory, neither of which is reported. So, in order:
 *   1. a language the person chose on the server: today only their Feishu notice language;
 *   2. the language they wrote the message in: a title with Chinese characters gets a Chinese receipt;
 *   3. English, the product's default.
 */
export function receiptLanguage(input: {
  chosen: AssistantLanguage | null;
  title: string;
}): AssistantLanguage {
  if (input.chosen) return input.chosen;
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(input.title) ? 'zh' : 'en';
}

export interface ReceiptInput {
  language: AssistantLanguage;
  originalTitle: string;
  bodyChars: number;
  files: Array<{ name: string; size: number }>;
  receivedAt: Date;
}

/** The receipt's title and body in one language; derived only from the drop, so a replay composes the same text. */
export function assistantReceipt(input: ReceiptInput): { title: string; body: string } {
  const { originalTitle, files } = input;
  const time = formatUtc(input.receivedAt);
  const lines =
    input.language === 'zh'
      ? [
          `${SYSTEM_ASSISTANT_NAMES.zh}已收到你的消息。这是一条自动回执，说明发送链路是通的。`,
          '',
          `- 标题：${originalTitle}`,
          `- 正文：${input.bodyChars} 个字符`,
          files.length === 0 ? '- 附件：无' : `- 附件：${files.length} 个`,
          ...files.map((f) => `  - ${f.name}（${formatBytes(f.size)}）`),
          `- 收到时间：${time}`,
          '',
          '下一步：去网页联系人页生成邀请链接，把真人同事加进来。对方打开链接注册或登录后，你们直接成为联系人，就能互发了。',
          '',
          '说明：助手只回执，不回传附件；发给助手的消息和这条回执 30 天后自动过期。',
        ]
      : [
          `${SYSTEM_ASSISTANT_NAMES.en} received your message. This is an automatic receipt: sending works.`,
          '',
          `- Title: ${originalTitle}`,
          `- Body: ${input.bodyChars} character${input.bodyChars === 1 ? '' : 's'}`,
          files.length === 0 ? '- Attachments: none' : `- Attachments: ${files.length}`,
          ...files.map((f) => `  - ${f.name} (${formatBytes(f.size)})`),
          `- Received: ${time}`,
          '',
          'Next: add a real colleague. On the Contacts page of the dashboard, create an invite link and send it to them; once they open it and sign up or sign in, you are contacts and can send to each other.',
          '',
          'Note: the assistant only sends receipts and never sends attachments back; messages to the assistant and this receipt expire after 30 days.',
        ];
  const prefix = input.language === 'zh' ? '回执：' : 'Receipt: ';
  return { title: `${prefix}${originalTitle}`.slice(0, LIMITS.TITLE_MAX_CHARS), body: lines.join('\n') };
}

/**
 * Answers one drop addressed directly to the assistant with a receipt to the agent that sent it. Replays are
 * harmless: the reply's request_id is `echo:<drop id>` and its content is derived only from the drop, so a second
 * run finds the first reply. Never answers its own drops (no loops) and never copies attachments back.
 */
export async function replyAsAssistant(tx: Tx, dropId: string): Promise<AssistantReplyOutcome> {
  const assistant = await getSystemAssistant(tx);
  if (!assistant) return { replied: false, reason: 'no_assistant' };
  const drop = await tx.query.drops.findFirst({ where: eq(drops.id, dropId) });
  if (!drop || drop.revokedAt) return { replied: false, reason: 'not_found' };
  if (drop.authorUserId === assistant.userId) return { replied: false, reason: 'own_drop' };
  const snapshot = drop.targetSnapshot as { user_ids?: string[] };
  if (!snapshot.user_ids?.includes(assistant.userId)) return { replied: false, reason: 'not_addressed' };
  const delivered = await tx.query.deliveries.findFirst({
    where: and(eq(deliveries.dropId, drop.id), eq(deliveries.hId, assistant.hId)),
  });
  if (!delivered) return { replied: false, reason: 'not_addressed' };

  const requestId = `echo:${drop.id}`;
  const previous = await tx.query.sendRequests.findFirst({
    where: and(eq(sendRequests.originHId, assistant.hId), eq(sendRequests.requestId, requestId)),
  });
  if (previous) return { replied: false, reason: 'already_replied' };
  const allowed = await canSendTo(tx, assistant.userId, drop.authorUserId);
  if (!allowed.allowed) return { replied: false, reason: 'not_allowed' };

  const files = (
    await tx
      .select({ a: attachments })
      .from(dropAttachments)
      .innerJoin(attachments, eq(attachments.id, dropAttachments.attachmentId))
      .where(eq(dropAttachments.dropId, drop.id))
      .orderBy(asc(dropAttachments.ordinal))
  ).map(({ a }) => ({ name: openAttachmentMeta(a).safeName, size: a.byteSize }));
  const { title: originalTitle } = openDrop(drop);

  // back to the agent that sent it (its automatic address), else the author's default receiver
  const originRoute = await tx.query.recipientRoutes.findFirst({
    where: and(
      eq(recipientRoutes.destinationHId, drop.originHId),
      eq(recipientRoutes.auto, true),
      eq(recipientRoutes.visibility, 'contacts'),
      isNull(recipientRoutes.revokedAt),
    ),
  });
  const target = originRoute
    ? { type: 'route' as const, route_id: originRoute.id }
    : { type: 'user' as const, user_id: drop.authorUserId };

  const author = await tx.query.appUsers.findFirst({
    where: eq(appUsers.id, drop.authorUserId),
    columns: { feishuWebhook: true },
  });
  const language = receiptLanguage({
    chosen: author?.feishuWebhook?.language ?? null,
    title: originalTitle,
  });
  const { title, body } = assistantReceipt({
    language,
    originalTitle,
    bodyChars: drop.bodyChars,
    files,
    receivedAt: drop.createdAt,
  });
  const envelope: SendEnvelopeInput = {
    request_id: requestId,
    targets: [target],
    payload: {
      payload_version: 1,
      kind: 'text',
      title,
      body,
      attachment_ids: [],
      extensions: {},
      expires_at: new Date(drop.createdAt.getTime() + SYSTEM_DROP_TTL_MS).toISOString(),
    },
  };
  try {
    // savepoint: a refused route (author revoked the agent, blocked the assistant meanwhile…) leaves nothing behind
    const res = await tx.transaction((sp) =>
      sendDrop(sp, { userId: assistant.userId, hId: assistant.hId, via: 'user_session' }, envelope, {
        originKind: 'web',
        maxGroupRecipients: 1,
        assistantReplyToDropId: drop.id,
      }),
    );
    if (res.outcome !== 'delivered' || !res.dropId) return { replied: false, reason: 'undeliverable' };
    // It did read the message to write the receipt, so the sender's first drop already shows "已读".
    await tx
      .update(deliveries)
      .set({ openedAt: new Date() })
      .where(and(eq(deliveries.id, delivered.id), isNull(deliveries.openedAt)));
    return { replied: true, dropId: res.dropId };
  } catch (err) {
    if (err instanceof AgentDropError && err.code !== 'INTERNAL') {
      await recordAudit(tx, {
        actorUserId: assistant.userId,
        hId: assistant.hId,
        action: 'system.assistant.reply',
        targetId: drop.id,
        result: 'denied',
        meta: { code: err.code },
      });
      return { replied: false, reason: 'undeliverable' };
    }
    throw err;
  }
}
