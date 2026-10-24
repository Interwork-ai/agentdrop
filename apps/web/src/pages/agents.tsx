import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, Circle, Laptop, Plus, Waypoints, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import {
  api,
  type Connection,
  type Contact,
  type Endpoint,
  harnessLabel,
  type ListDrops,
  mailboxUrl,
  type RouteView,
} from '../lib/api.js';
import { formatDateTime, formatDay, plural } from '../lib/format.js';
import { useT } from '../lib/lang.js';
import { mailboxKey, useFocusAwareInterval, useSession } from '../lib/session.js';
import { platformName } from '../ui/client-settings.js';
import { Chip, IconButton, Menu, PageToolbar, Panel } from '../ui/layout.jsx';
import { setupCommands } from '../ui/needs-agent.jsx';
import { Button, CodeBlock, ErrorBox, Field, Input, Loading } from '../ui/primitives.jsx';
import { RadioSegmented, settingsSelectClass } from '../ui/settings-controls.jsx';

/**
 * "My agents": one panel per device with its agents, names first. Each agent row shows whether it is online, its
 * tool and whether it receives; renaming, handing over, signing out and deleting sit in its "Manage" menu and open
 * inline under the row only when chosen. Deleted (revoked) agents are listed apart and collapsed.
 */
/** Removing the last agent has consequences for groups (ADR 0015); the confirmation says so. */
const LAST_AGENT = {
  en: '\n\nThis is your last agent: you will also leave all of your groups (groups you own pass to another member), and nobody can send to you until you pair again.',
  zh: '\n\n这是你最后一个 Agent：你还会退出所有群（你是群主的群会交给其他成员），重新配对之前别人也发不到你这里。',
};

type Act = { mutate: (fn: () => Promise<unknown>) => void };

/** The built-in assistant (packages/domain system-assistant.ts): every account has it as a contact. */
const ASSISTANT_HANDLE = 'agentdrop';
/** `agentdrop doctor` (run at the end of setup) opens the bridge once under this client name: not a real client. */
const DOCTOR_CLIENT = 'agentdrop-doctor';
/** `/v1/me/connections` returns at most this many rows; a shorter list is complete. */
const CONNECTIONS_LIMIT = 100;

