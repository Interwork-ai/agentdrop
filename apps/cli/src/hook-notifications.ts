import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { mergeNoticeState } from '@agentdrop/contracts';
import type { PendingSummary } from './commands/pending.js';
import type { NotificationSettings } from './hook-settings.js';
import type { Language } from './locale.js';
import { configDir, stateDir } from './paths.js';
import { recordSeenLocally } from './seen-log.js';
import { acquireStateLock } from './state-lock.js';
import { type ProfileFile, readProfile } from './store.js';

/** After a transport failure, how long advisory hooks leave the network alone. */
export const RETRY_MS = 5 * 60 * 1000;
/**
 * One limit for every harness. The generated opencode plugin hands the text to `client.tui.showToast`, which has
 * no height cap but word-wraps at roughly 54 columns; capping here instead of per host keeps the four notices
 * byte-identical and stops a toast from cutting a character in half.
 */
const NOTICE_LIMIT = 1200;
/**
 * The model's prompt context lists everything pending that fits (up to the list maximum it fetched); it is read
 * by a model, not a toast, so it gets more room. Drops that do not fit are counted in the overflow line.
 */
const MODEL_CONTEXT_LIMIT = 4000;
const TRUNCATED_LINE: Record<Language, string> = { en: '- … (truncated)', zh: '- …（已截断）' };
/** Matches the server-side `limit: 5` the hook already asks for, so a listed item is never invented. */
const INLINE_ITEMS = 5;
/** Join-request lines are the longest, and a human decides them elsewhere anyway. */
const INLINE_JOIN_REQUESTS = 3;
/**
 * What the human has already been shown. A notice is for a person: each item is announced once and not again on
 * every interval. Processing is a different job — the model's prompt context and the tools always see everything
 * that is pending, whether or not it was announced.
 */
export interface ShownState {
  drops: string[];
  contacts: string[];
  invitations: string[];
  join_requests: string[];
  approvals: number;
}
/** Drop ids are unique forever, so remembering more only prevents repeats; keep it bounded anyway. */
const MAX_SHOWN_DROPS = 500;
interface CheckState {
  shown?: ShownState;
  last_checked_at?: number;
  /** Kept only so caches written by CLI 0.4.x remain readable. */
  last_notified_at?: number;
  last_failed_at?: number;
  count: number;
}

