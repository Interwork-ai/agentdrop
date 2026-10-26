import { type Database, loggableErrorText, withTx } from '@agentdrop/db';
import {
  applyFeishuCardPress,
  type FeishuAppConfig,
  feishuNoticeCard,
  feishuTextCard,
  handleFeishuMessage,
  type NoticeLanguage,
  parseFeishuCardAction,
  sendFeishuCard,
} from '@agentdrop/domain';
import * as Lark from '@larksuiteoapi/node-sdk';
import { dropNoticeItem } from './feishu-items.js';
import { resolveDropNotificationAudience } from './push.js';

/*
 * The worker's WebSocket to the server's own Feishu app (ADR 0039): Feishu pushes the person's direct messages to
 * the bot (`im.message.receive_v1`, used only to link or unlink an account) and card button presses
 * (`card.action.trigger`, answered within Feishu's 3 seconds with the redrawn card). The connection goes out from
 * the worker, so a server without a public HTTPS address works. With several workers, Feishu hands each event to
 * one of them.
 *
 * What a person types to the bot is matched against a code or the unlink words and then dropped: it is never
 * stored, never turned into a drop and never shown to a model.
 */

export interface FeishuEventDeps {
  db: Database;
  app: FeishuAppConfig;
  /** Dashboard origin for links (WEB_ORIGIN, else PUBLIC_BASE_URL); null means no link. */
  dashboard: string | null;
  fetch: typeof fetch;
  log: {
    info(fields: Record<string, unknown>, msg: string): void;
    warn(fields: Record<string, unknown>, msg: string): void;
  };
}

/** Feishu may deliver one event twice; a message or press already handled by this process is not handled again. */
const seen = new Set<string>();
function firstTime(id: string | undefined): boolean {
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 2000) seen.delete(seen.values().next().value as string);
  return true;
}

/** Someone the app has not linked yet: the language of the platform's own users. */
const guessLanguage = (app: FeishuAppConfig): NoticeLanguage => (app.domain === 'lark' ? 'en' : 'zh');

const REPLIES = {
  linked: {
    en: 'Connected: AgentDrop notices arrive here as cards from now on, each once. You can mark them read or star them right here.',
    zh: '已连接：以后 AgentDrop 的提醒会以卡片发到这里，每条一次。可以直接在这里标为已读或收藏。',
  },
  unlinked: {
    en: 'Disconnected: AgentDrop notices no longer arrive here.',
    zh: '已解绑：AgentDrop 的提醒不会再发到这里。',
  },
  bad_code: {
    en: 'That code is wrong or has expired. Get a new one in AgentDrop: Settings → Feishu.',
    zh: '这个代码不对或已过期。请在 AgentDrop 网页「设置 → 飞书」里重新获取。',
  },
  too_many: {
    en: 'Too many wrong codes. Try again in an hour.',
    zh: '错误次数太多，请一小时后再试。',
  },
  linkedOther: {
    en: 'This chat only carries AgentDrop notices. To answer a message, use your agent or AgentDrop.',
    zh: '这里只用来接收 AgentDrop 的提醒。要回复消息，请在 Agent 或 AgentDrop 网页里操作。',
  },
  unlinkedOther: {
    en: 'To get AgentDrop notices here, send the code from AgentDrop: Settings → Feishu.',
    zh: '要在这里接收 AgentDrop 的提醒，请把 AgentDrop 网页「设置 → 飞书」里的代码发到这里。',
  },
} as const;

interface MessageEvent {
  sender?: { sender_id?: { open_id?: string; union_id?: string }; sender_type?: string; tenant_key?: string };
  message?: { message_id?: string; chat_type?: string; message_type?: string; content?: string };
}

/** A direct message to the bot: a code links, the unlink words unlink, anything else gets a one-line answer. */
export async function onFeishuMessage(deps: FeishuEventDeps, data: MessageEvent): Promise<void> {
  const openId = data.sender?.sender_id?.open_id;
  const message = data.message;
  if (!openId || data.sender?.sender_type !== 'user' || message?.chat_type !== 'p2p') return;
  if (!firstTime(message.message_id)) return;
  let text = '';
  if (message.message_type === 'text') {
    try {
      const parsed = JSON.parse(message.content ?? '{}') as { text?: unknown };
      text = typeof parsed.text === 'string' ? parsed.text.slice(0, 200) : '';
    } catch {
      /* not Feishu's text content: treated as anything else */
    }
  }
  const result = await withTx(deps.db, (tx) =>
    handleFeishuMessage(
      tx,
      deps.app.appId,
      {
        openId,
        unionId: data.sender?.sender_id?.union_id ?? null,
        tenantKey: data.sender?.tenant_key ?? null,
      },
      text,
    ),
  );
  deps.log.info({ outcome: result.outcome }, 'feishu message to the bot');
  // someone not linked (and not linking now) has told us no language yet
  const language = result.language ?? guessLanguage(deps.app);
  const reply =
    result.outcome === 'other'
      ? result.linked
        ? REPLIES.linkedOther
        : REPLIES.unlinkedOther
      : REPLIES[result.outcome];
  const settings = deps.dashboard ? `${deps.dashboard.replace(/\/$/, '')}/app/settings#feishu` : null;
  const link =
    settings && result.outcome !== 'linked' && result.outcome !== 'unlinked'
      ? { label: language === 'zh' ? '打开 AgentDrop 设置' : 'Open AgentDrop settings', url: settings }
      : undefined;
  const sent = await sendFeishuCard(deps.app, openId, feishuTextCard(reply[language], link), deps.fetch);
  if (!sent.ok) deps.log.warn({ feishuCode: sent.code }, 'feishu answer to the bot message failed');
}

