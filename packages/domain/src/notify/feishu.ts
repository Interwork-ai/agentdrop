import { createHash, createHmac } from 'node:crypto';
import { AgentDropError, type ReplyProgress } from '@agentdrop/contracts';

/*
 * Feishu (飞书) group-bot webhooks: the server posts a message to a custom bot the person added to a chat of their
 * own (docs/FEISHU.md). Only Feishu/Lark's own webhook hosts are accepted, so this can never be pointed at an
 * arbitrary server. Following https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot:
 * - POST JSON, `{"code":0}` on success (HTTP 200 is not enough: errors also come back as 200);
 * - optional signature: HmacSHA256 with key `timestamp + "\n" + secret` over an empty message, Base64, sent as
 *   `timestamp` (seconds) and `sign` in the body;
 * - at most 20 KB per request, 100 per minute and 5 per second per bot.
 */

export type NoticeLanguage = 'en' | 'zh';

export interface FeishuWebhook {
  url: string;
  /** Signature secret, when the person turned on signature verification for the bot. */
  secret: string | null;
  language: NoticeLanguage;
}

const HOOK = /^https:\/\/open\.(feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]{8,128}$/;

export function validateFeishuWebhookUrl(raw: string): string {
  const url = raw.trim();
  if (!HOOK.test(url))
    throw new AgentDropError('VALIDATION_FAILED', 'not a Feishu group-bot webhook address', { field: 'url' });
  return url;
}

/** Last characters only, for showing which bot is connected without handing the address back. */
export function feishuUrlHint(url: string): string {
  return `…${url.slice(-6)}`;
}

export function feishuSign(secret: string, timestamp: number): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

/**
 * The key an announced item is recorded under in the account's "already shown" record. Must stay identical to
 * `currentKeys` in apps/cli/src/hook-notifications.ts (a test checks both), so an item announced on Feishu is not
 * announced again at the end of an agent's turn, and the other way round.
 */
export function noticeKey(kind: 'drop' | 'contact' | 'invitation' | 'join', value: string): string {
  return createHash('sha256').update(`${kind}\u0000${value}`).digest('hex').slice(0, 16);
}

export type FeishuItem =
  | {
      kind: 'drop';
      fromName: string;
      fromHandle: string;
      title: string;
      /** The group it reached this person through; absent or null for a direct message. */
      group?: { name: string; slug: string } | null;
      /** The author called on this person by @handle. */
      mentioned?: boolean;
      /** The drop this answers, when this person may read it (ADR 0016); `mine` when they wrote it. */
      replyTo?: { title: string; mine: boolean } | null;
      /** Where the work the answered drop asked for stands, as the reply says (ADR 0038). */
      progress?: ReplyProgress | null;
      link: string | null;
    }
  | { kind: 'contact'; fromName: string; fromHandle: string; link: string | null }
  | { kind: 'invitation'; groupName: string; groupSlug: string; link: string | null }
  | {
      kind: 'join';
      groupName: string;
      groupSlug: string;
      /** The person a member wants to bring in, and that member; each request is its own notice. */
      inviteeHandle: string;
      invitedByHandle: string | null;
      link: string | null;
    }
  | { kind: 'test'; link: string | null };

const clean = (value: string, max: number) =>
  value
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .trim()
    .slice(0, max);

/**
 * The words of one notice, shared by Feishu and (by convention, checked in tests) the browser's service worker
 * (apps/web/public/sw.js): a label saying what kind of item it is, and a line naming the group and the person.
 */
function noticeLine(item: Exclude<FeishuItem, { kind: 'test' }>, zh: boolean): string {
  const person = (name: string, handle: string) =>
    zh ? `${clean(name, 32)}（@${clean(handle, 32)}）` : `${clean(name, 32)} (@${clean(handle, 32)})`;
  const group = (name: string, slug: string) =>
    zh ? `「${clean(name, 60)}」#${clean(slug, 32)}` : `“${clean(name, 60)}” #${clean(slug, 32)}`;
  switch (item.kind) {
    case 'drop': {
      const from = person(item.fromName, item.fromHandle);
      const title = clean(item.title, 120) || (zh ? '无标题' : 'untitled');
      const mention = item.mentioned ? (zh ? ' @了你' : ' mentioned you') : '';
      const reply = replyWords(item.replyTo, !!item.mentioned, zh, item.progress);
      // a reply titled "Re: <original>" would only repeat what the reply words already say
      const quoted =
        item.replyTo && isReplyTitle(clean(item.title, 160), clean(item.replyTo.title, 160))
          ? ''
          : zh
            ? `·「${title}」`
            : ` · “${title}”`;
      if (item.group) {
        const where = group(item.group.name, item.group.slug);
        return zh
          ? `群消息 ·${where}：${from}${mention}${reply}${quoted}`
          : `Group message · ${where}: ${from}${mention}${reply}${quoted}`;
      }
      return zh ? `私信：${from}${reply}${quoted}` : `Direct message: ${from}${reply}${quoted}`;
    }
    case 'contact':
      return zh
        ? `联系人申请：${person(item.fromName, item.fromHandle)}想加你为联系人`
        : `Contact request: ${person(item.fromName, item.fromHandle)} wants to add you as a contact`;
    case 'invitation':
      return zh
        ? `群邀请：你被邀请加入${group(item.groupName, item.groupSlug)}`
        : `Group invitation: you are invited to ${group(item.groupName, item.groupSlug)}`;
    case 'join': {
      const invitee = `@${clean(item.inviteeHandle, 32)}`;
      const by = item.invitedByHandle ? clean(item.invitedByHandle, 32) : '';
      return zh
        ? `入群申请：${invitee} 想加入${group(item.groupName, item.groupSlug)}${by ? `（@${by} 邀请）` : ''}，只能在网页上决定`
        : `Join request: ${invitee} wants to join ${group(item.groupName, item.groupSlug)}${by ? ` (invited by @${by})` : ''}; only you can decide, in the dashboard`;
    }
  }
}