/** Stop notifications are advisory: local state, transport and formatting failures stay quiet. */
export async function notificationForHook(
  profileName: string,
  settings: NotificationSettings,
  deps: {
    fetchPending: (profile: string) => Promise<PendingSummary | null>;
    now?: () => number;
    extraNotice?: string | null;
    /** Language of the human notice; English unless the user chose otherwise. */
    language?: Language;
    /**
     * The account's shared record of what was already shown (ADR 0007), so a notice seen in one agent is not
     * repeated in another, even on another machine. `load` resolves to `undefined` when the server predates it;
     * the local record is used then.
     */
    shared?: {
      /**
       * Atomically records `current` as shown and returns the record from before (null: nothing yet), so of
       * agents announcing at the same moment only one sees an item as new. `undefined`: no shared record.
       */
      claim: (current: ShownState) => Promise<ShownState | null | undefined>;
      /** The account's seen record; undefined only for an unsupported endpoint. Transient failures reject. */
      seen?: () => Promise<ShownState | null | undefined>;
      /** Atomically records `current` as seen in an agent; returns the seen record from before, or `undefined`. */
      claimSeen?: (current: ShownState) => Promise<ShownState | null | undefined>;
    };
    /**
     * `preview` (every host's end of turn): show what the person has not seen yet, once per session, and record
     * nothing as seen, because nobody may be looking at this session; the next prompt or session start does (see
     * `announceSeen`). `claim`: the older behaviour, showing counts as seen; used only by callers and tests that
     * ask for it, and as the fallback when the server keeps no "seen in an agent" record.
     */
    mode?: 'preview' | 'claim';
    /** The host's session id, so a preview is shown once per session and known to the next prompt in it. */
    session?: string | null;
  },
): Promise<string | null> {
  const language = deps.language ?? 'en';
  if (!settings.enabled) return hookMessage(deps.extraNotice, language);
  let release: (() => void) | undefined;
  try {
    const now = (deps.now ?? Date.now)();
    if (!Number.isFinite(now) || !Number.isFinite(settings.interval_ms) || settings.interval_ms < 0)
      return null;
    const profile = readProfile(profileName);
    if (!profile || Date.parse(profile.credential_expires_at) <= now) return null;
    const server = new URL(profile.server_url).href.replace(/\/$/, '');
    // One record per account, not per agent: all agents of an account are one reader (ADR 0007).
    const key = createHash('sha256')
      .update(JSON.stringify([server, profile.user_id, resolve(configDir())]))
      .digest('hex');
    const directory = join(stateDir(), 'hook-notifications');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `${key}.json`);
    release = acquireStateLock(`${file}.lock`);
    if (!release) return null;
    let previous: CheckState | undefined;
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as CheckState;
        if (
          !parsed ||
          !Number.isSafeInteger(parsed.count) ||
          parsed.count < 0 ||
          Object.entries(parsed).some(([key, value]) =>
            key === 'shown'
              ? !validShown(value)
              : !['count', 'last_failed_at', 'last_checked_at', 'last_notified_at'].includes(key) ||
                !Number.isFinite(value),
          )
        ) {
          throw new Error('invalid notification state');
        }
        previous = parsed;
      } catch {
        // A damaged cache must not grant another notification in the current interval.
        saveState(file, { count: 0, last_notified_at: now, last_checked_at: now });
        return null;
      }
    }

    if (previous?.last_checked_at !== undefined && now < previous.last_checked_at) {
      const reset = { ...previous, last_checked_at: now };
      delete reset.last_failed_at;
      delete reset.last_notified_at;
      saveState(file, reset);
      return hookMessage(deps.extraNotice, language);
    }
    // A successful mailbox query consumes the whole user-configured interval even when it is empty. Only a
    // transport failure retries early. Thus exactly the first Stop hook after the interval queries the mailbox.
    const delay =
      previous?.last_failed_at !== undefined && previous.last_failed_at === previous.last_checked_at
        ? RETRY_MS
        : settings.interval_ms;
    const coolingDown = previous?.last_checked_at !== undefined && now - previous.last_checked_at < delay;
    if (coolingDown) return hookMessage(deps.extraNotice, language);
    let summary: PendingSummary | null = null;
    try {
      summary = await deps.fetchPending(profileName);
    } catch {
      /* Retry after a short cooldown. */
    }
    let shared: ShownState | null | undefined;
    let previewKey: string | null = null;
    if (summary && deps.shared) {
      const keys = currentKeys(summary);
      if ((deps.mode ?? 'claim') === 'preview' && deps.shared.seen) {
        try {
          const seen = await deps.shared.seen();
          if (seen !== undefined) {
            previewKey = sessionKey(profile, deps.session);
            shared = mergeShown(seen, readPreview(previewKey));
          }
        } catch {
          // Preserve the failure cooldown without claiming or announcing an unverified preview.
          summary = null;
        }
      }
      if (summary && previewKey === null) {
        if (deps.shared.claimSeen) {
          shared = await deps.shared.claimSeen(keys).catch(() => undefined);
          if (shared !== undefined) recordNewlySeen(profile, keys, shared);
        }
        if (shared === undefined) shared = await deps.shared.claim(keys).catch(() => undefined);
      }
    }
    // The account's record wins; the local one stands in when the server keeps none (older server, or first run).
    const announced = summary ? onlyNew(summary, shared ?? previous?.shown) : null;
    // What this session has now shown (or found already seen) is not previewed again in it.
    if (summary && previewKey)
      writePreview(previewKey, mergeNoticeState(readPreview(previewKey), currentKeys(summary)));
    const content =
      [announced ? notificationText(announced.fresh, settings.detail, language) : null, deps.extraNotice]
        .filter(Boolean)
        .join('\n') || null;
    const message = hookMessage(content, language);
    const state: CheckState = previous ? { ...previous } : { count: 0 };
    if (announced) state.shown = announced.shown;
    state.last_checked_at = now;
    if (summary === null) state.last_failed_at = now;
    else delete state.last_failed_at;
    delete state.last_notified_at;
    state.count = summary ? pendingCount(summary) : 0;
    saveState(file, state);
    return message;
  } catch {
    return null;
  } finally {
    try {
      release?.();
    } catch {
      /* Stop hooks must never fail the agent turn. */
    }
  }
}

function validShown(value: unknown): value is ShownState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const strings = (x: unknown) => Array.isArray(x) && x.every((i) => typeof i === 'string');
  return (
    strings(v.drops) &&
    strings(v.contacts) &&
    strings(v.invitations) &&
    strings(v.join_requests) &&
    Number.isSafeInteger(v.approvals) &&
    (v.approvals as number) >= 0
  );
}

