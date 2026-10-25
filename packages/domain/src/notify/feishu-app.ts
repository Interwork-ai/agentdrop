import { createHash, randomInt } from 'node:crypto';
import { AgentDropError } from '@agentdrop/contracts';
import {
  appUsers,
  deliveries,
  feishuAccounts,
  feishuCards,
  feishuLinkCodes,
  feishuLinkFailures,
  harnessEndpoints,
  type Tx,
} from '@agentdrop/db';
import { and, count, eq, gt, isNull, lt } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { hasValidGrant } from '../mailbox/authorization.js';
import { markReadForPerson, setDropState } from '../mailbox/read.js';
import { bumpMailboxes } from '../mailbox/revision.js';
import { type FeishuItem, feishuNoticeText, type NoticeLanguage } from './feishu.js';

/*
 * The server's own Feishu app (ADR 0039, docs/FEISHU.md): a person links their Feishu account by sending a one-time
 * code to the app's bot, and notices then arrive as cards in that direct chat, with buttons. Feishu's server API
 * (https://open.feishu.cn/document/server-docs): a tenant access token from the app id and secret
 * (`auth/v3/tenant_access_token/internal`, about two hours), `im/v1/messages?receive_id_type=open_id` to send an
 * `interactive` card, `PATCH im/v1/messages/:id` to change it within 14 days (`config.update_multi`). Events and
 * card presses arrive over the worker's WebSocket (apps/worker/src/feishu-events.ts).
 *
 * Received names and titles go into cards as `plain_text` only: never markdown, never a link of someone else's.
 */

export interface FeishuAppConfig {
  appId: string;
  appSecret: string;
  /** `feishu`: open.feishu.cn; `lark`: open.larksuite.com. Apps and tokens of one do not work on the other. */
  domain: 'feishu' | 'lark';
}

/**
 * The operator's Feishu app from the environment: `FEISHU_APP_ID` and `FEISHU_APP_SECRET` together (no default for
 * either), `FEISHU_DOMAIN` `feishu` (default) or `lark`. Null when neither is set: the feature is off.
 */
export function feishuAppConfigFromEnv(
  env: Record<string, string | undefined>,
  options: { requireSecret?: boolean } = {},
): FeishuAppConfig | null {
  const appId = env.FEISHU_APP_ID?.trim() || '';
  const appSecret = env.FEISHU_APP_SECRET?.trim() || '';
  // the API only shows the bot link and keeps no secret (compose.production.yaml); the worker needs both
  if (options.requireSecret === false) {
    if (!appId) return null;
  } else {
    if (!appId && !appSecret) return null;
    if (!appId || !appSecret) throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be set together');
  }
  if (!/^cli_[A-Za-z0-9]+$/.test(appId))
    throw new Error('FEISHU_APP_ID is the app id from the Feishu console (cli_…)');
  const domain = env.FEISHU_DOMAIN?.trim() || 'feishu';
  if (domain !== 'feishu' && domain !== 'lark') throw new Error('FEISHU_DOMAIN must be feishu or lark');
  return { appId, appSecret, domain };
}

export const feishuOpenBase = (config: Pick<FeishuAppConfig, 'domain'>) =>
  config.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';

/** A link that opens the direct chat with the app's bot in the Feishu client (AppLink "open a bot chat"). */
export function feishuBotLink(config: Pick<FeishuAppConfig, 'appId' | 'domain'>): string {
  const host = config.domain === 'lark' ? 'applink.larksuite.com' : 'applink.feishu.cn';
  return `https://${host}/client/bot/open?appId=${encodeURIComponent(config.appId)}`;
}

export interface FeishuApiResult {
  ok: boolean;
  /** Feishu's code (0 on success), or the HTTP status when the body was not Feishu's. */
  code: number;
  message: string;
  messageId?: string;
}

/** Codes that retrying will not fix: the person is outside the app's availability, blocked the bot, no bot, no scope. */
export function feishuAppPermanentFailure(code: number): boolean {
  return [230002, 230006, 230013, 230053, 230099, 99991672, 99991403, 400, 403, 404].includes(code);
}

const TOKEN_INVALID = new Set([99991661, 99991663, 99991668]);
const tokens = new Map<string, { token: string; until: number }>();

