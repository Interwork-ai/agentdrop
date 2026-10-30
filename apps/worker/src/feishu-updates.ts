import { loggableErrorText, withTx } from '@agentdrop/db';
import {
  deliverFeishuUpdate,
  feishuChatLink,
  feishuChatMemberOpenIds,
  feishuChatName,
  feishuUpdateText,
  sendFeishuChatText,
} from '@agentdrop/domain';
import type { FeishuEventDeps } from './feishu-events.js';

/*
 * Updates that bots post in Feishu groups the app's bot is in, pushed to the members who watch for them (ADR 0041).
 * Only messages from bots are taken; what people write in the group is ignored here even when Feishu delivers it.
 * Who may receive is decided per message from the group's current members, asked from Feishu and kept two minutes.
 */

const CHAT_TTL_MS = 2 * 60_000;

interface ChatInfo {
  name: string | null;
  members: string[] | null;
  until: number;
}

/** Group names and members, kept briefly so a burst of bot messages asks Feishu once. */
export class FeishuChatCache {
  private readonly chats = new Map<string, ChatInfo>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(deps: FeishuEventDeps, chatId: string): Promise<ChatInfo> {
    const cached = this.chats.get(chatId);
    if (cached && cached.until > this.now()) return cached;
    const [name, members] = await Promise.all([
      feishuChatName(deps.app, chatId, deps.fetch),
      feishuChatMemberOpenIds(deps.app, chatId, deps.fetch),
    ]);
    const info = { name, members, until: this.now() + CHAT_TTL_MS };
    // a failed member lookup is not kept: the next message asks again
    if (members) this.chats.set(chatId, info);
    if (this.chats.size > 500) this.chats.delete(this.chats.keys().next().value as string);
    return info;
  }

  forget(chatId: string): void {
    this.chats.delete(chatId);
  }
}

export interface GroupMessageEvent {
  sender?: { sender_type?: string };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    create_time?: string;
  };
}

/** A message in a group the bot is in: a bot's message may become update drops; anything else is ignored. */
export async function onFeishuGroupMessage(
  deps: FeishuEventDeps,
  cache: FeishuChatCache,
  data: GroupMessageEvent,
): Promise<void> {
  const message = data.message;
  const senderType = data.sender?.sender_type;
  if (message?.chat_type !== 'group' || !message.chat_id || !message.message_id) return;
  if (!senderType || senderType === 'user') return;
  const update = feishuUpdateText(message.message_type ?? '', message.content ?? '');
  if (!update) return;
  const chat = await cache.get(deps, message.chat_id);
  if (!chat.members) {
    deps.log.warn({}, 'feishu update: the group members could not be read (scope im:chat.members:read?)');
    return;
  }
  const created = Number(message.create_time);
  const outcome = await withTx(deps.db, (tx) =>
    deliverFeishuUpdate(tx, {
      appId: deps.app.appId,
      chatId: message.chat_id as string,
      chatName: chat.name,
      chatLink: feishuChatLink(deps.app, message.chat_id as string),
      messageId: message.message_id as string,
      postedAt: Number.isFinite(created) && created > 0 ? new Date(created) : new Date(),
      memberOpenIds: chat.members ?? [],
      update,
    }),
  );
  // counts only: never the group, the text or who
  if (outcome.sent + outcome.capped + outcome.refused + outcome.repeated > 0)
    deps.log.info({ ...outcome }, 'feishu update');
}

const WELCOME = {
  zh: 'AgentDrop 机器人已加入。之后这个群里其他机器人发的消息（例如仓库更新），会按群成员各自在 AgentDrop「设置 → 飞书」里填的关注词，私信推送给命中的人。成员自己发的消息不会被读取；没有绑定飞书或没填关注词的人不会收到任何东西。',
  en: 'The AgentDrop bot has joined. From now on, messages other bots post here (such as repository updates) are sent privately to each member whose watch terms in AgentDrop (Settings → Feishu) they match. Messages people write here are not read, and nobody who has not linked Feishu and set watch terms receives anything.',
} as const;

/** The bot was added to a group: it says once, in the group, what it does there. */
export async function onFeishuBotAdded(
  deps: FeishuEventDeps,
  cache: FeishuChatCache,
  data: { chat_id?: string },
): Promise<void> {
  if (!data.chat_id) return;
  cache.forget(data.chat_id);
  const text = deps.app.domain === 'lark' ? WELCOME.en : `${WELCOME.zh}\n\n${WELCOME.en}`;
  const sent = await sendFeishuChatText(deps.app, data.chat_id, text, deps.fetch);
  if (sent.ok) deps.log.info({}, 'feishu bot added to a group');
  else deps.log.warn({ feishuCode: sent.code }, 'feishu bot added to a group; the welcome was refused');
}

/** Runs a handler without holding Feishu's event acknowledgement (3 s); failures are logged, not thrown. */
export function inBackground(deps: FeishuEventDeps, what: string, work: () => Promise<void>): void {
  void work().catch((err) => deps.log.warn({ error: loggableErrorText(err) }, `${what} failed`));
}