/** Union of two records: every key in either, the larger approval count. */
export function mergeShown(
  a: ShownState | null | undefined,
  b: ShownState | null | undefined,
): ShownState | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const join = (x: string[], y: string[]) => [...new Set([...x, ...y])];
  return {
    drops: join(a.drops, b.drops).slice(-MAX_SHOWN_DROPS),
    contacts: join(a.contacts, b.contacts),
    invitations: join(a.invitations, b.invitations),
    join_requests: join(a.join_requests, b.join_requests),
    approvals: Math.max(a.approvals, b.approvals),
  };
}

/*
 * What one host session has previewed at the end of its turns, kept on this machine (sessions are local). A
 * preview is shown once per session; the next prompt in the same session knows the person had it right above
 * the input and records it as seen without repeating it.
 */
const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sessionKey(profile: { server_url: string; user_id: string }, session: string | null | undefined) {
  const server = new URL(profile.server_url).href.replace(/\/$/, '');
  return createHash('sha256')
    .update(JSON.stringify([server, profile.user_id, resolve(configDir()), session ?? 'no-session']))
    .digest('hex');
}

function previewPath(key: string): string {
  return join(stateDir(), 'hook-sessions', `${key}.json`);
}

function readPreview(key: string): ShownState | null {
  try {
    const parsed = JSON.parse(readFileSync(previewPath(key), 'utf8')) as { shown?: unknown };
    return validShown(parsed.shown) ? parsed.shown : null;
  } catch {
    return null;
  }
}

function writePreview(key: string, shown: ShownState | null): void {
  if (!shown) return;
  try {
    const directory = join(stateDir(), 'hook-sessions');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    saveState(previewPath(key), { shown, count: 0, last_checked_at: Date.now() });
    // sessions end without telling anyone: forget the ones untouched for a week
    for (const name of readdirSync(directory)) {
      const file = join(directory, name);
      if (Date.now() - statSync(file).mtimeMs > PREVIEW_TTL_MS) rmSync(file, { force: true });
    }
  } catch {
    /* A lost preview only means the next prompt shows the item once more. */
  }
}

/**
 * A moment the person is certainly at this session (they just submitted a prompt, or started or resumed it):
 * show what they have not seen in an agent yet and record it as seen for the whole account. Items this session
 * previewed at the end of a turn were right above the input, so they are recorded without being repeated. Push
 * and Feishu do not count: the person sees each item inside their agent once. Returns the people text, or null.
 */
export async function announceSeen(
  profileName: string,
  summary: PendingSummary,
  settings: NotificationSettings,
  deps: {
    claimSeen: (current: ShownState) => Promise<ShownState | null | undefined>;
    session?: string | null;
    language?: Language;
  },
): Promise<string | null> {
  if (!settings.enabled) return null;
  try {
    const profile = readProfile(profileName);
    if (!profile) return null;
    const previous = await deps.claimSeen(currentKeys(summary)).catch(() => undefined);
    // No seen record (older server) or no answer: say nothing now rather than risk announcing twice.
    if (previous === undefined) return null;
    recordNewlySeen(profile, currentKeys(summary), previous);
    const key = sessionKey(profile, deps.session);
    const base = mergeShown(previous, readPreview(key));
    writePreview(key, mergeNoticeState(readPreview(key), currentKeys(summary)));
    return notificationText(
      onlyNew(summary, base ?? undefined).fresh,
      settings.detail,
      deps.language ?? 'en',
    );
  } catch {
    return null;
  }
}

/**
 * Split what is pending into what the human has not been told about yet. Requests and invitations are tracked
 * only while they are pending, so a new request from the same person after a decline is announced again.
 * Approvals are a count: the notice fires when it grows.
 */
/**
 * The drops this claim recorded as seen for the first time, written with the time to this machine's seen log
 * (ADR 0025), so the Claude Code band can tell "seen in this session" from "seen before it started".
 */
function recordNewlySeen(profile: ProfileFile, current: ShownState, previous: ShownState | null): void {
  const before = new Set(previous?.drops ?? []);
  recordSeenLocally(
    profile,
    current.drops.filter((key) => !before.has(key)),
  );
}

/** Hashes of what is pending now; only these ever leave the machine or reach a state file. */
export function currentKeys(summary: PendingSummary): ShownState {
  const key = (kind: string, value: string) =>
    createHash('sha256').update(`${kind}\u0000${value}`).digest('hex').slice(0, 16);
  return {
    drops: summary.unread_drops.map((d) => key('drop', d.drop_id)),
    contacts: summary.contact_requests.map((c) => key('contact', c.handle)),
    invitations: summary.group_invitations.map((g) => key('invitation', g.slug)),
    join_requests: (summary.group_join_requests ?? []).map((r) =>
      key('join', `${r.slug}\u0000${r.invitee_handle}`),
    ),
    approvals: summary.approvals ?? 0,
  };
}

