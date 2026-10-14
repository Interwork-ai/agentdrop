import { AgentDropError } from '@agentdrop/contracts';
import { appUsers, type Tx } from '@agentdrop/db';
import { eq } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import {
  type FeishuWebhook,
  feishuMessage,
  feishuUrlHint,
  type NoticeLanguage,
  postFeishu,
  validateFeishuWebhookUrl,
} from './feishu.js';

export interface FeishuView {
  connected: boolean;
  /** Last characters of the address; the address itself is never returned. */
  url_hint: string | null;
  has_secret: boolean;
  language: NoticeLanguage | null;
}

export function feishuView(hook: FeishuWebhook | null | undefined): FeishuView {
  return hook
    ? {
        connected: true,
        url_hint: feishuUrlHint(hook.url),
        has_secret: !!hook.secret,
        language: hook.language,
      }
    : { connected: false, url_hint: null, has_secret: false, language: null };
}

export async function getFeishuWebhook(tx: Tx, userId: string): Promise<FeishuWebhook | null> {
  const user = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, userId) });
  return user && !user.suspendedAt && !user.deletedAt ? user.feishuWebhook : null;
}

/**
 * Connects the person's Feishu group bot. A test message is sent first and the setting is saved only when Feishu
 * accepts it, so a wrong address, secret or keyword is reported right away instead of silently losing notices.
 */
export async function connectFeishuWebhook(
  tx: Tx,
  userId: string,
  input: { url: string; secret?: string | null | undefined; language?: NoticeLanguage | undefined },
  options: { link: string | null; fetchImpl?: typeof fetch; via: 'dashboard' | 'agent' },
): Promise<FeishuView> {
  const hook: FeishuWebhook = {
    url: validateFeishuWebhookUrl(input.url),
    secret: input.secret?.trim() || null,
    language: input.language ?? 'en',
  };
  let result: Awaited<ReturnType<typeof postFeishu>>;
  try {
    result = await postFeishu(
      hook,
      feishuMessage({ kind: 'test', link: options.link }, hook.language),
      options.fetchImpl,
    );
  } catch {
    throw new AgentDropError('UPSTREAM_UNAVAILABLE', 'could not reach Feishu to send the test message');
  }
  if (!result.ok)
    throw new AgentDropError('VALIDATION_FAILED', 'Feishu refused the test message', {
      field: 'url',
      feishu_code: result.code,
      feishu_message: result.message,
    });
  await tx
    .update(appUsers)
    .set({ feishuWebhook: hook, updatedAt: new Date() })
    .where(eq(appUsers.id, userId));
  await recordAudit(tx, {
    actorUserId: userId,
    action: 'notify.feishu.connect',
    result: 'ok',
    meta: { via: options.via, signed: !!hook.secret },
  });
  return feishuView(hook);
}

export async function disconnectFeishuWebhook(
  tx: Tx,
  userId: string,
  via: 'dashboard' | 'agent',
): Promise<FeishuView> {
  await tx
    .update(appUsers)
    .set({ feishuWebhook: null, updatedAt: new Date() })
    .where(eq(appUsers.id, userId));
  await recordAudit(tx, {
    actorUserId: userId,
    action: 'notify.feishu.disconnect',
    result: 'ok',
    meta: { via },
  });
  return feishuView(null);
}
