// The AgentDrop band's rows, from `agentdrop --json band` data. Pure: no mods API, so the CLI tests import it.
// People-facing text in the person's language (English by default); never ids. The prompts the Read and Look buttons
// submit as the person carry no text written by anyone else: only ids, a validated @handle or #slug, and our words.

const T = {
  en: {
    title: 'AgentDrop',
    unnamedGroup: 'Group message',
    alsoMentioned: ' · mentioned you',
    direct: (from, title) => `${from} · "${title}"`,
    mention: (from, group, title) => `${from} mentioned you in ${group} · "${title}"`,
    replyMine: (from, original, title) => `${from} replied to your "${original}" · "${title}"`,
    replyMineOnly: (from, original) => `${from} replied to your "${original}"`,
    reply: (from, original, title) => `${from} replied to "${original}" · "${title}"`,
    replyOnly: (from, original) => `${from} replied to "${original}"`,
    files: (n) => ` · ${n} file${n > 1 ? 's' : ''}`,
    group: (group, n, who) => `${group} · ${n} new message${n > 1 ? 's' : ''}${who ? ` (${who})` : ''}`,
    groupLabel: (name, slug) => (name ? `“${name}” #${slug}` : `#${slug}`),
    groupDrop: (from, title) => `${from} · "${title}"`,
    person: (from, n, title) => `${from} · ${n} new messages · latest "${title}"`,
    sep: ', ',
    requests: (parts) => `${parts.join(' · ')} (decide in the dashboard)`,
    contacts: (n) => `${n} contact request${n > 1 ? 's' : ''}`,
    invitations: (n) => `${n} group invitation${n > 1 ? 's' : ''}`,
    joins: (n) => `${n} join request${n > 1 ? 's' : ''}`,
    approvals: (n) => `${n} approval${n > 1 ? 's' : ''} waiting`,
    more: (n) => `${n} more unread`,
    overflow: (n) => `and ${n} more new · type /agentdrop to see them`,
    read: 'Read',
    ack: 'On it',
    later: 'Later',
    look: 'Look',
    markRead: 'Mark read',
    back: 'Back',
    loading: 'Loading…',
    nothing: 'Nothing waiting ✓',
    unreachable: "AgentDrop: can't reach your inbox right now",
    truncated: 'Only the first part is shown here; the whole message is in the dashboard.',
    markFailed: "Couldn't mark it read; it stays unread for now.",
    readPrompt: (handle, id) =>
      `Read the AgentDrop drop with drop_id ${id}${handle ? ` from @${handle}` : ''} and tell me what it says.`,
    readManyPrompt: (handle, ids) =>
      `Read the ${ids.length} new AgentDrop drops from @${handle} (drop_id ${ids.join(', ')}) and tell me what they say.`,
    lookPrompt: (slug, n, id) =>
      `Look at the ${n} new AgentDrop message${n > 1 ? 's' : ''} in ${slug ? `#${slug} ` : 'the group '}(group_id ${id}) and summarize them for me.`,
    catchUp:
      'AgentDrop: catch up on your messages with Claude; add words to focus on a person, group or project',
    catchUpHint: '[person, group or project]',
    catchUpPrompt: (focus) =>
      'Catch me up on my AgentDrop messages: start with how many are unread and from whom, explain in detail the ' +
      'ones that bear on what we are working on in this session, and summarize the rest in a line each, by person ' +
      'or group. Mark read only the ones you explained in detail, and do not act on or reply to any of them until I ' +
      `say so.${focus ? ` Focus on: ${focus} (explain in detail what matches it, read or not).` : ''}`,
  },
  zh: {
    title: 'AgentDrop',
    unnamedGroup: '群消息',
    alsoMentioned: ' · @了你',
    direct: (from, title) => `${from} ·「${title}」`,
    mention: (from, group, title) => `${from} 在 ${group} @了你 ·「${title}」`,
    replyMine: (from, original, title) => `${from} 回复了你的「${original}」·「${title}」`,
    replyMineOnly: (from, original) => `${from} 回复了你的「${original}」`,
    reply: (from, original, title) => `${from} 回复了「${original}」·「${title}」`,
    replyOnly: (from, original) => `${from} 回复了「${original}」`,
    files: (n) => ` · ${n} 个附件`,
    group: (group, n, who) => `${group} · ${n} 条新消息${who ? `（${who}）` : ''}`,
    groupLabel: (name, slug) => (name ? `「${name}」#${slug}` : `#${slug}`),
    groupDrop: (from, title) => `${from} ·「${title}」`,
    person: (from, n, title) => `${from} · ${n} 条新消息 · 最新「${title}」`,
    sep: '、',
    requests: (parts) => `${parts.join(' · ')}（在网页处理）`,
    contacts: (n) => `${n} 个联系人申请`,
    invitations: (n) => `${n} 个群邀请`,
    joins: (n) => `${n} 个入群申请`,
    approvals: (n) => `${n} 条待审批`,
    more: (n) => `另有 ${n} 条未读`,
    overflow: (n) => `还有 ${n} 条新消息 · 输入 /agentdrop 查看`,
    read: '读一下',
    ack: '收到，处理中',
    later: '稍后',
    look: '看看',
    markRead: '全部已读',
    back: '返回',
    loading: '正在加载…',
    nothing: '没有等你处理的 ✓',
    unreachable: 'AgentDrop：暂时连不上你的收件箱',
    truncated: '这里只显示了前一部分，完整内容请在网页上看。',
    markFailed: '没能标为已读，暂时仍是未读。',
    readPrompt: (handle, id) =>
      `读一下${handle ? ` @${handle} 发来的` : ''} AgentDrop 消息（drop_id ${id}），把内容告诉我。`,
    readManyPrompt: (handle, ids) =>
      `读一下 @${handle} 新发来的 ${ids.length} 条 AgentDrop 消息（drop_id ${ids.join('、')}），把内容告诉我。`,
    lookPrompt: (slug, n, id) =>
      `看看 AgentDrop 群${slug ? ` #${slug}` : ''} 里新来的 ${n} 条消息（group_id ${id}），给我概括一下。`,
    catchUp: 'AgentDrop：让 Claude 帮你过一遍消息；后面可以写人、群或项目，重点看那部分',
    catchUpHint: '[人、群或项目]',
    catchUpPrompt: (focus) =>
      '帮我看看 AgentDrop 最近的消息：先说一共有多少条未读、分别是谁发的，和我们这个会话正在做的事关系紧密的逐条详细讲，' +
      '其余的按人或群各用一句话概括。只把详细讲过的标为已读，在我开口之前不要处理或回复任何一条。' +
      (focus ? `重点看：${focus}（匹配的消息不论是否已读都详细讲）。` : ''),
  },
};

