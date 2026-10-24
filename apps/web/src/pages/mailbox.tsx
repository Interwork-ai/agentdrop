import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  ChevronRight,
  Forward,
  Inbox,
  Mail,
  MailOpen,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  PenSquare,
  Reply,
  Search,
  ShieldCheck,
  Star,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  ApiFailure,
  api,
  type DropDetail,
  type DropSummary,
  type ListDrops,
  mailboxUrl,
} from '../lib/api.js';
import { humanError } from '../lib/error-text.js';
import {
  formatAgo,
  formatClock,
  formatDateTime,
  formatDay,
  formatShort,
  plural,
  useFormat,
} from '../lib/format.js';
import { type Lang, type Translate, useLang, useT } from '../lib/lang.js';
import { isAssistant, personName } from '../lib/people.js';
import { replyHref, replyRecipient } from '../lib/reply.js';
import { mailboxKey, useFocusAwareInterval, useSession } from '../lib/session.js';
import { AttachmentTile } from '../ui/attachment-tile.jsx';
import {
  Avatar,
  Chip,
  EmptyState,
  IconButton,
  listRowClass,
  MetaList,
  PageToolbar,
  Segmented,
  SplitView,
} from '../ui/layout.jsx';
import { setupCommands } from '../ui/needs-agent.jsx';
import { Button, CodeBlock, ErrorBox, Input, Loading, PublicEmail } from '../ui/primitives.jsx';
import { InboxPushBanner } from '../ui/push-notifications.jsx';

type View = 'inbox' | 'sent' | 'starred' | 'archived';
/** List filters. `unread` asks the server; the others narrow the loaded page by how each drop reached me. */
type Filter = 'all' | 'direct' | 'groups' | 'mentions' | 'unread';

const viewTitle = (view: View, t: Translate): string =>
  ({
    inbox: t('Inbox', '收件箱'),
    sent: t('Sent', '已发送'),
    starred: t('Starred', '收藏'),
    archived: t('Archived', '归档'),
  })[view];

/**
 * List beside detail (SplitView). Keyboard: while the list has focus ↑/↓ or j/k select (focus follows the selected
 * row); the reading pane scrolls with the arrow keys once it has focus; Esc goes back to the list, / searches.
 */
