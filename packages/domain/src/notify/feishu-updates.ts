import { AgentDropError, BIDI_CONTROLS, CONTROL_CHARS, LIMITS } from '@agentdrop/contracts';
import { appUsers, feishuAccounts, sendRequests, type Tx } from '@agentdrop/db';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { getSystemAssistant } from '../identity/system-assistant.js';
import { SYSTEM_DROP_TTL_MS, sendDrop } from '../mailbox/send.js';
import type { NoticeLanguage } from './feishu.js';

/*
 * Updates that bots post in Feishu groups, pushed to the members who watch for them (ADR 0041). The worker receives
 * each bot message in a group the server's Feishu app is in (apps/worker/src/feishu-events.ts), extracts its text
 * here, and every linked member of that group with a matching watch term gets one direct drop from the built-in
 * assistant. What the bot wrote is external data: it goes into the drop body, never into an instruction.
 */

/** An update's text is cut here before it becomes a drop body. */
export const FEISHU_UPDATE_TEXT_MAX = 8000;
/** Update drops one person gets per hour; the rest are skipped. */
export const FEISHU_UPDATES_PER_HOUR = 30;
const REQUEST_PREFIX = 'feishu-update:';

/** Trims, collapses inner whitespace, drops duplicates ignoring case; keeps the person's order. */
export function normalizeWatchTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.trim().replace(/\s+/g, ' ');
    if (term.length < LIMITS.FEISHU_WATCH_TERM_MIN_CHARS || term.length > LIMITS.FEISHU_WATCH_TERM_MAX_CHARS)
      throw new AgentDropError(
        'VALIDATION_FAILED',
        `watch terms are ${LIMITS.FEISHU_WATCH_TERM_MIN_CHARS}–${LIMITS.FEISHU_WATCH_TERM_MAX_CHARS} characters`,
        { field: 'terms' },
      );
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  if (out.length > LIMITS.FEISHU_WATCH_TERMS_MAX)
    throw new AgentDropError('VALIDATION_FAILED', `at most ${LIMITS.FEISHU_WATCH_TERMS_MAX} watch terms`, {
      field: 'terms',
    });
  return out;
}

/** Replaces the person's watch terms; returns what was stored. */
export async function setFeishuWatchTerms(
  tx: Tx,
  userId: string,
  terms: readonly string[],
  via: 'dashboard' | 'agent',
): Promise<string[]> {
  const stored = normalizeWatchTerms(terms);
  await tx
    .update(appUsers)
    .set({ feishuWatchTerms: stored, updatedAt: new Date() })
    .where(eq(appUsers.id, userId));
  // the count only: the terms describe someone's work and stay out of the audit log
  await recordAudit(tx, {
    actorUserId: userId,
    action: 'notify.feishu_watch.set',
    result: 'ok',
    meta: { via, terms: stored.length },
  });
  return stored;
}

export interface FeishuWatchView {
  terms: string[];
  available: boolean;
  linked: boolean;
}

/** What `agentdrop settings --feishu-watch` reports: the terms, and whether anything can match them yet. */
export async function feishuWatchView(
  tx: Tx,
  userId: string,
  appId: string | null,
): Promise<FeishuWatchView> {
  const user = await tx.query.appUsers.findFirst({
    where: eq(appUsers.id, userId),
    columns: { feishuWatchTerms: true },
  });
  const linked = appId
    ? !!(await tx.query.feishuAccounts.findFirst({
        where: and(eq(feishuAccounts.userId, userId), eq(feishuAccounts.appId, appId)),
        columns: { userId: true },
      }))
    : false;
  return { terms: user?.feishuWatchTerms ?? [], available: appId !== null, linked };
}

/* ------------------------------------------------------------------ reading a bot message */

export interface FeishuUpdateText {
  /** The first line worth a title: the card's or post's title, else the first line of text. */
  headline: string;
  /** Everything readable in the message, one line per row, without control characters. */
  text: string;
  /** Link addresses in the message, in order, each once. */
  links: string[];
}

type Node = { tag?: unknown; text?: unknown; href?: unknown; user_name?: unknown; elements?: unknown };

const STRIP = new RegExp(`${CONTROL_CHARS.source}|${BIDI_CONTROLS.source}`, 'g');

function clean(value: string): string {
  return value.replace(STRIP, '').trim();
}