/** What went wrong, for the person: by the CLI's error code, never the server's or the CLI's own words. */
const ERRORS = {
  en: {
    offline: "Can't reach AgentDrop right now. Try again in a moment.",
    signedOut: 'This agent is no longer signed in to AgentDrop; it needs to be connected again.',
    gone: 'That message is no longer available to you.',
    changed: 'That changed in the meantime; the list is up to date now.',
    own: 'That message is yours; there is nothing to acknowledge.',
    approval: 'Your reply waits for your approval in the dashboard.',
    generic: "That didn't work. Try again in a moment.",
  },
  zh: {
    offline: '暂时连不上 AgentDrop，请稍后再试。',
    signedOut: '这个 Agent 已经退出了 AgentDrop，需要重新连接。',
    gone: '这条消息你已经看不到了。',
    changed: '这条消息刚刚有了变化，列表已更新。',
    own: '这是你自己发的消息，不需要回复「收到」。',
    approval: '你的回复要先在网页上确认才会发出。',
    generic: '没有成功，请稍后再试。',
  },
};

const ERROR_KIND = {
  NETWORK_ERROR: 'offline',
  UPSTREAM_UNAVAILABLE: 'offline',
  RATE_LIMITED: 'offline',
  INTERNAL: 'offline',
  UNAUTHORIZED: 'signedOut',
  ENDPOINT_REVOKED: 'signedOut',
  NOT_PAIRED: 'signedOut',
  FORBIDDEN: 'gone',
  NOT_FOUND: 'gone',
  VERSION_CONFLICT: 'changed',
  OWN_DROP: 'own',
  NEEDS_APPROVAL: 'approval',
};

