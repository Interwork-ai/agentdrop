import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ApiClient } from '@agentdrop/client';
import { type DropSummary, LIMITS } from '@agentdrop/contracts';
import { readEffectiveHookSettings } from '../client-preferences.js';
import { dropNoticeSource } from '../drop-notice-source.js';
import { type Language, readLanguage } from '../locale.js';
import type { Output } from '../output.js';
import { configDir, stateDir } from '../paths.js';
import { dropSeenKey, readSeenLog } from '../seen-log.js';
import { acquireStateLock } from '../state-lock.js';
import { readProfile, writePrivateFile } from '../store.js';
import { resolveGroupId } from './group.js';
import { clientFor, errorCode, markDropRead, resolveDropId } from './mail.js';

/*
 * Data for the Claude Code mod's band above the prompt (apps/cli/claude-mod): what is waiting for the person, one row
 * per drop that is theirs to answer (direct, mentioning them, or a reply to their own drop), one row per group for the
 * rest, and counts for requests and approvals. The mod runs these commands; it never holds a credential itself.
 */

/** Every Claude Code session on the machine polls; one shared cache per profile keeps that to one query per window. */
const CACHE_MS = 15_000;
/** How long a call waits for another session's refresh (when it has nothing to show, or after `--fresh`). */
const WAIT_MS = 5_000;
/** Unread pages read per refresh (50 each): enough that direct drops and mentions do not hide behind group chatter. */
const MAX_PAGES = 4;
const TITLE_MAX = 80;
const NAME_MAX = 40;

export interface BandDrop {
  drop_id: string;
  title: string;
  from: { handle: string; label: string };
  group: { group_id: string; slug: string; name: string } | null;
  mentioned: boolean;
  /** Title of the drop it answers, when the person may read it and it may be theirs. */
  reply_to_title: string | null;
  /** Whether the drop it answers is the person's own; null when the server does not say (before 0.5.9). */
  reply_to_mine: boolean | null;
  attachments: number;
  created_at: string;
  /** When it reached the person; the band sorts by this, as the dashboard does. */
  received_at: string | null;
  /**
   * When it was first seen inside an agent (ADR 0025): null not yet, 0 before anything this machine logged (another
   * machine, or earlier), else this machine's time. Absent when the server keeps no seen record (older server).
   */
  seen_at?: number | null;
}

export interface BandGroup {
  group_id: string;
  slug: string;
  name: string;
  count: number;
  /** Up to three people who wrote, newest first. */
  from: string[];
  /** The newest listed drop's received time: "Later" remembers it, so a newer message brings the row back. */
  up_to: string;
  /** The drops this row stands for: its "Mark read" marks these and nothing else; the pane lists them to open. */
  drops: Array<{
    drop_id: string;
    state_version: number;
    title: string;
    from: string;
    at: string;
    seen_at?: number | null;
  }>;
}

export interface BandData {
  /** People notices on; when off the band stays hidden, but the pane the person opens still lists what is unread. */
  enabled: boolean;
  language: Language;
  drops: BandDrop[];
  groups: BandGroup[];
  requests: { contacts: number; invitations: number; join_requests: number; approvals: number };
  /** Unread drops beyond the listed window (the person has more than the band reads). */
  more: number;
  at: number;
  /**
   * Hashes of the drops in the account's seen record when this was fetched; null when the server keeps none. Cached
   * with the rest, turned into `seen_at` per drop on output and never printed.
   */
  seen?: string[] | null;
}

/**
 * At most `max` UTF-16 units (how the server counts lengths), cut between characters: never half of a surrogate
 * pair (an emoji, a rare CJK character).
 */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  let out = '';
  for (const char of value) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
}

/** External text for a terminal row: no control or format characters, one line, bounded. */
function clean(value: string, max: number): string {
  return truncate(
    value
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    max,
  );
}

function cachePath(profileName: string, profile: { server_url: string; user_id: string }): string {
  const server = new URL(profile.server_url).href.replace(/\/$/, '');
  const key = createHash('sha256')
    .update(JSON.stringify([server, profile.user_id, profileName, resolve(configDir())]))
    .digest('hex');
  return join(stateDir(), 'band', `${key}.json`);
}

function readCache(path: string): BandData | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as BandData;
    return typeof data.at === 'number' && Array.isArray(data.drops) ? data : null;
  } catch {
    return null;
  }
}

/** After the person acted (acknowledged, marked read), no session may show what the band held before. */
function invalidateBand(profileName: string): void {
  try {
    const profile = readProfile(profileName);
    if (profile) rmSync(cachePath(profileName, profile), { force: true });
  } catch {
    /* the next refresh replaces it anyway */
  }
}