export function MailboxPage({ view }: { view: View }) {
  const { me, currentH, setCurrentH } = useSession();
  const t = useT();
  const params = useParams();
  const [search, setSearch] = useSearchParams();
  const nav = useNavigate();
  const interval = useFocusAwareInterval();
  const [query, setQuery] = useState(search.get('q') ?? '');
  const [filter, setFilter] = useState<Filter>('all');
  const unreadOnly = filter === 'unread';
  const groupId = search.get('group');
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLUListElement>(null);

  const requestedH = search.get('h');
  const requestedEndpoint = requestedH
    ? me?.endpoints.find((endpoint) => endpoint.h_id === requestedH && !endpoint.revoked_at)
    : undefined;
  const deepLinkReady =
    !requestedH || Boolean(requestedEndpoint && currentH?.h_id === requestedEndpoint.h_id);

  useEffect(() => {
    if (requestedEndpoint && currentH?.h_id !== requestedEndpoint.h_id) {
      setCurrentH(requestedEndpoint.h_id);
      return;
    }
    if (requestedH && !requestedEndpoint && me) {
      const next = new URLSearchParams(search);
      next.delete('h');
      setSearch(next, { replace: true });
    }
  }, [requestedEndpoint, requestedH, currentH?.h_id, me, search, setCurrentH, setSearch]);

  const hId = currentH?.h_id ?? '';
  // searched once typing pauses: every search decrypts messages on the server and is rate-limited per person
  const [searchTerm, setSearchTerm] = useState(query.trim());
  useEffect(() => {
    const id = setTimeout(() => setSearchTerm(query.trim()), 350);
    return () => clearTimeout(id);
  }, [query]);
  const list = useQuery({
    queryKey: mailboxKey(hId, 'list', view, searchTerm, unreadOnly, groupId),
    queryFn: () =>
      api.get<ListDrops>(
        mailboxUrl(
          hId,
          `/drops?view=${view}&limit=50${searchTerm ? `&query=${encodeURIComponent(searchTerm)}` : ''}${unreadOnly ? '&unread_only=true' : ''}${
            groupId ? `&group_id=${groupId}` : ''
          }`,
        ),
      ),
    enabled: !!currentH && deepLinkReady,
    // a search reads and decrypts messages on the server: no background refetch while searching
    refetchInterval: searchTerm ? false : interval,
  });

  /*
   * A search looks through at most 2000 messages per request (docs/plan/CONTENT_ENCRYPTION.md §9). A short or empty
   * page that still has a cursor means "not searched to the end yet": "Search further" fetches the next stretch.
   */
  const searchKey = `${hId}|${view}|${searchTerm}|${unreadOnly}|${groupId}`;
  const [further, setFurther] = useState<{ key: string; drops: ListDrops['drops']; cursor: string | null }>({
    key: '',
    drops: [],
    cursor: null,
  });
  const furtherPages = further.key === searchKey ? further : null;
  const nextCursor = furtherPages ? furtherPages.cursor : (list.data?.next_cursor ?? null);
  const [searchingFurther, setSearchingFurther] = useState(false);
  const searchFurther = async () => {
    if (!nextCursor) return;
    setSearchingFurther(true);
    try {
      const page = await api.get<ListDrops>(
        mailboxUrl(
          hId,
          `/drops?view=${view}&limit=50&query=${encodeURIComponent(searchTerm)}${unreadOnly ? '&unread_only=true' : ''}${
            groupId ? `&group_id=${groupId}` : ''
          }&cursor=${encodeURIComponent(nextCursor)}`,
        ),
      );
      setFurther({
        key: searchKey,
        drops: [...(furtherPages?.drops ?? []), ...page.drops],
        cursor: page.next_cursor,
      });
    } finally {
      setSearchingFurther(false);
    }
  };

  const selected = params.dropId ?? null;
  const loaded = useMemo(
    () => [...(list.data?.drops ?? []), ...(furtherPages?.drops ?? [])].map((d) => withNames(d, t)),
    [list.data, furtherPages, t],
  );
  const showFilters = view !== 'sent';
  const drops = useMemo(
    () => (showFilters ? loaded.filter((d) => matchesFilter(d, filter)) : loaded),
    [loaded, filter, showFilters],
  );
  const title = viewTitle(view, t);

  /*
   * "Mark all as read" (ADR 0018): everything unread in the inbox, or in the one group filtered to, up to the newest
   * drop this list shows; whatever arrived since stays unread. Not offered under Direct / Groups / @Me, where
   * "all" would mean more than what is on screen.
   */
  const qc = useQueryClient();
  const [markedNote, setMarkedNote] = useState<number | null>(null);
  const canMarkAll =
    view === 'inbox' &&
    !query.trim() &&
    !searchTerm &&
    loaded.length > 0 &&
    (filter === 'all' || filter === 'unread') &&
    (list.data?.unread_count ?? 0) > 0;
  const markAll = useMutation({
    mutationFn: async () => {
      const newest = loaded.reduce<string | null>((max, d) => {
        const at = d.received_at ?? d.created_at;
        return !max || at > max ? at : max;
      }, null);
      // Never substitute the server's current time for the list's boundary, including during a query transition.
      if (!canMarkAll || !newest) return 0;
      let marked = 0;
      // at most a few thousand per call on the server; keep going while it says more are left
      for (let round = 0; round < 20; round++) {
        const res = await api.post<{ marked: number; remaining: number }>(
          mailboxUrl(hId, '/drops/mark-read'),
          {
            up_to: newest,
            ...(groupId ? { group_id: groupId } : {}),
          },
        );
        marked += res.marked;
        if (res.remaining === 0 || res.marked === 0) break;
      }
      return marked;
    },
    onSuccess: (marked) => {
      setMarkedNote(marked);
      qc.invalidateQueries({ queryKey: mailboxKey(hId) });
    },
  });
  useEffect(() => {
    if (markedNote === null) return;
    const id = setTimeout(() => setMarkedNote(null), 4000);
    return () => clearTimeout(id);
  }, [markedNote]);

  // Global keys: Esc back to the list, / to search. Arrow keys and j/k belong to the list (onListKey) so they never
  // steal scrolling from the reading pane or the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable))
        return;
      if (e.key === 'Escape' && selected) {
        nav(`/app/${view}${search.toString() ? `?${search}` : ''}`);
      } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        (listRef.current?.querySelector('input[type=search]') as HTMLInputElement | null)?.focus();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, nav, view, search]);
  const onListKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const down = e.key === 'j' || e.key === 'ArrowDown';
    const up = e.key === 'k' || e.key === 'ArrowUp';
    if (!down && !up) return;
    e.preventDefault();
    const idx = drops.findIndex((d) => d.drop_id === selected);
    const next = down ? drops[Math.min(drops.length - 1, idx + 1)] : drops[Math.max(0, idx - 1)];
    if (!next) return;
    nav(`/app/${view}/${next.drop_id}${search.toString() ? `?${search}` : ''}`);
    rowsRef.current?.querySelector<HTMLElement>(`[data-drop-id="${next.drop_id}"]`)?.focus();
  };

  if (!currentH)
    return (
      <EmptyState icon={<Inbox size={20} />} title={t('Pair an agent first', '先配对一个 Agent')}>
        <div className="space-y-3">
          <p>
            {t(
              'An inbox belongs to a paired agent. Run this in a terminal on your computer (Node.js 22+ required):',
              '收件箱属于某个已配对的 Agent。在你的电脑终端里执行（需要 Node.js 22+）：',
            )}
          </p>
          <CodeBlock code={setupCommands()} />
          <p className="text-xs text-dim">
            {t(
              'setup opens your browser to confirm the pairing. After that you can send and receive right inside Codex / Claude Code / Cursor / opencode / oh-my-pi / WorkBuddy.',
              'setup 会自动打开浏览器让你确认配对；之后就能在 Codex / Claude Code / Cursor / opencode / oh-my-pi / WorkBuddy 里直接收发。',
            )}
          </p>
        </div>
      </EmptyState>
    );

  const unreadLabel = `${t('Unread', '未读')}${list.data ? ` (${list.data.unread_count})` : ''}`;
  const inboxUnread = view === 'inbox' ? (list.data?.unread_count ?? 0) : 0;
  const countText = list.data
    ? inboxUnread > 0
      ? t(`${drops.length} · ${inboxUnread} unread`, `${drops.length} · ${inboxUnread} 未读`)
      : drops.length
    : undefined;
  const emptyTitle =
    filter === 'unread'
      ? t('Nothing unread', '没有未读')
      : filter === 'direct'
        ? t('No direct messages here', '这里没有私信')
        : filter === 'groups'
          ? t('No group messages here', '这里没有群消息')
          : filter === 'mentions'
            ? t('Nobody mentioned you here', '这里没有 @ 你的消息')
            : view === 'inbox'
              ? t('Your inbox is empty', '收件箱是空的')
              : view === 'sent'
                ? t("You haven't sent anything yet", '还没有发出过')
                : view === 'starred'
                  ? t('Nothing starred yet', '还没有收藏')
                  : t('Nothing archived yet', '还没有归档');

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
      {view === 'inbox' ? <InboxPushBanner detailOpen={Boolean(selected)} /> : null}
      <SplitView
        showDetail={Boolean(selected)}
        list={
          <div ref={listRef} className="flex min-h-0 flex-1 flex-col">
            <PageToolbar
              title={title}
              {...(countText !== undefined ? { count: countText } : {})}
              sticky={false}
            >
              <form
                className="relative"
                onSubmit={(e) => {
                  e.preventDefault();
                  const next = new URLSearchParams(search);
                  if (query) next.set('q', query);
                  else next.delete('q');
                  setSearch(next);
                }}
              >
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"
                  size={14}
                />
                <Input
                  type="search"
                  className="h-8 bg-bg pl-8"
                  placeholder={t('Search (/)', '搜索（/）')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label={t('Search', '搜索')}
                />
              </form>
              {showFilters || groupId ? (
                <div className="flex flex-wrap items-center gap-2">
                  {showFilters ? (
                    <Segmented<Filter>
                      label={t('Filter messages', '筛选消息')}
                      value={filter}
                      onChange={setFilter}
                      options={[
                        { value: 'all', label: t('All', '全部') },
                        { value: 'direct', label: t('Direct', '私信') },
                        { value: 'groups', label: t('Groups', '群组') },
                        { value: 'mentions', label: t('@Me', '@我') },
                        { value: 'unread', label: unreadLabel },
                      ]}
                    />
                  ) : null}
                  {groupId ? (
                    <button
                      type="button"
                      className="inline-flex h-7 items-center gap-1 rounded-md bg-accent/12 px-2 text-sm font-medium text-accent-fg hover:bg-accent/20"
                      onClick={() => setSearch(new URLSearchParams())}
                    >
                      {t('Group filter', '群组过滤')}
                      <X size={13} aria-hidden="true" />
                    </button>
                  ) : null}
                  {canMarkAll ? (
                    <button
                      type="button"
                      className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-sm font-medium text-fg-2 hover:bg-surface hover:text-fg disabled:opacity-60"
                      disabled={markAll.isPending}
                      onClick={() => markAll.mutate()}
                    >
                      <CheckCheck size={14} aria-hidden="true" />
                      {groupId
                        ? t('Mark this group read', '本群全部标为已读')
                        : t('Mark all as read', '全部标为已读')}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {markedNote !== null ? (
                <p className="text-xs text-dim" role="status">
                  {markedNote === 0
                    ? t('Nothing was left unread.', '没有需要标记的未读消息。')
                    : t(
                        `Marked ${plural(markedNote, 'message', 'messages')} as read.`,
                        `已将 ${markedNote} 条标为已读。`,
                      )}
                </p>
              ) : null}
              {markAll.isError ? <ErrorBox error={markAll.error} /> : null}
              {me?.cross_h_mailbox_enabled ? null : (
                <p className="text-xs text-dim">
                  {t(`Only agent "${currentH.label}"`, `仅 Agent「${currentH.label}」`)}
                </p>
              )}
            </PageToolbar>
            <section className="min-h-0 flex-1 overflow-y-auto" aria-label={t('Message list', '消息列表')}>
              {list.isLoading ? <Loading /> : null}
              {list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : null}
              {list.data && drops.length === 0 && searchTerm && !nextCursor ? (
                <EmptyState icon={<Search size={18} />} title={t('No matching messages', '没有匹配的消息')}>
                  {t('Nothing here contains these words.', '没有消息包含这些字。')}
                </EmptyState>
              ) : null}
              {list.data && drops.length === 0 && !searchTerm ? (
                <EmptyState icon={<Inbox size={18} />} title={emptyTitle}>
                  {filter === 'unread' ? (
                    t('No unread messages right now.', '目前没有未读消息。')
                  ) : filter !== 'all' ? null : view === 'inbox' ? (
                    <span>
                      {t('First', '先')}
                      <Link
                        className="mx-1 text-accent-fg underline underline-offset-2 hover:decoration-2"
                        to="/app/contacts"
                      >
                        {t('add a contact', '加联系人')}
                      </Link>
                      {t(', then', '，再')}
                      <Link
                        className="mx-1 text-accent-fg underline underline-offset-2 hover:decoration-2"
                        to="/app/compose"
                      >
                        {t('send one', '发一条')}
                      </Link>
                      {t(". They don't need to be online at the same time.", '。对方不需要同时在线。')}
                    </span>
                  ) : view === 'sent' ? (
                    <span>
                      {t('Begin with', '从')}
                      <Link
                        className="mx-1 text-accent-fg underline underline-offset-2 hover:decoration-2"
                        to="/app/compose"
                      >
                        {t('a new message', '写一条消息')}
                      </Link>
                      {t(
                        ". Results and context go straight to the other person's agent.",
                        '开始。结果和上下文会直接送到对方的 Agent。',
                      )}
                    </span>
                  ) : null}
                </EmptyState>
              ) : null}
              {drops.length > 0 ? (
                // one Tab stop for the whole list (the selected row, else the first); arrows and j/k move inside it
                <ul ref={rowsRef} className="m-0 list-none p-0" onKeyDown={onListKey}>
                  {drops.map((d, i) => (
                    <li key={d.drop_id}>
                      <DropRow
                        d={d}
                        view={view}
                        active={d.drop_id === selected}
                        tabbable={
                          d.drop_id === selected || (i === 0 && !drops.some((x) => x.drop_id === selected))
                        }
                        onClick={() =>
                          nav(`/app/${view}/${d.drop_id}${search.toString() ? `?${search}` : ''}`)
                        }
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              {nextCursor && searchTerm ? (
                <div className="space-y-2 p-4 text-center text-xs text-dim">
                  <div>
                    {drops.length === 0
                      ? t('No match among the most recent messages.', '在最近的消息里没有找到。')
                      : t('There may be older matches.', '可能还有更早的匹配。')}
                  </div>
                  <Button onClick={() => void searchFurther()} disabled={searchingFurther}>
                    {searchingFurther ? t('Searching…', '正在搜索…') : t('Search further', '继续搜索')}
                  </Button>
                </div>
              ) : null}
              {list.data?.next_cursor && !searchTerm ? (
                <div className="p-4 text-center text-xs text-dim">
                  {t('Showing the latest 50 only', '仅显示最近 50 条')}
                </div>
              ) : null}
            </section>
          </div>
        }
        detail={
          !deepLinkReady ? (
            <Loading label={t("Switching to the message's agent…", '正在切换到消息所属 Agent…')} />
          ) : selected ? (
            <DropDetailPane key={`${hId}:${selected}`} hId={hId} dropId={selected} view={view} />
          ) : (
            <NothingSelected inbox={list.data} />
          )
        }
      />
    </div>
  );
}

/**
 * Where a received drop came from, classified like every other surface (notices, `agentdrop pending`, Feishu,
 * browser push): sent to the person directly wins; otherwise the group the server names first (`group_labels`,
 * sorted by slug), which stays named after the person left the group. Null: a direct message.
 */
function groupOf(d: DropSummary): { name: string; slug: string } | null {
  if (d.sources.includes('direct') || !d.sources.includes('group')) return null;
  const label = d.group_labels?.[0];
  return { name: label?.display_name ?? '', slug: label?.slug ?? '' };
}

/** The built-in assistant named in the reader's language wherever a drop names people (lib/people.ts). */
function withNames<T extends DropSummary>(d: T, t: Translate): T {
  const authors = d.replies?.authors;
  if (!isAssistant(d.author) && !authors?.some(isAssistant)) return d;
  return {
    ...d,
    author: { ...d.author, display_label: personName(d.author, d.author.display_label, t) },
    ...(d.replies && authors
      ? {
          replies: {
            ...d.replies,
            authors: authors.map((a) => ({ ...a, display_label: personName(a, a.display_label, t) })),
          },
        }
      : {}),
  };
}

/** Reached through a group's history (an admin's request, or the owner letting members see it), not a delivery. */
function groupHistoryOnly(d: DropSummary): boolean {
  return d.sources.includes('group_admin') || d.sources.includes('group_history');
}

function matchesFilter(d: DropSummary, filter: Filter): boolean {
  if (filter === 'direct') return groupOf(d) === null && !groupHistoryOnly(d);
  if (filter === 'groups') return groupOf(d) !== null || groupHistoryOnly(d);
  if (filter === 'mentions') return Boolean(d.mentioned_me);
  return true;
}

/** "Name #slug": the name when known, the slug always with exactly one `#`. */
function groupText(group: { name: string; slug: string }, t: Translate): string {
  if (!group.slug) return group.name || t('Group', '群');
  return group.name ? `${group.name} #${group.slug}` : `#${group.slug}`;
}

/** A group recipient's label already carries its `#` (`#paper`); never add a second one. */
function hashed(label: string): string {
  return label.startsWith('#') ? label : `#${label}`;
}

/**
 * The spoken summary of a row, state first: "Unread, from Alice @alice, in #lab, Results are in, mentions you, 1 file,
 * 15 min ago". The visible row abbreviates (a dot, a chip, "15 min"); a screen reader hears it in words.
 */
function rowLabel(d: DropSummary, view: View, t: Translate, lang: Lang): string {
  const sent = view === 'sent';
  const group = groupOf(d);
  const parts: string[] = [];
  if (sent) {
    parts.push(t(`To ${recipientsText(d, t)}`, `发给 ${recipientsText(d, t)}`));
    const receipt = receiptSummary(d, t);
    if (receipt) parts.push(receipt.text);
  } else {
    parts.push(d.read ? t('Read', '已读') : t('Unread', '未读'));
    parts.push(
      t(
        `from ${d.author.display_label} @${d.author.handle}`,
        `来自 ${d.author.display_label} @${d.author.handle}`,
      ),
    );
    if (group) parts.push(t(`in ${groupText(group, t)}`, `群 ${groupText(group, t)}`));
  }
  parts.push(d.title);
  if (d.mentioned_me && !sent) parts.push(t('mentions you', '@了你'));
  if (d.starred) parts.push(t('starred', '已收藏'));
  if (d.attachment_count > 0)
    parts.push(t(plural(d.attachment_count, 'file', 'files'), `${d.attachment_count} 个附件`));
  if (d.replies && d.replies.count > 0)
    parts.push(t(plural(d.replies.count, 'reply', 'replies'), `${d.replies.count} 条回复`));
  parts.push(formatAgo(d.received_at ?? d.created_at, lang));
  return parts.join(t(', ', '，'));
}

function DropRow({
  d,
  view,
  active,
  tabbable,
  onClick,
}: {
  d: DropSummary;
  view: View;
  active: boolean;
  tabbable: boolean;
  onClick: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const group = groupOf(d);
  const sent = view === 'sent';
  const receipt = sent ? receiptSummary(d, t) : null;
  const unread = !sent && !d.read;
  const first = d.recipients[0];
  const avatarLabel = sent ? (first?.address?.split('/')[0] ?? first?.label ?? '?') : d.author.handle;
  const when = d.received_at ?? d.created_at;
  return (
    <button
      type="button"
      onClick={onClick}
      data-drop-id={d.drop_id}
      tabIndex={tabbable ? 0 : -1}
      aria-current={active ? 'true' : undefined}
      aria-label={rowLabel(d, view, t, lang)}
      {...(d.preview ? { 'aria-describedby': `preview-${d.drop_id}` } : {})}
      className={`${listRowClass(active)} flex gap-3`}
    >
      {unread ? (
        <span aria-hidden="true" className="absolute left-1.5 top-6 h-1.5 w-1.5 rounded-full bg-accent" />
      ) : null}
      <Avatar
        name={sent ? avatarLabel.replace(/^[@#]/, '') : d.author.display_label}
        seed={avatarLabel.replace(/^[@#]/, '')}
        size={32}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={`min-w-0 truncate text-sm ${unread ? 'font-semibold text-fg' : 'font-medium text-fg-2'}`}
          >
            {sent ? t(`To ${recipientsText(d, t)}`, `发给 ${recipientsText(d, t)}`) : d.author.display_label}
          </span>
          {group && !sent ? (
            <Chip {...(group.name ? { title: group.name } : {})}>
              {group.slug ? `#${group.slug}` : groupText(group, t)}
            </Chip>
          ) : null}
          {d.mentioned_me && !sent ? <Chip tone="accent">{t('@you', '@你')}</Chip> : null}
          {receipt ? <Chip tone={receipt.done ? 'ok' : 'neutral'}>{receipt.text}</Chip> : null}
          <span
            className={`ml-auto shrink-0 pl-1 text-xs tabular-nums ${unread ? 'font-medium text-accent-fg' : 'text-dim'}`}
            title={formatDateTime(when, lang)}
          >
            {formatShort(when, lang)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className={`min-w-0 flex-1 truncate text-sm ${unread ? 'text-fg' : 'text-fg-2'}`}>
            {d.title}
          </span>
          {d.starred ? (
            <Star size={13} aria-label={t('Starred', '已收藏')} className="shrink-0 fill-warn text-warn" />
          ) : null}
          {d.replies && d.replies.count > 0 ? (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-accent-fg"
              title={repliesText(d.replies, t)}
            >
              <MessageSquare size={13} aria-hidden="true" />
              {d.replies.count}
              <span className="sr-only">{t(d.replies.count === 1 ? 'reply' : 'replies', '条回复')}</span>
            </span>
          ) : null}
          {d.attachment_count > 0 ? (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 text-xs text-dim"
              title={t(
                plural(d.attachment_count, 'attachment', 'attachments'),
                `${d.attachment_count} 个附件`,
              )}
            >
              <Paperclip size={13} aria-hidden="true" />
              {d.attachment_count > 1 ? d.attachment_count : null}
            </span>
          ) : null}
        </div>
        {d.preview ? (
          <div id={`preview-${d.drop_id}`} className="mt-0.5 truncate text-sm text-muted">
            {d.preview}
          </div>
        ) : null}
      </div>
    </button>
  );
}

/** "2 replies from Wang @wang, Li @li": a count always comes with who (docs/PRODUCT_PRINCIPLES.md #4). */
function repliesText(replies: NonNullable<DropSummary['replies']>, t: Translate): string {
  const who = (replies.authors ?? []).map((a) => `${a.display_label} @${a.handle}`).join(t(', ', '、'));
  const n = replies.count;
  return who
    ? t(`${plural(n, 'reply', 'replies')} from ${who}`, `${n} 条回复，来自 ${who}`)
    : t(plural(n, 'reply', 'replies'), `${n} 条回复`);
}

/** Who a drop I sent went to: "@wang", "#paper", "@wang, @lili". */
function recipientsText(d: DropSummary, t: Translate): string {
  if (!d.recipients.length) return t('(recipients unknown)', '（收件人未知）');
  return d.recipients
    .map((r) => (r.type === 'group' ? hashed(r.label) : (r.address?.split('/')[0] ?? r.label)))
    .join(t(', ', '、'));
}

/** Author-only: 「已读」/「未读」 for one person, otherwise 「k/n 已读」 across everyone the drop reached. */
function receiptSummary(d: DropSummary, t: Translate): { text: string; done: boolean } | null {
  const statuses = d.recipient_status;
  if (!statuses?.length) return null;
  const only = statuses[0];
  if (statuses.length === 1 && only && only.type !== 'group') {
    return { text: only.read_at ? t('Read', '已读') : t('Unread', '未读'), done: only.read_at !== null };
  }
  let read = 0;
  let total = 0;
  for (const s of statuses) {
    if (s.type === 'group') {
      read += s.read_count;
      total += s.member_count;
    } else {
      read += s.read_at ? 1 : 0;
      total += 1;
    }
  }
  return { text: t(`${read}/${total} read`, `${read}/${total} 已读`), done: total > 0 && read === total };
}

function RecipientReceipts({ d }: { d: DropSummary }) {
  const t = useT();
  const f = useFormat();
  const statuses = d.recipient_status;
  if (!statuses?.length) return null;
  return (
    <div className="space-y-2 border-t border-line pt-3 text-sm">
      <div className="flex items-center gap-1.5 font-medium text-fg-2">
        <MailOpen size={14} className="text-muted" /> {t('Read by recipients', '对方是否已读')}
      </div>
      <ul className="space-y-1.5">
        {statuses.map((s) =>
          s.type === 'group' ? (
            <li key={`group:${s.label}`}>
              <details>
                <summary className="cursor-pointer text-fg-2">
                  <span className="font-medium">{hashed(s.label)}</span>
                  <span className="ml-2 text-muted">
                    {s.read_count}/{s.member_count} {t('read', '已读')}
                  </span>
                </summary>
                {s.readers.length ? (
                  <ul className="mt-1.5 space-y-1 pl-4 text-muted">
                    {s.readers.map((r) => (
                      <li key={r.handle}>
                        <span className="untrusted text-fg-2">{r.display_label}</span>
                        <span className="ml-1 text-dim">@{r.handle}</span>
                        <span className="ml-2">{f.dateTime(r.read_at)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-1.5 pl-4 text-muted">
                    {t('No one has opened it yet.', '还没有人打开。')}
                  </div>
                )}
              </details>
            </li>
          ) : (
            <li key={`${s.type}:${s.label}`} className="text-fg-2">
              <span className="font-medium">{s.label}</span>
              <span className={`ml-2 ${s.read_at ? 'text-ok' : 'text-muted'}`}>
                {s.read_at
                  ? t(`Read · ${f.dateTime(s.read_at)}`, `已读 · ${f.dateTime(s.read_at)}`)
                  : t('Delivered · unread', '已送达 · 未读')}
              </span>
            </li>
          ),
        )}
      </ul>
      <p className="text-xs text-dim">
        {t(
          'Opening it in the dashboard marks it read. An agent marks it read after showing it at their request; reading through the API or CLI alone does not. Read status is shared across their agents.',
          '对方在网页打开消息会标为已读；Agent 应对方要求展示消息后会标记已读。仅通过 API 或 CLI 读取不会改变状态。已读状态在对方的 Agent 间共享。',
        )}
      </p>
    </div>
  );
}

/** One muted line: where this drop came from or went, and whether it was read. */
function routeLine(d: DropSummary, t: Translate): string {
  if (d.recipients.length) {
    const receipt = receiptSummary(d, t);
    return (
      t(`To ${recipientsText(d, t)}`, `发给 ${recipientsText(d, t)}`) + (receipt ? ` · ${receipt.text}` : '')
    );
  }
  if (groupHistoryOnly(d) && !d.deliveries.length) return t('Not delivered to you', '未投递给你');
  const group = groupOf(d);
  const where = group
    ? t(`To the group ${groupText(group, t)}`, `发到群 ${groupText(group, t)}`)
    : t('To you', '发给你');
  const n = d.deliveries.length;
  if (n === 0) return where;
  if (n === 1)
    return `${where} · ${t(`delivered to ${d.deliveries[0]?.agent_name}`, `送达 ${d.deliveries[0]?.agent_name}`)}`;
  // a count comes with who (docs/PRODUCT_PRINCIPLES.md #4): these are the person's own agents
  const names = d.deliveries.map((x) => x.agent_name).join(t(', ', '、'));
  return `${where} · ${t(`delivered to your ${n} agents: ${names}`, `已送达你的 ${n} 个 Agent：${names}`)}`;
}

/** Right pane with nothing open: a quiet pointer, what is waiting, and one way to start. */
function NothingSelected({ inbox }: { inbox: ListDrops | undefined }) {
  const t = useT();
  const nav = useNavigate();
  const pending = inbox?.viewer.pending;
  const waiting = [
    pending?.unread ? t(`${pending.unread} unread`, `${pending.unread} 条未读`) : null,
    pending?.contact_requests
      ? t(
          plural(pending.contact_requests, 'contact request', 'contact requests'),
          `${pending.contact_requests} 个联系人申请`,
        )
      : null,
    pending?.group_invitations
      ? t(
          plural(pending.group_invitations, 'group invitation', 'group invitations'),
          `${pending.group_invitations} 个群邀请`,
        )
      : null,
  ].filter(Boolean);
  return (
    <EmptyState
      icon={<MailOpen size={20} />}
      title={t('Select a message', '选择一条消息查看')}
      action={
        <Button onClick={() => nav('/app/compose')}>
          <MessageSquarePlus size={14} /> {t('New message', '写消息')}
        </Button>
      }
    >
      {waiting.length ? waiting.join(' · ') : null}
    </EmptyState>
  );
}

function DropDetailPane({ hId, dropId, view }: { hId: string; dropId: string; view: View }) {
  const t = useT();
  const f = useFormat();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [offset, setOffset] = useState(0);
  const detail = useQuery({
    queryKey: mailboxKey(hId, 'drop', dropId, offset),
    queryFn: () =>
      api.get<{ drop: DropDetail }>(mailboxUrl(hId, `/drops/${dropId}?offset=${offset}&max_chars=8192`)),
  });
  // All of my agents are one reader (ADR 0007): the state is the same on every delivery of this drop to any of
  // them, so it can be shown and changed from whichever agent is selected.
  const mine = detail.data?.drop.deliveries ?? [];
  const myState = mine.length
    ? {
        read: mine.some((x) => x.read),
        starred: mine.some((x) => x.starred),
        archived: mine.some((x) => x.archived),
        state_version: Math.max(...mine.map((x) => x.state_version)),
      }
    : undefined;
  // Opening a drop in the dashboard is reading it: mark it read (for all of my agents) once, when the body is
  // first shown. Only the current H's delivery (never another agent's or an admin view), and only once per drop,
  // so "Mark as unread" afterwards sticks. Agent (MCP) and CLI reads still never auto-mark.
  const autoMarked = useRef<string | null>(null);
  /** The version the auto-mark produced, so a Star/Archive clicked while it is in flight waits and builds on it. */
  const autoMarkDone = useRef<{ dropId: string; version: Promise<number | null> } | null>(null);
  const autoMark = useMutation({
    mutationFn: (version: number) =>
      api.patch<{ state_version: number }>(mailboxUrl(hId, `/drops/${dropId}/state`), {
        expected_version: version,
        read: true,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailboxKey(hId) });
    },
  });
  useEffect(() => {
    if (!myState || myState.read || offset !== 0 || autoMarked.current === dropId) return;
    autoMarked.current = dropId;
    autoMarkDone.current = {
      dropId,
      version: autoMark
        .mutateAsync(myState.state_version)
        .then((r) => r.state_version)
        .catch(() => null),
    };
  }, [myState, offset, dropId, autoMark]);
  const state = useMutation({
    mutationFn: async (patch: { read?: boolean; starred?: boolean; archived?: boolean }) => {
      const url = mailboxUrl(hId, `/drops/${dropId}/state`);
      // Opening the drop marks it read, which moves the version while the page still shows the old one: wait for
      // that to land and start from the newer version, so a Star or Archive clicked right away is not refused.
      const pending = autoMarkDone.current?.dropId === dropId ? await autoMarkDone.current.version : null;
      const version = Math.max(pending ?? 0, myState?.state_version ?? 0);
      try {
        return await api.patch(url, { expected_version: version, ...patch });
      } catch (err) {
        // Another tab or agent changed it meanwhile: re-read the state and try once more.
        if (!(err instanceof ApiFailure) || err.body.code !== 'VERSION_CONFLICT') throw err;
        const fresh = (await detail.refetch()).data?.drop.deliveries ?? [];
        const latest = fresh.length ? Math.max(...fresh.map((x) => x.state_version)) : 0;
        return api.patch(url, { expected_version: latest, ...patch });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailboxKey(hId) });
    },
  });
  const d = detail.data ? withNames(detail.data.drop, t) : undefined;
  const back = (
    <IconButton label={t('Back', '返回')} className="lg:hidden" onClick={() => nav(`/app/${view}`)}>
      <ArrowLeft size={16} />
    </IconButton>
  );
  if (detail.isLoading || detail.isError || !d)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center border-b border-line px-3 md:px-5 lg:hidden">
          {back}
        </div>
        {detail.isLoading ? <Loading /> : null}
        {detail.isError ? <ErrorBox error={detail.error} retry={() => detail.refetch()} /> : null}
      </div>
    );
  const canFlag = myState !== undefined;
  // to the group when it came only through one, else to its author; the composer names the drop it answers
  const reply = () => nav(replyHref(d));
  const receipts = d.recipient_status?.length ? d.recipient_status : null;
  const group = groupOf(d);
  const adminView = d.sources.includes('group_admin');
  // the owner lets members read the group's earlier messages (ADR 0022): an ordinary read, not audited
  const historyView = !adminView && d.sources.includes('group_history');
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="glass flex h-14 shrink-0 items-center gap-1 border-b border-line px-3 md:px-5">
        {back}
        {canFlag ? (
          <>
            {myState.read ? (
              <IconButton
                label={t('Mark as unread', '标为未读')}
                disabled={state.isPending}
                onClick={() => state.mutate({ read: false })}
              >
                <Mail size={16} />
              </IconButton>
            ) : (
              <IconButton
                label={t('Mark as read', '标为已读')}
                disabled={state.isPending}
                onClick={() => state.mutate({ read: true })}
              >
                <MailOpen size={16} />
              </IconButton>
            )}
            <IconButton
              label={myState.starred ? t('Starred', '已收藏') : t('Star', '收藏')}
              title={
                myState.starred ? t('Starred · click to unstar', '已收藏 · 点击取消') : t('Star', '收藏')
              }
              active={myState.starred}
              disabled={state.isPending}
              onClick={() => state.mutate({ starred: !myState.starred })}
            >
              <Star size={16} className={myState.starred ? 'fill-warn text-warn' : ''} />
            </IconButton>
            <IconButton
              label={myState.archived ? t('Unarchive', '取消归档') : t('Archive', '归档')}
              active={myState.archived}
              disabled={state.isPending}
              onClick={() => state.mutate({ archived: !myState.archived })}
            >
              {myState.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
            </IconButton>
          </>
        ) : null}
        {state.isError ? (
          <span className="ml-1 truncate text-xs text-danger" title={humanError(state.error).detail}>
            {humanError(state.error).text}
          </span>
        ) : null}
        {canFlag ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <IconButton label={t('Forward', '转发')} onClick={() => nav(`/app/compose?forward=${dropId}`)}>
              <Forward size={16} />
            </IconButton>
            <Button variant="primary" onClick={reply}>
              <Reply size={14} /> {t('Reply', '回复')}
            </Button>
          </div>
        ) : null}
      </div>

      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus so the arrow keys and Page Up/Down scroll the message (WCAG 2.1.1)
        tabIndex={0}
        aria-label={t('Message', '消息')}
        className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-focus)]"
      >
        <div className="mx-auto w-full max-w-3xl px-4 pb-10 pt-6 md:px-8 md:pt-8">
          {adminView ? (
            <div className="mb-3">
              <Chip tone="warn">{t('Admin view · read-only', '管理员视角·只读')}</Chip>
            </div>
          ) : null}
          {historyView ? (
            <div className="mb-3">
              <Chip tone="neutral">{t('Earlier group message · read-only', '群里的早前消息·只读')}</Chip>
            </div>
          ) : null}
          {d.reply_to ? (
            <p className="mb-1.5 flex min-w-0 items-center gap-1.5 text-sm text-muted">
              <Reply size={14} aria-hidden="true" className="shrink-0" />
              {/* any readable drop opens under the inbox route: the detail pane loads it whoever wrote it */}
              <Link
                className="min-w-0 truncate hover:text-fg hover:underline"
                to={`/app/inbox/${encodeURIComponent(d.reply_to.drop_id)}`}
              >
                {t('Reply to ', '回复')}
                <span className="untrusted text-fg-2">
                  {t(`“${d.reply_to.title}”`, `「${d.reply_to.title}」`)}
                </span>
              </Link>
            </p>
          ) : null}
          <h2 className="untrusted text-balance text-lg font-semibold text-fg">{d.title}</h2>

          <div className="mt-4 flex items-start gap-3">
            <Avatar name={d.author.display_label || d.author.handle} seed={d.author.handle} size={32} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                <span className="untrusted font-semibold text-fg">{d.author.display_label}</span>
                <span className="text-dim">@{d.author.handle}</span>
                {d.author.public_email ? <PublicEmail email={d.author.public_email} /> : null}
                {d.author.public_name ? <Chip>{d.author.public_name}</Chip> : null}
              </div>
              <div className="untrusted mt-0.5 text-xs text-muted">{routeLine(d, t)}</div>
            </div>
            <time
              className="shrink-0 pt-0.5 text-xs text-dim"
              dateTime={d.created_at}
              title={f.dateTime(d.created_at)}
            >
              {shortWhen(d.created_at, t, f.lang)}
            </time>
          </div>

          {d.mentions?.length ? (
            <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted">
              <span className="untrusted">
                {t('Mentions: ', '@了：')}
                {d.mentions.map((m) => `${m.display_label} @${m.handle}`).join(t(', ', '、'))}
              </span>
              {d.mentioned_me ? <Chip tone="accent">{t('including you', '包括你')}</Chip> : null}
            </p>
          ) : null}

          {d.replies && d.replies.count > 0 ? (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-muted">
              <MessageSquare size={14} aria-hidden="true" className="shrink-0 text-accent-fg" />
              <span className="untrusted">{repliesText(d.replies, t)}</span>
            </p>
          ) : null}

          <details className="group mt-3" open={view === 'sent' && Boolean(receipts)}>
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md text-xs font-medium text-dim hover:text-fg [&::-webkit-details-marker]:hidden">
              <ChevronRight size={13} className="transition-transform group-open:rotate-90" />
              {t('Details', '详情')}
            </summary>
            <div className="mt-2 space-y-3 rounded-lg border border-line bg-surface px-4 py-3">
              <MetaList
                items={[
                  {
                    label: t('From', '发件人'),
                    value: (
                      <span className="untrusted">
                        {d.author.display_label} @{d.author.handle}
                      </span>
                    ),
                  },
                  d.recipients.length
                    ? { label: t('To', '收件人'), value: recipientsText(d, t) }
                    : {
                        label: t('To', '收件人'),
                        value: (
                          <span className="untrusted">
                            {group
                              ? t(`The group ${groupText(group, t)}`, `群 ${groupText(group, t)}`)
                              : t('You', '你')}
                          </span>
                        ),
                      },
                  d.deliveries.length
                    ? {
                        label: t('Delivered to', '送达'),
                        value: d.deliveries.map((x) => x.agent_name).join(t(', ', '、')),
                      }
                    : null,
                  { label: t('Sent', '发送时间'), value: f.dateTime(d.created_at) },
                  d.received_at && d.received_at !== d.created_at
                    ? { label: t('Received', '收到时间'), value: f.dateTime(d.received_at) }
                    : null,
                ]}
              />
              {receipts ? <RecipientReceipts d={d} /> : null}
            </div>
          </details>

          {!canFlag && historyView ? (
            <p className="mt-4 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-fg-2">
              {t(
                "The group's owner lets members see earlier messages. This one wasn't delivered to any of your agents, so there's no read state to change.",
                '群主允许成员查看入群前的消息。这条没有投递到你的任何 Agent，所以没有已读状态可改。',
              )}
            </p>
          ) : null}
          {!canFlag && adminView ? (
            <p className="mt-4 rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-sm text-fg-2">
              {t(
                "You're viewing this group's history as a group admin. It wasn't delivered to any of your agents, so there's no read state to change. Every view is recorded in the audit log.",
                '你以群管理员身份查看本群历史：这条没有投递到你的任何 Agent，所以没有已读状态可改。每次查看都会记入审计日志。',
              )}
            </p>
          ) : null}

          <div className="mt-6 border-t border-line pt-6">
            <article className="untrusted max-w-[72ch] whitespace-pre-wrap text-base leading-7 text-fg">
              {d.body_chunk}
            </article>
            {d.next_offset !== null || offset > 0 ? (
              <div className="mt-4 flex gap-2">
                {offset > 0 ? (
                  <Button onClick={() => setOffset(Math.max(0, offset - 8192))}>
                    {t('Previous part', '上一段')}
                  </Button>
                ) : null}
                {d.next_offset !== null ? (
                  <Button onClick={() => setOffset(d.next_offset ?? 0)}>{t('Next part', '下一段')}</Button>
                ) : null}
              </div>
            ) : null}
            <p className="mt-4 flex items-center gap-1.5 text-xs text-dim">
              <ShieldCheck size={13} aria-hidden="true" />
              {t(
                'External content shown in isolation · never runs automatically',
                '外部内容隔离展示 · 不会自动执行',
              )}
            </p>
          </div>

          {d.attachments.length > 0 ? (
            <section className="mt-8">
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-fg-2">
                <Paperclip size={14} className="text-muted" />
                {t("Attachments · downloads don't open automatically", '附件 · 下载后不会自动打开')}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {d.attachments.map((a) => (
                  <AttachmentTile
                    key={a.attachment_id}
                    a={a}
                    href={mailboxUrl(hId, `/drops/${dropId}/attachments/${a.attachment_id}`)}
                    inGroup={d.group_ids.length > 0}
                  />
                ))}
              </div>
            </section>
          ) : null}
          {Object.keys(d.extensions).length > 0 ? (
            <details className="mt-6 text-xs">
              <summary className="cursor-pointer text-muted">
                {t('Extension fields (display only, never run)', '扩展字段（仅展示，不执行）')}
              </summary>
              <pre className="untrusted mt-2 rounded-lg bg-surface-2 p-3 font-mono">
                {JSON.stringify(d.extensions, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      </section>

      {canFlag ? (
        <div className="shrink-0 border-t border-line bg-surface px-4 py-3 md:px-8">
          <button
            type="button"
            onClick={reply}
            className="mx-auto flex w-full max-w-3xl items-center gap-3 rounded-lg border border-line-strong bg-bg px-3.5 py-2.5 text-left text-sm text-muted transition-colors hover:border-accent/40 hover:text-fg"
          >
            <PenSquare size={15} className="shrink-0 text-accent-fg" />
            <span className="min-w-0 flex-1 truncate">{t('Reply to this message…', '回复这条消息…')}</span>
            <ArrowRight size={15} className="shrink-0" />
          </button>
          <p className="mx-auto mt-1.5 max-w-3xl text-xs text-dim">
            {replyRecipient(d).startsWith('#')
              ? t(
                  'Goes to the group and says which message it answers · you confirm before it sends',
                  '发到群里并注明回复的是哪条 · 由你确认后发送',
                )
              : t(
                  'Goes to the sender and says which message it answers · you confirm before it sends',
                  '发给发件人并注明回复的是哪条 · 由你确认后发送',
                )}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** "Today 14:02" / "Sep 25 14:02" (with the year when it is not this year); the full time goes in a tooltip. */
function shortWhen(iso: string, t: Translate, lang: Lang): string {
  const d = new Date(iso);
  const time = formatClock(d, lang);
  if (d.toDateString() === new Date().toDateString()) return t(`Today ${time}`, `今天 ${time}`);
  return `${formatDay(d, lang)} ${time}`;
}