export function strings(language) {
  return T[language === 'zh' ? 'zh' : 'en'];
}

/** A people sentence for a failed CLI call, from its error code; anything unknown gets the generic one. */
export function errorText(code, language) {
  const table = ERRORS[language === 'zh' ? 'zh' : 'en'];
  return table[ERROR_KIND[code] ?? 'generic'];
}

/**
 * Text written by someone else, made safe to draw: no control or format characters (bidi overrides, zero-width
 * joiners, escapes), except line breaks and tabs where the text may span lines. One line otherwise.
 */
export function clean(value, opts = {}) {
  if (typeof value !== 'string') return '';
  const kept = value
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) =>
      opts.multiline && (c === '\n' || c === '\t') ? c : opts.multiline ? '' : ' ',
    );
  const text = opts.multiline ? kept : kept.replace(/\s+/g, ' ').trim();
  // by characters: never half of a surrogate pair (an emoji, a rare CJK character)
  return opts.max ? Array.from(text).slice(0, opts.max).join('') : text;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// the server's own rules (packages/contracts/src/names.ts): nothing else may reach a prompt
const HANDLE = /^[a-z0-9][a-z0-9_]{2,31}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function safeHandle(value) {
  return typeof value === 'string' && HANDLE.test(value) ? value : null;
}

/** The key "Later" remembers: a group's key includes its newest message, so a new one brings the row back. */
export function rowKey(row) {
  if (row.kind === 'person') return `p:${row.handle}:${row.id}`;
  return row.kind === 'drop' ? `d:${row.id}` : `g:${row.id}:${row.upTo}`;
}

/** What putting a row away puts away: the row, and for a person's row each drop it stands for. */
export function rowKeys(row) {
  return row.kind === 'person' ? [rowKey(row), ...row.drops.map((id) => `d:${id}`)] : [rowKey(row)];
}

/**
 * Several new drops from one person are one row, as a phone stacks a conversation (ADR 0027): who, how many, the
 * newest title; its key follows the newest drop, so another message makes it a new row. A single drop keeps its
 * own row and buttons. Only drops whose author has a valid @handle are stacked: the prompt names the handle.
 */
export function stackByPerson(rows, language = 'en') {
  const t = strings(language);
  const by = new Map();
  for (const row of rows)
    if (row.kind === 'drop' && row.handle) by.set(row.handle, [...(by.get(row.handle) ?? []), row]);
  const out = [];
  for (const row of rows) {
    const same = row.kind === 'drop' && row.handle ? by.get(row.handle) : null;
    if (!same || same.length < 2) {
      out.push(row);
      continue;
    }
    // rows are newest first: the first of the person's rows stands for all of them
    if (same[0] !== row) continue;
    const ids = same.map((r) => r.id);
    out.push({
      kind: 'person',
      id: row.id,
      handle: row.handle,
      at: row.at,
      drops: ids,
      text: t.person(row.from, ids.length, row.title),
      prompt: t.readManyPrompt(row.handle, ids),
    });
  }
  return out;
}

/** Received time, as the dashboard sorts: when it reached the person, else when it was written. */
function timeOf(d) {
  return d.received_at ?? d.created_at ?? '';
}

/**
 * A session's start may come a few seconds after its own SessionStart hook recorded what it showed; anything seen
 * within this margin before the start still counts as this session's.
 */
