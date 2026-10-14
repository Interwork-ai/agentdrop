import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  Bot,
  ChevronDown,
  ChevronsUpDown,
  CircleHelp,
  ContactRound,
  FileCheck2,
  FolderLock,
  Hash,
  Inbox,
  type LayoutGrid,
  LogOut,
  Menu as MenuIcon,
  PenSquare,
  Send,
  Settings,
  ShieldCheck,
  Star,
  UsersRound,
  Waypoints,
  X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import {
  type Approval,
  api,
  type GroupSummary,
  harnessLabel,
  type JoinRequestView,
  type ListDrops,
  mailboxUrl,
} from '../lib/api.js';
import { type Translate, useT } from '../lib/lang.js';
import { mailboxKey, useFocusAwareInterval, useSession } from '../lib/session.js';
import { useDocumentTitle } from '../ui/document-title.jsx';
import { Drawer } from '../ui/drawer.jsx';
import { PageErrorBoundary } from '../ui/error-boundary.jsx';
import { Avatar, IconButton } from '../ui/layout.jsx';
import { PairAgentBanner } from '../ui/needs-agent.jsx';
import { PreferenceToggles } from '../ui/preferences.jsx';
import { Button, Loading } from '../ui/primitives.jsx';

/** The name of the page a path belongs to: the browser tab's title and the phone's top bar (the page itself carries the real heading). */
function pageTitle(pathname: string, t: Translate): string {
  const section = pathname.split('/')[2] ?? '';
  const titles: Record<string, string> = {
    inbox: t('Inbox', '收件箱'),
    sent: t('Sent', '已发送'),
    starred: t('Starred', '收藏'),
    archived: t('Archived', '归档'),
    compose: t('New message', '写消息'),
    space: t('My space', '我的空间'),
    contacts: t('Contacts', '联系人'),
    groups: t('Groups', '群组'),
    agents: t('My agents', '我的 Agent'),
    connections: t('Connections', '连接'),
    approvals: t('Approvals', '审批'),
    settings: t('Settings', '设置'),
    help: t('Help', '使用说明'),
    admin: t('Admin', '管理后台'),
  };
  return titles[section] ?? 'AgentDrop';
}

/**
 * Global frame. From `md` a 240 px sidebar carries everything global: brand, the agent sending right now, New
 * message, navigation and the account (language, theme, sign out); each page owns its own toolbar, so there is no
 * top bar. On a phone the same sidebar is a modal drawer (ui/drawer.tsx) after a compact top bar in the DOM, with a
 * tab bar at the bottom. A skip link leads past the navigation to the page.
 */