interface CardEvent {
  operator?: { open_id?: string };
  action?: { value?: unknown };
  context?: { open_message_id?: string };
  event_id?: string;
}

const TOASTS = {
  read: { en: 'Marked read', zh: '已标为已读' },
  star: { en: 'Starred', zh: '已收藏' },
  unstar: { en: 'Unstarred', zh: '已取消收藏' },
  not_linked: {
    en: 'This card belongs to another AgentDrop account, or Feishu was disconnected.',
    zh: '这张卡片不属于你当前绑定的 AgentDrop 账号，或飞书已解绑。',
  },
  gone: { en: 'This message is no longer in your mailbox.', zh: '这条消息已不在你的收件箱里。' },
} as const;

/**
 * A button pressed on a card. The answer is what Feishu shows: a toast, and for a press that changed something the
 * redrawn card. Only the linked person's own press on their own card changes anything (applyFeishuCardPress).
 */
export async function onFeishuCardPress(
  deps: FeishuEventDeps,
  data: CardEvent,
): Promise<Record<string, unknown>> {
  const openId = data.operator?.open_id;
  const action = parseFeishuCardAction(data.action?.value);
  const fallback = guessLanguage(deps.app);
  if (!openId || !action) return { toast: { type: 'error', content: TOASTS.gone[fallback] } };
  const result = await withTx(deps.db, (tx) => applyFeishuCardPress(tx, deps.app.appId, openId, action));
  deps.log.info({ outcome: result.outcome, action: action.a }, 'feishu card press');
  if (result.outcome !== 'done')
    return { toast: { type: 'info', content: TOASTS[result.outcome][fallback] } };
  const audience = await resolveDropNotificationAudience(deps.db.drizzle, result.dropId);
  const recipient = audience?.recipients.find((r) => r.userId === result.userId);
  const dashboard = deps.dashboard?.replace(/\/$/, '') ?? null;
  const link = dashboard
    ? `${dashboard}/app/inbox/${encodeURIComponent(result.dropId)}?h=${encodeURIComponent(result.hId)}`
    : null;
  const card = feishuNoticeCard(dropNoticeItem(audience, recipient, link), result.language, {
    dropId: result.dropId,
    ...result.state,
  });
  return {
    toast: { type: 'success', content: TOASTS[action.a][result.language] },
    card: { type: 'raw', data: card },
  };
}

/** Starts the WebSocket. Returns a function that closes it. */
export function startFeishuEvents(deps: FeishuEventDeps): () => void {
  const quiet = {
    error: (...args: unknown[]) => deps.log.warn({ detail: String(args[1] ?? args[0] ?? '') }, 'feishu ws'),
    warn: (...args: unknown[]) => deps.log.warn({ detail: String(args[1] ?? args[0] ?? '') }, 'feishu ws'),
    info: () => {},
    debug: () => {},
    trace: () => {},
  };
  const ws = new Lark.WSClient({
    appId: deps.app.appId,
    appSecret: deps.app.appSecret,
    domain: deps.app.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn,
    logger: quiet,
  });
  const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.warn, logger: quiet }).register(
    {
      'im.message.receive_v1': async (data: unknown) => {
        try {
          await onFeishuMessage(deps, data as MessageEvent);
        } catch (err) {
          deps.log.warn({ error: loggableErrorText(err) }, 'feishu message failed');
        }
      },
      'card.action.trigger': async (data: unknown) => {
        const event = data as CardEvent;
        if (!firstTime(event.event_id)) return {};
        try {
          return await onFeishuCardPress(deps, event);
        } catch (err) {
          deps.log.warn({ error: loggableErrorText(err) }, 'feishu card press failed');
          return {};
        }
      },
    } as never,
  );
  void ws.start({ eventDispatcher: dispatcher });
  deps.log.info({ domain: deps.app.domain }, 'feishu app connection started');
  return () => ws.close();
}
