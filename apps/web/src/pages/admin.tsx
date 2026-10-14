import type {
  AdminAuditEvent,
  AdminOverview,
  AdminPasswordResetLink,
  AdminProductHealth,
  AdminSettings,
  AdminUserDetail,
  AdminUserSummary,
  SignupMode,
} from '@agentdrop/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Users as UsersIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { api, harnessLabel } from '../lib/api.js';
import { AUDIT_CATEGORIES, auditActionLabel, auditResult } from '../lib/audit-labels.js';
import { formatAgo, formatBytes, formatDateTime } from '../lib/format.js';
import { type Translate, useT } from '../lib/lang.js';
import { useSession } from '../lib/session.js';
import {
  Avatar,
  Chip,
  EmptyState,
  ListLabel,
  listRowClass,
  PageToolbar,
  Panel,
  Segmented,
  SplitView,
} from '../ui/layout.jsx';
import { Button, copyText, ErrorBox, Field, Input, Loading } from '../ui/primitives.jsx';

export type AdminSection = 'overview' | 'users' | 'audit' | 'settings';

const tabs = (t: Translate): Array<{ to: string; label: string; section: AdminSection }> => [
  { to: '/app/admin', label: t('Overview', '总览'), section: 'overview' },
  { to: '/app/admin/users', label: t('Users', '用户'), section: 'users' },
  { to: '/app/admin/audit', label: t('Audit log', '审计日志'), section: 'audit' },
  { to: '/app/admin/settings', label: t('Server settings', '服务器设置'), section: 'settings' },
];

/**
 * Operator console. It shows accounts, agents, activity and counters. It deliberately shows no message content:
 * the API does not return titles or bodies here, and nothing on this page asks for them.
 */