async function feishuJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function tenantToken(config: FeishuAppConfig, fetchImpl: typeof fetch, now: number): Promise<string> {
  const cached = tokens.get(config.appId);
  if (cached && cached.until > now) return cached.token;
  const res = await fetchImpl(`${feishuOpenBase(config)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const body = await feishuJson(res);
  const token = typeof body.tenant_access_token === 'string' ? body.tenant_access_token : null;
  if (body.code !== 0 || !token)
    throw new AgentDropError('UPSTREAM_UNAVAILABLE', 'Feishu did not issue an app token', {
      feishu_code: typeof body.code === 'number' ? body.code : res.status,
    });
  const expire = typeof body.expire === 'number' ? body.expire : 7200;
  // renew five minutes early, so a token never expires in the middle of a send
  tokens.set(config.appId, { token, until: now + Math.max(60, expire - 300) * 1000 });
  return token;
}

/** Forgets cached tokens (tests, or an operator changing the secret). */
export function resetFeishuTokens(): void {
  tokens.clear();
}

async function callFeishu(
  config: FeishuAppConfig,
  path: string,
  init: { method: 'POST' | 'PATCH'; body: unknown },
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<FeishuApiResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await tenantToken(config, fetchImpl, now());
    const res = await fetchImpl(`${feishuOpenBase(config)}${path}`, {
      method: init.method,
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: JSON.stringify(init.body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    const body = await feishuJson(res);
    const code = typeof body.code === 'number' ? body.code : res.ok ? -1 : res.status;
    // a token revoked early (the secret was reset): fetch a new one once
    if (TOKEN_INVALID.has(code) && attempt === 0) {
      tokens.delete(config.appId);
      continue;
    }
    const data = (body.data ?? {}) as { message_id?: unknown };
    return {
      ok: code === 0,
      code,
      message: String(body.msg ?? res.statusText).slice(0, 200),
      ...(typeof data.message_id === 'string' ? { messageId: data.message_id } : {}),
    };
  }
  return { ok: false, code: -1, message: 'token refresh failed' };
}

/** Sends a card to a person in the app's direct chat. Never throws for Feishu-level errors. */
export function sendFeishuCard(
  config: FeishuAppConfig,
  openId: string,
  card: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<FeishuApiResult> {
  return callFeishu(
    config,
    '/open-apis/im/v1/messages?receive_id_type=open_id',
    {
      method: 'POST',
      body: { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card) },
    },
    fetchImpl,
    now,
  );
}

/** Replaces a card the app sent (within Feishu's 14 days). Never throws for Feishu-level errors. */
export function updateFeishuCard(
  config: FeishuAppConfig,
  messageId: string,
  card: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<FeishuApiResult> {
  return callFeishu(
    config,
    `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
    { method: 'PATCH', body: { content: JSON.stringify(card) } },
    fetchImpl,
    now,
  );
}

/* ------------------------------------------------------------------ cards */

/** What a drop card shows about the person's state, and what its buttons do. */
export interface FeishuCardState {
  read: boolean;
  starred: boolean;
}

/** The value a card button carries back; nothing in it is trusted when it returns. */
export interface FeishuCardAction {
  v: 1;
  a: 'read' | 'star' | 'unstar';
  d: string;
}

const plain = (content: string) => ({ tag: 'plain_text', content });

function button(
  text: string,
  type: 'primary' | 'default' | 'text',
  behavior: Record<string, unknown>,
  disabled = false,
): Record<string, unknown> {
  return { tag: 'button', text: plain(text), type, size: 'small', disabled, behaviors: [behavior] };
}

/**
 * A notice as a card (JSON 2.0): the notice line in plain text, then buttons. A drop card can be marked read and
 * starred from Feishu (ADR 0039); every card opens the dashboard where it is about.
 */
export function feishuNoticeCard(
  item: FeishuItem,
  language: NoticeLanguage,
  state?: { dropId: string } & FeishuCardState,
): Record<string, unknown> {
  const zh = language === 'zh';
  const line = feishuNoticeText(item, language);
  const buttons: Array<Record<string, unknown>> = [];
  if (state) {
    const action = (a: FeishuCardAction['a']): Record<string, unknown> => ({
      type: 'callback',
      value: { v: 1, a, d: state.dropId } satisfies FeishuCardAction,
    });
    buttons.push(
      state.read
        ? button(zh ? '已读' : 'Read', 'default', action('read'), true)
        : button(zh ? '标为已读' : 'Mark read', 'primary', action('read')),
      state.starred
        ? button(zh ? '取消收藏' : 'Unstar', 'default', action('unstar'))
        : button(zh ? '收藏' : 'Star', 'default', action('star')),
    );
  }
  if (item.link)
    buttons.push(
      button(zh ? '在 AgentDrop 打开' : 'Open in AgentDrop', 'text', {
        type: 'open_url',
        default_url: item.link,
      }),
    );
  const elements: Array<Record<string, unknown>> = [{ tag: 'div', text: plain(line) }];
  if (buttons.length)
    elements.push({
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: 'small',
      columns: buttons.map((b) => ({ tag: 'column', width: 'auto', elements: [b] })),
    });
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: line.slice(0, 120) } },
    header: {
      title: plain('AgentDrop'),
      template: state?.read ? 'grey' : 'blue',
    },
    body: { elements },
  };
}