/**
 * Split what is pending into what the human has not been told about yet, given the record of what was shown.
 * The record after this announcement is `mergeNoticeState(shown, currentKeys(summary))`, the same rule the
 * server applies in its atomic claim.
 */
export function onlyNew(
  summary: PendingSummary,
  shown: ShownState | undefined,
): { fresh: PendingSummary; shown: ShownState } {
  const keys = currentKeys(summary);
  const seen = {
    drops: new Set(shown?.drops ?? []),
    contacts: new Set(shown?.contacts ?? []),
    invitations: new Set(shown?.invitations ?? []),
    joins: new Set(shown?.join_requests ?? []),
  };
  const newDrops = summary.unread_drops.filter((_, i) => !seen.drops.has(keys.drops[i] ?? ''));
  const atLeast =
    shown !== undefined &&
    newDrops.length > 0 &&
    newDrops.length === summary.unread_drops.length &&
    summary.unread > summary.unread_drops.length;
  const approvals = keys.approvals;
  const joins = summary.group_join_requests ?? [];
  return {
    fresh: {
      ...summary,
      // The first announcement covers the whole backlog, including rows beyond the fetched window. After that
      // only the fetched rows can be told apart, so the count is exactly what is listed as new — unless every
      // fetched row is new and the server holds more: then more new ones may lie beyond the window ("at least").
      unread: shown ? newDrops.length : summary.unread,
      ...(atLeast ? { unread_at_least: true } : {}),
      unread_drops: newDrops,
      contact_requests: summary.contact_requests.filter((_, i) => !seen.contacts.has(keys.contacts[i] ?? '')),
      group_invitations: summary.group_invitations.filter(
        (_, i) => !seen.invitations.has(keys.invitations[i] ?? ''),
      ),
      group_join_requests: joins.filter((_, i) => !seen.joins.has(keys.join_requests[i] ?? '')),
      approvals: approvals > (shown?.approvals ?? 0) ? approvals : 0,
    },
    shown: mergeNoticeState(shown, keys),
  };
}

function saveState(file: string, state: CheckState): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function cleanExternal(value: string, max = 32): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * A field an older server never sends must not turn the cached count into NaN: a NaN count fails the
 * `Number.isSafeInteger` check on the next read, which throws the cache away and hands out a second notice
 * inside the user's interval.
 */
function pendingCount(summary: PendingSummary): number {
  const total =
    (summary.unread ?? 0) +
    (summary.approvals ?? 0) +
    (summary.contact_requests?.length ?? 0) +
    (summary.group_invitations?.length ?? 0) +
    (summary.group_join_requests?.length ?? 0);
  return Number.isSafeInteger(total) && total >= 0 ? total : 0;
}

/** Truncate on a line boundary so no harness ever shows half an item or half a character. */
export function capNotice(
  text: string,
  language: Language = 'en',
  truncatedLine?: string,
  limit = NOTICE_LIMIT,
): string {
  if (text.length <= limit) return text;
  const truncated = truncatedLine ?? TRUNCATED_LINE[language];
  const budget = limit - truncated.length - 1;
  const kept: string[] = [];
  let used = 0;
  for (const line of text.split('\n')) {
    const next = kept.length === 0 ? line.length : used + 1 + line.length;
    if (next > budget) break;
    kept.push(line);
    used = next;
  }
  kept.push(truncated);
  return kept.join('\n');
}

function hookMessage(content: string | null | undefined, language: Language = 'en'): string | null {
  return content ? capNotice(content, language) : null;
}

/** Everything the renderer says, per audience and language; the items and their order are shared. */
interface Strings {
  title: string;
  unread: (n: number) => string;
  /** More new messages than were fetched may exist: `n` is how many are known to be new. */
  unreadAtLeast: (n: number) => string;
  /** One message line. `id` is the full drop id for the model; people never see ids (they ask by title). */
  drop: (
    id: string,
    sender: string,
    title: string,
    attachments: number,
    mentioned: boolean,
    /** Title of the drop it answers, when the person may read it. */
    replyTo: string | null,
  ) => string;
  direct: string;
  /** `label` is `#slug` or `"name" #slug`; empty when an older server did not name the group. */
  group: (label: string) => string;
  groupLabel: (name: string, slug: string) => string;
  untitled: string;
  moreUnread: (n: number) => string;
  /** Overflow line when the total is only a lower bound; `n` may be 0 (every known one is listed). */
  moreUnreadAtLeast: (n: number) => string;
  contacts: (n: number) => string;
  invitations: (n: number) => string;
  joinRequests: (n: number) => string;
  joinRequest: (slug: string, invitee: string, by: string) => string;
  more: (n: number) => string;
  approvals: (n: number) => string;
  footer?: string;
  /** Model only: what an item new since the last list in this session is marked with. */
  newMark?: string;
  /** Model only: the line after the title that says what changed since the last list in this session. */
  changes?: (added: number, gone: number) => string;
}