export function AdminPage({ section }: { section: AdminSection }) {
  const { me } = useSession();
  const t = useT();
  if (!me) return <Loading />;
  if (!me.is_admin)
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <PageToolbar title={t('Admin', '管理后台')} />
        <EmptyState title={t('Admins only', '仅管理员可见')}>
          {t('This account does not have admin rights.', '这个账号没有管理员权限。')}
        </EmptyState>
      </div>
    );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageToolbar title={t('Admin', '管理后台')}>
        {/* links, not buttons: each section has its own URL */}
        <nav
          aria-label={t('Admin sections', '管理分区')}
          className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-hover p-0.5"
        >
          {tabs(t).map((tb) => (
            <NavLink
              key={tb.to}
              to={tb.to}
              end={tb.section === 'overview'}
              aria-current={tb.section === section ? 'page' : undefined}
              className={`inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-md px-2.5 text-sm font-medium transition-colors ${
                tb.section === section ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'
              }`}
            >
              {tb.label}
            </NavLink>
          ))}
        </nav>
      </PageToolbar>
      {section === 'users' ? (
        <Users />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {section === 'overview' ? <Overview /> : null}
          {section === 'audit' ? <Audit /> : null}
          {section === 'settings' ? <Settings /> : null}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ overview */

function Overview() {
  const t = useT();
  const q = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.get<AdminOverview>('/v1/admin/overview'),
    refetchInterval: 30_000,
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  const o = q.data;
  if (!o) return null;
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat
          label={t('Accounts', '账号')}
          value={o.users.total}
          hint={t(
            `${o.users.active} active · ${o.users.suspended} suspended`,
            `${o.users.active} 正常 · ${o.users.suspended} 封禁`,
          )}
        />
        <Stat
          label={t('Agents', 'Agent')}
          value={o.endpoints.active}
          hint={t(
            `${o.endpoints.live_connections} live connections`,
            `${o.endpoints.live_connections} 个在线连接`,
          )}
        />
        <Stat
          label={t('Messages', '消息')}
          value={o.drops.total}
          hint={t(`${o.drops.last_24h} in 24 hours`, `24 小时 ${o.drops.last_24h} 条`)}
        />
        <Stat
          label={t('Attachment storage', '附件占用')}
          value={formatBytes(o.storage.bytes)}
          hint={t(`${o.storage.attachments} files`, `${o.storage.attachments} 个文件`)}
        />
      </section>
      {o.product_health ? <ProductHealth h={o.product_health} /> : null}
      <Panel title={t('Details', '明细')}>
        <dl className="grid gap-x-10 gap-y-2 text-sm md:grid-cols-2">
          <Row k={t('Closed accounts', '已注销账号')}>{o.users.deleted}</Row>
          <Row k={t('Admins', '管理员')}>{o.users.admins}</Row>
          <Row k={t('New accounts, last 7 days', '近 7 天新账号')}>{o.users.new_7d}</Row>
          <Row k={t('Agents ever paired', '累计配对的 Agent')}>{o.endpoints.total}</Row>
          {o.endpoints.by_harness.map((h) => (
            <Row
              key={h.harness_key}
              k={t(`Agents: ${harnessLabel(h.harness_key)}`, `Agent：${harnessLabel(h.harness_key)}`)}
            >
              {h.count}
            </Row>
          ))}
          <Row k={t('Messages, last 7 days', '近 7 天消息')}>{o.drops.last_7d}</Row>
          <Row k={t('Deliveries (one per agent)', '投递条目（每个 Agent 一条）')}>{o.drops.deliveries}</Row>
          <Row k={t('Pending approvals', '待审批')}>{o.drops.pending_approvals}</Row>
          <Row k={t('Groups / active memberships', '群组 / 活跃成员关系')}>
            {o.groups.total} / {o.groups.active_members}
          </Row>
          <Row k={t('Sign-up', '注册')}>
            {o.signup_mode === 'open' ? t('Open', '开放') : t('Closed', '已关闭')}
          </Row>
          <Row k={t('Server version', '服务端版本')}>{o.server_version}</Row>
          {o.encryption ? (
            <Row k={t('Content encryption', '内容加密')}>
              {o.encryption.mode === 'on'
                ? t(`On (key ${o.encryption.key_id ?? '?'})`, `已开启（密钥 ${o.encryption.key_id ?? '?'}）`)
                : t('Off', '未开启')}
              {(() => {
                const r = o.encryption.plaintext_remaining;
                const left = r.drops + r.approvals + r.attachments;
                return o.encryption.mode === 'on' && left > 0
                  ? t(` · ${left} older items still being encrypted`, ` · 还有 ${left} 条旧内容正在加密`)
                  : null;
              })()}
            </Row>
          ) : null}
        </dl>
      </Panel>
      <p className="text-xs text-dim">
        {t(
          "Admin shows only account and activity metadata. No one's message titles or bodies appear here, and the API does not return them.",
          '管理后台只显示账号与活动的元数据。任何人的消息标题和正文都不会出现在这里，接口也不返回。',
        )}
      </p>
    </div>
  );
}

/**
 * Product health (ADR 0035): how well messages between people work, from timestamps and counts only. Every number
 * says what it counts; a share always comes with its "x of y".
 */
function ProductHealth({ h }: { h: AdminProductHealth }) {
  const t = useT();
  const percent = (s: number | null) => (s === null ? '—' : `${Math.round(s * 100)}%`);
  const answered = (r: AdminProductHealth['answered_72h']['last_7d']) =>
    r.eligible === 0
      ? t('No message has had its 72 hours yet', '还没有满 72 小时的消息')
      : t(
          `${r.answered} of ${r.eligible} messages got a reply from someone else`,
          `${r.eligible} 条消息中有 ${r.answered} 条得到了别人的回复`,
        );
  const a = h.activation;
  const r = h.read_latency_7d;
  return (
    <section aria-labelledby="product-health" className="space-y-3">
      <div>
        <h2 id="product-health" className="text-sm font-semibold text-fg">
          {t('Product health', '产品健康度')}
        </h2>
        <p className="mt-0.5 text-xs text-dim">
          {t(
            'Messages people sent to other people or to groups, counted from times and counts only. Messages to or from the assistant, My space and messages to one’s own agents are left out.',
            '统计人发给别人或群的消息，只用时间和数量计算。与助手之间的消息、我的空间、发给自己 Agent 的消息不计入。',
          )}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat
          label={t('Answered within 72 hours, last 7 days', '72 小时内得到回复（近 7 天）')}
          value={percent(h.answered_72h.last_7d.share)}
          hint={answered(h.answered_72h.last_7d)}
        />
        <Stat
          label={t('Answered within 72 hours, last 28 days', '72 小时内得到回复（近 28 天）')}
          value={percent(h.answered_72h.last_28d.share)}
          hint={answered(h.answered_72h.last_28d)}
        />
        <Stat
          label={t('Time to read, last 7 days', '从收到到已读（近 7 天）')}
          value={r.median_seconds === null ? '—' : formatDuration(r.median_seconds, t)}
          hint={t(
            `Median, over the ${r.read} of ${r.delivered} received messages that the person marked read`,
            `中位数：${r.delivered} 条收到的消息中，被收件人标为已读的 ${r.read} 条`,
          )}
        />
        <Stat
          label={t('People who sent, last 7 days', '发过消息的人（近 7 天）')}
          value={h.active_senders.last_7d}
          hint={t(
            `${h.active_senders.last_28d} people in the last 28 days`,
            `近 28 天 ${h.active_senders.last_28d} 人`,
          )}
        />
        <Stat
          label={t('Messages sent, last 7 days', '发出的消息（近 7 天）')}
          value={h.sent_7d.direct + h.sent_7d.group}
          hint={t(
            `${h.sent_7d.direct} to people · ${h.sent_7d.group} to groups`,
            `${h.sent_7d.direct} 条发给个人 · ${h.sent_7d.group} 条发到群`,
          )}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat
          label={t('New accounts, last 28 days', '新账号（近 28 天）')}
          value={a.signups_28d}
          hint={t(`${a.in_first_week} still in their first week`, `其中 ${a.in_first_week} 个注册还不满一周`)}
        />
        <Stat
          label={t('Paired an agent in their first week', '一周内配对了 Agent')}
          value={a.paired_agent}
          hint={t(`of ${a.signups_28d} new accounts`, `占 ${a.signups_28d} 个新账号`)}
        />
        <Stat
          label={t('Tried the assistant in their first week', '一周内试发给助手')}
          value={a.tried_assistant}
          hint={t(
            `of ${a.signups_28d} new accounts sent a test message to the assistant`,
            `${a.signups_28d} 个新账号中给助手发过测试消息的`,
          )}
        />
        <Stat
          label={t('Wrote to a person or group in their first week', '一周内给人或群发了消息')}
          value={a.sent_to_people}
          hint={t(`of ${a.signups_28d} new accounts`, `占 ${a.signups_28d} 个新账号`)}
        />
      </div>
    </section>
  );
}

/** A duration for people: seconds, minutes, hours or days, whichever reads best. */
function formatDuration(seconds: number, t: Translate): string {
  if (seconds < 60) return t(`${seconds} s`, `${seconds} 秒`);
  if (seconds < 3600) {
    const m = Math.round(seconds / 60);
    return t(`${m} min`, `${m} 分钟`);
  }
  if (seconds < 86400) {
    const hours = Math.round(seconds / 360) / 10;
    return t(`${hours} h`, `${hours} 小时`);
  }
  const days = Math.round(seconds / 8640) / 10;
  return t(`${days} days`, `${days} 天`);
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="card rounded-xl border border-line px-4 py-3">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-fg">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-dim">{hint}</div> : null}
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right tabular-nums text-fg">{children}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------ users */

const statusFilters = (t: Translate) =>
  [
    { key: 'all', label: t('All', '全部') },
    { key: 'active', label: t('Active', '正常') },
    { key: 'suspended', label: t('Suspended', '已封禁') },
    { key: 'admin', label: t('Admins', '管理员') },
    { key: 'deleted', label: t('Closed', '已注销') },
  ] as const;

function Users() {
  const params = useParams();
  const nav = useNavigate();
  const t = useT();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string>('all');
  const list = useQuery({
    queryKey: ['admin', 'users', query, status],
    queryFn: () =>
      api.get<{ users: AdminUserSummary[]; total: number }>(
        `/v1/admin/users?status=${status}${query ? `&query=${encodeURIComponent(query)}` : ''}&limit=200`,
      ),
  });
  const selected = params.id ?? null;
  return (
    <SplitView
      showDetail={Boolean(selected)}
      listLabel={t('Accounts', '账号')}
      list={
        <>
          <div className="space-y-2 border-b border-line p-3">
            <Input
              type="search"
              placeholder={t('Search handle, name or email', '搜索 handle、昵称或邮箱')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t('Search users', '搜索用户')}
            />
            <Segmented
              label={t('Account status', '账号状态')}
              value={status}
              onChange={setStatus}
              options={statusFilters(t).map((f) => ({ value: f.key as string, label: f.label }))}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.data ? (
              <ListLabel>{t(`${list.data.total} accounts`, `${list.data.total} 个账号`)}</ListLabel>
            ) : null}
            {list.isLoading ? <Loading /> : null}
            {list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : null}
            {list.data?.users.length === 0 ? (
              <EmptyState title={t('No matching accounts', '没有匹配的账号')} />
            ) : null}
            {list.data?.users.map((u) => (
              <button
                key={u.user_id}
                type="button"
                aria-current={u.user_id === selected ? 'true' : undefined}
                onClick={() => nav(`/app/admin/users/${u.user_id}`)}
                className={listRowClass(u.user_id === selected)}
              >
                <div className="flex items-start gap-3">
                  <Avatar name={u.display_name} seed={u.handle} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium text-fg">{u.display_name}</span>
                      <span className="ml-auto flex shrink-0 gap-1">
                        {u.is_admin ? <Chip tone="accent">{t('Admin', '管理员')}</Chip> : null}
                        {u.is_system ? <Chip>{t('System', '系统')}</Chip> : <StatusChip status={u.status} />}
                      </span>
                    </div>
                    <div className="truncate text-xs text-muted">@{u.handle}</div>
                    <div className="mt-0.5 truncate text-xs text-dim">
                      {t(
                        `${u.endpoints} agents · sent ${u.drops_sent} · received ${u.drops_received}`,
                        `${u.endpoints} 个 Agent · 发出 ${u.drops_sent} · 收到 ${u.drops_received}`,
                      )}{' '}
                      ·{' '}
                      {u.last_seen_at
                        ? t(`Active ${formatWhen(u.last_seen_at)}`, `活跃于 ${formatWhen(u.last_seen_at)}`)
                        : t('Never active', '从未活跃')}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      }
      detail={
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected ? (
            <UserDetail
              key={selected}
              userId={selected}
              onBack={() => nav('/app/admin/users')}
              onClosed={() => nav('/app/admin/users')}
            />
          ) : (
            <EmptyState icon={<UsersIcon size={20} />} title={t('Select an account', '选择一个账号')}>
              {t(
                'The list shows accounts with their agents and activity counts.',
                '列表显示账号与它们的 Agent、活动计数。',
              )}
            </EmptyState>
          )}
        </div>
      }
    />
  );
}

function StatusChip({ status }: { status: string }) {
  const t = useT();
  if (status === 'suspended') return <Chip tone="warn">{t('Suspended', '已封禁')}</Chip>;
  if (status === 'deleted') return <Chip tone="danger">{t('Closed', '已注销')}</Chip>;
  return <Chip tone="ok">{t('Active', '正常')}</Chip>;
}

function UserDetail({
  userId,
  onBack,
  onClosed,
}: {
  userId: string;
  onBack: () => void;
  onClosed: () => void;
}) {
  const qc = useQueryClient();
  const { me } = useSession();
  const t = useT();
  const [reason, setReason] = useState('');
  const [confirmHandle, setConfirmHandle] = useState('');
  const detail = useQuery({
    queryKey: ['admin', 'user', userId],
    queryFn: () => api.get<AdminUserDetail>(`/v1/admin/users/${userId}`),
  });
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin'] });
      setReason('');
      setConfirmHandle('');
    },
  });
  const back = (
    <Button variant="ghost" className="-ml-2 text-muted lg:hidden" onClick={onBack}>
      <ArrowLeft size={14} aria-hidden="true" />
      {t('All accounts', '全部账号')}
    </Button>
  );
  if (detail.isLoading)
    return (
      <div className="p-4 md:p-6">
        {back}
        <Loading />
      </div>
    );
  if (detail.isError)
    return (
      <div className="p-4 md:p-6">
        {back}
        <ErrorBox error={detail.error} retry={() => detail.refetch()} />
      </div>
    );
  const u = detail.data;
  if (!u) return null;
  const isSelf = me?.user_id === u.user_id;
  const closed = u.status === 'deleted';

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
      {back}
      <header className="flex items-start gap-4">
        <Avatar name={u.display_name} seed={u.handle} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="break-words text-lg font-semibold text-fg">{u.display_name}</h2>
            {u.is_admin ? <Chip tone="accent">{t('Admin', '管理员')}</Chip> : null}
            {u.is_system ? <Chip>{t('System', '系统')}</Chip> : <StatusChip status={u.status} />}
            {isSelf ? <Chip>{t("That's you", '这是你自己')}</Chip> : null}
          </div>
          <div className="text-sm text-muted">@{u.handle}</div>
          <div className="mt-1 break-words text-xs text-dim">
            {u.email ?? t('(none)', '（无）')} ·{' '}
            {t(`Signed up ${formatWhen(u.created_at)}`, `注册于 ${formatWhen(u.created_at)}`)} ·{' '}
            {u.last_seen_at
              ? t(`Last active ${formatWhen(u.last_seen_at)}`, `最近活跃 ${formatWhen(u.last_seen_at)}`)
              : t('Never active', '从未活跃')}
          </div>
        </div>
      </header>
      {u.suspended_reason ? (
        <div className="rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn">
          {t('Suspension reason: ', '封禁原因：')}
          {u.suspended_reason}
        </div>
      ) : null}

      <section className="grid grid-cols-3 gap-3">
        <Stat label={t('Sent', '发出')} value={u.drops_sent} />
        <Stat label={t('Received', '收到')} value={u.drops_received} />
        <Stat label={t('Attachment storage', '附件占用')} value={formatBytes(u.storage_bytes)} />
      </section>

      <Panel title={t(`Agents (${u.endpoint_list.length})`, `Agent（${u.endpoint_list.length}）`)}>
        {u.endpoint_list.length === 0 ? (
          <div className="text-sm text-muted">{t('No agents paired yet.', '还没有配对的 Agent。')}</div>
        ) : (
          <ul className="-mx-5 -mb-5 -mt-1 divide-y divide-line border-t border-line">
            {u.endpoint_list.map((e) => (
              <li key={e.h_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`font-medium ${e.revoked_at ? 'text-muted' : 'text-fg'}`}>
                      {e.label}
                    </span>
                    <Chip>{harnessLabel(e.harness_key)}</Chip>
                    {e.is_default_receiver ? (
                      <Chip tone="ok">{t('Default receiver', '默认接收')}</Chip>
                    ) : null}
                    {e.revoked_at ? <Chip tone="danger">{t('Revoked', '已撤销')}</Chip> : null}
                    {e.live_connections > 0 ? (
                      <Chip tone="ok">
                        {t(`${e.live_connections} online`, `${e.live_connections} 个在线`)}
                      </Chip>
                    ) : null}
                  </div>
                  <div className="mt-0.5 break-words text-xs text-dim">
                    {e.address ? <span className="font-mono">{e.address} · </span> : null}
                    {t(
                      `Device ${e.device_label} · received ${e.drops_received}`,
                      `设备 ${e.device_label} · 收到 ${e.drops_received}`,
                    )}{' '}
                    · {e.last_seen_at ? formatWhen(e.last_seen_at) : t('Never connected', '未连接过')}
                  </div>
                </div>
                {!e.revoked_at ? (
                  <Button
                    variant="ghost"
                    className="text-muted hover:text-danger"
                    disabled={act.isPending}
                    onClick={() => {
                      if (
                        confirm(
                          t(
                            `Revoke the credentials of "${e.label}"? The agent disconnects immediately and must pair again.`,
                            `撤销「${e.label}」的凭证？该 Agent 会立刻断开，需要重新配对。`,
                          ),
                        )
                      )
                        act.mutate(() => api.post(`/v1/admin/endpoints/${e.h_id}/revoke`));
                    }}
                  >
                    {t('Revoke', '撤销')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid gap-5 md:grid-cols-2">
        <Panel title={t(`Groups (${u.group_list.length})`, `群组（${u.group_list.length}）`)}>
          {u.group_list.length === 0 ? <div className="text-sm text-dim">{t('None', '无')}</div> : null}
          {u.group_list.length > 0 ? (
            <ul className="space-y-1.5 text-sm">
              {u.group_list.map((g) => (
                <li key={g.group_id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-words text-fg">
                    <span className="text-dim">#</span>
                    {g.display_name}
                  </span>
                  <Chip>
                    {g.role === 'owner'
                      ? t('Owner', '群主')
                      : g.role === 'admin'
                        ? t('Admin', '管理')
                        : t('Member', '成员')}
                  </Chip>
                  {g.status !== 'active' ? (
                    <Chip tone="warn">
                      {g.status === 'invited'
                        ? t('Invited', '已邀请')
                        : g.status === 'left'
                          ? t('Left', '已退出')
                          : g.status === 'removed'
                            ? t('Removed', '已移除')
                            : g.status}
                    </Chip>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
        <Panel title={t(`Contacts (${u.contact_list.length})`, `联系人（${u.contact_list.length}）`)}>
          {u.contact_list.length === 0 ? <div className="text-sm text-dim">{t('None', '无')}</div> : null}
          {u.contact_list.length > 0 ? (
            <ul className="space-y-1.5 text-sm">
              {u.contact_list.map((c) => (
                <li key={c.user_id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-all text-fg">@{c.handle}</span>
                  <Chip tone={c.status === 'accepted' ? 'ok' : 'neutral'}>
                    {c.status === 'accepted'
                      ? t('Contact', '已是联系人')
                      : c.status === 'requested'
                        ? t('Request received', '收到申请')
                        : c.status === 'invited'
                          ? t('Awaiting their reply', '待对方接受')
                          : c.status === 'blocked'
                            ? t('Blocked', '已屏蔽')
                            : c.status}
                  </Chip>
                  {c.blocked ? <Chip tone="danger">{t('Blocked', '已屏蔽')}</Chip> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      </div>

      <Panel title={t('Recent activity', '最近操作')}>
        {u.recent_activity.length === 0 ? <div className="text-sm text-dim">{t('None', '无')}</div> : null}
        {u.recent_activity.length > 0 ? (
          <ul className="space-y-1.5 text-sm">
            {u.recent_activity.map((a) => {
              const result = auditResult(a.result, t);
              return (
                <li key={a.id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="w-full shrink-0 text-xs tabular-nums text-dim sm:w-40">
                    {formatWhen(a.created_at)}
                  </span>
                  <span className="text-fg">{auditActionLabel(a.action, t)}</span>
                  <span className="font-mono text-xs text-dim">{a.action}</span>
                  {a.result !== 'ok' ? (
                    <span className={`text-xs ${result.tone}`}>{result.label}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </Panel>

      {act.isError ? <ErrorBox error={act.error} /> : null}

      {u.is_system ? (
        <p className="text-sm leading-6 text-muted">
          {t(
            'The built-in AgentDrop assistant: every user has it as a contact by default, for sending test messages and getting an automatic receipt. It cannot log in, and cannot be suspended, closed or made an admin.',
            '内置的 AgentDrop 助手：每个用户默认都有它这个联系人，用来试发消息并收到自动回执。它不能登录，也不能被封禁、注销或设为管理员。',
          )}
        </p>
      ) : null}

      {!closed && !u.is_system ? (
        <PasswordResetLinkPanel key={u.user_id} userId={u.user_id} handle={u.handle} />
      ) : null}

      {!closed && !u.is_system ? (
        <Panel title={t('Admin actions', '管理操作')}>
          {isSelf ? (
            <div className="text-sm text-muted">
              {t(
                "You can't do these on your own account; use another admin account.",
                '不能对自己的账号执行这些操作，请用另一个管理员账号。',
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-2">
                {u.status === 'suspended' ? (
                  <Button
                    disabled={act.isPending}
                    onClick={() => act.mutate(() => api.post(`/v1/admin/users/${u.user_id}/unsuspend`))}
                  >
                    {t('Unsuspend', '解除封禁')}
                  </Button>
                ) : (
                  <>
                    <div className="min-w-0 flex-1 basis-60">
                      <Field
                        label={t(
                          'Suspension reason (optional, shown to them)',
                          '封禁原因（可选，会展示给对方）',
                        )}
                      >
                        <Input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder={t('e.g. mass-send abuse', '例如：滥用群发')}
                          maxLength={200}
                        />
                      </Field>
                    </div>
                    <Button
                      className="h-9"
                      disabled={act.isPending}
                      onClick={() =>
                        act.mutate(() =>
                          api.post(`/v1/admin/users/${u.user_id}/suspend`, reason ? { reason } : {}),
                        )
                      }
                    >
                      {t('Suspend', '封禁')}
                    </Button>
                  </>
                )}
                <Button
                  className="h-9"
                  disabled={act.isPending}
                  onClick={() =>
                    act.mutate(() =>
                      api.post(`/v1/admin/users/${u.user_id}/admin`, { is_admin: !u.is_admin }),
                    )
                  }
                >
                  {u.is_admin ? t('Remove admin', '取消管理员') : t('Make admin', '设为管理员')}
                </Button>
              </div>
              <p className="text-xs leading-5 text-dim">
                {t(
                  'Suspending immediately ends their web sessions and cuts off all agent credentials; both come back on unsuspend. Meanwhile others can still send to them, and messages wait in the mailbox.',
                  '封禁会立刻断开该账号的网页会话和全部 Agent 凭证，解除后自动恢复；期间别人仍可以给 TA 发消息，消息会留在信箱里。',
                )}
              </p>
            </>
          )}
        </Panel>
      ) : null}

      {!closed && !u.is_system && !isSelf ? (
        <Panel tone="danger" title={t('Close account (permanent)', '注销账号（不可恢复）')}>
          <p className="text-sm leading-6 text-fg-2">
            {t(
              'Deletes login methods, all credentials, agents, devices, addresses, contacts and group memberships, and turns the name and handle into a tombstone. ',
              '会删除登录方式、全部凭证、Agent、设备、地址、联系人和群成员关系，并把昵称与 handle 抹成墓碑。',
            )}
            <strong className="font-semibold text-fg">
              {t('Messages others already received are not deleted', '别人已经收到的消息不会被删除')}
            </strong>
            {t(
              ' — delivered content belongs to the recipient, and this product never recalls it.',
              '—— 已投递的内容属于收件人，本产品从不撤回。',
            )}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-60">
              <Field label={t(`Type ${u.handle} to confirm`, `输入 ${u.handle} 以确认`)}>
                <Input
                  value={confirmHandle}
                  onChange={(e) => setConfirmHandle(e.target.value)}
                  placeholder={u.handle}
                />
              </Field>
            </div>
            <Button
              variant="danger"
              className="h-9"
              disabled={act.isPending || confirmHandle.trim().replace(/^@/, '') !== u.handle}
              onClick={() =>
                act.mutate(async () => {
                  await api.post(`/v1/admin/users/${u.user_id}/close`, {
                    confirm_handle: confirmHandle.trim(),
                  });
                  onClosed();
                })
              }
            >
              {t('Close this account', '注销这个账号')}
            </Button>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

/**
 * One-time password reset link for someone who cannot receive email. The link exists only in this component's
 * memory: it is not cached by react-query, and leaving the page or generating another one discards it.
 */
function PasswordResetLinkPanel({ userId, handle }: { userId: string; handle: string }) {
  const [link, setLink] = useState<AdminPasswordResetLink | null>(null);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const t = useT();
  const gen = useMutation({
    mutationFn: () => api.post<AdminPasswordResetLink>(`/v1/admin/users/${userId}/password-reset-link`),
    onSuccess: (res) => {
      setLink(res);
      setCopied('idle');
    },
  });
  return (
    <Panel
      title={t('Reset password', '重置密码')}
      description={t(
        `Generate a one-time reset link for @${handle}. It is valid for 1 hour and works once; generating another voids the previous one. After they set a new password with it, all web sessions are signed out; paired agents are unaffected. Generation is recorded in the audit log (without the link itself).`,
        `为 @${handle} 生成一次性重置链接，1 小时内有效，只能使用一次；再生成一次会让上一条失效。对方用它设置新密码后，所有网页登录会退出，已配对的 Agent 不受影响。生成记录会写入审计日志（不含链接本身）。`,
      )}
    >
      {link ? (
        <div className="space-y-2 rounded-lg border border-warn-line bg-warn-bg p-3">
          <p className="text-sm text-warn">
            {t(
              'The link is shown only this once. Give it to them privately (in person or direct message), never in a group; whoever has the link can change this account’s password.',
              '链接只显示这一次。请通过私下渠道（当面、私聊）交给本人，不要发到群里；拿到链接的人可以改掉这个账号的密码。',
            )}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 select-all break-all rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-xs text-fg">
              {link.url}
            </code>
            <Button
              onClick={() =>
                copyText(link.url).then((ok) => {
                  setCopied(ok ? 'copied' : 'failed');
                  setTimeout(() => setCopied('idle'), 2000);
                })
              }
            >
              {copied === 'copied'
                ? t('Copied', '已复制')
                : copied === 'failed'
                  ? t('Copy failed; select it manually', '复制失败，请手动选择')
                  : t('Copy', '复制')}
            </Button>
          </div>
          <p className="text-xs text-dim">
            {t(`Valid until ${formatWhen(link.expires_at)}`, `有效期至 ${formatWhen(link.expires_at)}`)}
          </p>
        </div>
      ) : null}
      {gen.isError ? <ErrorBox error={gen.error} /> : null}
      <div>
        <Button
          disabled={gen.isPending}
          onClick={() => {
            if (
              !link ||
              confirm(
                t(
                  'Generating another will void the link you just made. Continue?',
                  '再生成一条会让刚才那条链接失效，继续？',
                ),
              )
            )
              gen.mutate();
          }}
        >
          {link ? t('Generate again', '重新生成') : t('Generate reset link', '生成重置链接')}
        </Button>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ audit */

function Audit() {
  const t = useT();
  const [action, setAction] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['admin', 'audit', action],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<{ events: AdminAuditEvent[]; next_cursor: string | null }>(
        `/v1/admin/audit?limit=50${action ? `&action=${encodeURIComponent(action)}` : ''}${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''
        }`,
      ),
    getNextPageParam: (last) => last.next_cursor,
  });
  const events = q.data?.pages.flatMap((p) => p.events) ?? [];
  const custom = !AUDIT_CATEGORIES.some((c) => c.prefix === action);
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label={t('Category', '类别')}
          value={custom ? '__custom' : action || '__all'}
          onChange={(v) => setAction(v === '__all' ? '' : v)}
          options={AUDIT_CATEGORIES.map((c) => ({ value: c.prefix || '__all', label: t(c.en, c.zh) }))}
        />
        <Input
          className="h-8 w-full font-mono text-xs sm:ml-auto sm:w-56"
          placeholder={t('Action code prefix', '按动作代码筛选')}
          value={action}
          onChange={(e) => setAction(e.target.value.trim())}
          aria-label={t('Filter by action code', '按动作代码筛选')}
        />
      </div>
      {q.isLoading ? <Loading /> : null}
      {q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : null}
      {q.data && events.length === 0 ? (
        <EmptyState title={t('No matching records', '没有匹配的记录')} />
      ) : null}
      {events.length > 0 ? (
        <div className="card overflow-hidden rounded-xl border border-line">
          <div className="hidden grid-cols-[7rem_9rem_minmax(0,1fr)_5.5rem_6rem] gap-3 border-b border-line bg-surface-2 px-4 py-2 text-xs font-medium text-muted md:grid">
            <div>{t('Time', '时间')}</div>
            <div>{t('Who', '操作者')}</div>
            <div>{t('Action', '动作')}</div>
            <div>{t('Result', '结果')}</div>
            <div>{t('Target', '对象')}</div>
          </div>
          <ul className="divide-y divide-line">
            {events.map((e) => {
              const result = auditResult(e.result, t);
              const who = e.actor_handle ? `@${e.actor_handle}` : t('System', '系统');
              return (
                <li
                  key={e.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm md:grid-cols-[7rem_9rem_minmax(0,1fr)_5.5rem_6rem] md:items-baseline"
                >
                  <div
                    className="order-3 col-span-2 text-xs text-dim md:order-none md:col-span-1 md:text-sm"
                    title={formatDateTime(e.created_at)}
                  >
                    {formatWhen(e.created_at)}
                    <span className="md:hidden">
                      {' '}
                      · {who}
                      {e.target_id ? ` · ${e.target_id.slice(0, 8)}` : ''}
                    </span>
                  </div>
                  <div className="hidden truncate text-fg-2 md:block">{who}</div>
                  <div className="min-w-0">
                    <span className="text-fg">{auditActionLabel(e.action, t)}</span>{' '}
                    <span className="break-all font-mono text-xs text-dim">{e.action}</span>
                  </div>
                  <div
                    className={`text-right md:text-left ${e.result === 'ok' ? 'text-muted' : result.tone}`}
                  >
                    {result.label}
                  </div>
                  <div
                    className="hidden font-mono text-xs text-dim md:block"
                    title={e.target_id ?? undefined}
                  >
                    {e.target_id ? e.target_id.slice(0, 8) : '—'}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {q.hasNextPage ? (
          <Button onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {q.isFetchingNextPage ? t('Loading…', '加载中…') : t('Load more', '加载更多')}
          </Button>
        ) : null}
        <p className="text-xs text-dim">
          {t(
            'Records actions, target IDs and counts only; never message content, file names or tokens.',
            '只记录动作、对象 ID 和计数，从不记录消息内容、文件名或令牌。',
          )}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ settings */

function Settings() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<AdminSettings>('/v1/admin/settings'),
  });
  const save = useMutation({
    mutationFn: (signup_mode: SignupMode) => api.patch('/v1/admin/settings', { signup_mode }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  const s = q.data;
  if (!s) return null;
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <Panel
        title={t('Sign-up', '注册')}
        description={
          s.updated_at
            ? t(
                `Last changed by @${s.updated_by_handle ?? '?'} ${formatWhen(s.updated_at)}.`,
                `最近由 @${s.updated_by_handle ?? '?'} 于 ${formatWhen(s.updated_at)} 修改。`,
              )
            : t(
                'Never changed; the server’s startup default is in effect.',
                '还没有人改过，当前用的是服务器启动时的默认值。',
              )
        }
      >
        <div className="space-y-2">
          {(
            [
              {
                mode: 'open' as const,
                title: t('Open sign-up', '开放注册'),
                desc: t(
                  'Anyone who can reach this site can create an account.',
                  '任何能访问本站的人都可以自行注册账号。',
                ),
              },
              {
                mode: 'closed' as const,
                title: t('Closed sign-up', '关闭注册'),
                desc: t(
                  'The sign-up page is disabled; only existing accounts can log in. Suited to internal or small-group use.',
                  '注册页面停用，只有已有账号可以登录。适合内部或小范围使用。',
                ),
              },
            ] satisfies Array<{ mode: SignupMode; title: string; desc: string }>
          ).map((opt) => (
            <label
              key={opt.mode}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition-colors ${
                s.signup_mode === opt.mode ? 'border-accent/50 bg-selected' : 'border-line hover:bg-hover'
              }`}
            >
              <input
                type="radio"
                name="signup_mode"
                className="mt-1"
                checked={s.signup_mode === opt.mode}
                disabled={save.isPending}
                onChange={() => save.mutate(opt.mode)}
              />
              <span>
                <span className="block text-sm font-medium text-fg">{opt.title}</span>
                <span className="block text-sm text-muted">{opt.desc}</span>
              </span>
            </label>
          ))}
        </div>
        {save.isError ? <ErrorBox error={save.error} /> : null}
      </Panel>
      {s.group_storage_quota_bytes !== undefined ? (
        <GroupStorageQuota key={s.group_storage_quota_bytes} bytes={s.group_storage_quota_bytes} />
      ) : null}
    </div>
  );
}

const MiB = 1024 * 1024;
/** Mirrors adminSettingsInputSchema: 1 MiB to 1 TiB. */
const QUOTA_MAX_MIB = 1024 * 1024;

/**
 * The file space of every group (ADR 0029), in MB so the default 512 reads naturally. A send whose files would go past
 * it is refused; nothing already stored is removed when the value goes down.
 */
function GroupStorageQuota({ bytes }: { bytes: number }) {
  const t = useT();
  const qc = useQueryClient();
  const [value, setValue] = useState(String(Math.round(bytes / MiB)));
  const mib = Number(value);
  const valid = value.trim() !== '' && Number.isInteger(mib) && mib >= 1 && mib <= QUOTA_MAX_MIB;
  const changed = valid && mib * MiB !== bytes;
  const save = useMutation({
    mutationFn: () => api.patch('/v1/admin/settings', { group_storage_quota_bytes: mib * MiB }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });
  return (
    <Panel
      title={t('Group file space', '群文件空间')}
      description={t(
        `Each group can keep up to ${formatBytes(bytes)} of files. When a group is full, messages with files are refused and its admins can remove old files on the group page. Lowering it removes nothing.`,
        `每个群最多保存 ${formatBytes(bytes)} 的文件。群满后带文件的消息会被拒收，群管理员可以在群页面删除旧文件。调低上限不会删除任何已有文件。`,
      )}
    >
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) save.mutate();
        }}
      >
        <div className="w-40">
          <Field label={t('Per group (MB)', '每个群（MB）')}>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={QUOTA_MAX_MIB}
              step={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={save.isPending}
            />
          </Field>
        </div>
        <Button type="submit" variant="primary" className="h-9" disabled={!changed || save.isPending}>
          {save.isPending ? t('Saving…', '保存中…') : t('Save', '保存')}
        </Button>
        {value.trim() !== '' && !valid ? (
          <p className="w-full text-xs text-danger">
            {t(
              'Enter a whole number from 1 to 1048576 MB (1 TB).',
              '请输入 1 到 1048576 之间的整数（MB，最大 1 TB）。',
            )}
          </p>
        ) : (
          <p className="w-full text-xs text-dim">{t('1024 MB = 1 GB.', '1024 MB = 1 GB。')}</p>
        )}
      </form>
      {save.isError ? <ErrorBox error={save.error} /> : null}
    </Panel>
  );
}

/* ------------------------------------------------------------------ helpers */

/**
 * "just now", "15 min ago", "3 hours ago" for the last few hours, otherwise the full date and time (also for a time
 * still ahead, such as when a link expires). The dashboard's language, never the browser's locale (lib/format.ts).
 */
function formatWhen(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff >= 0 && diff < 6 * 3_600_000) return formatAgo(iso);
  return formatDateTime(iso);
}