export const SEEN_SLACK_MS = 15_000;

/**
 * Whether the band of a session started at `since` lists this drop (ADR 0025): not seen inside an agent yet, or
 * first seen after the session started (by this session, or a moment the person had it open too). What an earlier
 * session already showed is not listed again; the pane still has it. Data without `seen_at` (an older CLI or
 * server) lists everything, as before.
 */
export function newToSession(drop, since) {
  if (typeof since !== 'number') return true;
  const at = drop?.seen_at;
  if (at === undefined || at === null) return true;
  return typeof at === 'number' && at >= since - SEEN_SLACK_MS;
}

/** How long a row or line stays on a session's band from when it was first drawn there (ADR 0027). */
export const SHOW_MS = 120_000;

/** A row that moved up into view stays at least this long, whatever is left of its two minutes (ADR 0027). */
export const MIN_DRAWN_MS = 30_000;

/** The most rows the band draws at once; the rest of a burst is one line counting them (ADR 0027). */
export const BAND_MAX_ROWS = 5;

/** A footer line's key for "shown since" and "put away": short and store-safe, changing with its text. */
export function footerKey(text) {
  let h = 5381;
  for (const c of text) h = ((h * 33) ^ c.codePointAt(0)) >>> 0;
  return `f:${h.toString(36)}`;
}

/**
 * What the band draws at `now` (ADR 0027), from `buildRows`' rows and footer: each row and footer line for SHOW_MS
 * from when it was first drawn (`shownAt`, key → epoch ms, or null when drawn while the person was away: it stays
 * until their two minutes start; `dismissed` holds what was put away); several drops from one person stacked into
 * one row (stackByPerson); BAND_MAX_ROWS rows, drops to answer before group rows, then the newest; for the rest one
 * line counting them, which goes when they do. `seen` is `{ shownAt, drawnAt }` (or just `shownAt`): when each key's
 * two minutes started, and when a row was first actually drawn. Returns `stamp`: `[key, at]` pairs new now (`at`
 * undefined: start now), `drawn`: keys drawn for the first time, `expired`: keys whose time is up, to put away for
 * every session (a person's row with each drop it stands for).
 */
export function bandView(built, seen, now, dismissed = new Set(), language = 'en') {
  const t = strings(language);
  const { shownAt, drawnAt = new Map() } = seen instanceof Map ? { shownAt: seen } : seen;
  const stamp = [];
  const expired = [];
  // a person's row new to the band keeps its members' time when it only lost or reordered messages: it is not a
  // new notice; with a message not seen before it starts afresh (ADR 0027)
  const firstTime = (row, key) => {
    if (row.kind !== 'person') return undefined;
    const times = row.drops.map((id) => shownAt.get(`d:${id}`));
    for (const id of row.drops) if (!shownAt.has(`d:${id}`)) stamp.push([`d:${id}`, undefined]);
    if (times.some((at) => at === undefined)) return undefined;
    stamp.push([key, times.includes(null) ? null : Math.min(...times)]);
    return stamp.at(-1)[1];
  };
  const sort = (row, key, keys = [key]) => {
    let at = shownAt.get(key);
    if (!shownAt.has(key)) {
      at = row ? firstTime(row, key) : undefined;
      if (at === undefined) stamp.push([key, undefined]);
    }
    // null: drawn while the person was away; its two minutes start when they are back. A row that moved up into
    // view keeps at least MIN_DRAWN_MS on screen, so it does not flash and go.
    const drawn = drawnAt.get(key);
    const over =
      typeof at === 'number' &&
      now - at >= SHOW_MS &&
      (typeof drawn !== 'number' || now - drawn >= MIN_DRAWN_MS);
    if (over) expired.push(...keys);
    return !over;
  };
  const rows = stackByPerson(built.rows, language).filter((row) => sort(row, rowKey(row), rowKeys(row)));
  const footer = built.footer.filter((line) => {
    const key = footerKey(line);
    return !dismissed.has(key) && sort(null, key);
  });
  const extra = rows.length - BAND_MAX_ROWS;
  if (extra > 0) footer.unshift(t.overflow(extra));
  // drops that are the person's to answer take the places first, as the hook notices list them (noticeOrder);
  // what is drawn stays newest first
  const kept = new Set(
    [...rows].sort((a, b) => (a.kind === 'group') - (b.kind === 'group')).slice(0, BAND_MAX_ROWS),
  );
  const shown = rows.filter((row) => kept.has(row));
  const drawn = shown.map(rowKey).filter((key) => !drawnAt.has(key));
  return { rows: shown, footer, stamp, drawn, expired };
}