const HUMAN: Record<Language, Strings> = {
  en: {
    title: 'AgentDrop: new',
    unread: (n) => `New messages: ${n}`,
    unreadAtLeast: (n) => `New messages: at least ${n}`,
    drop: (_id, sender, title, a, m, r) =>
      `- ${sender}${m ? ' mentioned you' : ''}${r ? ` replied to "${r}"` : ''} · "${title}"${a ? ` · ${a} attachment${a > 1 ? 's' : ''}` : ''}`,
    direct: 'Direct messages:',
    group: (label) => (label ? `In group ${label}:` : 'Group messages:'),
    groupLabel: (name, slug) => `“${name}” #${slug}`,
    untitled: '(untitled)',
    moreUnread: (n) =>
      `- ${n} more new message${n > 1 ? 's' : ''} not listed; ask your agent to catch you up`,
    moreUnreadAtLeast: (n) =>
      n > 0
        ? `- at least ${n} more new message${n > 1 ? 's' : ''} not listed; ask your agent to catch you up`
        : '- more new messages not listed; ask your agent to catch you up',
    contacts: (n) => `Contact requests: ${n}`,
    invitations: (n) => `Group invitations: ${n}`,
    joinRequests: (n) => `Join requests: ${n} (only you can decide, in the dashboard)`,
    joinRequest: (slug, invitee, by) => `- #${slug} ← @${invitee} (invited by @${by})`,
    more: (n) => `- ${n} more not listed`,
    approvals: (n) => `Pending approvals: ${n} (only you can approve, in a terminal or the dashboard)`,
  },
  zh: {
    title: 'AgentDrop 新通知',
    unread: (n) => `新消息：${n} 条`,
    unreadAtLeast: (n) => `新消息：至少 ${n} 条`,
    drop: (_id, sender, title, a, m, r) =>
      `- ${sender}${m ? ' @了你' : ''}${r ? ` 回复了「${r}」·` : ' ·'}「${title}」${a ? ` · ${a} 个附件` : ''}`,
    direct: '私信：',
    group: (label) => (label ? `群 ${label}：` : '群消息：'),
    groupLabel: (name, slug) => `「${name}」#${slug}`,
    untitled: '无标题',
    moreUnread: (n) => `- 另有 ${n} 条新消息未列出，可以让 Agent 帮你过一遍`,
    moreUnreadAtLeast: (n) =>
      n > 0
        ? `- 另有至少 ${n} 条新消息未列出，可以让 Agent 帮你过一遍`
        : '- 另有更多新消息未列出，可以让 Agent 帮你过一遍',
    contacts: (n) => `联系人申请：${n} 个`,
    invitations: (n) => `群邀请：${n} 个`,
    joinRequests: (n) => `入群申请：${n} 个（只能由用户在网页确认）`,
    joinRequest: (slug, invitee, by) => `- #${slug} ← @${invitee}（@${by} 邀请）`,
    more: (n) => `- 另有 ${n} 个未列出`,
    approvals: (n) => `待人工审批：${n} 条（只能由用户在终端或网页确认）`,
  },
};

/** Models read English; the user never sees this, so it does not follow the language setting. */
const MODEL: Strings = {
  ...HUMAN.en,
  title: 'AgentDrop pending items',
  unread: (n) => `Unread drops: ${n}`,
  unreadAtLeast: (n) => `Unread drops: at least ${n}`,
  drop: (id, sender, title, a, m, r) =>
    `- drop_id=${id} ${sender}${m ? ' (mentions the user)' : ''}${r ? ` (replies to "${r}")` : ''} · "${title}"${a ? ` · ${a} attachment${a > 1 ? 's' : ''}` : ''}`,
  direct: 'Direct (sent to the user personally):',
  group: (label) => (label ? `Group ${label}:` : 'Group drops:'),
  // Whatever does not fit is not listed; every overflow line says where the rest is, so nothing looks like the whole set.
  moreUnread: (n) => `- ${n} more unread, not listed (use list_drops)`,
  moreUnreadAtLeast: (n) => `- ${n > 0 ? `at least ${n}` : 'more'} unread, not listed (use list_drops)`,
  more: (n) => `- ${n} more not listed (use pending_requests)`,
  footer:
    'Only if the user asks: the AgentDrop list_drops / read_drop tools read these. Join requests and approvals can only be decided by the user.',
  newMark: 'NEW',
  changes: (added, gone) =>
    `Since the list earlier in this session: ${added} new (marked NEW, listed first), ${gone} from that list no longer listed.`,
};

