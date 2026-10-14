import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, ChevronRight, Languages, Plug, ShieldCheck, UserRound, Webhook } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { ApiFailure, type Approval, api, type Connection } from '../lib/api.js';
import { plural, useFormat } from '../lib/format.js';
import { type Lang, setLang, useLang, useT } from '../lib/lang.js';
import { useFocusAwareInterval, useSession } from '../lib/session.js';
import { setTheme, type Theme, useTheme } from '../lib/theme.js';
import { ClientSettings } from '../ui/client-settings.js';
import { FeishuSettingsCard } from '../ui/feishu-settings.jsx';
import { Chip, EmptyState, MetaList, PageToolbar, Panel, Segmented } from '../ui/layout.jsx';
import { Button, ErrorBox, Field, Input, Loading } from '../ui/primitives.jsx';
import { PushSettingsCard } from '../ui/push-notifications.jsx';
import { RecoveryCodesCard } from '../ui/recovery-codes.jsx';
import {
  RadioSegmented,
  SectionNav,
  SettingsSwitch,
  TitleWithChip,
  useSectionSpy,
} from '../ui/settings-controls.jsx';

/** "Connections & sessions": MCP connections are facts; native sessions are shown as not connected. */
export function ConnectionsPage() {
  const { me } = useSession();
  const interval = useFocusAwareInterval();
  const conns = useQuery({
    queryKey: ['connections'],
    queryFn: () =>
      api.get<{ connections: Connection[]; native_sessions: { status: string } }>('/v1/me/connections'),
    refetchInterval: interval,
  });
  const t = useT();
  const fmt = useFormat();
  const nameOf = (hId: string) => me?.endpoints.find((e) => e.h_id === hId)?.label ?? hId.slice(0, 8);
  const list = conns.data?.connections ?? [];
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <PageToolbar title={t('Connections', '连接与会话')} />
      <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
        <Panel
          icon={<Plug size={16} />}
          title={t('MCP connections', 'MCP 连接')}
          description={t(
            'Bridge processes, not model sessions: one per running agent client.',
            'Bridge 进程，不是模型会话：每个运行中的 Agent 客户端一个。',
          )}
        >
          {conns.isLoading ? <Loading /> : null}
          {conns.isError ? <ErrorBox error={conns.error} retry={() => conns.refetch()} /> : null}
          {list.length > 0 ? (
            <ul className="-mx-5 -mb-5 -mt-1 divide-y divide-line border-t border-line">
              {list.map((c) => (
                <li key={c.connection_id} className="flex items-start gap-3 px-5 py-3">
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      c.status === 'live' ? 'bg-ok' : c.status === 'stale' ? 'bg-warn' : 'bg-line-strong'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-fg">{nameOf(c.h_id)}</span>
                      <span className="text-sm text-muted">
                        {c.client_name ?? t('Unknown client', '未知客户端')} {c.client_version ?? ''}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-dim">
                      {t('Toolset', '工具集')} {c.toolset ?? '–'} · {t('last tool', '最近工具')}{' '}
                      {c.last_tool ?? '–'} · {t('started', '启动于')} {fmt.dateTime(c.opened_at)} ·{' '}
                      {t('last active', '最后活跃')} {fmt.ago(c.last_seen_at)}
                    </div>
                  </div>
                  {c.status === 'live' ? (
                    <Chip tone="ok">{t('Online', '在线')}</Chip>
                  ) : c.status === 'stale' ? (
                    <Chip tone="warn">{t('Unconfirmed for 90 s', '90 秒未确认')}</Chip>
                  ) : (
                    <Chip>{t('Closed', '已关闭')}</Chip>
                  )}
                </li>
              ))}
            </ul>
          ) : conns.data ? (
            <p className="text-sm leading-6 text-muted">
              {t(
                'No Bridge connections yet. Run agentdrop setup in a terminal (see "My agents"), then start Codex / Claude Code, and connections will appear here.',
                '还没有 Bridge 连接。先在终端完成 agentdrop setup（见「我的 Agent」），然后启动 Codex / Claude Code，连接会在这里出现。',
              )}
            </p>
          ) : null}
        </Panel>
        <Panel
          title={
            <TitleWithChip chip={<Chip>{t('Not connected', '未接入')}</Chip>}>
              {t('Native sessions', '原生会话（Native Sessions）')}
            </TitleWithChip>
          }
        >
          <p className="text-sm leading-6 text-muted">
            {t(
              'AgentDrop does not read private Codex / Claude Code session data; the connection count is not the session count.',
              'AgentDrop 不读取 Codex / Claude Code 的私有会话数据；连接数不等于会话数。',
            )}
          </p>
        </Panel>
      </div>
    </div>
  );
}