/** What a reply did to the drop it answers, by the progress it gives (ADR 0038); without progress it "replied to". */
const REPLY_PHRASES: Record<
  ReplyProgress | 'none',
  { en: (t: string) => string; zh: (t: string) => string }
> = {
  none: { en: (t) => `replied to ${t}`, zh: (t) => `回复了${t}` },
  started: { en: (t) => `started on ${t}`, zh: (t) => `开始处理${t}` },
  done: { en: (t) => `finished ${t}`, zh: (t) => `完成了${t}` },
  declined: { en: (t) => `declined ${t}`, zh: (t) => `婉拒了${t}` },
  needs_info: { en: (t) => `needs more information for ${t}`, zh: (t) => `需要补充信息才能处理${t}` },
};

/**
 * " replied to your “X”" / " 回复了你的「X」", or the progress the reply gives (" finished your “X”" / " 完成了你的「X」"),
 * after the person (and after "mentioned you"). Shared wording with the service worker (apps/web/public/sw.js);
 * empty when the drop answers nothing the recipient may read.
 */
function replyWords(
  replyTo: { title: string; mine: boolean } | null | undefined,
  mentioned: boolean,
  zh: boolean,
  progress?: ReplyProgress | null,
) {
  if (!replyTo) return '';
  const original = clean(replyTo.title, 60) || (zh ? '无标题' : 'untitled');
  const phrase = REPLY_PHRASES[progress ?? 'none'];
  if (zh) return `${mentioned ? '，并' : ' '}${phrase.zh(`${replyTo.mine ? '你的' : ''}「${original}」`)}`;
  return `${mentioned ? ' and' : ''} ${phrase.en(`${replyTo.mine ? 'your ' : ''}“${original}”`)}`;
}

/** "Re: X" (any case, also "Re：" and "回复：") for the original title X. */
export function isReplyTitle(title: string, original: string): boolean {
  const m = /^(?:re|回复)\s*[:：]\s*(.*)$/i.exec(title.trim());
  return !!m && m[1]?.trim() === original.trim();
}

/**
 * One rich-text (`post`) message. Every message contains "AgentDrop", so a bot secured with the custom keyword
 * "AgentDrop" accepts it. Received names and titles are shown as plain text only.
 */
export function feishuMessage(item: FeishuItem, language: NoticeLanguage): Record<string, unknown> {
  const zh = language === 'zh';
  const line =
    item.kind === 'test'
      ? zh
        ? '连接成功：以后 AgentDrop 的新消息、联系人申请和群邀请会在这里提醒你，每条一次。'
        : 'Connected: new AgentDrop messages, contact requests and group invitations will be announced here, each once.'
      : noticeLine(item, zh);
  const content: Array<Array<Record<string, string>>> = [[{ tag: 'text', text: line }]];
  if (item.link)
    content.push([{ tag: 'a', text: zh ? '在 AgentDrop 打开' : 'Open in AgentDrop', href: item.link }]);
  return {
    msg_type: 'post',
    content: { post: { [zh ? 'zh_cn' : 'en_us']: { title: 'AgentDrop', content } } },
  };
}

export interface FeishuResult {
  ok: boolean;
  /** Feishu's own code (0 on success), or the HTTP status when the body was not Feishu's. */
  code: number;
  message: string;
}

/** Posts one message. Never throws for Feishu-level errors; returns them so callers decide about retries. */
export async function postFeishu(
  hook: FeishuWebhook,
  message: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  timeoutMs = 10_000,
): Promise<FeishuResult> {
  const timestamp = Math.floor(now() / 1000);
  const body = hook.secret
    ? { timestamp: String(timestamp), sign: feishuSign(hook.secret, timestamp), ...message }
    : message;
  const res = await fetchImpl(validateFeishuWebhookUrl(hook.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  let parsed: { code?: number; msg?: string } = {};
  try {
    parsed = (await res.json()) as { code?: number; msg?: string };
  } catch {
    /* not Feishu's JSON */
  }
  const code = typeof parsed.code === 'number' ? parsed.code : res.ok ? -1 : res.status;
  return { ok: code === 0, code, message: String(parsed.msg ?? res.statusText).slice(0, 200) };
}

/** Feishu codes that will not go away by retrying: a wrong signature, keyword, IP, a removed bot or a bad body. */
export function feishuPermanentFailure(code: number): boolean {
  return [9499, 19001, 19002, 19021, 19022, 19024, 404, 410].includes(code);
}