/** A card with one sentence, for answers to what a person sends the bot (linked, unlinked, a wrong code). */
export function feishuTextCard(text: string, link?: { label: string; url: string }): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [{ tag: 'div', text: plain(text) }];
  if (link) elements.push(button(link.label, 'default', { type: 'open_url', default_url: link.url }));
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: text.slice(0, 120) } },
    header: { title: plain('AgentDrop'), template: 'blue' },
    body: { elements },
  };
}

/* ------------------------------------------------------------------ linking */

/** No 0/O, 1/I/L: a code is read off a screen and typed into a chat. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60_000;
const MAX_FAILURES_PER_HOUR = 5;

const hashCode = (code: string) => createHash('sha256').update(`feishu-link:${code}`).digest('hex');

/** The code in a message: the 8 letters and digits, ignoring case, spaces and dashes; null when there is none. */
export function feishuCodeIn(text: string): string | null {
  const compact = text.toUpperCase().replace(/[\s-]/g, '');
  if (compact.length === CODE_LENGTH && [...compact].every((c) => CODE_ALPHABET.includes(c))) return compact;
  const m = /(?:^|[^A-Z0-9])([A-Z0-9]{4})-?([A-Z0-9]{4})(?:$|[^A-Z0-9])/.exec(text.toUpperCase());
  const found = m ? `${m[1]}${m[2]}` : null;
  return found && [...found].every((c) => CODE_ALPHABET.includes(c)) ? found : null;
}

/** "unlink" / "解绑" (and close variants) sent to the bot. */
export function isFeishuUnlinkWord(text: string): boolean {
  return /^\s*(unlink|disconnect|解绑|解除绑定|取消绑定)\s*$/i.test(text);
}

/** A new one-time code for the person (any earlier one stops working). Shown as `ABCD-EFGH`. */
export async function createFeishuLinkCode(
  tx: Tx,
  userId: string,
  language: NoticeLanguage,
  now: Date = new Date(),
): Promise<{ code: string; expires_at: string }> {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  await tx.delete(feishuLinkCodes).where(eq(feishuLinkCodes.userId, userId));
  await tx.delete(feishuLinkCodes).where(lt(feishuLinkCodes.expiresAt, now));
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  await tx.insert(feishuLinkCodes).values({ codeHash: hashCode(code), userId, language, expiresAt });
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: expiresAt.toISOString() };
}

export interface FeishuSender {
  openId: string;
  unionId?: string | null;
  tenantKey?: string | null;
}

export type FeishuLinkOutcome =
  | { outcome: 'linked'; userId: string; language: NoticeLanguage }
  | { outcome: 'unlinked'; userId: string; language: NoticeLanguage }
  /** `language` null: nothing tells which language this Feishu user reads; the caller picks one. */
  | { outcome: 'bad_code' | 'too_many'; language: NoticeLanguage | null }
  | { outcome: 'other'; linked: boolean; language: NoticeLanguage | null };

const asLanguage = (value: string | null | undefined): NoticeLanguage => (value === 'zh' ? 'zh' : 'en');
const knownLanguage = (value: string | null | undefined): NoticeLanguage | null =>
  value === 'zh' || value === 'en' ? value : null;

/**
 * What a person's direct message to the bot does: a valid code links their Feishu account (replacing any earlier
 * link of either side), the unlink words remove the link, anything else does nothing. The text itself is never
 * stored or shown anywhere.
 */