/** How many of each kind a rendering lists inline; the rest are counted in an overflow line. */
interface Inline {
  drops: number;
  requests: number;
  joins: number;
}
const PEOPLE_INLINE: Inline = { drops: INLINE_ITEMS, requests: INLINE_ITEMS, joins: INLINE_JOIN_REQUESTS };

type PendingDrop = PendingSummary['unread_drops'][number];

/** Items that were not in the list given earlier in this session, by their raw identifiers (model context only). */
interface NewItems {
  drops: Set<string>;
  contacts: Set<string>;
  invitations: Set<string>;
  joins: Set<string>;
  /** How many items of the earlier list are no longer pending. */
  gone: number;
}

/** New items first, the given order kept otherwise; without marks the order is unchanged. */
function newFirst<T>(items: T[], isNew: (item: T) => boolean): T[] {
  return items
    .map((item, index) => ({ item, index, rank: isNew(item) ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.item);
}

/** `- text` becomes `- NEW text` for a new item; unchanged when the strings have no mark. */
function marked(line: string, isNew: boolean, t: Strings): string {
  return isNew && t.newMark ? line.replace(/^- /, `- ${t.newMark} `) : line;
}

/**
 * What a notice lists first, for people and models alike: direct messages, then the ones that @mention the person,
 * then the rest. Time order (the list's order) is kept within each class, so a burst of group traffic never pushes
 * a direct message or a mention past the inline limit.
 */
export function noticeOrder(drops: PendingDrop[]): PendingDrop[] {
  const rank = (d: PendingDrop) => (!d.group ? 0 : d.mentioned_me === true ? 1 : 2);
  return drops
    .map((drop, index) => ({ drop, index }))
    .sort((a, b) => rank(a.drop) - rank(b.drop) || a.index - b.index)
    .map((x) => x.drop);
}

/**
 * Group mute is for people: a drop that reached this person only through groups they muted is not announced to
 * them unless it @mentions them. It stays unread, counted and in the model's context.
 */
function forPeople(summary: PendingSummary): PendingSummary {
  const kept = summary.unread_drops.filter((d) => !(d.muted === true && d.mentioned_me !== true));
  const removed = summary.unread_drops.length - kept.length;
  if (removed === 0) return summary;
  return { ...summary, unread: Math.max(kept.length, summary.unread - removed), unread_drops: kept };
}

function renderPending(
  summary: PendingSummary,
  detail: NotificationSettings['detail'],
  t: Strings,
  inline: Inline = PEOPLE_INLINE,
  fresh?: NewItems,
): string[] | null {
  const isNewDrop = (d: PendingDrop) => fresh?.drops.has(d.drop_id) === true;
  const isNewContact = (c: PendingSummary['contact_requests'][number]) =>
    fresh?.contacts.has(c.handle) === true;
  const isNewInvitation = (g: PendingSummary['group_invitations'][number]) =>
    fresh?.invitations.has(g.slug) === true;
  const isNewJoin = (r: NonNullable<PendingSummary['group_join_requests']>[number]) =>
    fresh?.joins.has(`${r.slug}\u0000${r.invitee_handle}`) === true;
  const joinRequests = newFirst(summary.group_join_requests ?? [], isNewJoin);
  const contactRequests = newFirst(summary.contact_requests, isNewContact);
  const invitations = newFirst(summary.group_invitations, isNewInvitation);
  if (
    summary.unread === 0 &&
    summary.contact_requests.length === 0 &&
    summary.group_invitations.length === 0 &&
    joinRequests.length === 0 &&
    summary.approvals === 0
  )
    return null;
  // The profile's agent_name is local, private and identical on every turn: it belongs nowhere near this text.
  const lines = [t.title];
  if (fresh && t.changes) {
    const added =
      summary.unread_drops.filter(isNewDrop).length +
      contactRequests.filter(isNewContact).length +
      invitations.filter(isNewInvitation).length +
      joinRequests.filter(isNewJoin).length;
    lines.push(t.changes(added, fresh.gone));
  }
  if (summary.unread > 0) {
    const atLeast = summary.unread_at_least === true;
    lines.push(atLeast ? t.unreadAtLeast(summary.unread) : t.unread(summary.unread));
    // Direct messages first, then one section per group, each naming the group; mentions lead within the groups.
    // New ones lead (model context after a change), so the size cap never drops a new item before an old one.
    const listedDrops = newFirst(noticeOrder(summary.unread_drops), isNewDrop).slice(0, inline.drops);
    const sections = new Map<string, { header: string; drops: PendingDrop[] }>();
    for (const drop of listedDrops) {
      const group = drop.group ?? null;
      const key = group ? `group:${group.slug}` : 'direct';
      if (!sections.has(key)) {
        const slug = group ? cleanExternal(group.slug) : '';
        const name = group ? cleanExternal(group.name, 40) : '';
        // a group is always named, whatever the detail setting: "#lab" alone says little to a person
        const label = !slug ? '' : name ? t.groupLabel(name, slug) : `#${slug}`;
        sections.set(key, { header: group ? t.group(label) : t.direct, drops: [] });
      }
      sections.get(key)?.drops.push(drop);
    }
    const ordered = [...sections.entries()].sort(([a], [b]) =>
      a === 'direct' ? -1 : b === 'direct' ? 1 : 0,
    );
    for (const [, section] of ordered) {
      lines.push(section.header);
      for (const drop of section.drops) {
        const sender =
          detail === 'names'
            ? `${cleanExternal(drop.author.display_label)} @${cleanExternal(drop.author.handle)}`
            : `@${cleanExternal(drop.author.handle)}`;
        lines.push(
          marked(
            t.drop(
              drop.drop_id,
              sender,
              cleanExternal(drop.title, 80) || t.untitled,
              drop.attachment_count,
              drop.mentioned_me === true,
              drop.reply_to_title ? cleanExternal(drop.reply_to_title, 60) || t.untitled : null,
            ),
            isNewDrop(drop),
            t,
          ),
        );
      }
    }
    const listed = listedDrops.length;
    if (atLeast) lines.push(t.moreUnreadAtLeast(Math.max(0, summary.unread - listed)));
    else if (summary.unread > listed) lines.push(t.moreUnread(summary.unread - listed));
  }
  if (contactRequests.length) {
    lines.push(t.contacts(contactRequests.length));
    for (const request of contactRequests.slice(0, inline.requests))
      lines.push(
        marked(
          detail === 'names'
            ? `- ${cleanExternal(request.display_name)} @${cleanExternal(request.handle)}`
            : `- @${cleanExternal(request.handle)}`,
          isNewContact(request),
          t,
        ),
      );
    if (contactRequests.length > inline.requests)
      lines.push(t.more(contactRequests.length - inline.requests));
  }
  if (invitations.length) {
    lines.push(t.invitations(invitations.length));
    for (const invitation of invitations.slice(0, inline.requests))
      lines.push(
        marked(
          cleanExternal(invitation.display_name, 40)
            ? `- ${t.groupLabel(cleanExternal(invitation.display_name, 40), cleanExternal(invitation.slug))}`
            : `- #${cleanExternal(invitation.slug)}`,
          isNewInvitation(invitation),
          t,
        ),
      );
    if (invitations.length > inline.requests) lines.push(t.more(invitations.length - inline.requests));
  }
  if (joinRequests.length) {
    // No tool and no CLI command decides these; the decision link stays in the interactive `agentdrop pending`.
    lines.push(t.joinRequests(joinRequests.length));
    for (const request of joinRequests.slice(0, inline.joins))
      lines.push(
        marked(
          t.joinRequest(
            cleanExternal(request.slug),
            cleanExternal(request.invitee_handle),
            cleanExternal(request.invited_by_handle),
          ),
          isNewJoin(request),
          t,
        ),
      );
    if (joinRequests.length > inline.joins) lines.push(t.more(joinRequests.length - inline.joins));
  }
  if (summary.approvals > 0) lines.push(t.approvals(summary.approvals));
  if (t.footer) lines.push(t.footer);
  return lines;
}

/**
 * The human notice every harness shows, in the user's language (English by default). Pass it only what is new
 * (`onlyNew`): it announces, it does not keep reminding. It names what arrived and nothing else — no terminal
 * commands (a person in a chat harness just asks the agent) and no model-directed instruction. Drops from muted
 * groups are left out unless they mention the person.
 */
export function notificationText(
  summary: PendingSummary,
  detail: NotificationSettings['detail'],
  language: Language = 'en',
): string | null {
  const lines = renderPending(forPeople(summary), detail, HUMAN[language]);
  return lines ? capNotice(lines.join('\n'), language) : null;
}

/**
 * The one line Claude Code's status bar shows: what the person has not seen in an agent yet, with up to three
 * names (direct and mentions first), or an empty string. Muted groups follow the notice rule.
 */
export function statusLineText(fresh: PendingSummary, language: Language = 'en'): string {
  const people = forPeople(fresh);
  const messages = people.unread;
  const requests =
    people.contact_requests.length +
    people.group_invitations.length +
    (people.group_join_requests?.length ?? 0);
  const approvals = people.approvals ?? 0;
  if (messages === 0 && requests === 0 && approvals === 0) return '';
  const who = [
    ...new Set(
      noticeOrder(people.unread_drops).map((d) =>
        d.group?.slug ? `#${cleanExternal(d.group.slug)}` : `@${cleanExternal(d.author.handle)}`,
      ),
    ),
  ].slice(0, 3);
  const zh = language === 'zh';
  const parts: string[] = [];
  if (messages > 0) {
    const names = who.length ? (zh ? `（${who.join('、')}）` : ` (${who.join(', ')})`) : '';
    parts.push(
      zh ? `${messages} 条新消息${names}` : `${messages} new message${messages > 1 ? 's' : ''}${names}`,
    );
  }
  if (requests > 0) parts.push(zh ? `${requests} 个申请` : `${requests} request${requests > 1 ? 's' : ''}`);
  if (approvals > 0)
    parts.push(zh ? `${approvals} 条待审批` : `${approvals} approval${approvals > 1 ? 's' : ''} waiting`);
  // a full-width bracket already ends the phrase; no space before the next separator in Chinese
  return `✉ AgentDrop · ${parts.join(' · ')}`.replaceAll('） · ', '）· ');
}

const MODEL_TRUNCATED = '- … (truncated; use list_drops / pending_requests for the full list)';

/**
 * The model's view, for prompt-time context the user never sees: the same items, but everything currently
 * pending that was fetched (handling needs the whole picture, muted groups included), in English, pointing at the
 * tools the model actually has. Drops that do not fit the size cap are counted in the overflow line rather than
 * cut off mid-list. The caller adds the trust boundary around it.
 *
 * `previous` is what the list given earlier in this session held (hashed keys, ADR 0031): items not in it are
 * marked NEW and listed first, and a line after the title counts what is new and what is no longer pending.
 */
export function pendingContextText(
  summary: PendingSummary,
  opts: { previous?: ShownState | null } = {},
): string | null {
  const all = {
    drops: summary.unread_drops.length,
    requests: Number.POSITIVE_INFINITY,
    joins: Number.POSITIVE_INFINITY,
  };
  const fresh = opts.previous ? newItems(summary, opts.previous) : undefined;
  let lines = renderPending(summary, 'counts', MODEL, all, fresh);
  if (!lines) return null;
  for (let drops = all.drops - 1; drops >= 0 && lines.join('\n').length > MODEL_CONTEXT_LIMIT; drops--)
    lines = renderPending(summary, 'counts', MODEL, { ...all, drops }, fresh) ?? lines;
  return capNotice(lines.join('\n'), 'en', MODEL_TRUNCATED, MODEL_CONTEXT_LIMIT);
}

/** What is pending now and was not in `previous`, and how many of `previous` are gone. */
function newItems(summary: PendingSummary, previous: ShownState): NewItems {
  const keys = currentKeys(summary);
  const before = {
    drops: new Set(previous.drops),
    contacts: new Set(previous.contacts),
    invitations: new Set(previous.invitations),
    joins: new Set(previous.join_requests),
  };
  const pick = <T>(items: T[], hashes: string[], had: Set<string>, id: (item: T) => string) =>
    new Set(items.filter((_, i) => !had.has(hashes[i] ?? '')).map(id));
  const now = new Set([...keys.drops, ...keys.contacts, ...keys.invitations, ...keys.join_requests]);
  const gone = [
    ...previous.drops,
    ...previous.contacts,
    ...previous.invitations,
    ...previous.join_requests,
  ].filter((key) => !now.has(key)).length;
  return {
    drops: pick(summary.unread_drops, keys.drops, before.drops, (d) => d.drop_id),
    contacts: pick(summary.contact_requests, keys.contacts, before.contacts, (c) => c.handle),
    invitations: pick(summary.group_invitations, keys.invitations, before.invitations, (g) => g.slug),
    joins: pick(
      summary.group_join_requests ?? [],
      keys.join_requests,
      before.joins,
      (r) => `${r.slug}\u0000${r.invitee_handle}`,
    ),
    gone,
  };
}