/** A failure the mod can name for the person: by code, never by the words of a message. */
export class BandFailure extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

function modClient(profileName: string): ApiClient {
  try {
    return clientFor(profileName).client;
  } catch {
    throw new BandFailure('NOT_PAIRED');
  }
}

/**
 * What `agentdrop --json` prints on stdout when a command the mod runs fails: the error's code and the person's
 * language, so the mod says what happened in its own words (no server text, ids or commands reach the person).
 */
export function modFailure(
  err: unknown,
  profileName?: string,
): { error: { code: string }; language: Language; enabled?: boolean } {
  let enabled: boolean | undefined;
  try {
    // whether people notices are on, from local settings: with them off the band says nothing, failures included
    if (profileName) enabled = readEffectiveHookSettings(profileName).notifications.enabled;
  } catch {
    /* unknown: the mod keeps what it last knew */
  }
  return {
    error: { code: errorCode(err) },
    language: readLanguage(),
    ...(enabled === undefined ? {} : { enabled }),
  };
}

/** The drop is the person's to answer: sent to them, calling on them, or answering their own drop. */
function replyToMine(d: DropSummary): boolean | null {
  // `mine` arrives with servers 0.5.9+; widened locally until the client's contract has it
  const mine = (d.reply_to as { mine?: unknown } | null | undefined)?.mine;
  return typeof mine === 'boolean' ? mine : null;
}

async function unreadInbox(
  client: ApiClient,
): Promise<{ drops: DropSummary[]; unread: number; mutedUnread: number | null; complete: boolean }> {
  const drops: DropSummary[] = [];
  let unread = 0;
  let mutedUnread: number | null = null;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await client.listDrops({
      view: 'inbox',
      unread_only: true,
      limit: LIMITS.LIST_LIMIT_MAX,
      ...(cursor ? { cursor } : {}),
    });
    if (page === 0) {
      unread = res.unread_count;
      // servers before 0.5.9 do not say how many of those stay quiet
      const muted = (res as { muted_unread_count?: unknown }).muted_unread_count;
      mutedUnread = typeof muted === 'number' && Number.isInteger(muted) && muted >= 0 ? muted : null;
    }
    drops.push(...res.drops);
    cursor = res.next_cursor;
    if (!cursor) break;
  }
  return { drops, unread, mutedUnread, complete: cursor === null };
}

async function fetchBand(profileName: string, now: number): Promise<BandData> {
  const settings = readEffectiveHookSettings(profileName);
  const client = modClient(profileName);
  const [identity, requests, inbox, seen] = await Promise.all([
    client.identity(),
    client.pendingRequests(),
    unreadInbox(client),
    // whether each drop was already seen inside an agent (ADR 0025); an older server keeps no such record
    client.seenNoticeState().then(
      (res) => res.state?.drops ?? [],
      () => null,
    ),
  ]);
  const drops: BandDrop[] = [];
  const groups = new Map<string, BandGroup>();
  for (const d of inbox.drops) {
    const { group: label } = dropNoticeSource(d);
    const mentioned = d.mentioned_me === true;
    const at = d.received_at ?? d.created_at;
    // a muted group stays quiet unless the drop calls on the person (ADR 0015)
    if (d.muted === true && !mentioned) continue;
    const mine = replyToMine(d);
    // a reply to someone else's drop is like any other drop; an older server cannot say, so it keeps its row
    const replyTitle = d.reply_to?.title && mine !== false ? clean(d.reply_to.title, TITLE_MAX) : null;
    // Without a group address, keep an individual row that can still be opened by drop id.
    if (!label?.group_id || mentioned || replyTitle) {
      drops.push({
        drop_id: d.drop_id,
        title: clean(d.title, TITLE_MAX),
        from: { handle: clean(d.author.handle, NAME_MAX), label: clean(d.author.display_label, NAME_MAX) },
        group: label
          ? {
              group_id: label.group_id,
              slug: clean(label.slug, NAME_MAX),
              name: clean(label.display_name, NAME_MAX),
            }
          : null,
        mentioned,
        reply_to_title: replyTitle,
        reply_to_mine: replyTitle ? mine : null,
        attachments: d.attachment_count,
        created_at: d.created_at,
        received_at: d.received_at,
      });
      continue;
    }
    const g = groups.get(label.group_id) ?? {
      group_id: label.group_id,
      slug: clean(label.slug, NAME_MAX),
      name: clean(label.display_name, NAME_MAX),
      count: 0,
      from: [],
      up_to: at,
      drops: [],
    };
    g.count += 1;
    const who = clean(d.author.display_label, NAME_MAX);
    g.drops.push({
      drop_id: d.drop_id,
      state_version: d.state_version,
      title: clean(d.title, TITLE_MAX),
      from: who,
      at,
    });
    if (g.from.length < 3 && !g.from.includes(who)) g.from.push(who);
    if (at > g.up_to) g.up_to = at;
    groups.set(label.group_id, g);
  }
  return {
    enabled: settings.notifications.enabled,
    language: readLanguage(),
    drops,
    groups: [...groups.values()],
    requests: {
      contacts: requests.contact_requests_received.length,
      invitations: requests.group_invitations.length,
      join_requests: (requests.group_join_requests ?? []).length,
      approvals: identity.viewer.pending.approvals ?? 0,
    },
    more: moreUnread(inbox),
    at: now,
    seen,
  };
}