export async function handleFeishuMessage(
  tx: Tx,
  appId: string,
  sender: FeishuSender,
  text: string,
  now: Date = new Date(),
): Promise<FeishuLinkOutcome> {
  const existing = await tx.query.feishuAccounts.findFirst({
    where: and(eq(feishuAccounts.appId, appId), eq(feishuAccounts.openId, sender.openId)),
  });
  if (isFeishuUnlinkWord(text)) {
    if (!existing) return { outcome: 'other', linked: false, language: null };
    await tx.delete(feishuAccounts).where(eq(feishuAccounts.userId, existing.userId));
    await tx.delete(feishuCards).where(eq(feishuCards.userId, existing.userId));
    await recordAudit(tx, {
      actorUserId: existing.userId,
      action: 'notify.feishu_app.unlink',
      result: 'ok',
      meta: { via: 'feishu' },
    });
    return { outcome: 'unlinked', userId: existing.userId, language: asLanguage(existing.language) };
  }
  const code = feishuCodeIn(text);
  if (!code) return { outcome: 'other', linked: !!existing, language: knownLanguage(existing?.language) };
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const [failures] = await tx
    .select({ n: count() })
    .from(feishuLinkFailures)
    .where(
      and(
        eq(feishuLinkFailures.appId, appId),
        eq(feishuLinkFailures.openId, sender.openId),
        gt(feishuLinkFailures.failedAt, hourAgo),
      ),
    );
  if ((failures?.n ?? 0) >= MAX_FAILURES_PER_HOUR)
    return { outcome: 'too_many', language: knownLanguage(existing?.language) };
  const row = await tx.query.feishuLinkCodes.findFirst({
    where: eq(feishuLinkCodes.codeHash, hashCode(code)),
  });
  const user = row ? await tx.query.appUsers.findFirst({ where: eq(appUsers.id, row.userId) }) : undefined;
  if (!row || row.expiresAt <= now || !user || user.suspendedAt || user.deletedAt) {
    await tx.insert(feishuLinkFailures).values({ appId, openId: sender.openId, failedAt: now });
    await tx.delete(feishuLinkFailures).where(lt(feishuLinkFailures.failedAt, hourAgo));
    return { outcome: 'bad_code', language: knownLanguage(row?.language ?? existing?.language) };
  }
  await tx.delete(feishuLinkCodes).where(eq(feishuLinkCodes.codeHash, row.codeHash));
  // one Feishu user per account and one account per Feishu user: a new link replaces either earlier one
  await tx
    .delete(feishuAccounts)
    .where(and(eq(feishuAccounts.appId, appId), eq(feishuAccounts.openId, sender.openId)));
  await tx.delete(feishuAccounts).where(eq(feishuAccounts.userId, row.userId));
  await tx.delete(feishuCards).where(eq(feishuCards.userId, row.userId));
  if (existing && existing.userId !== row.userId)
    await tx.delete(feishuCards).where(eq(feishuCards.userId, existing.userId));
  await tx.insert(feishuAccounts).values({
    userId: row.userId,
    appId,
    openId: sender.openId,
    unionId: sender.unionId ?? null,
    tenantKey: sender.tenantKey ?? null,
    language: row.language,
  });
  await recordAudit(tx, {
    actorUserId: row.userId,
    action: 'notify.feishu_app.link',
    result: 'ok',
    meta: { via: 'feishu' },
  });
  return { outcome: 'linked', userId: row.userId, language: asLanguage(row.language) };
}

/** The person's linked Feishu account for this app, when the account is active. */
export async function getFeishuAccount(tx: Tx, userId: string, appId: string) {
  const row = await tx.query.feishuAccounts.findFirst({
    where: and(eq(feishuAccounts.userId, userId), eq(feishuAccounts.appId, appId)),
  });
  if (!row) return null;
  const user = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, userId) });
  return user && !user.suspendedAt && !user.deletedAt ? row : null;
}

/** Disconnect from the dashboard; also forgets the cards, so nothing is updated for an unlinked person. */
export async function unlinkFeishuAccount(tx: Tx, userId: string): Promise<void> {
  const removed = await tx
    .delete(feishuAccounts)
    .where(eq(feishuAccounts.userId, userId))
    .returning({ userId: feishuAccounts.userId });
  await tx.delete(feishuCards).where(eq(feishuCards.userId, userId));
  await tx.delete(feishuLinkCodes).where(eq(feishuLinkCodes.userId, userId));
  if (removed.length)
    await recordAudit(tx, {
      actorUserId: userId,
      action: 'notify.feishu_app.unlink',
      result: 'ok',
      meta: { via: 'dashboard' },
    });
}

/** What the dashboard shows: whether the server has an app, and whether this person linked it. */
export interface FeishuAppView {
  available: boolean;
  linked: boolean;
  bot_link: string | null;
  linked_at: string | null;
}

export async function feishuAppView(
  tx: Tx,
  userId: string,
  config: FeishuAppConfig | null,
): Promise<FeishuAppView> {
  if (!config) return { available: false, linked: false, bot_link: null, linked_at: null };
  const account = await getFeishuAccount(tx, userId, config.appId);
  return {
    available: true,
    linked: !!account,
    bot_link: feishuBotLink(config),
    linked_at: account ? account.createdAt.toISOString() : null,
  };
}

/* ------------------------------------------------------------------ card presses */