export function ApprovalsPage() {
  const qc = useQueryClient();
  const params = useParams();
  const { me } = useSession();
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const list = useQuery({
    queryKey: ['approvals', filter],
    queryFn: () =>
      api.get<{ approvals: Approval[] }>(`/v1/me/approvals${filter === 'pending' ? '?status=pending' : ''}`),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'reject' }) =>
      api.post<{ status: string; drop_id: string | null }>(`/v1/me/approvals/${id}/decide`, { decision }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['mailbox'] });
    },
  });
  const t = useT();
  const fmt = useFormat();
  const nameOf = (hId: string) => me?.endpoints.find((e) => e.h_id === hId)?.label ?? hId.slice(0, 8);
  const items = (list.data?.approvals ?? []).filter(
    (a) => !params.approvalId || a.approval_id === params.approvalId,
  );
  const statusChip = (a: Approval) =>
    a.status === 'pending' ? (
      <Chip tone="warn">{t('Not sent · pending approval', '未发送 · 待审批')}</Chip>
    ) : a.status === 'consumed' ? (
      <Chip tone="ok">{t('Approved and delivered', '已批准并投递')}</Chip>
    ) : a.status === 'approved' ? (
      <Chip tone="ok">{t('Approved', '已批准')}</Chip>
    ) : a.status === 'rejected' ? (
      <Chip>{t('Rejected · not sent', '已拒绝 · 未发送')}</Chip>
    ) : a.status === 'expired' ? (
      <Chip>{t('Expired · not sent', '已过期 · 未发送')}</Chip>
    ) : (
      <Chip>{a.status}</Chip>
    );
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <PageToolbar
        title={t('Approvals', '审批')}
        actions={
          <Segmented
            label={t('Show', '显示')}
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'pending', label: t('Pending approval', '待审批') },
              { value: 'all', label: t('All', '全部') },
            ]}
          />
        }
      />
      <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
        {list.isLoading ? <Loading /> : null}
        {list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : null}
        {decide.data ? (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              decide.data.status === 'delivered'
                ? 'border-ok-line bg-ok-bg text-ok'
                : 'border-line bg-hover text-fg-2'
            }`}
            role="status"
          >
            {decide.data.status === 'delivered'
              ? t('Delivered.', '已投递。')
              : t('Rejected; the request is marked as not sent.', '已拒绝，该请求标记为未发送。')}
          </div>
        ) : null}
        {decide.isError ? (
          <ErrorBox
            error={
              decide.error instanceof ApiFailure &&
              decide.error.body.code === 'STALE_APPROVAL' &&
              decide.error.body.details?.closed !== true
                ? new Error(
                    t(
                      'The recipients changed after the preview (for example, the recipient changed which agent receives). The preview has been refreshed; check it again and approve once more.',
                      '收件目标在预览后发生了变化（例如对方改了接收的 Agent）。已刷新预览，请重新核对后再批准一次。',
                    ),
                  )
                : decide.error
            }
          />
        ) : null}
        {list.data && items.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck size={20} />}
            title={
              filter === 'pending'
                ? t('No sends awaiting approval', '没有待审批的发送')
                : t('No approvals yet', '还没有审批记录')
            }
          >
            {filter === 'pending'
              ? t(
                  'Outgoing sends that need your confirmation are listed here; they are delivered only after you approve.',
                  '需要你确认的外发会列在这里；批准后才会投递。',
                )
              : null}
          </EmptyState>
        ) : null}
        {items.map((a) => (
          <Panel
            key={a.approval_id}
            title={
              <TitleWithChip chip={statusChip(a)}>
                <span className="break-words">{a.title}</span>
              </TitleWithChip>
            }
          >
            <MetaList
              items={[
                { label: t('From', '从'), value: nameOf(a.origin_h_id) },
                {
                  label: t('To', '发往'),
                  value: a.recipients
                    .map((r) => (r.endpoint_label ? `${r.label} → ${r.endpoint_label}` : r.label))
                    .join(t(', ', '，')),
                },
                { label: t('Created', '创建于'), value: fmt.dateTime(a.created_at) },
                { label: t('Expires', '过期'), value: fmt.dateTime(a.expires_at) },
                a.attachment_ids.length > 0
                  ? {
                      label: t('Attachments', '附件'),
                      value: t(
                        plural(a.attachment_ids.length, 'attachment', 'attachments'),
                        `${a.attachment_ids.length} 个附件`,
                      ),
                    }
                  : null,
              ]}
            />
            {a.reasons.length > 0 ? (
              <div className="rounded-lg border border-warn-line bg-warn-bg px-3 py-2">
                <div className="text-xs font-medium text-warn">
                  {t('Why it needs you', '需要你确认的原因')}
                </div>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-fg-2 marker:text-warn">
                  {a.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="untrusted max-h-60 overflow-y-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs leading-5 text-fg-2">
              {a.body_preview}
            </div>
            {a.status === 'pending' ? (
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="danger"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: a.approval_id, decision: 'reject' })}
                >
                  {t('Reject', '拒绝')}
                </Button>
                <Button
                  variant="primary"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: a.approval_id, decision: 'approve' })}
                >
                  {t('Approve and deliver', '批准并投递')}
                </Button>
              </div>
            ) : null}
          </Panel>
        ))}
      </div>
    </div>
  );
}

const SETTINGS_SECTIONS = ['account', 'appearance', 'notifications', 'clients', 'privacy'] as const;

export function SettingsPage() {
  const { me, refresh } = useSession();
  const t = useT();
  const qc = useQueryClient();
  const scroller = useRef<HTMLDivElement>(null);
  const active = useSectionSpy(SETTINGS_SECTIONS, scroller);
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [webhook, setWebhook] = useState<string | null>(null);
  const [mailboxVisibility, setMailboxVisibility] = useState<boolean | null>(null);
  const saveMailboxVisibility = useMutation({
    mutationFn: (cross_h_mailbox_enabled: boolean) =>
      api.patch('/v1/me/mailbox-settings', { cross_h_mailbox_enabled }),
    onSuccess: async () => {
      qc.removeQueries({ queryKey: ['mailbox'] });
      await refresh();
      setMailboxVisibility(null);
    },
    onError: () => setMailboxVisibility(null),
  });
  const saveWebhook = useMutation({
    mutationFn: (webhook_url: string | null) => api.patch('/v1/me/notifications', { webhook_url }),
    onSuccess: () => {
      refresh();
      setWebhook(null);
    },
  });
  const save = useMutation({
    mutationFn: (display_name: string) => api.patch('/v1/me', { display_name }),
    onSuccess: () => {
      refresh();
      setName(null);
    },
  });
  const saveEmail = useMutation({
    mutationFn: (public_email: string | null) => api.put('/v1/me/public-email', { public_email }),
    onSuccess: () => {
      refresh();
      setEmail(null);
    },
  });
  if (!me) return null;
  const publishedEmail = me.public_email ?? '';
  const titles: Record<(typeof SETTINGS_SECTIONS)[number], string> = {
    account: t('Account', '账号'),
    appearance: t('Appearance', '外观'),
    notifications: t('Notifications', '通知'),
    clients: t('Agent clients', 'Agent 客户端'),
    privacy: t('Privacy', '隐私'),
  };
  const sections = SETTINGS_SECTIONS.map((id) => ({ id, title: titles[id] }));
  return (
    <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
      <PageToolbar title={t('Settings', '设置')} />
      <div className="mx-auto flex max-w-5xl gap-10 p-4 md:p-6">
        <aside className="sticky top-20 hidden h-fit w-44 shrink-0 lg:block">
          <SectionNav label={t('Settings sections', '设置分区')} sections={sections} active={active} />
        </aside>
        <div className="min-w-0 flex-1 space-y-10">
          {/* below lg the sections are a row of links instead of a sidebar */}
          <nav
            aria-label={t('Settings sections', '设置分区')}
            className="-mx-4 -mt-1 flex gap-1 overflow-x-auto px-4 lg:hidden"
          >
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className={`shrink-0 rounded-md px-2.5 py-1 text-sm ${
                  s.id === active ? 'bg-hover font-medium text-fg' : 'text-muted hover:text-fg'
                }`}
              >
                {s.title}
              </a>
            ))}
          </nav>

          <SettingsGroup id="account" title={titles.account}>
            <Panel
              icon={<UserRound size={16} />}
              title={
                <TitleWithChip chip={<Chip tone="accent">@{me.handle}</Chip>}>
                  {t('Profile', '个人资料')}
                </TitleWithChip>
              }
              description={t(
                'Contacts and group members see your nickname and public email; your handle is permanent.',
                '联系人和群成员能看到你的昵称和公开邮箱；handle 注册后不能改。',
              )}
            >
              <Field label={t('Public nickname', '公开昵称')}>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={name ?? me.display_name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={64}
                  />
                  <Button
                    className="h-9 sm:w-32"
                    disabled={name === null || save.isPending}
                    onClick={() => save.mutate(name ?? '')}
                  >
                    {save.isPending ? t('Saving…', '保存中…') : t('Save nickname', '保存昵称')}
                  </Button>
                </div>
              </Field>
              {save.isError ? <ErrorBox error={save.error} /> : null}
              <Field
                label={t('Public email', '公开邮箱')}
                hint={t(
                  'Optional. Shown on your profile and on every agent of yours, so people can find you in other tools. It is not verified. Save it empty to remove it.',
                  '可选。显示在你的资料和你的每个 Agent 上，方便别人在其他工具里找到你。不做验证。留空保存即删除。',
                )}
              >
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    type="email"
                    autoComplete="email"
                    value={email ?? publishedEmail}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@example.com"
                    maxLength={254}
                  />
                  <Button
                    className="h-9 sm:w-32"
                    disabled={email === null || email.trim() === publishedEmail || saveEmail.isPending}
                    onClick={() => saveEmail.mutate(email?.trim() ? email.trim() : null)}
                  >
                    {saveEmail.isPending ? t('Saving…', '保存中…') : t('Save email', '保存邮箱')}
                  </Button>
                </div>
              </Field>
              {me.sign_in_email && me.sign_in_email.toLowerCase() !== publishedEmail ? (
                <Button
                  variant="ghost"
                  className="-ml-3 -mt-2 max-w-full truncate text-muted"
                  disabled={saveEmail.isPending}
                  onClick={() => saveEmail.mutate(me.sign_in_email ?? null)}
                >
                  {t(`Use my sign-in email (${me.sign_in_email})`, `使用登录邮箱（${me.sign_in_email}）`)}
                </Button>
              ) : null}
              {saveEmail.isError ? <ErrorBox error={saveEmail.error} /> : null}
            </Panel>
            <RecoveryCodesCard />
          </SettingsGroup>

          <SettingsGroup id="appearance" title={titles.appearance}>
            <AppearanceCard />
          </SettingsGroup>

          <SettingsGroup id="notifications" title={titles.notifications}>
            <FeishuSettingsCard />
            <PushSettingsCard />
            <details className="card group rounded-xl border border-line">
              <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4">
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent-fg">
                  <Webhook size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-fg">
                      {t('Developer webhook', '开发者 Webhook')}
                    </span>
                    <Chip>{t('Advanced', '高级')}</Chip>
                    {me.notification_webhook_url ? <Chip tone="ok">{t('On', '已开启')}</Chip> : null}
                  </span>
                  <span className="mt-0.5 block text-sm text-muted">
                    {t(
                      'POSTs event JSON (no message bodies or attachments) to your own HTTPS receiver.',
                      '把事件 JSON（不含正文和附件）POST 到你自建的 HTTPS 接收端。',
                    )}
                  </span>
                </span>
                <ChevronRight
                  size={16}
                  aria-hidden="true"
                  className="shrink-0 text-dim transition-transform group-open:rotate-90"
                />
              </summary>
              <div className="space-y-4 border-t border-line px-5 py-4">
                <p className="text-sm leading-6 text-muted">
                  {t(
                    'Chat bots usually need an adapter; for Feishu use the card above.',
                    '聊天机器人通常需要适配；飞书请用上面的卡片。',
                  )}
                </p>
                <Field
                  label={t('Receiving URL', '接收地址')}
                  hint={t('Save it empty to turn the Webhook off.', '留空保存即关闭。')}
                >
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      value={webhook ?? me.notification_webhook_url ?? ''}
                      onChange={(e) => setWebhook(e.target.value)}
                      placeholder="https://example.com/agentdrop-events"
                    />
                    <Button
                      className="h-9 sm:w-32"
                      disabled={webhook === null || saveWebhook.isPending}
                      onClick={() => saveWebhook.mutate(webhook || null)}
                    >
                      {saveWebhook.isPending ? t('Saving…', '保存中…') : t('Save Webhook', '保存 Webhook')}
                    </Button>
                  </div>
                </Field>
                {saveWebhook.isError ? <ErrorBox error={saveWebhook.error} /> : null}
              </div>
            </details>
          </SettingsGroup>

          <SettingsGroup id="clients" title={titles.clients}>
            <ClientSettings />
          </SettingsGroup>

          <SettingsGroup id="privacy" title={titles.privacy}>
            <Panel
              icon={<Boxes size={16} />}
              title={t('Cross-agent history', '跨 Agent 消息记录')}
              description={t(
                "Whether your agents can read each other's history; read and starred stay shared either way.",
                '你的各个 Agent 能否互相看到收发记录；已读、收藏始终同步。',
              )}
            >
              <SettingsSwitch
                checked={mailboxVisibility ?? me.cross_h_mailbox_enabled}
                disabled={saveMailboxVisibility.isPending}
                onChange={(checked) => {
                  setMailboxVisibility(checked);
                  saveMailboxVisibility.mutate(checked);
                }}
                title={t('Let all agents see the full history', '允许所有 Agent 查看完整记录')}
                description={t(
                  'Turning it off deletes nothing; each agent just sees its own history again.',
                  '关闭不会删除任何内容，只是各 Agent 只看得到自己的记录。',
                )}
              />
              {saveMailboxVisibility.isError ? <ErrorBox error={saveMailboxVisibility.error} /> : null}
            </Panel>
            <Panel icon={<ShieldCheck size={16} />} title={t('What the server can see', '服务器能看到什么')}>
              <div className="space-y-2 text-sm leading-6 text-fg-2">
                <p>
                  {me?.content_encryption === 'on'
                    ? t(
                        'Traffic uses HTTPS and this server stores message content encrypted: a copy of its database, a backup or its file storage alone reveals nothing. Whoever runs the server and holds its key can still decrypt; this is not end-to-end encryption.',
                        '传输全程 HTTPS，本服务器加密存储消息内容：只拿到数据库、备份或文件存储看不到内容。同时掌握服务器和密钥的运维方仍能解密，这不是端到端加密。',
                      )
                    : t(
                        'Traffic uses HTTPS, but content is stored readable on the server: its operator can technically read it. There is no end-to-end encryption.',
                        '传输全程 HTTPS，但内容在服务器上可读存储，运营方技术上能读取；没有端到端加密。',
                      )}
                </p>
                <p>
                  {t(
                    'Received content is untrusted data: nothing is run, opened or passed on automatically.',
                    '收到的内容一律视为不可信数据：不会被自动执行、打开或转交。',
                  )}
                </p>
              </div>
            </Panel>
          </SettingsGroup>
        </div>
      </div>
    </div>
  );
}

/** One titled group of settings panels, an anchor for the in-page navigation. */
function SettingsGroup({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 space-y-3">
      <h2 className="text-sm font-medium text-fg-2">{title}</h2>
      {children}
    </section>
  );
}

/** Language (English by default) and theme (dark by default) of this dashboard, kept in this browser. */
function AppearanceCard() {
  const lang = useLang();
  const theme = useTheme();
  const t = useT();
  const row = (label: string, control: ReactNode) => (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="text-sm font-medium text-fg-2">{label}</div>
      {control}
    </div>
  );
  return (
    <Panel
      icon={<Languages size={16} />}
      title={t('Language & theme', '语言与主题')}
      description={t(
        'For this browser only; agent notices follow agentdrop settings --language.',
        '只对这个浏览器生效；Agent 里的提醒语言用 agentdrop settings --language 设置。',
      )}
    >
      {row(
        t('Language', '语言'),
        <RadioSegmented<Lang>
          label={t('Language', '语言')}
          value={lang}
          options={[
            { value: 'en', label: 'English' },
            { value: 'zh', label: '中文' },
          ]}
          onChange={setLang}
        />,
      )}
      <div className="border-t border-line" />
      {row(
        t('Theme', '主题'),
        <RadioSegmented<Theme>
          label={t('Theme', '主题')}
          value={theme}
          options={[
            { value: 'dark', label: t('Dark', '深色') },
            { value: 'light', label: t('Light', '浅色') },
          ]}
          onChange={setTheme}
        />,
      )}
    </Panel>
  );
}