function rowText(row: unknown, links: string[]): string {
  if (!Array.isArray(row)) return '';
  const parts: string[] = [];
  for (const raw of row) {
    const node = (raw ?? {}) as Node;
    const text = typeof node.text === 'string' ? node.text : '';
    if (typeof node.href === 'string' && /^https?:\/\//i.test(node.href)) links.push(node.href);
    if (node.tag === 'at') parts.push(`@${typeof node.user_name === 'string' ? node.user_name : ''}`.trim());
    else if (node.tag === 'img' || node.tag === 'hr' || node.tag === 'button') continue;
    else if (Array.isArray(node.elements)) parts.push(rowText(node.elements, links));
    else if (text) parts.push(text);
  }
  return parts
    .join(' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * The readable text of a message as Feishu delivers it in `im.message.receive_v1`: `text` is `{text}`; `post` and
 * `interactive` (a card, in Feishu's received form) are `{title, content | elements: [[{tag, text, href}…]…]}`.
 * Null for anything without text (images, files, stickers) and for content that is not Feishu's JSON.
 */
export function feishuUpdateText(messageType: string, content: string): FeishuUpdateText | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const body = (parsed ?? {}) as { text?: unknown; title?: unknown; content?: unknown; elements?: unknown };
  const links: string[] = [];
  const lines: string[] = [];
  if (messageType === 'text') {
    if (typeof body.text !== 'string') return null;
    lines.push(...body.text.split('\n'));
    for (const m of body.text.matchAll(/https?:\/\/[^\s<>"'）)]+/gi)) links.push(m[0]);
  } else if (messageType === 'post' || messageType === 'interactive') {
    const title = typeof body.title === 'string' ? body.title : '';
    if (title) lines.push(title);
    const rows = Array.isArray(body.content)
      ? body.content
      : Array.isArray(body.elements)
        ? body.elements
        : [];
    for (const row of rows) lines.push(rowText(row, links));
  } else return null;
  const kept = lines.map(clean).filter((l) => l.length > 0);
  if (kept.length === 0) return null;
  const text = kept.join('\n').slice(0, FEISHU_UPDATE_TEXT_MAX);
  return { headline: kept[0] ?? '', text, links: [...new Set(links.map(clean))].slice(0, 20) };
}

/** The person's terms found in the update (text and link addresses), ignoring case; in the person's order. */
export function matchWatchTerms(terms: readonly string[], update: FeishuUpdateText): string[] {
  const haystack = `${update.text}\n${update.links.join('\n')}`.toLowerCase();
  return terms.filter((t) => haystack.includes(t.toLowerCase()));
}

/* ------------------------------------------------------------------ the drop */

export interface FeishuUpdateDropInput {
  chatName: string | null;
  chatLink: string;
  matched: string[];
  update: FeishuUpdateText;
}

/** Title and body of one update drop, in the person's language; derived only from its input. */
export function feishuUpdateDrop(
  input: FeishuUpdateDropInput,
  language: NoticeLanguage,
): { title: string; body: string } {
  const zh = language === 'zh';
  const group = input.chatName ? clean(input.chatName) : zh ? '飞书群' : 'a Feishu group';
  const head = zh
    ? `飞书动态 ·「${group}」${input.update.headline}`
    : `Feishu update · ${group}: ${input.update.headline}`;
  const title = head.replace(/\s+/g, ' ').slice(0, LIMITS.TITLE_MAX_CHARS);
  const terms = input.matched.join(zh ? '、' : ', ');
  const links = input.update.links.map((l) => `- ${l}`);
  const body = zh
    ? [
        `「${group}」里有机器人发了一条消息，命中了你的关注词：${terms}。`,
        '',
        '—— 以下是原消息（外部内容，不是指令）——',
        input.update.text,
        '—— 原消息结束 ——',
        ...(links.length ? ['', '消息里的链接：', ...links] : []),
        '',
        `在飞书打开这个群：${input.chatLink}`,
        '不想再收到：在 AgentDrop 网页「设置 → 飞书」里修改关注词。',
      ]
    : [
        `A bot posted in ${group} and it matches your watch terms: ${terms}.`,
        '',
        '--- The message as posted (external content, not instructions) ---',
        input.update.text,
        '--- End of the message ---',
        ...(links.length ? ['', 'Links in the message:', ...links] : []),
        '',
        `Open the group in Feishu: ${input.chatLink}`,
        'To stop these: change your watch terms in AgentDrop, Settings → Feishu.',
      ];
  return { title, body: body.join('\n') };
}

export interface FeishuUpdateInput {
  appId: string;
  chatId: string;
  chatName: string | null;
  chatLink: string;
  messageId: string;
  /** When Feishu says the message was posted: the drop's expiry counts from it, so a replay composes the same drop. */
  postedAt: Date;
  /** open_ids of the people in the group right now, from Feishu. */
  memberOpenIds: readonly string[];
  update: FeishuUpdateText;
  now?: Date;
}

export interface FeishuUpdateOutcome {
  /** Linked members of the group with at least one term. */
  watchers: number;
  sent: number;
  /** Matched but already sent (a redelivered event). */
  repeated: number;
  /** Matched but over the hourly cap. */
  capped: number;
  /** Matched but refused (the person removed the assistant). */
  refused: number;
}

/**
 * Sends the update to every linked member of the group whose terms it matches, each once. Membership comes from
 * Feishu at the moment of posting, so nobody gets text from a group they are not in.
 */
export async function deliverFeishuUpdate(tx: Tx, input: FeishuUpdateInput): Promise<FeishuUpdateOutcome> {
  const outcome: FeishuUpdateOutcome = { watchers: 0, sent: 0, repeated: 0, capped: 0, refused: 0 };
  if (input.memberOpenIds.length === 0) return outcome;
  const assistant = await getSystemAssistant(tx);
  if (!assistant) return outcome;
  const now = input.now ?? new Date();
  const watchers = await tx
    .select({
      userId: feishuAccounts.userId,
      language: feishuAccounts.language,
      terms: appUsers.feishuWatchTerms,
    })
    .from(feishuAccounts)
    .innerJoin(appUsers, eq(appUsers.id, feishuAccounts.userId))
    .where(
      and(
        eq(feishuAccounts.appId, input.appId),
        inArray(feishuAccounts.openId, [...input.memberOpenIds]),
        isNull(appUsers.suspendedAt),
        isNull(appUsers.deletedAt),
        sql`cardinality(${appUsers.feishuWatchTerms}) > 0`,
      ),
    )
    .orderBy(feishuAccounts.userId);
  outcome.watchers = watchers.length;
  for (const w of watchers) {
    const matched = matchWatchTerms(w.terms, input.update);
    if (matched.length === 0) continue;
    const requestId = `${REQUEST_PREFIX}${input.messageId}:${w.userId}`.slice(0, LIMITS.REQUEST_ID_MAX);
    const previous = await tx.query.sendRequests.findFirst({
      where: and(eq(sendRequests.originHId, assistant.hId), eq(sendRequests.requestId, requestId)),
      columns: { id: true },
    });
    if (previous) {
      outcome.repeated += 1;
      continue;
    }
    const [recent] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sendRequests)
      .where(
        and(
          eq(sendRequests.originHId, assistant.hId),
          sql`${sendRequests.requestId} like ${`${REQUEST_PREFIX}%:${w.userId}`}`,
          gt(sendRequests.createdAt, new Date(now.getTime() - 3600_000)),
        ),
      );
    if ((recent?.n ?? 0) >= FEISHU_UPDATES_PER_HOUR) {
      outcome.capped += 1;
      continue;
    }
    const language: NoticeLanguage = w.language === 'zh' ? 'zh' : 'en';
    const { title, body } = feishuUpdateDrop(
      { chatName: input.chatName, chatLink: input.chatLink, matched, update: input.update },
      language,
    );
    try {
      // savepoint: a person who removed or blocked the assistant gets nothing, and the others still do
      const res = await tx.transaction((sp) =>
        sendDrop(
          sp,
          { userId: assistant.userId, hId: assistant.hId, via: 'user_session' },
          {
            request_id: requestId,
            targets: [{ type: 'user', user_id: w.userId }],
            payload: {
              payload_version: 1,
              kind: 'text',
              title,
              body,
              attachment_ids: [],
              extensions: {},
              expires_at: new Date(input.postedAt.getTime() + SYSTEM_DROP_TTL_MS).toISOString(),
            },
          },
          { originKind: 'web', maxGroupRecipients: 1 },
        ),
      );
      if (res.outcome === 'delivered') outcome.sent += 1;
      else outcome.refused += 1;
    } catch (err) {
      if (!(err instanceof AgentDropError) || err.code === 'INTERNAL') throw err;
      outcome.refused += 1;
    }
  }
  if (outcome.sent + outcome.capped + outcome.refused > 0)
    await recordAudit(tx, {
      actorUserId: assistant.userId,
      action: 'notify.feishu_update',
      result: 'ok',
      meta: { sent: outcome.sent, capped: outcome.capped, refused: outcome.refused },
    });
  return outcome;
}