export function AgentsPage() {
  const { me, refresh, currentH } = useSession();
  const t = useT();
  const qc = useQueryClient();
  const interval = useFocusAwareInterval();
  const [showDeleted, setShowDeleted] = useState(false);
  const conns = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<{ connections: Connection[] }>('/v1/me/connections'),
    refetchInterval: interval,
  });
  const routes = useQuery({
    queryKey: ['routes'],
    queryFn: () => api.get<{ routes: RouteView[] }>('/v1/me/routes'),
  });
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: async () => {
      await refresh();
      qc.invalidateQueries({ queryKey: ['routes'] });
    },
  });
  if (!me) return null;
  const allAgents = me?.direct_receive_all ?? true;
  const active = me.endpoints.filter((e) => !e.revoked_at);
  const deleted = me.endpoints.filter((e) => e.revoked_at);
  const byDevice = new Map<string, Endpoint[]>();
  for (const e of active) byDevice.set(e.device.device_id, [...(byDevice.get(e.device.device_id) ?? []), e]);
  const live = (hId: string) =>
    (conns.data?.connections ?? []).filter((c) => c.h_id === hId && c.status === 'live').length;
  /*
   * Never connected from a real client: certain only when the connection list is complete (connections are kept,
   * only closed, and the API returns the newest CONNECTIONS_LIMIT) and has no row for this agent other than the
   * doctor check setup runs. Otherwise "Offline" stays the honest word.
   */
  const connectedRows = (conns.data?.connections ?? []).filter((c) => c.client_name !== DOCTOR_CLIENT);
  const listComplete = conns.isSuccess && (conns.data?.connections.length ?? 0) < CONNECTIONS_LIMIT;
  const neverConnected = (hId: string) => listComplete && !connectedRows.some((c) => c.h_id === hId);
  const anyClientConnected = connectedRows.some((c) => active.some((e) => e.h_id === c.h_id));
  // devices sharing a name are told apart by when they were paired (with the time when even the day is the same)
  const nameCount = new Map<string, number>();
  for (const eps of byDevice.values()) {
    const label = eps[0]?.device.label ?? '';
    nameCount.set(label, (nameCount.get(label) ?? 0) + 1);
  }
  const addressOf = (hId: string) =>
    (routes.data?.routes ?? []).find((r) => r.auto && r.destination_h_id === hId)?.alias ?? null;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <PageToolbar
        title={t('My agents', '我的 Agent')}
        {...(active.length > 0 ? { count: active.length } : {})}
      />
      <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
        {active.length === 0 ? <PairFirstAgent hasDeleted={deleted.length > 0} /> : null}
        {active.length > 0 && currentH ? (
          <GettingStarted
            userId={me.user_id}
            hId={currentH.h_id}
            connected={anyClientConnected}
            connectionsKnown={conns.isSuccess}
          />
        ) : null}
        {active.length > 0 ? (
          <Panel
            title={t(`Messages sent to @${me.handle} reach`, `发给 @${me.handle} 的消息投到`)}
            description={
              allAgents
                ? t(
                    'Each agent gets its own copy; read and starred are shared. To use one, choose "Receive only here" on it.',
                    '每个 Agent 各收一份，已读、收藏同步。想只用一个，在它上面点「只在这里接收」。',
                  )
                : t(
                    'Only the agent marked "Default receiver" gets them; the others still see the shared mailbox.',
                    '只有标着「默认接收」的 Agent 收到；其他 Agent 仍能看到共享信箱。',
                  )
            }
          >
            <RadioSegmented
              label={t('Receiving', '接收方式')}
              value={allAgents ? 'all' : 'one'}
              options={[
                { value: 'all', label: t('All my agents', '我的所有 Agent') },
                // one agent is chosen on the agent itself ("Receive only here"), so this option only shows the state
                { value: 'one', label: t('One agent', '只投一个 Agent'), disabled: true },
              ]}
              onChange={(v) =>
                v === 'all' ? act.mutate(() => api.post('/v1/me/default-endpoint', { all: true })) : null
              }
            />
          </Panel>
        ) : null}
        {act.isError ? <ErrorBox error={act.error} /> : null}
        {[...byDevice.entries()].map(([deviceId, eps]) => {
          const device = eps[0]?.device;
          // two machines can share a name; the pairing date tells them apart
          const pairedAt = eps.map((e) => e.created_at).sort()[0];
          const platform = platformName(device?.platform ?? null);
          const meta = [
            platform,
            pairedAt
              ? t(
                  `paired ${pairedWhen(pairedAt, (nameCount.get(device?.label ?? '') ?? 0) > 1)}`,
                  `配对于 ${pairedWhen(pairedAt, (nameCount.get(device?.label ?? '') ?? 0) > 1)}`,
                )
              : null,
            t(plural(eps.length, 'agent', 'agents'), `${eps.length} 个 Agent`),
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <Panel
              key={deviceId}
              icon={<Laptop size={16} />}
              title={<span className="break-words">{device?.label}</span>}
              description={meta}
              actions={
                <Menu
                  label={t(`Device actions: ${device?.label ?? ''}`, `设备操作：${device?.label ?? ''}`)}
                  items={[
                    {
                      label: t('Delete device', '删除设备'),
                      danger: true,
                      onSelect: () => {
                        if (
                          confirm(
                            t(
                              `Delete the device "${device?.label}"? All its agents stop working and disappear from this page; this machine can only pair again as a new device. Messages are kept.`,
                              `删除设备「${device?.label}」？它上面的所有 Agent 都会停用并从这里消失；这台机器以后只能作为新设备重新配对。消息保留。`,
                            ) +
                              (active.every((o) => eps.some((x) => x.h_id === o.h_id))
                                ? t(LAST_AGENT.en, LAST_AGENT.zh)
                                : ''),
                          )
                        )
                          act.mutate(() => api.post(`/v1/me/devices/${deviceId}/revoke`));
                      },
                    },
                  ]}
                />
              }
            >
              <ul className="-mx-5 -mb-5 -mt-1 divide-y divide-line border-t border-line">
                {eps.map((e) => (
                  <AgentRow
                    key={e.h_id}
                    e={e}
                    handle={me.handle}
                    address={addressOf(e.h_id)}
                    liveConnections={live(e.h_id)}
                    neverConnected={neverConnected(e.h_id)}
                    act={act}
                    allAgents={allAgents}
                    successors={active.filter((o) => o.h_id !== e.h_id)}
                  />
                ))}
              </ul>
            </Panel>
          );
        })}
        {active.length > 0 ? (
          <RoutesSection
            routes={routes.data?.routes ?? []}
            handle={me.handle}
            endpoints={active}
            loading={routes.isLoading}
            act={act}
          />
        ) : null}
        {deleted.length > 0 ? (
          <section className="space-y-3">
            <button
              type="button"
              aria-expanded={showDeleted}
              className="inline-flex items-center gap-1.5 rounded-md text-sm text-muted hover:text-fg"
              onClick={() => setShowDeleted((v) => !v)}
            >
              <ChevronRight
                size={14}
                aria-hidden="true"
                className={`transition-transform ${showDeleted ? 'rotate-90' : ''}`}
              />
              {showDeleted
                ? t('Hide deleted', '隐藏已删除的')
                : t(`Show deleted (${deleted.length})`, `显示已删除的（${deleted.length}）`)}
            </button>
            {showDeleted ? (
              <Panel
                title={t('Deleted agents', '已删除的 Agent')}
                description={t(
                  'They no longer send or receive; their messages stay readable. Hand one over to move its entries and groups to a current agent.',
                  '它们已不能收发，消息照常能读。把一个转给现有 Agent，它的入口和群设置就能延续。',
                )}
              >
                <ul className="-mx-5 -mb-5 -mt-1 divide-y divide-line border-t border-line">
                  {deleted.map((e) => (
                    <DeletedRow
                      key={e.h_id}
                      e={e}
                      act={act}
                      successors={active}
                      takenOverLabel={me.endpoints.find((o) => o.h_id === e.taken_over_by)?.label}
                    />
                  ))}
                </ul>
              </Panel>
            ) : null}
          </section>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4 text-sm text-muted">
          <Link to="/app/settings#client-settings" className="hover:text-fg">
            {t('Reminders and updates per device →', '各设备的提醒与更新设置 →')}
          </Link>
          <Link to="/app/connections" className="hover:text-fg">
            {t('Connection details →', '连接详情 →')}
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * After the first pairing: the three steps to a first real message, each ticked off from data the dashboard already
 * has (a connection from a real client, anything in Sent, an accepted contact other than the assistant). It stays
 * until all three are done or the person hides it (remembered in this browser, per account).
 */
function GettingStarted({
  userId,
  hId,
  connected,
  connectionsKnown,
}: {
  userId: string;
  hId: string;
  connected: boolean;
  connectionsKnown: boolean;
}) {
  const t = useT();
  const key = `agentdrop.gettingStarted.hidden.${userId}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const sent = useQuery({
    queryKey: mailboxKey(hId, 'getting-started-sent'),
    queryFn: () => api.get<ListDrops>(mailboxUrl(hId, '/drops?view=sent&limit=1')),
    enabled: !hidden,
    // a message sent from an agent or the CLI since the last visit ticks the step off on return
    refetchOnMount: 'always',
  });
  const contacts = useQuery({
    queryKey: ['contacts'],
    queryFn: () => api.get<{ contacts: Contact[] }>('/v1/me/contacts'),
    enabled: !hidden,
  });
  if (hidden || !sent.isSuccess || !contacts.isSuccess || !connectionsKnown) return null;
  const hasSent = sent.data.drops.length > 0;
  const hasColleague = contacts.data.contacts.some(
    (c) => c.status === 'accepted' && !c.is_system && c.handle !== ASSISTANT_HANDLE,
  );
  if (connected && hasSent && hasColleague) return null;
  const hide = () => {
    try {
      globalThis.localStorage?.setItem(key, '1');
    } catch {
      /* private mode: hidden for this page only */
    }
    setHidden(true);
  };
  const steps: Array<{ done: boolean; title: string; text: string; action?: ReactNode }> = [
    {
      done: connected,
      title: t('Restart your agent’s client', '重启 Agent 所在的客户端'),
      text: connected
        ? t('Connected: your agent can send and receive.', '已连接：你的 Agent 可以收发了。')
        : t(
            'Quit and reopen Codex, Claude Code, Cursor, opencode, oh-my-pi or WorkBuddy so it loads AgentDrop. WorkBuddy asks once whether to trust agentdrop: allow it.',
            '退出并重新打开 Codex、Claude Code、Cursor、opencode、oh-my-pi 或 WorkBuddy，让它加载 AgentDrop。WorkBuddy 会问一次是否信任 agentdrop，选允许。',
          ),
    },
    {
      done: hasSent,
      title: t('Send a test message to the assistant', '给助手发一条测试消息'),
      text: t(
        'The built-in assistant @agentdrop answers within seconds. You can also ask your agent to do it.',
        '内置助手 @agentdrop 几秒内回复。也可以让你的 Agent 来发。',
      ),
      action: hasSent ? undefined : (
        <Link
          to={`/app/compose?to=@${ASSISTANT_HANDLE}`}
          className="inline-flex h-8 items-center rounded-lg border border-line-strong bg-surface-2 px-3 text-sm font-medium text-fg hover:border-accent/40 hover:bg-surface-3"
        >
          {t('Write to the assistant', '写给助手')}
        </Link>
      ),
    },
    {
      done: hasColleague,
      title: t('Invite a colleague', '邀请一位同事'),
      text: t(
        'Send them an invite link or invite them by @handle; once they accept, your agents can write to each other.',
        '发给对方邀请链接，或用 @handle 邀请；对方接受后，你们的 Agent 就能互相发消息。',
      ),
      action: hasColleague ? undefined : (
        <Link
          to="/app/contacts"
          className="inline-flex h-8 items-center rounded-lg border border-line-strong bg-surface-2 px-3 text-sm font-medium text-fg hover:border-accent/40 hover:bg-surface-3"
        >
          {t('Invite someone', '去邀请')}
        </Link>
      ),
    },
  ];
  const done = steps.filter((x) => x.done).length;
  return (
    <Panel
      id="getting-started"
      title={t('Get started', '开始使用')}
      description={t(`${done} of 3 done`, `已完成 ${done}/3`)}
      actions={
        <IconButton label={t('Hide these steps', '隐藏这些步骤')} className="-mr-2" onClick={hide}>
          <X size={14} />
        </IconButton>
      }
    >
      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={step.title} className="flex items-start gap-3">
            {step.done ? (
              <CheckCircle2 size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-ok" />
            ) : (
              <Circle size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-dim" />
            )}
            <div className="min-w-0 flex-1 space-y-1">
              <p className={`text-sm font-medium ${step.done ? 'text-fg-2' : 'text-fg'}`}>
                <span className="sr-only">
                  {step.done
                    ? t(`Step ${i + 1}, done: `, `第 ${i + 1} 步，已完成：`)
                    : t(`Step ${i + 1}: `, `第 ${i + 1} 步：`)}
                </span>
                {step.title}
              </p>
              <p className="text-sm leading-5 text-muted">{step.text}</p>
              {step.action ? <div className="pt-1">{step.action}</div> : null}
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** Nothing paired yet: how to pair the first agent. */
function PairFirstAgent({ hasDeleted }: { hasDeleted: boolean }) {
  const t = useT();
  return (
    <Panel
      icon={<Waypoints size={16} />}
      title={t('No paired agents yet', '还没有配对的 Agent')}
      description={t(
        'Run these two commands in a terminal on your computer (Node.js 22+ required):',
        '在你的电脑终端里执行两条命令（需要 Node.js 22+）：',
      )}
    >
      <CodeBlock code={setupCommands()} />
      <p className="text-sm leading-6 text-fg-2">
        {t(
          'setup detects Codex / Claude Code / Cursor / OpenCode / oh-my-pi (omp) / WorkBuddy, opens the browser to confirm pairing, and installs everything the agent needs. Run it in a project folder: it offers to let your agents upload files from there. Then tell your agent "send a test message to @agentdrop"; the built-in assistant replies within seconds.',
          'setup 会检测 Codex / Claude Code / Cursor / OpenCode / oh-my-pi（omp）/ WorkBuddy，打开浏览器确认配对，并装好 Agent 需要的一切。在项目文件夹里运行，它会问是否允许 Agent 从那里上传文件。之后对 Agent 说「发一条测试消息给 @agentdrop」，内置助手几秒内回复。',
        )}
      </p>
      <div className="space-y-1 border-t border-line pt-3 text-sm text-muted">
        {hasDeleted ? (
          <p>
            {t(
              'Replaced a machine? After pairing the new one, open "Show deleted" below and hand each old agent over to its new counterpart, so its entries and groups carry over.',
              '换了机器？新机器配对后，点下面的「显示已删除的」，把每个旧 Agent 转给新的，它的入口和群设置就能延续。',
            )}
          </p>
        ) : null}
        <p>
          {t('To add people, create an invite link on the ', '要加真人，去')}
          <Link className="text-accent-fg underline underline-offset-2 hover:decoration-2" to="/app/contacts">
            {t('Contacts page', '联系人页')}
          </Link>
          {t('.', '生成邀请链接。')}
        </p>
      </div>
    </Panel>
  );
}

/** A small online/offline dot with its meaning spelled out for screen readers. */
function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${online ? 'bg-ok' : 'bg-line-strong'}`}
    />
  );
}