export function AppShell() {
  const { me, loading, currentH, setCurrentH, signOut } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const interval = useFocusAwareInterval();
  const [menuOpen, setMenuOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(true);
  const t = useT();
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useEffect(() => {
    if (loc.pathname) setMenuOpen(false);
  }, [loc.pathname]);
  // the drawer is a phone-only dialog: widening the window past `md` turns it back into the static sidebar
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 768px)');
    const onChange = () => {
      if (wide.matches) setMenuOpen(false);
    };
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, []);
  const unread = useQuery({
    queryKey: currentH ? mailboxKey(currentH.h_id, 'unread') : ['none'],
    queryFn: () =>
      api.get<ListDrops>(mailboxUrl(currentH?.h_id ?? '', '/drops?view=inbox&limit=1&unread_only=true')),
    enabled: !!currentH,
    refetchInterval: interval,
  });
  const groups = useQuery({
    queryKey: ['groups', currentH?.h_id],
    queryFn: () =>
      api.get<{ groups: GroupSummary[] }>(`/v1/me/groups${currentH ? `?h_id=${currentH.h_id}` : ''}`),
    enabled: !!me,
    refetchInterval: interval * 3,
  });
  const contacts = useQuery({
    queryKey: ['contacts'],
    queryFn: () => api.get<{ contacts: Array<{ status: string }> }>('/v1/me/contacts'),
    enabled: !!me,
    refetchInterval: interval,
  });
  const contactRequests = (contacts.data?.contacts ?? []).filter((c) => c.status === 'requested').length;
  const groupInvites = (groups.data?.groups ?? []).filter((g) => g.status === 'invited').length;
  /*
   * Join requests waiting for me as an owner/admin. The mailbox poll already carries the account-wide count, so
   * the badge normally costs nothing; with no endpoint to poll (nothing paired yet) fall back to asking the
   * groups where I could actually decide one, at the group list's own cadence.
   */
  const viewerJoinRequests = unread.data?.viewer.pending.group_join_requests;
  const adminGroupIds = (groups.data?.groups ?? [])
    .filter((g) => g.status === 'active' && (g.role === 'owner' || g.role === 'admin'))
    .map((g) => g.group_id);
  const joinRequests = useQuery({
    queryKey: ['group-join-requests', adminGroupIds],
    queryFn: async () => {
      const perGroup = await Promise.all(
        adminGroupIds.map((groupId) =>
          api
            .get<{ join_requests: JoinRequestView[] }>(`/v1/me/groups/${groupId}/requests`)
            .then((r) => r.join_requests.length)
            .catch(() => 0),
        ),
      );
      return perGroup.reduce((total, n) => total + n, 0);
    },
    enabled: !currentH && adminGroupIds.length > 0,
    refetchInterval: interval * 3,
  });
  const pendingJoinRequests = currentH ? (viewerJoinRequests ?? 0) : (joinRequests.data ?? 0);
  const tabUnread = unread.data?.unread_count ?? 0;
  const section = loc.pathname.split('/')[2] ?? '';
  useDocumentTitle(
    me
      ? `${pageTitle(loc.pathname, t)}${section === 'inbox' && tabUnread > 0 ? ` (${tabUnread})` : ''} · AgentDrop`
      : null,
  );
  const approvals = useQuery({
    queryKey: ['approvals', 'pending'],
    queryFn: () => api.get<{ approvals: Approval[] }>('/v1/me/approvals?status=pending'),
    enabled: !!me,
    refetchInterval: interval,
  });

  if (loading) return <Loading />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  const active = me.endpoints.filter((e) => !e.revoked_at);
  const unreadCount = tabUnread;
  const pendingApprovals = approvals.data?.approvals.length ?? 0;
  const activeGroups = (groups.data?.groups ?? []).filter((g) => g.status === 'active');

  return (
    <div className="app-frame flex h-full flex-col bg-bg md:flex-row">
      <a
        href="#main-content"
        className="sr-only rounded-lg bg-surface px-3 py-2 text-sm font-medium text-fg ring-2 ring-focus focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50"
      >
        {t('Skip to content', '跳到正文')}
      </a>
      {/* phone top bar first in the DOM, so the drawer it opens comes right after its button */}
      <header
        inert={menuOpen}
        className="glass flex h-14 shrink-0 items-center gap-2 border-b border-line px-2 md:hidden"
      >
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
          aria-label={t('Open navigation menu', '打开导航菜单')}
          aria-expanded={menuOpen}
          aria-controls="workspace-navigation"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <MenuIcon size={18} />
        </button>
        <div className="brand-mark scale-90" aria-hidden="true">
          <Waypoints size={14} strokeWidth={2.25} />
        </div>
        {/* the page names itself in its own toolbar; the bar says who is sending, which the drawer hides */}
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-semibold text-fg">
            {currentH ? currentH.label : 'AgentDrop'}
          </div>
          <div className="truncate text-xs text-dim">
            {currentH
              ? `${currentH.device.label} · ${harnessLabel(currentH.harness_key)}`
              : pageTitle(loc.pathname, t)}
          </div>
        </div>
        <Button className="shrink-0" onClick={() => nav('/app/compose')} disabled={!currentH}>
          <PenSquare size={14} />
          {t('Write', '写消息')}
        </Button>
      </header>
      <Drawer
        id="workspace-navigation"
        open={menuOpen}
        onClose={closeMenu}
        label={t('Navigation', '导航')}
        closeLabel={t('Close navigation', '关闭导航')}
        className={`fixed inset-y-0 left-0 z-40 w-60 shrink-0 flex-col border-r border-line bg-surface shadow-2xl md:static md:flex md:shadow-none ${menuOpen ? 'flex' : 'hidden'}`}
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
          <div className="brand-mark" aria-hidden="true">
            <Waypoints size={15} strokeWidth={2.25} />
          </div>
          <span className="text-md font-semibold tracking-tight text-fg">AgentDrop</span>
          <IconButton label={t('Close menu', '关闭菜单')} className="ml-auto md:hidden" onClick={closeMenu}>
            <X size={16} />
          </IconButton>
        </div>

        <div className="space-y-2 px-3 pb-2">
          {currentH ? (
            <div className="group relative rounded-lg border border-line bg-surface-2 px-3 py-2 transition-colors focus-within:border-accent/60 hover:border-line-strong">
              <div className="text-xs text-dim">{t('Sending as', '当前发件')}</div>
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full bg-ok"
                  title={t('Paired; this does not mean the agent is online', '已配对；不代表 Agent 在线')}
                />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
                  {currentH.label}
                </span>
                {active.length > 1 ? (
                  <ChevronsUpDown size={14} className="shrink-0 text-dim group-hover:text-fg" />
                ) : null}
              </div>
              <div className="truncate pl-4 text-xs text-muted">
                {currentH.device.label} · {harnessLabel(currentH.harness_key)}
              </div>
              {/* the whole card opens the native agent picker: accessible and right on every platform */}
              <select
                className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
                value={currentH.h_id}
                onChange={(e) => setCurrentH(e.target.value)}
                aria-label={t('Current agent', '当前 Agent')}
              >
                {active.map((e) => (
                  <option className="bg-surface-2 text-fg" key={e.h_id} value={e.h_id}>
                    {e.label} · {e.device.label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <NavLink
              to="/app/agents"
              aria-label={t('No agent paired yet · see setup steps', '还没有配对的 Agent · 查看安装步骤')}
              className="block rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm hover:border-accent/50"
            >
              <span className="block font-medium text-fg">
                {t('No agent paired yet', '还没有配对的 Agent')}
              </span>
              <span className="block text-xs text-accent-fg">
                {t('See the setup steps →', '查看安装步骤 →')}
              </span>
            </NavLink>
          )}
          <Button
            variant="primary"
            className="h-9 w-full"
            onClick={() => nav('/app/compose')}
            disabled={!currentH}
          >
            <PenSquare size={15} />
            {t('New message', '写消息')}
          </Button>
        </div>

        <nav
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 text-sm"
          aria-label={t('Main navigation', '主导航')}
        >
          <Section title={t('Mail', '邮件')}>
            <Item to="/app/inbox" icon={Inbox}>
              {t('Inbox', '收件箱')}
              {unreadCount > 0 ? <CountBadge tone="accent">{unreadCount}</CountBadge> : null}
            </Item>
            <Item to="/app/sent" icon={Send}>
              {t('Sent', '已发送')}
            </Item>
            <Item to="/app/starred" icon={Star}>
              {t('Starred', '收藏')}
            </Item>
            <Item to="/app/archived" icon={Archive}>
              {t('Archived', '归档')}
            </Item>
            <Item to="/app/space" icon={FolderLock}>
              {t('My space', '我的空间')}
            </Item>
          </Section>
          <Section title={t('People', '联系人与群组')}>
            <Item to="/app/contacts" icon={ContactRound}>
              {t('Contacts', '联系人')}
              {contactRequests > 0 ? (
                <CountBadge tone="warn" title={t('Requests waiting for you', '待我接受的申请')}>
                  {contactRequests}
                </CountBadge>
              ) : null}
            </Item>
            <div className="relative">
              <Item to="/app/groups" icon={UsersRound} end>
                {t('All groups', '全部群组')}
                <span className="ml-auto flex items-center gap-1 pr-6">
                  {groupInvites > 0 ? (
                    <CountBadge tone="warn" title={t('Invitations waiting for you', '待我处理的邀请')}>
                      {groupInvites}
                    </CountBadge>
                  ) : null}
                  {pendingJoinRequests > 0 ? (
                    <CountBadge
                      tone="warn"
                      title={t('Join requests waiting for your approval', '待我批准的入群申请')}
                    >
                      {t(`${pendingJoinRequests} to approve`, `${pendingJoinRequests} 待批`)}
                    </CountBadge>
                  ) : null}
                </span>
              </Item>
              {activeGroups.length > 0 ? (
                <button
                  type="button"
                  aria-expanded={groupsOpen}
                  aria-controls="sidebar-groups"
                  aria-label={
                    groupsOpen ? t('Hide my groups', '收起我的群组') : t('Show my groups', '展开我的群组')
                  }
                  title={
                    groupsOpen ? t('Hide my groups', '收起我的群组') : t('Show my groups', '展开我的群组')
                  }
                  onClick={() => setGroupsOpen((v) => !v)}
                  className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-md text-dim hover:bg-hover hover:text-fg"
                >
                  <ChevronDown
                    size={14}
                    className={`transition-transform ${groupsOpen ? '' : '-rotate-90'}`}
                  />
                </button>
              ) : null}
            </div>
            {groupsOpen ? (
              <div id="sidebar-groups" className="space-y-px">
                {activeGroups.map((g) => (
                  <Item key={g.group_id} to={`/app/groups/${g.group_id}`} icon={Hash} indent>
                    <span className="min-w-0 truncate">{g.display_name}</span>
                    {g.current_h_receives === false ? (
                      <span className="ml-auto shrink-0 text-xs text-dim">
                        {t('Not receiving', '未接收')}
                      </span>
                    ) : null}
                  </Item>
                ))}
              </div>
            ) : null}
          </Section>
          <Section title={t('Workspace', '工作区')}>
            <Item to="/app/agents" icon={Bot}>
              {t('My agents', '我的 Agent')}
            </Item>
            <Item to="/app/approvals" icon={FileCheck2}>
              {t('Approvals', '审批')}
              {pendingApprovals > 0 ? <CountBadge tone="warn">{pendingApprovals}</CountBadge> : null}
            </Item>
            <Item to="/app/settings" icon={Settings}>
              {t('Settings', '设置')}
            </Item>
            <Item to="/app/help" icon={CircleHelp}>
              {t('Help', '使用说明')}
            </Item>
            {me.is_admin ? (
              <Item to="/app/admin" icon={ShieldCheck}>
                {t('Admin', '管理后台')}
              </Item>
            ) : null}
          </Section>
        </nav>

        <div className="shrink-0 space-y-2 border-t border-line px-3 py-3">
          <div className="flex items-center gap-2.5">
            <Avatar name={me.display_name || me.handle} seed={me.handle} size={32} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-medium text-fg">{me.display_name}</div>
              <div className="truncate text-xs text-dim">@{me.handle}</div>
            </div>
            <IconButton label={t('Sign out', '退出')} onClick={() => signOut().then(() => nav('/login'))}>
              <LogOut size={15} />
            </IconButton>
          </div>
          <PreferenceToggles stretch />
        </div>
      </Drawer>

      <div inert={menuOpen} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          {active.length === 0 && !loc.pathname.startsWith('/app/agents') ? <PairAgentBanner /> : null}
          <main
            id="main-content"
            tabIndex={-1}
            className="flex min-h-0 min-w-0 flex-1 animate-fade-in outline-none"
            key={loc.pathname.split('/').slice(0, 3).join('/')}
          >
            <PageErrorBoundary>
              <Outlet />
            </PageErrorBoundary>
          </main>
        </div>
        <nav
          className="mobile-nav grid h-14 shrink-0 grid-cols-5 border-t border-line bg-surface md:hidden"
          aria-label={t('Mobile navigation', '移动导航')}
        >
          <MobileItem
            to="/app/inbox"
            icon={Inbox}
            label={t('Inbox', '收件')}
            badge={unreadCount}
            tone="accent"
          />
          <MobileItem
            to="/app/contacts"
            icon={ContactRound}
            label={t('Contacts', '联系人')}
            badge={contactRequests}
          />
          <MobileItem
            to="/app/groups"
            icon={UsersRound}
            label={t('Groups', '群组')}
            badge={groupInvites + pendingJoinRequests}
          />
          <MobileItem to="/app/agents" icon={Bot} label="Agent" />
          <MobileItem to="/app/settings" icon={Settings} label={t('Settings', '设置')} />
        </nav>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pt-3">
      <div className="px-2.5 pb-1 text-xs font-medium text-dim">{title}</div>
      <div className="space-y-px">{children}</div>
    </div>
  );
}

/** A count next to a navigation entry: accent for unread mail, warn for something waiting on the person. */
function CountBadge({
  children,
  tone,
  title,
}: {
  children: ReactNode;
  tone: 'accent' | 'warn';
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`ml-auto shrink-0 rounded-md px-1.5 text-xs font-semibold tabular-nums ${
        tone === 'accent' ? 'bg-accent/15 text-accent-fg' : 'bg-warn-bg text-warn'
      }`}
    >
      {children}
    </span>
  );
}

function Item({
  to,
  children,
  icon: Icon,
  end,
  indent,
}: {
  to: string;
  children: ReactNode;
  icon?: typeof LayoutGrid;
  /** Active only on this exact path, not on its sub-pages (a group's own entry lights up instead). */
  end?: boolean;
  /** A child entry (one group under "All groups"). */
  indent?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end ?? false}
      className={({ isActive }) =>
        `group/item flex h-8 items-center gap-2.5 rounded-md pr-2 transition-colors duration-150 ${
          indent ? 'pl-6' : 'pl-2.5'
        } ${isActive ? 'bg-selected font-medium text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg'}`
      }
    >
      {({ isActive }) => (
        <>
          {Icon ? (
            <Icon
              size={indent ? 13 : 15}
              strokeWidth={1.9}
              className={`shrink-0 ${isActive ? 'text-accent-fg' : 'text-dim group-hover/item:text-muted'}`}
            />
          ) : null}
          {children}
        </>
      )}
    </NavLink>
  );
}

function MobileItem({
  to,
  icon: Icon,
  label,
  badge = 0,
  tone = 'warn',
}: {
  to: string;
  icon: typeof LayoutGrid;
  label: string;
  badge?: number;
  tone?: 'accent' | 'warn';
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex flex-col items-center justify-center gap-0.5 text-xs ${isActive ? 'font-medium text-accent-fg' : 'text-dim'}`
      }
    >
      <span className="relative">
        <Icon size={18} strokeWidth={1.9} />
        {badge > 0 ? (
          <span
            className={`absolute -right-3 -top-1.5 min-w-4 rounded-full px-1 text-center text-xs font-semibold leading-4 ${
              tone === 'accent' ? 'bg-accent text-on-accent' : 'bg-warn text-bg'
            }`}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
      </span>
      {label}
    </NavLink>
  );
}