/** The person's own state of a drop, over the deliveries that carry state (as setDropState counts them). */
export async function personDropState(
  tx: Tx,
  userId: string,
  dropId: string,
): Promise<(FeishuCardState & { version: number }) | null> {
  const rows = await tx
    .select({ readAt: deliveries.readAt, starredAt: deliveries.starredAt, version: deliveries.stateVersion })
    .from(deliveries)
    .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, deliveries.hId))
    .where(
      and(eq(deliveries.dropId, dropId), eq(harnessEndpoints.userId, userId), hasValidGrant(deliveries.id)),
    );
  if (rows.length === 0) return null;
  return {
    read: rows.every((r) => r.readAt !== null),
    starred: rows.some((r) => r.starredAt !== null),
    version: Math.max(...rows.map((r) => r.version)),
  };
}

export type FeishuCardPress =
  | {
      outcome: 'done';
      userId: string;
      hId: string;
      dropId: string;
      state: FeishuCardState;
      language: NoticeLanguage;
    }
  | { outcome: 'not_linked' | 'gone' };

/** Reads a button's value back defensively: it came from Feishu, so it is checked like any input. */
export function parseFeishuCardAction(value: unknown): FeishuCardAction | null {
  const v = value as Partial<FeishuCardAction> | null;
  if (!v || typeof v !== 'object' || v.v !== 1) return null;
  if (v.a !== 'read' && v.a !== 'star' && v.a !== 'unstar') return null;
  if (typeof v.d !== 'string' || !/^[0-9a-f-]{36}$/i.test(v.d)) return null;
  return { v: 1, a: v.a, d: v.d };
}

/**
 * A button pressed on a card: only the linked person's own press counts, only on a card the app sent them, and
 * the change is the ordinary explicit state change of that person (ADR 0005/0007), as if they had pressed it in the
 * dashboard: read marks every delivery of the drop to any of their agents read, star and unstar change the shared
 * flag with the usual version bump and mailbox events.
 */
export async function applyFeishuCardPress(
  tx: Tx,
  appId: string,
  openId: string,
  action: FeishuCardAction,
): Promise<FeishuCardPress> {
  const account = await tx.query.feishuAccounts.findFirst({
    where: and(eq(feishuAccounts.appId, appId), eq(feishuAccounts.openId, openId)),
  });
  if (!account || !(await getFeishuAccount(tx, account.userId, appId))) return { outcome: 'not_linked' };
  const card = await tx.query.feishuCards.findFirst({
    where: and(eq(feishuCards.userId, account.userId), eq(feishuCards.dropId, action.d)),
  });
  if (!card) return { outcome: 'gone' };
  const endpoint = await tx.query.harnessEndpoints.findFirst({
    where: and(
      eq(harnessEndpoints.id, card.hId),
      eq(harnessEndpoints.userId, account.userId),
      isNull(harnessEndpoints.revokedAt),
    ),
  });
  if (action.a === 'read') {
    await bumpMailboxes(tx, await markReadForPerson(tx, account.userId, [action.d]));
  } else {
    const before = await personDropState(tx, account.userId, action.d);
    if (!before || !endpoint) return { outcome: 'gone' };
    try {
      await setDropState(
        tx,
        { userId: account.userId, hId: endpoint.id, via: 'user_session' },
        { drop_id: action.d, expected_version: before.version, starred: action.a === 'star' },
      );
    } catch (err) {
      if (err instanceof AgentDropError && err.code === 'NOT_FOUND') return { outcome: 'gone' };
      throw err;
    }
  }
  const state = await personDropState(tx, account.userId, action.d);
  if (!state) return { outcome: 'gone' };
  await tx
    .update(feishuCards)
    .set({ shownRead: state.read, shownStarred: state.starred })
    .where(and(eq(feishuCards.userId, account.userId), eq(feishuCards.dropId, action.d)));
  return {
    outcome: 'done',
    userId: account.userId,
    hId: card.hId,
    dropId: action.d,
    state: { read: state.read, starred: state.starred },
    language: asLanguage(account.language),
  };
}

/** Remembers the card a notice became, so presses and reads elsewhere can update it. */
export async function rememberFeishuCard(
  tx: Tx,
  input: { userId: string; dropId: string; hId: string; messageId: string; state: FeishuCardState },
): Promise<void> {
  await tx
    .insert(feishuCards)
    .values({
      userId: input.userId,
      dropId: input.dropId,
      hId: input.hId,
      messageId: input.messageId,
      shownRead: input.state.read,
      shownStarred: input.state.starred,
    })
    .onConflictDoUpdate({
      target: [feishuCards.userId, feishuCards.dropId],
      set: {
        hId: input.hId,
        messageId: input.messageId,
        shownRead: input.state.read,
        shownStarred: input.state.starred,
        createdAt: new Date(),
      },
    });
}