/**
 * What the band prints: the cached data with `seen_at` on every drop, from the account's seen record and this
 * machine's seen log (read fresh, so a session that started a moment ago sees what its own hook just recorded).
 * The mod lists in a session only what was not seen before that session started (ADR 0025).
 */
export function withSeenAt(data: BandData, log: Record<string, number>): BandData {
  const { seen, ...rest } = data;
  if (seen === undefined || seen === null) return rest;
  const inRecord = new Set(seen);
  const seenAt = (dropId: string) => {
    const key = dropSeenKey(dropId);
    return log[key] ?? (inRecord.has(key) ? 0 : null);
  };
  return {
    ...rest,
    drops: rest.drops.map((d) => ({ ...d, seen_at: seenAt(d.drop_id) })),
    groups: rest.groups.map((g) => ({
      ...g,
      drops: g.drops.map((d) => ({ ...d, seen_at: seenAt(d.drop_id) })),
    })),
  };
}

/**
 * Unread drops beyond the window the band read, not counting the quiet ones (muted groups that do not call on the
 * person), which the band never lists. When every unread drop was read there is nothing more; beyond the window the
 * server says how many stay quiet (0.5.9+), else its total is all the band has.
 */
export function moreUnread(inbox: {
  drops: Array<Pick<DropSummary, 'muted' | 'mentioned_me'>>;
  unread: number;
  mutedUnread: number | null;
  complete: boolean;
}): number {
  if (inbox.complete) return 0;
  if (inbox.mutedUnread === null) return Math.max(0, inbox.unread - inbox.drops.length);
  const listable = inbox.drops.filter((d) => !(d.muted === true && d.mentioned_me !== true)).length;
  return Math.max(0, inbox.unread - inbox.mutedUnread - listable);
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * The band's data, from the shared cache unless it is older than CACHE_MS. `fresh` (after the person acted) accepts
 * only data whose query started after this call did: it waits for a refresh another session is running and then
 * queries itself, so it never answers with what was there before the action. A call with no cache at all while
 * another session refreshes (several sessions starting at once) waits for that session's result the same way; only
 * after WAIT_MS it fails with BUSY, which the mod does not count as a failed refresh.
 */
export async function bandData(
  profileName: string,
  opts: { fresh?: boolean; now?: number; waitMs?: number } = {},
): Promise<BandData> {
  const now = opts.now ?? Date.now();
  const profile = readProfile(profileName);
  if (!profile) throw new BandFailure('NOT_PAIRED');
  const path = cachePath(profileName, profile);
  const usable = (c: BandData | null): c is BandData =>
    c !== null && (opts.fresh ? c.at >= now : c.at <= now && now - c.at < CACHE_MS);
  const cached = readCache(path);
  if (usable(cached)) return cached;
  mkdirSync(join(stateDir(), 'band'), { recursive: true, mode: 0o700 });
  let release = acquireStateLock(`${path}.lock`);
  if (!release) {
    // another session is refreshing right now: what we have is at most one window old
    if (!opts.fresh && cached) return cached;
    // nothing yet (or only what was there before the action): wait for that session's result, briefly
    const theirsWill = (c: BandData | null): c is BandData => (opts.fresh ? usable(c) : c !== null);
    const until = Date.now() + (opts.waitMs ?? WAIT_MS);
    while (!release && Date.now() < until) {
      await pause(100);
      const theirs = readCache(path);
      if (theirsWill(theirs)) return theirs;
      release = acquireStateLock(`${path}.lock`);
    }
    if (!release) throw new BandFailure('BUSY');
  }
  try {
    // it may have been refreshed while we waited for the lock
    const current = readCache(path);
    if (usable(current)) return current;
    const data = await fetchBand(profileName, now);
    writePrivateFile(path, `${JSON.stringify(data)}\n`);
    return data;
  } finally {
    release();
  }
}

export async function bandCommand(out: Output, opts: { profile: string; fresh?: boolean }): Promise<void> {
  const cached = await bandData(opts.profile, { fresh: opts.fresh === true });
  const profile = readProfile(opts.profile);
  const data = withSeenAt(cached, profile ? readSeenLog(profile) : {});
  out.result(data, () => JSON.stringify(data));
}

const ACK_TEXT = {
  en: "Got it, I'm on it.",
  zh: '收到，我在处理了。',
};

/** A group as people read it: `“Name” #slug` / `「Name」#slug`, just `#slug` when it has no name. */
export function groupLabel(language: Language, name: string, slug: string): string {
  if (!name) return `#${slug}`;
  return language === 'zh' ? `「${name}」#${slug}` : `“${name}” #${slug}`;
}

/** The person's one-line plan sent with the acknowledgement (`ack --note`): one line, no controls, capped. */
export function ackNote(raw: string | undefined): string {
  const line = (raw ?? '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a note is one plain line
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > ACK_NOTE_MAX ? `${line.slice(0, ACK_NOTE_MAX - 1)}…` : line;
}
const ACK_NOTE_MAX = 280;

/** What the person reads after pressing "On it", by what the server did with the reply. */
function ackMessage(language: Language, outcome: string, where: string): string {
  const en: Record<string, string> = {
    delivered: `Replied to ${where}: ${ACK_TEXT.en}`,
    needs_approval: `Your reply to ${where} waits for your approval in the dashboard.`,
    not_sent: `Your reply to ${where} was not sent.`,
    already_sent: 'You already replied to that.',
  };
  const zh: Record<string, string> = {
    already_sent: '已经回复过了。',
    delivered: `已回复 ${where}：${ACK_TEXT.zh}`,
    needs_approval: `给 ${where} 的回复要先在网页上确认才会发出。`,
    not_sent: `给 ${where} 的回复没有发出。`,
  };
  const unknown = {
    en: `Not sure yet whether your reply reached ${where}.`,
    zh: `还不确定回复是否已经送到 ${where}。`,
  };
  return (language === 'zh' ? zh : en)[outcome] ?? unknown[language];
}

function isMentionRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; details?: { field?: unknown } } | null;
  return e?.code === 'VALIDATION_FAILED' && e.details?.field === 'mentions';
}