/**
 * Rows newest first, one for every new drop that is the person's to answer and one per group for the rest.
 * `dismissed` is the set of keys the person put off with "Later". `surface` is `band` (hidden when notices are off)
 * or `pane` (the person opened it: always lists what is unread). `since`, for the band, is when this session
 * started: drops seen before it are left to the pane (ADR 0025).
 */
export function buildRows(data, dismissed, surface = 'band', since = undefined) {
  if (!data || (surface === 'band' && !data.enabled)) return { rows: [], footer: [] };
  const t = strings(data.language);
  const fresh = (d) => surface !== 'band' || newToSession(d, since);
  const rows = [];
  for (const d of data.drops ?? []) {
    if (typeof d.drop_id !== 'string' || !UUID.test(d.drop_id)) continue;
    if (!fresh(d)) continue;
    const handle = safeHandle(d.from?.handle);
    // the person's name as the viewer knows them (remark, nickname, else @handle)
    const from = clean(d.from?.label, { max: 40 }) || (handle ? `@${handle}` : '?');
    const title = clean(d.title, { max: 80 });
    const slug = d.group && SLUG.test(d.group.slug ?? '') ? d.group.slug : null;
    // shown, never submitted: the group is named for the person
    const groupName = clean(d.group?.name, { max: 40 });
    const group = d.group ? (slug ? t.groupLabel(groupName, slug) : groupName || t.unnamedGroup) : '';
    const original = clean(d.reply_to_title, { max: 80 });
    // `reply_to_mine` true: it answers the person's own drop; null: an older server could not say whose
    const mine = d.reply_to_mine === true;
    const reply = original && d.reply_to_mine !== false;
    // a reply titled "Re: <original>" says nothing more than "replied to <original>"
    const redundant = reply && /^re:\s*/i.test(title) && title.replace(/^re:\s*/i, '') === original;
    const description =
      (reply
        ? redundant
          ? (mine ? t.replyMineOnly : t.replyOnly)(from, original)
          : (mine ? t.replyMine : t.reply)(from, original, title)
        : d.mentioned && group
          ? t.mention(from, group, title)
          : t.direct(from, title)) + (d.attachments > 0 ? t.files(d.attachments) : '');
    // Replies and older metadata still name their group, as every other notice surface does. A mention's
    // normal sentence already contains the group. These labels stay display-only, never in the Read prompt.
    const text =
      (group && (reply || !d.mentioned) ? `${group} · ${description}` : description) +
      (reply && d.mentioned ? t.alsoMentioned : '');
    rows.push({
      kind: 'drop',
      id: d.drop_id,
      at: timeOf(d),
      text,
      prompt: t.readPrompt(handle, d.drop_id),
      handle,
      from,
      title,
    });
  }
  for (const g of data.groups ?? []) {
    if (typeof g.group_id !== 'string' || !UUID.test(g.group_id)) continue;
    const slug = SLUG.test(g.slug ?? '') ? g.slug : null;
    const all = (g.drops ?? []).filter((x) => typeof x?.drop_id === 'string' && UUID.test(x.drop_id));
    // on the band the row stands only for this session's new drops: count, people and newest time follow them
    const mine = all.filter(fresh);
    const filtered = mine.length !== all.length;
    if (filtered && mine.length === 0) continue;
    const count = filtered ? mine.length : g.count;
    const people = filtered
      ? [...new Set(mine.map((x) => x.from).filter((x) => typeof x === 'string'))].slice(0, 3)
      : (g.from ?? []);
    const who = people.map((name) => clean(name, { max: 40 })).filter(Boolean);
    const upTo = filtered
      ? mine.reduce((max, x) => (typeof x.at === 'string' && x.at > max ? x.at : max), '')
      : g.up_to;
    rows.push({
      kind: 'group',
      id: g.group_id,
      upTo,
      at: upTo,
      // the drops this row stands for, as `agentdrop mark-read --drop` takes them; nothing else is marked
      drops: mine.map((x) =>
        Number.isInteger(x.state_version) ? `${x.drop_id}:${x.state_version}` : x.drop_id,
      ),
      text: t.group(
        slug ? t.groupLabel(clean(g.name, { max: 40 }), slug) : clean(g.name, { max: 40 }),
        count,
        who.join(t.sep),
      ),
      prompt: t.lookPrompt(slug, count, g.group_id),
    });
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const visible = rows.filter((r) => !dismissed.has(rowKey(r)));
  const r = data.requests ?? {};
  const parts = [
    r.contacts ? t.contacts(r.contacts) : null,
    r.invitations ? t.invitations(r.invitations) : null,
    r.join_requests ? t.joins(r.join_requests) : null,
    r.approvals ? t.approvals(r.approvals) : null,
  ].filter(Boolean);
  const footer = [];
  if (parts.length) footer.push(t.requests(parts));
  if (data.more > 0) footer.push(t.more(data.more));
  return { rows: visible, footer };
}

/** Longest focus `/agentdrop-read` passes on: the person's own words, one line. */
export const FOCUS_MAX = 300;

/**
 * The prompt `/agentdrop-read [words]` submits as the person (ADR 0028). The words are the person's own, typed
 * after the command; they are cleaned to one line and capped, and nothing anyone else wrote is added.
 */
export function catchUpPrompt(args, language) {
  return strings(language).catchUpPrompt(clean(args, { max: FOCUS_MAX }).trim());
}

/** The pane's list of one group row: its unread drops, newest first, each one to open. */
export function groupDropRows(data, groupId) {
  const t = strings(data?.language);
  const group = (data?.groups ?? []).find((g) => g.group_id === groupId);
  return (group?.drops ?? [])
    .filter((x) => typeof x?.drop_id === 'string' && UUID.test(x.drop_id))
    .map((x) => ({
      kind: 'drop',
      id: x.drop_id,
      at: typeof x.at === 'string' ? x.at : '',
      text: t.groupDrop(clean(x.from, { max: 40 }) || '?', clean(x.title, { max: 80 })),
    }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * Where claude-mod.json is when the plugin copy carries no pointer to it, by the CLI's own rule
 * (apps/cli/src/paths.ts): AGENTDROP_CONFIG_DIR when set (even empty), else XDG_CONFIG_HOME/agentdrop, else
 * <home>/.config/agentdrop, with USERPROFILE as the home where HOME is unset (Windows).
 */
export function fallbackConfigPath(env) {
  const set = (v) => typeof v === 'string';
  const windows = !env.HOME && !!env.USERPROFILE;
  const sep = windows ? '\\' : '/';
  // like path.join: an empty part adds nothing, so an empty directory is the working directory
  const join = (a, b) => (a ? `${a.replace(/[\\/]+$/, '')}${sep}${b}` : b);
  const home = env.HOME || env.USERPROFILE || '';
  const dir = set(env.AGENTDROP_CONFIG_DIR)
    ? env.AGENTDROP_CONFIG_DIR
    : join(set(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config'), 'agentdrop');
  return join(dir, 'claude-mod.json');
}

/**
 * Each "Later" is its own store key, so sessions never overwrite each other's: a session writes only the key it
 * adds, never the whole set (the store has no compare-and-set across sessions).
 */
export const LATER_PREFIX = 'later:';

/** The row key a store key stands for, or null for any other key. */
export function laterRowKey(storeKey) {
  return typeof storeKey === 'string' && storeKey.startsWith(LATER_PREFIX)
    ? storeKey.slice(LATER_PREFIX.length)
    : null;
}

/** "Later" entries older than a week are forgotten, so the store stays small. */
export function pruneDismissed(entries, now, ttlMs = 7 * 24 * 60 * 60 * 1000) {
  const kept = {};
  for (const [key, at] of Object.entries(entries ?? {}))
    if (typeof at === 'number' && now - at < ttlMs) kept[key] = at;
  return kept;
}

/**
 * The store is shared by every Claude Code session of the person: what another session put off since this one
 * last read it is kept, and the later time wins.
 */
export function mergeDismissed(stored, local) {
  const merged = {};
  for (const source of [stored ?? {}, local ?? {}])
    for (const [key, at] of Object.entries(source))
      if (typeof at === 'number' && !(merged[key] >= at)) merged[key] = at;
  return merged;
}

/** The newest "Later" entries kept; older ones are deleted from the store, so each reload stays bounded. */
export const LATER_MAX = 200;

/** The newest `max` "Later" entries (by when they were put off). */
export function capDismissed(entries, max = LATER_MAX) {
  const list = Object.entries(entries ?? {}).filter(([, at]) => typeof at === 'number');
  if (list.length <= max) return Object.fromEntries(list);
  list.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(list.slice(0, max));
}

/** After a failed refresh the band keeps its rows for one more poll; after the second it shows only `unreachable`. */
export const FAILURES_BEFORE_CLEARING = 2;

/** The agent's credential no longer works: no retry fixes that, only connecting it again. */
const SIGNED_OUT = new Set(['UNAUTHORIZED', 'ENDPOINT_REVOKED', 'NOT_PAIRED']);

export function isSignedOut(code) {
  return SIGNED_OUT.has(code);
}

/**
 * Another session is refreshing right now and this one waited long enough: not a failure, the next poll reads the
 * shared result.
 */
export function isBusy(code) {
  return code === 'BUSY';
}

/**
 * What the band shows when it has no rows to show after failed refreshes: nothing, or one dim line. `enabled` is
 * whether notices were on when last known (undefined: never known); with them off the band says nothing at all.
 * Signed out (or revoked) says so at once, since waiting does not help; anything else says the inbox cannot be
 * reached after FAILURES_BEFORE_CLEARING failures in a row.
 */
export function bandFallback(state, language) {
  if (state.enabled === false) return null;
  if (isSignedOut(state.code)) return errorText(state.code, language);
  return state.failures >= FAILURES_BEFORE_CLEARING ? strings(language).unreachable : null;
}

/** `2026-10-02T08:00:03Z` → `2026-10-02 10:00` in the local time zone. */
export function localTime(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const two = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** What the pane shows of one drop read with `agentdrop --json read`, every field cleaned. */
export function dropView(drop, language) {
  const t = strings(language);
  const handle = safeHandle(drop?.author?.handle);
  const label = clean(drop?.author?.display_label, { max: 40 });
  return {
    title: clean(drop?.title, { max: 160 }) || ' ',
    meta: [label || null, handle ? `@${handle}` : null, localTime(drop?.received_at ?? drop?.created_at)]
      .filter(Boolean)
      .join(' · '),
    body: clean(drop?.body_chunk, { multiline: true }) || ' ',
    files: (drop?.attachments ?? []).map((a) => clean(a?.safe_name, { max: 80 })).filter(Boolean),
    truncated: drop?.next_offset !== null && drop?.next_offset !== undefined ? t.truncated : null,
  };
}