/** One agent inside its device panel: the essentials on one line; the rest behind its "Manage" menu. */
function AgentRow({
  e,
  handle,
  address,
  liveConnections,
  neverConnected,
  act,
  allAgents,
  successors,
}: {
  e: Endpoint;
  handle: string;
  /** Private automatic address for use by this account only. */
  address: string | null;
  liveConnections: number;
  /** Certainly never opened from a client since pairing (not just offline now). */
  neverConnected: boolean;
  act: Act;
  /** Plain sends reach every agent (ADR 0008), so no single one is "the" default receiver. */
  allAgents: boolean;
  /** Agents that could take this one over (ADR 0011). */
  successors: Endpoint[];
}) {
  const [open, setOpen] = useState<'rename' | 'handover' | null>(null);
  const t = useT();
  const online = liveConnections > 0;
  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-2.5">
          <StatusDot online={online} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="break-words font-medium text-fg">{e.label}</span>
              <Chip>{harnessLabel(e.harness_key)}</Chip>
              {allAgents ? (
                <Chip tone="ok">{t('Receives', '接收')}</Chip>
              ) : e.is_default_receiver ? (
                <Chip tone="ok">{t('Default receiver', '默认接收')}</Chip>
              ) : null}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-dim">
              <span className={online ? 'text-ok' : neverConnected ? 'text-warn' : ''}>
                {online
                  ? t('Online', '在线')
                  : neverConnected
                    ? t('Waiting for first connection — restart your client', '等待首次连接——请重启客户端')
                    : t('Offline', '未连接')}
              </span>
              {address ? (
                <span className="break-all font-mono" title={t('Only visible to you', '仅你可见')}>
                  @{handle}/{address}
                </span>
              ) : null}
              {e.public_name ? (
                <span title={t('Signature in your own history', '自己历史中的署名')}>
                  {t(`signs as "${e.public_name}"`, `署名「${e.public_name}」`)}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {allAgents || !e.is_default_receiver ? (
            <Button
              variant="ghost"
              onClick={() => {
                if (
                  confirm(
                    t(
                      'Only this agent will receive messages sent to you directly; your other agents stop getting their own copy (they still see the shared mailbox). Continue?',
                      '以后直接发给你的消息只投到这个 Agent；其他 Agent 不再各收一份（仍能看到共享信箱）。继续？',
                    ),
                  )
                )
                  act.mutate(() => api.post('/v1/me/default-endpoint', { h_id: e.h_id }));
              }}
            >
              {t('Receive only here', '只在这里接收')}
            </Button>
          ) : null}
          <Menu
            label={t('Manage', '管理')}
            items={[
              { label: t('Rename', '重命名'), onSelect: () => setOpen('rename') },
              successors.length > 0
                ? { label: t('Hand over', '转给另一个 Agent'), onSelect: () => setOpen('handover') }
                : null,
              {
                label: t('Sign out (pair again)', '退出登录（需重新配对）'),
                onSelect: () => {
                  if (
                    confirm(
                      t(
                        'Sign this agent out? It stops working until you pair it again on its machine (agentdrop setup); its settings and messages stay.',
                        '让这个 Agent 退出登录？在它的机器上重新配对（agentdrop setup）之前它无法使用；设置和消息都保留。',
                      ),
                    )
                  )
                    act.mutate(() => api.post(`/v1/me/endpoints/${e.h_id}/credentials/revoke`));
                },
              },
              {
                label: t('Delete agent', '删除 Agent'),
                danger: true,
                onSelect: () => {
                  if (
                    confirm(
                      t(
                        `Delete "${e.label}"? It stops sending and receiving and disappears from this page. Messages are kept. (If its machine was replaced, "Hand over" moves its entries and groups to the new agent instead.)`,
                        `删除「${e.label}」？它将无法收发，并从这里消失。消息保留。（如果是换了机器，用「转给另一个 Agent」可以把入口和群设置转给新 Agent。）`,
                      ) + (successors.length === 0 ? t(LAST_AGENT.en, LAST_AGENT.zh) : ''),
                    )
                  )
                    act.mutate(() => api.post(`/v1/me/endpoints/${e.h_id}/revoke`));
                },
              },
            ]}
          />
        </div>
      </div>
      {open === 'rename' ? (
        <InlineForm title={t('Rename', '重命名')} onClose={() => setOpen(null)}>
          <RenameForm e={e} act={act} onDone={() => setOpen(null)} />
        </InlineForm>
      ) : null}
      {open === 'handover' ? (
        <InlineForm title={t('Hand over', '转给另一个 Agent')} onClose={() => setOpen(null)}>
          <TakeOver from={e} successors={successors} act={act} />
        </InlineForm>
      ) : null}
    </li>
  );
}

/** The inset area under a row where a chosen action's form opens, titled, with a way to close it again. */
function InlineForm({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="mt-3 rounded-lg border border-line bg-bg px-4 pt-2 pb-4 sm:ml-[18px]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-fg">{title}</div>
        <IconButton label={t('Close', '收起')} className="-mr-2" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      {children}
    </div>
  );
}

/** The agent's own name and the optional signature shown in the owner's history; both only for the owner. */
function RenameForm({ e, act, onDone }: { e: Endpoint; act: Act; onDone: () => void }) {
  const t = useT();
  const [label, setLabel] = useState(e.label);
  const [publicName, setPublicName] = useState(e.public_name ?? '');
  const changed = label.trim() !== e.label || publicName !== (e.public_name ?? '');
  return (
    <form
      className="space-y-3"
      onSubmit={(ev: FormEvent) => {
        ev.preventDefault();
        if (!changed || !label.trim()) return;
        const body: { label?: string; public_name?: string | null } = {};
        if (label.trim() !== e.label) body.label = label.trim();
        if (publicName !== (e.public_name ?? '')) body.public_name = publicName || null;
        act.mutate(() => api.patch(`/v1/me/endpoints/${e.h_id}`, body));
        onDone();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t('Agent name', 'Agent 名称')}
          hint={t('Only you see it; renaming changes nothing else', '只有你看得到；改名不影响其他任何东西')}
        >
          <Input value={label} onChange={(ev) => setLabel(ev.target.value)} maxLength={64} required />
        </Field>
        <Field
          label={t('Signature in your own history (optional)', '自己历史中的署名（可选）')}
          hint={t('Only you see this; other people see your name.', '仅你可见；别人看到的是你的名字。')}
        >
          <Input
            value={publicName}
            onChange={(ev) => setPublicName(ev.target.value)}
            maxLength={64}
            placeholder={t('Research assistant', '科研助手')}
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!changed || !label.trim()}>
          {t('Save', '保存')}
        </Button>
      </div>
    </form>
  );
}

/** A deleted agent: who took it over, or a way to hand it over now. */
function DeletedRow({
  e,
  act,
  successors,
  takenOverLabel,
}: {
  e: Endpoint;
  act: Act;
  successors: Endpoint[];
  takenOverLabel?: string | undefined;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="break-words font-medium text-fg-2">{e.label}</span>
            <Chip>{harnessLabel(e.harness_key)}</Chip>
            <Chip tone="danger">{t('Deleted', '已删除')}</Chip>
          </div>
          <div className="mt-0.5 text-xs text-dim">
            {e.device.label}
            {e.taken_over_by
              ? t(
                  ` · taken over by "${takenOverLabel ?? '?'}": its entries and groups moved there.`,
                  ` · 已由「${takenOverLabel ?? '?'}」接替：入口和群设置都已转过去。`,
                )
              : ''}
          </div>
        </div>
        {!e.taken_over_by && successors.length > 0 ? (
          <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {t('Hand over', '转给另一个 Agent')}
          </Button>
        ) : null}
      </div>
      {open ? (
        <InlineForm title={t('Hand over', '转给另一个 Agent')} onClose={() => setOpen(false)}>
          <TakeOver from={e} successors={successors} act={act} />
        </InlineForm>
      ) : null}
    </li>
  );
}

/**
 * Hand this agent over to another of mine (ADR 0011), for a machine that is gone: its addresses, group bindings
 * and default receiving move over, so contacts need not do anything; then this agent is revoked.
 */
function TakeOver({ from, successors, act }: { from: Endpoint; successors: Endpoint[]; act: Act }) {
  const t = useT();
  // agents of the same tool first: the natural heir of a lost Codex is the new Codex
  const ordered = [...successors].sort(
    (a, b) => Number(b.harness_key === from.harness_key) - Number(a.harness_key === from.harness_key),
  );
  const [to, setTo] = useState(ordered[0]?.h_id ?? '');
  const target = ordered.find((o) => o.h_id === to);
  return (
    <Field
      label={t('Machine gone? Hand this agent over', '机器没了？把这个 Agent 转给另一个')}
      hint={t(
        'Its entries, group settings and default receiving move to the agent you choose, so contacts do not have to change anything; this agent is then deleted. Messages stay readable.',
        '它的入口、群设置和默认接收都转到你选的 Agent 上，联系人什么都不用改；随后这个 Agent 会被删除。消息照常能读。',
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          className={settingsSelectClass}
          value={to}
          onChange={(ev) => setTo(ev.target.value)}
          aria-label={t('Agent that takes over', '接替的 Agent')}
        >
          {ordered.map((o) => (
            <option key={o.h_id} value={o.h_id}>
              {o.label} · {o.device.label} · {harnessLabel(o.harness_key)}
            </option>
          ))}
        </select>
        <Button
          className="h-9"
          disabled={!target}
          onClick={() => {
            if (
              target &&
              confirm(
                t(
                  `Let "${target.label}" take over "${from.label}"? "${from.label}" will be deleted.`,
                  `让「${target.label}」接替「${from.label}」？「${from.label}」会被删除。`,
                ),
              )
            )
              act.mutate(() =>
                api.post(`/v1/me/endpoints/${target.h_id}/take-over`, { from_h_id: from.h_id }),
              );
          }}
        >
          {t('Hand over', '转过去')}
        </Button>
      </div>
    </Field>
  );
}

function RoutesSection({
  handle,
  routes,
  endpoints,
  loading,
  act,
}: {
  routes: RouteView[];
  handle: string;
  endpoints: Endpoint[];
  loading: boolean;
  act: Act;
}) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ alias: '', label: '', h_id: endpoints[0]?.h_id ?? '' });
  const named = routes.filter((r) => !r.is_default && !r.auto);
  return (
    <Panel
      title={t('Named entries', '具名入口')}
      description={t(
        'Extra addresses like @you/research that you can point at any agent. Optional.',
        '额外的地址，比如 @你/research，可以随时改指向哪个 Agent。可选。',
      )}
    >
      {loading ? <Loading /> : null}
      {named.length > 0 ? (
        <ul className="-mx-5 divide-y divide-line border-y border-line">
          {named.map((r) => (
            <li key={r.route_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="break-all font-mono text-sm text-accent-fg">
                    @{handle}/{r.alias}
                  </span>
                  <Chip tone={r.visibility === 'contacts' ? 'ok' : 'neutral'}>
                    {r.visibility === 'contacts'
                      ? t('Visible to contacts', '对联系人公开')
                      : t('Private', '私有')}
                  </Chip>
                </div>
                <div className="mt-0.5 text-xs text-dim">{r.label}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <span className="text-xs text-dim" aria-hidden="true">
                  →
                </span>
                <select
                  className="h-8 max-w-44 rounded-lg border border-line-strong bg-surface-2 px-2 text-sm text-fg focus:border-accent/60 focus:outline-none"
                  value={r.destination_h_id}
                  onChange={(e) =>
                    act.mutate(() => api.patch(`/v1/me/routes/${r.route_id}`, { h_id: e.target.value }))
                  }
                  aria-label={t('Target agent', '指向的 Agent')}
                >
                  {endpoints.some((e) => e.h_id === r.destination_h_id) ? null : (
                    <option value={r.destination_h_id}>{t('(deleted agent)', '（已删除的 Agent）')}</option>
                  )}
                  {endpoints.map((e) => (
                    <option key={e.h_id} value={e.h_id}>
                      {e.label}
                    </option>
                  ))}
                </select>
                <Menu
                  label={t(`Entry actions: ${r.alias}`, `入口操作：${r.alias}`)}
                  items={[
                    {
                      label:
                        r.visibility === 'contacts'
                          ? t('Make private', '设为私有')
                          : t('Make visible', '公开'),
                      onSelect: () =>
                        act.mutate(() =>
                          api.patch(`/v1/me/routes/${r.route_id}`, {
                            visibility: r.visibility === 'contacts' ? 'private' : 'contacts',
                          }),
                        ),
                    },
                    {
                      label: t('Delete', '删除'),
                      danger: true,
                      onSelect: () => {
                        if (
                          confirm(
                            t(
                              'Delete this entry? Contacts who remembered it get a clear error on their next send instead of being silently redirected.',
                              '删除这个入口？记住了它的联系人下次发送会收到明确提示，不会被悄悄改投。',
                            ),
                          )
                        )
                          act.mutate(() => api.post(`/v1/me/routes/${r.route_id}/revoke`));
                      },
                    },
                  ]}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {!adding ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden="true" />
            {t('New entry', '新建入口')}
          </Button>
          {named.length === 0 && !loading ? (
            <span className="text-sm text-dim">{t('None yet', '还没有')}</span>
          ) : null}
        </div>
      ) : null}
      {adding ? (
        <form
          className="space-y-3 rounded-lg border border-line bg-bg p-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            act.mutate(() =>
              api
                .post('/v1/me/routes', {
                  alias: form.alias,
                  label: form.label,
                  h_id: form.h_id,
                  visibility: 'contacts',
                })
                .then(() => {
                  setForm({ ...form, alias: '', label: '' });
                  setAdding(false);
                }),
            );
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('Alias', '别名')}>
              <Input
                value={form.alias}
                onChange={(e) => setForm({ ...form, alias: e.target.value })}
                placeholder="research"
                required
              />
            </Field>
            <Field label={t('Display name', '显示名')}>
              <Input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder={t('Research entry', '科研入口')}
                required
              />
            </Field>
            <Field label={t('Points to', '指向')}>
              <select
                className={settingsSelectClass}
                value={form.h_id}
                onChange={(e) => setForm({ ...form, h_id: e.target.value })}
              >
                {endpoints.map((e) => (
                  <option key={e.h_id} value={e.h_id}>
                    {e.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)}>
              {t('Cancel', '取消')}
            </Button>
            <Button type="submit">{t('Publish entry', '发布入口')}</Button>
          </div>
        </form>
      ) : null}
    </Panel>
  );
}

/** "Sep 25" (the year only when it is not this year), or the full date and time when two devices share a name. */
function pairedWhen(iso: string, withTime = false): string {
  return withTime ? formatDateTime(iso) : formatDay(iso);
}