function isIdempotencyConflict(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'IDEMPOTENCY_CONFLICT';
}

/**
 * `agentdrop ack <drop>`: the person's one-press acknowledgement (ADR 0021). A quoted reply where the drop was asked:
 * to its author for a direct drop, in its group with the author mentioned otherwise; if the author has left the
 * group, in the group without the mention (the members still see it is in hand). The request id is derived from the
 * drop and the language, so pressing twice sends one reply. Replying marks the drop read for the person (ADR 0016).
 * A request id already used with other content (the author's handle changed since, so the mention differs; or the
 * author left and rejoined, so the first press went without the mention) means the person already replied: that is
 * what they are told, and nothing is sent again (one acknowledgement per drop, ADR 0021).
 */
export async function ackCommand(
  out: Output,
  opts: { profile: string; dropId: string; note?: string },
): Promise<void> {
  const client = modClient(opts.profile);
  const profile = readProfile(opts.profile);
  // the mod passes full ids; a person at a terminal may give the first characters
  const dropId = await resolveDropId(client, opts.dropId);
  const note = ackNote(opts.note);
  const { drop } = await client.readDrop({ drop_id: dropId, max_chars: 1 });
  if (profile && drop.author.user_id === profile.user_id) throw new BandFailure('OWN_DROP');
  const group = (drop.sources ?? []).includes('direct') ? null : (drop.group_labels?.[0] ?? null);
  const language = readLanguage();
  // answering an answer keeps one "Re:" ("Re: x", "RE:x")
  const title = truncate(
    /^re:\s*/i.test(drop.title) ? drop.title : `Re: ${drop.title}`,
    LIMITS.TITLE_MAX_CHARS,
  );
  const send = (requestId: string, mention: boolean) =>
    client.sendDrop({
      // the body is in the person's language: a press in the other language is another reply, not a conflict
      request_id: requestId,
      targets: group
        ? [{ type: 'group', group_id: group.group_id }]
        : [{ type: 'user', user_id: drop.author.user_id }],
      payload: {
        payload_version: 1,
        kind: 'text',
        title,
        body: note ? `${ACK_TEXT[language]}\n\n${note}` : ACK_TEXT[language],
        attachment_ids: [],
        extensions: {},
        reply_to: dropId,
        ...(mention ? { mentions: [drop.author.handle] } : {}),
      },
    });
  const requestId = `ack:${dropId}:${language}`;
  /** null: this acknowledgement was already sent with other content. */
  const sendOnce = async (id: string, mention: boolean) => {
    try {
      return await send(id, mention);
    } catch (err) {
      if (isIdempotencyConflict(err)) return null;
      throw err;
    }
  };
  let result: Awaited<ReturnType<typeof send>> | null;
  try {
    result = await sendOnce(requestId, group !== null);
  } catch (err) {
    if (!group || !isMentionRefusal(err)) throw err;
    result = await sendOnce(`${requestId}:group`, false);
  }
  invalidateBand(opts.profile);
  // people text: the person's name as the viewer knows them, or the group
  const where = group
    ? groupLabel(language, clean(group.display_name, NAME_MAX), clean(group.slug, NAME_MAX))
    : clean(drop.author.display_label, NAME_MAX);
  const outcome = result?.outcome ?? 'already_sent';
  const message = ackMessage(language, outcome, where);
  out.result({ outcome, to: where, message }, () => message);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Marks at once at most this many: a group row stands for up to 200 drops. */
const MARK_CONCURRENCY = 8;
/** A drop that is gone, no longer the person's, or changed again after the retry: skipped, the rest go on. */
const SKIPPED = new Set(['NOT_FOUND', 'FORBIDDEN', 'VERSION_CONFLICT']);

/** `<drop_id>` or `<drop_id>:<state_version>`, a full drop id; anything else is a usage error. */
function parseDropSpec(spec: string): { id: string; known?: { read: false; state_version: number } } {
  const m = /^([^:]+)(?::(\d+))?$/.exec(spec);
  const id = m?.[1] ?? '';
  if (!m || !UUID.test(id))
    throw new BandFailure('VALIDATION_FAILED', '--drop takes a full drop id, optionally `:<state_version>`');
  return m[2] === undefined ? { id } : { id, known: { read: false, state_version: Number(m[2]) } };
}

/**
 * `agentdrop mark-read`: the person marks what they caught up with as read. `--drop <id[:version]>` (repeatable)
 * marks exactly those drops, each by the ordinary per-drop state change (ADR 0005), as the band's group row does
 * for the drops it stands for, a few at a time; a drop that is gone or changed again is skipped and counted, the
 * others are still marked. Otherwise everything, or one group with `--group`, up to `--up-to` (ADR 0018).
 */
export async function markReadCommand(
  out: Output,
  opts: { profile: string; group?: string; upTo?: string; drops?: string[] },
): Promise<void> {
  if (opts.drops?.length) {
    if (opts.group || opts.upTo)
      throw new BandFailure(
        'VALIDATION_FAILED',
        '--drop marks exactly the drops given; leave out --group and --up-to',
      );
    const specs = opts.drops.map(parseDropSpec);
    const client = modClient(opts.profile);
    let marked = 0;
    let skipped = 0;
    let failure: unknown = null;
    let next = 0;
    const worker = async () => {
      while (failure === null && next < specs.length) {
        const spec = specs[next++];
        if (!spec) break;
        try {
          if (await markDropRead(client, spec.id, spec.known)) marked += 1;
        } catch (err) {
          if (SKIPPED.has(errorCode(err))) skipped += 1;
          else failure ??= err;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(MARK_CONCURRENCY, specs.length) }, worker));
    } finally {
      invalidateBand(opts.profile);
    }
    if (failure !== null) throw failure;
    out.result({ marked, skipped }, () =>
      readLanguage() === 'zh'
        ? `已标为已读：${marked} 条${skipped ? `；${skipped} 条已不在或刚有变化，跳过` : ''}`
        : `Marked read: ${marked}${skipped ? `; skipped ${skipped} that are gone or changed meanwhile` : ''}`,
    );
    return;
  }
  const client = modClient(opts.profile);
  // the mod passes a group id; a person may write `#slug`
  const groupId = opts.group ? await resolveGroupId(client, opts.group) : undefined;
  const result = await client.markAllRead({
    ...(groupId ? { group_id: groupId } : {}),
    ...(opts.upTo ? { up_to: opts.upTo } : {}),
  });
  invalidateBand(opts.profile);
  out.result(result, () =>
    readLanguage() === 'zh' ? `已标为已读：${result.marked} 条` : `Marked read: ${result.marked}`,
  );
}
