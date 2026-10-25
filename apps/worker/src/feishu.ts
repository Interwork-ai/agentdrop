import { type Database, withTx } from '@agentdrop/db';
import {
  claimNoticeItem,
  type FeishuAppConfig,
  type FeishuItem,
  feishuAppPermanentFailure,
  feishuMessage,
  feishuNoticeCard,
  feishuPermanentFailure,
  getFeishuAccount,
  getFeishuWebhook,
  personDropState,
  postFeishu,
  rememberFeishuCard,
  sendFeishuCard,
} from '@agentdrop/domain';
import { announcedInEvent, type NoticeList, releaseUnlessAnnounced } from './notice.js';
import type { NotifyContext } from './webhook.js';

/**
 * Server-side Feishu notices (docs/FEISHU.md): when an event reaches a person who connected a Feishu group bot, the
 * worker posts it there. Before sending, the item is claimed in the account's "already shown" record, so it is
 * announced once across Feishu and the agents' end-of-turn notices; a send that fails gives the claim back.
 * Browser push of the same event records the same item (apps/worker/src/notice.ts); that does not stop this
 * event's Feishu message, only later ones. Each person is recorded in the event's progress, so a retry never sends
 * to them twice.
 *
 * A person who linked their Feishu account to the server's own app (ADR 0039) gets the notice as a card in the
 * app's direct chat instead, with buttons for a drop; the group bot is then not used for them, so each item is
 * posted once.
 */
export interface FeishuTarget {
  userId: string;
  list: NoticeList;
  key: string;
  item: FeishuItem;
  /** For a drop: which one and the agent its link opens, so the app's card can act on it and be updated. */
  drop?: { dropId: string; hId: string };
}

/** What is logged per send: the account, the outcome and Feishu's code. Never the address or the secret. */
export interface FeishuLog {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
}

export async function sendFeishuNotices(
  db: Database,
  targets: FeishuTarget[],
  context: NotifyContext,
  fetchImpl: typeof fetch = fetch,
  log?: FeishuLog,
  app: FeishuAppConfig | null = null,
): Promise<void> {
  const failures: string[] = [];
  for (const target of targets) {
    if (context.signal.aborted) throw new Error('LEASE_LOST');
    const progressKey = `feishu:${target.userId}:${target.key}`;
    if (context.progress?.done(progressKey)) continue;
    const account = app ? await getFeishuAccount(db.drizzle, target.userId, app.appId) : null;
    const hook = account ? null : await getFeishuWebhook(db.drizzle, target.userId);
    if (!account && !hook) continue;
    // Claimed by this event's browser push counts as this event's own claim, not as "already announced".
    const claimed =
      (await withTx(db, (tx) => claimNoticeItem(tx, target.userId, target.list, target.key))) ||
      announcedInEvent(context.progress, target.userId, target.key);
    const fields = { userId: target.userId, kind: target.item.kind, eventId: context.eventId };
    const release = () =>
      releaseUnlessAnnounced(db.drizzle, context.progress, target.userId, target.list, target.key);
    if (!claimed) {
      log?.info({ ...fields, outcome: 'already_announced' }, 'feishu notice skipped');
      await context.progress?.markDone(progressKey);
      continue;
    }
    try {
      let result: { ok: boolean; code: number; message: string };
      let permanent: boolean;
      if (account && app) {
        const language = account.language === 'zh' ? 'zh' : 'en';
        const state = target.drop
          ? await personDropState(db.drizzle, target.userId, target.drop.dropId)
          : null;
        const drop = target.drop && state ? { dropId: target.drop.dropId, ...state } : undefined;
        const sent = await sendFeishuCard(
          app,
          account.openId,
          feishuNoticeCard(target.item, language, drop),
          fetchImpl,
        );
        if (sent.ok && target.drop && drop && sent.messageId) {
          await withTx(db, (tx) =>
            rememberFeishuCard(tx, {
              userId: target.userId,
              dropId: drop.dropId,
              hId: target.drop?.hId ?? '',
              messageId: sent.messageId ?? '',
              state: { read: drop.read, starred: drop.starred },
            }),
          );
        }
        result = sent;
        permanent = feishuAppPermanentFailure(sent.code);
      } else if (hook) {
        result = await postFeishu(hook, feishuMessage(target.item, hook.language), fetchImpl);
        permanent = feishuPermanentFailure(result.code);
      } else continue;
      const feishu = {
        feishuCode: result.code,
        feishuMessage: result.message,
        channel: account ? 'app' : 'bot',
      };
      if (result.ok || permanent) {
        // A wrong secret or a removed bot will not fix itself; settle instead of retrying for hours.
        if (result.ok) log?.info({ ...fields, outcome: 'sent' }, 'feishu notice sent');
        else {
          log?.warn({ ...fields, ...feishu, outcome: 'gave_up' }, 'feishu refused the notice; not retrying');
          await release();
        }
        await context.progress?.markDone(progressKey);
        continue;
      }
      log?.warn({ ...fields, ...feishu, outcome: 'retry' }, 'feishu notice failed; will retry');
      await release();
      failures.push(`${target.userId}: feishu ${result.code}`);
    } catch (error) {
      await release();
      if (context.signal.aborted) throw new Error('LEASE_LOST');
      const reason = error instanceof Error ? error.message : String(error);
      log?.warn({ ...fields, error: reason, outcome: 'retry' }, 'feishu unreachable; will retry');
      failures.push(`${target.userId}: ${reason}`);
    }
  }
  if (failures.length) throw new Error(`feishu delivery failed: ${failures.join('; ')}`);
}
