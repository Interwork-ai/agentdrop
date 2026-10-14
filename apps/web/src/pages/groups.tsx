import type { GroupFilesResult } from '@agentdrop/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Download, FileText, PenLine, Plus, Trash2, UsersRound, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { NavLink, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  ApiFailure,
  api,
  defaultExportRange,
  downloadExport,
  EXPORT_MAX_DAYS,
  exportDayRange,
  type GroupDetail,
  type GroupSummary,
  type InviteOutcome,
  type ListDrops,
  mailboxUrl,
} from '../lib/api.js';
import { formatBytes, plural, useFormat } from '../lib/format.js';
import { type Translate, useT } from '../lib/lang.js';
import { mailboxKey, useFocusAwareInterval, useSession } from '../lib/session.js';
import { usePanelFocus } from '../ui/focus.js';
import {
  Avatar,
  Chip,
  EmptyState,
  IconButton,
  ListLabel,
  listRowClass,
  Menu,
  PageToolbar,
  Panel,
  Segmented,
  SplitView,
} from '../ui/layout.jsx';
import { NeedsAgentNote } from '../ui/needs-agent.jsx';
import { Button, ErrorBox, Field, Input, Loading, PublicEmail } from '../ui/primitives.jsx';
import { RadioSegmented, SettingsSwitch } from '../ui/settings-controls.jsx';

/** One field, several people: handles may be pasted separated by spaces, commas or Chinese punctuation. */
function parseHandles(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,，、;；]+/)
        .map((h) => h.trim().replace(/^@+/, ''))
        .filter((h) => h.length > 0),
    ),
  ];
}

const outcomes = (
  t: Translate,
): Record<InviteOutcome['outcome'], { label: string; tone: 'ok' | 'warn' | 'neutral' }> => ({
  invited: {
    label: t(
      'Invitation sent; waiting for them to pick a receiving agent',
      '已发出邀请，等待对方选择接收 Agent',
    ),
    tone: 'ok',
  },
  requested: {
    label: t('Request submitted; waiting for admin approval', '已提交申请，等待管理员批准'),
    tone: 'warn',
  },
  already_member: { label: t('Already in the group', '已经在群里'), tone: 'neutral' },
});

function InviteOutcomes({ invites }: { invites: InviteOutcome[] }) {
  const t = useT();
  const OUTCOME = outcomes(t);
  if (invites.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {invites.map((i) => (
        <li key={i.handle} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium text-fg">@{i.handle}</span>
          <Chip tone={OUTCOME[i.outcome].tone}>
            <span className="whitespace-normal">{OUTCOME[i.outcome].label}</span>
          </Chip>
        </li>
      ))}
    </ul>
  );
}

/**
 * An invite call is all-or-nothing, so a refusal means nobody was invited. The server names the handles it could
 * not find and the member-slot numbers in `details`; without them the user cannot tell which entry to fix.
 */
function InviteError({ error, id }: { error: unknown; id?: string }) {
  const t = useT();
  const details = error instanceof ApiFailure ? error.body.details : undefined;
  const limit = typeof details?.member_limit === 'number' ? details.member_limit : null;
  const used = typeof details?.member_slots_used === 'number' ? details.member_slots_used : null;
  // humanError already names unknown usernames (lib/error-text.ts); the wrapper's id ties it to the field
  return (
    <div id={id}>
      <ErrorBox error={error}>
        {limit !== null && used !== null ? (
          <p>
            {t(
              `Member slots used: ${used} / ${limit} (active members + unanswered invitations). You can invite at most ${Math.max(0, limit - used)} more; nobody was invited this time.`,
              `成员名额已用 ${used} / ${limit}（有效成员 + 未回应的邀请），最多还能再邀请 ${Math.max(0, limit - used)} 人；这次没有邀请任何人。`,
            )}
          </p>
        ) : null}
      </ErrorBox>
    </div>
  );
}

/** True when a failed invitation is about the usernames typed (unknown, yourself, the assistant, too many). */
function handlesProblem(error: unknown): boolean {
  if (!(error instanceof ApiFailure)) return false;
  const { code, details } = error.body;
  return (code === 'NOT_FOUND' && Array.isArray(details?.handles)) || details?.field === 'handles';
}

/** Free-text handle entry with chips, so one call can carry several people. */
function HandleField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  hideLabel = false,
  action,
  errorId,
}: {
  /** The id of an error about these usernames: the field is marked invalid and described by it. */
  errorId?: string | undefined;
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  placeholder?: string;
  /** When the surrounding Panel already says it; the input keeps the label as its accessible name. */
  hideLabel?: boolean;
  /** A button beside the input, such as the submit of a one-field form. */
  action?: ReactNode;
}) {
  const t = useT();
  const handles = parseHandles(value);
  return (
    <div className="space-y-1.5">
      {hideLabel ? null : <span className="block text-sm font-medium text-fg-2">{label}</span>}
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={errorId ? true : undefined}
          aria-describedby={errorId}
        />
        {action}
      </div>
      {handles.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {handles.map((h) => (
            <span
              key={h}
              className="inline-flex max-w-full items-center gap-1 rounded-md bg-hover py-0.5 pl-2 pr-1 text-xs font-medium text-fg-2"
            >
              <span className="truncate">@{h}</span>
              <button
                type="button"
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-dim hover:bg-hover hover:text-fg"
                aria-label={t(`Remove ${h}`, `移除 ${h}`)}
                onClick={() => onChange(handles.filter((x) => x !== h).join(' '))}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {hint ? <span className="block text-xs text-dim">{hint}</span> : null}
    </div>
  );
}

/** A labelled group of controls (radios, checkboxes): a fieldset, so the caption does not toggle the first one. */
function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1.5 text-sm font-medium text-fg-2">{label}</legend>
      {children}
      {hint ? <span className="block text-xs text-dim">{hint}</span> : null}
    </fieldset>
  );
}

/** Members are entitled to know this before they post, so it sits next to the group settings and the invitation. */
function AdminReadDisclosure() {
  const t = useT();
  return (
    <p className="text-xs leading-5 text-dim">
      {t(
        'The owner and admins can read every message in this group, including ones from before they joined (read-only and recorded in the audit log).',
        '群主和管理员可以查看本群的全部消息，包括他们加入之前的（只读，并记入审计日志）。',
      )}
    </p>
  );
}

/** Group roles in the reader's language; the raw values never reach the page. */
function roleLabel(t: Translate, role: 'owner' | 'admin' | 'member' | null | undefined): string {
  if (role === 'owner') return t('Owner', '群主');
  if (role === 'admin') return t('Admin', '管理员');
  return t('Member', '成员');
}

/** What new members see, in the words every member reads on the group page (ADR 0022). */
function historyStatus(t: Translate, visible: boolean): string {
  return visible
    ? t('New members can see earlier messages', '新成员可以查看入群前的消息')
    : t('New members see only messages after they join', '新成员只能看到入群之后的消息');
}

/**
 * Whether members who join later can read the group's earlier messages. The owner chooses; everyone else sees the
 * current choice. Read-only access either way, never unread and never announced.
 */
function HistoryVisibility({
  group,
  isOwner,
  act,
}: {
  group: GroupDetail;
  isOwner: boolean;
  act: { mutate: (fn: () => Promise<unknown>) => void; isPending: boolean };
}) {
  const t = useT();
  const visible = group.history_visible === true;
  return (
    <Panel
      title={t('Earlier messages', '入群前的消息')}
      description={
        isOwner
          ? t(
              'Applies to everyone who joins later: when on, the group’s past messages become visible to them, read-only.',
              '对之后加入的每个人都生效：开启后，本群过去的消息对他们可见（只读）。',
            )
          : t('Only the owner can change this.', '只有群主可以修改。')
      }
    >
      {isOwner ? (
        <RadioSegmented<'on' | 'off'>
          label={t('Earlier messages', '入群前的消息')}
          value={visible ? 'on' : 'off'}
          disabled={act.isPending}
          options={[
            { value: 'on', label: historyStatus(t, true) },
            { value: 'off', label: historyStatus(t, false) },
          ]}
          onChange={(next) =>
            act.mutate(() =>
              api.patch(`/v1/me/groups/${group.group_id}/policy`, { history_visible: next === 'on' }),
            )
          }
        />
      ) : (
        <p className="text-sm text-fg-2">{historyStatus(t, visible)}</p>
      )}
    </Panel>
  );
}

const memberCount = (t: Translate, n: number) => t(plural(n, 'member', 'members'), `${n} 位成员`);

/** The square mark a group wears in lists and headers, where a person would have an avatar. */
function GroupGlyph({ size = 32 }: { size?: 32 | 40 }) {
  return (
    // a text "#", not an icon: a group row's accessible name starts with it, like the #slug people type
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-lg bg-surface-3 font-semibold text-muted ${
        size === 40 ? 'h-10 w-10 text-md' : 'h-8 w-8 text-base'
      }`}
    >
      #
    </span>
  );
}

export function GroupsPage() {
  const t = useT();
  const { groupId } = useParams();
  const { me, currentH } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [form, setForm] = useState({
    slug: '',
    display_name: '',
    receive_all: true,
    h_ids: [] as string[],
    invite: '',
  });
  const [creating, setCreating] = useState(false);
  const createPanel = useRef<HTMLElement>(null);
  usePanelFocus(creating, createPanel);
  const createErrorId = useId();
  const [createdInvites, setCreatedInvites] = useState<InviteOutcome[] | null>(null);
  const groups = useQuery({
    queryKey: ['groups', currentH?.h_id],
    queryFn: () =>
      api.get<{ groups: GroupSummary[] }>(`/v1/me/groups${currentH ? `?h_id=${currentH.h_id}` : ''}`),
  });
  const create = useMutation({
    mutationFn: () => {
      const handles = parseHandles(form.invite);
      // Left empty, the server names the group after its creator ("Alice +2") and derives the slug from their handle.
      return api.post<GroupDetail>('/v1/me/groups', {
        ...(form.slug.trim() ? { slug: form.slug.trim() } : {}),
        ...(form.display_name.trim() ? { display_name: form.display_name.trim() } : {}),
        ...(form.receive_all ? { receive_all: true } : { receive_all: false, binding_h_ids: form.h_ids }),
        ...(handles.length > 0 ? { invite_handles: handles } : {}),
      });
    },
    onSuccess: (g) => {
      qc.invalidateQueries({ queryKey: ['groups'] });
      setCreating(false);
      setCreatedInvites(g.invites ?? []);
      setForm({ slug: '', display_name: '', receive_all: true, h_ids: [], invite: '' });
      nav(`/app/groups/${g.group_id}`);
    },
  });
  const endpoints = (me?.endpoints ?? []).filter((e) => !e.revoked_at);
  // without an agent a group cannot be created (the shell's banner says how to pair one): no "New" to press
  const noAgent = !!me && endpoints.length === 0;
  const all = groups.data?.groups ?? [];
  // an invitation is the thing to act on, so it is pinned above the groups I am in
  const invitations = all.filter((g) => g.status === 'invited');
  const joined = all.filter((g) => g.status !== 'invited');

  const listPane = (
    <>
      <PageToolbar
        title={t('Groups', '群组')}
        actions={
          noAgent ? null : (
            <Button aria-expanded={creating} onClick={() => setCreating((v) => !v)}>
              <Plus size={14} aria-hidden="true" />
              {t('New', '新建')}
            </Button>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {creating && !noAgent ? (
          <section
            ref={createPanel}
            aria-label={t('New group', '新建群组')}
            className="border-b border-line p-3"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setCreating(false);
            }}
          >
            <Panel
              title={t('New group', '新建群组')}
              actions={
                <IconButton
                  label={t('Close', '关闭')}
                  className="-mr-1.5 -mt-1"
                  onClick={() => setCreating(false)}
                >
                  <X size={16} />
                </IconButton>
              }
            >
              <form
                className="space-y-4"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  create.mutate();
                }}
              >
                <Field
                  label={t('Group name (optional)', '群名（可选）')}
                  hint={t(
                    'Leave it empty to use your nickname and the number of people you invite, for example “Alice +2”.',
                    '留空就用你的昵称加上邀请人数命名，例如“Alice +2”。',
                  )}
                >
                  <Input
                    value={form.display_name}
                    onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                    placeholder={t('Paper discussion', '论文讨论组')}
                    maxLength={64}
                  />
                </Field>
                <Field
                  label={t('Slug (optional, unique)', '短代码（可选，唯一）')}
                  hint={t(
                    'Used as #slug. Left empty, it is made from your handle.',
                    '用作 #短代码；留空按你的 handle 生成。',
                  )}
                >
                  <Input
                    value={form.slug}
                    onChange={(e) => setForm({ ...form, slug: e.target.value })}
                    placeholder="research"
                    maxLength={32}
                  />
                </Field>
                <FieldGroup
                  label={t('Receive this group with', '用哪些 Agent 接收此群')}
                  hint={t(
                    'You can change it later; changes only affect future messages.',
                    '以后可改，改动只影响之后的消息。',
                  )}
                >
                  <ReceivePicker
                    name="create-receive"
                    all={form.receive_all}
                    hIds={form.h_ids}
                    endpoints={endpoints}
                    onChange={(all, h_ids) => setForm({ ...form, receive_all: all, h_ids })}
                  />
                </FieldGroup>
                <HandleField
                  label={t('Invite at the same time (optional)', '同时邀请（可选）')}
                  value={form.invite}
                  onChange={(invite) => setForm({ ...form, invite })}
                  placeholder={t('@wang @li, separated by spaces or commas', '@wang @li，用空格或逗号分隔')}
                  hint={t('Each person joins once they accept.', '对方接受后才算入群。')}
                  errorId={create.isError && handlesProblem(create.error) ? createErrorId : undefined}
                />
                {create.isError ? <InviteError error={create.error} id={createErrorId} /> : null}
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    variant="primary"
                    className="h-9"
                    disabled={
                      create.isPending ||
                      (form.receive_all ? endpoints.length === 0 : form.h_ids.length === 0)
                    }
                  >
                    {t('Create', '创建')}
                  </Button>
                </div>
              </form>
            </Panel>
          </section>
        ) : null}
        {createdInvites && createdInvites.length > 0 ? (
          <div className="space-y-2.5 border-b border-line bg-selected px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-fg">
                {t('Invitations sent with the new group', '建群时的邀请结果')}
              </span>
              <Button className="ml-auto" variant="ghost" onClick={() => setCreatedInvites(null)}>
                {t('Got it', '知道了')}
              </Button>
            </div>
            <InviteOutcomes invites={createdInvites} />
          </div>
        ) : null}
        {groups.isLoading ? <Loading /> : null}
        {groups.isError ? <ErrorBox error={groups.error} retry={() => groups.refetch()} /> : null}
        {invitations.length > 0 ? (
          <section>
            <ListLabel>
              <span className="inline-flex items-center gap-1.5 text-warn">
                <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true" />
                {t(`Invitations (${invitations.length})`, `待回应的邀请（${invitations.length}）`)}
              </span>
            </ListLabel>
            {invitations.map((g) => (
              <GroupRow key={g.group_id} g={g} />
            ))}
          </section>
        ) : null}
        {joined.length > 0 ? (
          <section>
            {invitations.length > 0 ? (
              <ListLabel>{t(`My groups (${joined.length})`, `我的群组（${joined.length}）`)}</ListLabel>
            ) : null}
            {joined.map((g) => (
              <GroupRow key={g.group_id} g={g} />
            ))}
          </section>
        ) : null}
        {groups.data && groups.data.groups.length === 0 && !creating ? (
          <EmptyState icon={<UsersRound size={20} />} title={t('No groups yet', '还没有群组')}>
            {noAgent
              ? t(
                  'A group sends one message to several people at once. Once your first agent is paired, you can create one here or join one you are invited to.',
                  '群组可以把一条消息同时发给几个人。配对第一个 Agent 之后，就能在这里建群，或加入别人邀请你的群。',
                )
              : t(
                  'Click “New” at the top right, name the group and invite members; all your agents receive it by default.',
                  '点右上角「新建」，起名并邀请成员；默认你的所有 Agent 都接收。',
                )}
          </EmptyState>
        ) : null}
      </div>
    </>
  );

  return (
    <SplitView
      listLabel={t('Groups', '群组')}
      showDetail={!!groupId}
      list={listPane}
      detail={<GroupDetailPane />}
    />
  );
}

/** A group in the list. The accessible name reads "name #slug members · role chips", in that order. */
function GroupRow({ g }: { g: GroupSummary }) {
  const t = useT();
  const notReceiving = g.status === 'active' && g.current_h_receives === false;
  return (
    <NavLink to={`/app/groups/${g.group_id}`} className={({ isActive }) => listRowClass(isActive)}>
      <div className="flex items-center gap-3">
        <GroupGlyph />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-sm font-medium text-fg">{g.display_name}</span>
            <span className="min-w-0 shrink-2 truncate text-sm text-muted">#{g.slug}</span>
          </div>
          <div className="truncate text-xs text-dim">
            {memberCount(t, g.active_member_count)}
            {g.status === 'active' && g.role ? ` · ${roleLabel(t, g.role)}` : ''}
          </div>
        </div>
        <span className="flex shrink-0 flex-col items-end gap-1">
          {g.status === 'invited' ? <Chip tone="warn">{t('Invitation', '待回应邀请')}</Chip> : null}
          {g.status === 'active' && g.muted ? <Chip>{t('Muted', '静音')}</Chip> : null}
          {notReceiving ? (
            <Chip
              tone="warn"
              title={t('The current agent does not receive this group.', '当前 Agent 不接收此群。')}
            >
              {t('Not receiving', '未接收')}
            </Chip>
          ) : null}
        </span>
      </div>
    </NavLink>
  );
}

type GroupTab = 'messages' | 'members' | 'files' | 'settings';

function GroupDetailPane() {
  const t = useT();
  const f = useFormat();
  const params = useParams();
  const [search, setSearch] = useSearchParams();
  const { me, currentH } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const interval = useFocusAwareInterval();
  const id = params.groupId ?? null;
  const [history, setHistory] = useState(false);
  // Opening another group starts over: the admin view belongs to the group it was turned on in.
  const [shownGroup, setShownGroup] = useState(id);
  if (shownGroup !== id) {
    setShownGroup(id);
    setHistory(false);
  }
  const rawTab = search.get('tab');
  const tab: GroupTab =
    rawTab === 'members' || rawTab === 'files' || rawTab === 'settings' ? rawTab : 'messages';
  const setTab = (next: GroupTab) => {
    const params = new URLSearchParams(search);
    if (next === 'messages') params.delete('tab');
    else params.set('tab', next);
    setSearch(params, { replace: true });
  };
  // A group I just left or declined is no longer visible to me: stop asking for it before the answer can come back
  // 404 (a mounted query refetches as soon as its cache is dropped, and the timeline polls).
  const [goneGroup, setGoneGroup] = useState<string | null>(null);
  const gone = !!id && goneGroup === id;
  const group = useQuery({
    queryKey: ['group', id, currentH?.h_id],
    queryFn: () => api.get<GroupDetail>(`/v1/me/groups/${id}${currentH ? `?h_id=${currentH.h_id}` : ''}`),
    enabled: !!id && !gone,
  });
  const mine = group.data?.my_membership ?? null;
  const joinedAt = mine?.joined_at ?? null;
  const isAdmin = mine?.status === 'active' && (mine.role === 'owner' || mine.role === 'admin');
  // With earlier messages visible to members (ADR 0022) every member's timeline is the whole history already;
  // the admin's explicit, audited view is only for groups where it is not.
  const historyVisible = group.data?.history_visible === true;
  const historyOn = history && isAdmin && !historyVisible;
  // Receiving bindings govern delivery, not account-wide reading (ADR 0007 and ADR 0022).
  const canReadTimeline =
    mine?.status === 'active' &&
    (historyOn || me?.cross_h_mailbox_enabled === true || group.data?.current_h_receives === true);
  const timeline = useQuery({
    queryKey: mailboxKey(
      currentH?.h_id ?? '',
      'list',
      'inbox',
      '',
      false,
      id,
      ...(historyOn ? ['group-history'] : []),
      ...(historyVisible ? ['history-visible'] : []),
    ),
    queryFn: () =>
      api.get<ListDrops>(
        mailboxUrl(
          currentH?.h_id ?? '',
          `/drops?view=inbox&group_id=${id}&limit=50${historyOn ? '&include_group_history=true' : ''}`,
        ),
      ),
    enabled: !!id && !gone && !!currentH && canReadTimeline,
    refetchInterval: interval,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['group', id] });
    qc.invalidateQueries({ queryKey: ['groups'] });
  };
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
  });
  /** After leaving or declining: disable and cancel this group's queries, then go back to the list. */
  const forgetGroup = () => {
    if (!id) return;
    setGoneGroup(id);
    void qc.cancelQueries({ queryKey: ['group', id] });
    nav('/app/groups');
    qc.removeQueries({ queryKey: ['group', id] });
    qc.invalidateQueries({ queryKey: ['groups'] });
  };
  const leave = useMutation({
    mutationFn: () => api.post(`/v1/me/groups/${id}/leave`),
    onSuccess: forgetGroup,
  });
  if (!id)
    return (
      <EmptyState icon={<UsersRound size={20} />} title={t('Select a group', '选择一个群组')}>
        {t(
          "A group message reaches every member's agents, even while they are offline.",
          '群消息会投递到每位成员的 Agent，成员离线也会收到。',
        )}
      </EmptyState>
    );

  const frame = (body: ReactNode) => (
    <>
      <PageToolbar
        title={t('Group', '群组')}
        backLabel={t('Back to groups', '返回群组')}
        onBack={() => nav('/app/groups')}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </>
  );
  if (group.isLoading) return frame(<Loading />);
  if (group.isError) return frame(<ErrorBox error={group.error} />);
  const g = group.data;
  if (!g || !me) return null;
  const endpoints = me.endpoints.filter((e) => !e.revoked_at);

  if (mine?.status !== 'active')
    return frame(
      <div className="mx-auto w-full max-w-3xl space-y-5 p-4 md:p-6">
        <GroupHeader group={g} />
        {mine?.status === 'invited' ? (
          <InviteAccept group={g} endpoints={endpoints} onDone={refresh} onGone={forgetGroup} />
        ) : null}
      </div>,
    );

  // The server still lists bindings of revoked endpoints; sending those back makes every update fail.
  const bound = new Set((mine.binding_h_ids ?? []).filter((hId) => endpoints.some((e) => e.h_id === hId)));
  const endpointsOverLimit = g.endpoints_over_limit ?? g.endpoint_total > g.endpoint_limit;
  const tabs: Array<{ value: GroupTab; label: string; count?: number }> = [
    { value: 'messages', label: t('Messages', '消息') },
    { value: 'members', label: t('Members', '成员'), count: isAdmin ? g.join_requests.length : 0 },
    // the file space exists on servers that report it (ADR 0029); older ones have no Files tab
    ...(g.storage ? [{ value: 'files' as const, label: t('Files', '文件') }] : []),
    { value: 'settings', label: t('Settings', '设置'), count: bound.size === 0 ? 1 : 0 },
  ];

  return frame(
    <div className="mx-auto w-full max-w-3xl space-y-5 p-4 md:p-6">
      <GroupHeader
        group={g}
        action={
          <Button
            variant="primary"
            className="h-9"
            onClick={() => nav(`/app/compose?to=${encodeURIComponent(`#${g.slug}`)}`)}
          >
            <PenLine size={14} aria-hidden="true" />
            {t('Write to the group', '写一条')}
          </Button>
        }
      />

      {endpointsOverLimit ? (
        <div
          className="rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger"
          role="alert"
        >
          {t(
            'This group currently exceeds the delivery limit. Members can select fewer of their own receiving agents in Settings before trying again.',
            '本群目前超过投递上限。成员可以在「设置」里减少自己的接收 Agent 后重试。',
          )}
        </div>
      ) : null}

      {g.storage && g.storage.used_bytes >= g.storage.limit_bytes * 0.9 && tab !== 'files' ? (
        <p
          className="rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn"
          role="status"
        >
          {t(
            `This group's file space is almost full (${formatBytes(g.storage.used_bytes)} of ${formatBytes(g.storage.limit_bytes)}): files sent to it may be refused.`,
            `本群的文件空间快满了（已用 ${formatBytes(g.storage.used_bytes)}，上限 ${formatBytes(g.storage.limit_bytes)}），发到群里的文件可能会被拒收。`,
          )}{' '}
          {isAdmin
            ? t('Remove old files under Files.', '可以在「文件」里删除旧文件。')
            : t('A group admin can remove old files.', '群管理员可以删除旧文件。')}
        </p>
      ) : null}

      <Segmented
        asTabs
        label={t('Group sections', '群组分区')}
        options={tabs}
        value={tab}
        onChange={setTab}
      />

      {act.isError ? <ErrorBox error={act.error} /> : null}

      {tab === 'messages' ? (
        <div className="space-y-4">
          {isAdmin && !historyVisible ? (
            <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-fg-2">
              <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
              {t('Show all group messages (admin)', '查看本群全部消息（管理员）')}
            </label>
          ) : null}
          {historyOn ? (
            <p className="rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-xs leading-5 text-warn">
              {t(
                'Admin view: includes messages you never received; they are read-only and this viewing is audited.',
                '管理员视角：包含你没有收到过的消息；它们只读，此次查看会记入审计日志。',
              )}
            </p>
          ) : null}
          {timeline.isError ? <ErrorBox error={timeline.error} /> : null}
          {canReadTimeline ? (
            <ul className="card overflow-hidden rounded-xl border border-line">
              {timeline.isLoading ? (
                <li>
                  <Loading />
                </li>
              ) : null}
              {(timeline.data?.drops ?? []).map((d) => {
                const adminOnly = d.sources.includes('group_admin') && d.deliveries.length === 0;
                const historyOnly = d.sources.includes('group_history') && d.deliveries.length === 0;
                // History reaches drops sent after joining too (one that went to an agent no longer receiving the
                // group): only what predates this membership is "before you joined".
                const earlier = historyOnly && !!joinedAt && Date.parse(d.created_at) < Date.parse(joinedAt);
                const unread = !d.read && !adminOnly && !historyOnly;
                return (
                  <li key={d.drop_id} className="border-b border-line last:border-b-0">
                    <NavLink
                      className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-hover"
                      to={`/app/inbox/${d.drop_id}?group=${g.group_id}`}
                    >
                      <Avatar name={d.author.display_label} seed={d.author.handle} size={28} />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={`truncate text-sm ${unread ? 'font-semibold text-fg' : 'text-fg-2'}`}
                          >
                            {d.author.display_label}
                          </span>
                          {adminOnly ? <Chip tone="warn">{t('Admin view', '管理员视角')}</Chip> : null}
                          {earlier ? <Chip tone="neutral">{t('Before you joined', '入群前')}</Chip> : null}
                          <span
                            className="ml-auto shrink-0 text-xs tabular-nums text-dim"
                            title={f.dateTime(d.created_at)}
                          >
                            {f.short(d.created_at)}
                          </span>
                          {unread ? (
                            <span className="h-2 w-2 shrink-0 rounded-full bg-accent">
                              <span className="sr-only">{t('Unread', '未读')}</span>
                            </span>
                          ) : null}
                        </div>
                        <div className={`truncate text-sm ${unread ? 'font-medium text-fg' : 'text-fg-2'}`}>
                          {d.title}
                        </div>
                        {d.preview ? <div className="truncate text-xs text-muted">{d.preview}</div> : null}
                      </div>
                    </NavLink>
                  </li>
                );
              })}
              {timeline.data && timeline.data.drops.length === 0 ? (
                <li className="px-4 py-8 text-center text-sm text-muted">
                  {historyOn || historyVisible
                    ? t('No messages in this group yet.', '本群还没有消息。')
                    : t(
                        'No messages yet. Messages from before you joined are not shown.',
                        '还没有消息。加入之前的消息不会显示。',
                      )}
                </li>
              ) : null}
            </ul>
          ) : (
            <Panel tone="warn">
              <p className="text-sm text-fg-2">
                {t(
                  'The current agent does not receive this group. Switch agents at the top, or choose it under Settings.',
                  '当前 Agent 不接收此群。切换顶部的 Agent，或在「设置」里选择它接收。',
                )}
              </p>
            </Panel>
          )}
          {currentH ? (
            <DisclosurePanel summary={t('Export group messages', '导出群消息')}>
              <GroupExport
                key={g.group_id}
                hId={currentH.h_id}
                groupId={g.group_id}
                isAdmin={isAdmin}
                agentLabel={currentH.label}
                crossAgent={me.cross_h_mailbox_enabled}
              />
            </DisclosurePanel>
          ) : null}
        </div>
      ) : null}

      {tab === 'members' ? (
        <div className="space-y-5">
          {isAdmin ? <JoinRequests group={g} onDone={refresh} /> : null}
          <Panel
            title={t('Members', '成员')}
            description={t(
              `${g.member_slots_used} / ${g.member_limit} people (members and open invitations)`,
              `${g.member_slots_used} / ${g.member_limit} 人（含未回应的邀请）`,
            )}
            actions={
              isAdmin && g.members_needing_repair > 0 ? (
                <Chip tone="warn">
                  {t(
                    `${g.members_needing_repair} need to fix how they receive`,
                    `${g.members_needing_repair} 人的接收设置待修复`,
                  )}
                </Chip>
              ) : null
            }
          >
            <ul className="-mx-5 -mb-5 border-t border-line">
              {g.members.map((m) => (
                <li
                  key={m.membership_id}
                  className="flex min-w-0 items-center gap-3 border-b border-line px-5 py-3 last:border-b-0"
                >
                  <Avatar name={m.display_label} seed={m.handle} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                      <span className="min-w-0 truncate text-sm font-medium text-fg">{m.display_label}</span>
                      <span className="min-w-0 truncate text-sm text-muted">@{m.handle}</span>
                      {m.role !== 'member' ? (
                        <Chip tone={m.role === 'owner' ? 'accent' : 'neutral'}>{roleLabel(t, m.role)}</Chip>
                      ) : null}
                      {m.status === 'invited' ? <Chip tone="warn">{t('Invited', '已邀请')}</Chip> : null}
                      {m.needs_repair ? <Chip tone="warn">{t('Cannot receive', '无法接收')}</Chip> : null}
                    </div>
                    {m.public_email ? <PublicEmail email={m.public_email} className="text-xs" /> : null}
                  </div>
                  {isAdmin && m.user_id !== me.user_id && m.role !== 'owner' ? (
                    <MemberActions
                      groupId={g.group_id}
                      member={m}
                      iAmOwner={mine.role === 'owner'}
                      act={act}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>
          <InviteBox group={g} isAdmin={isAdmin} onDone={refresh} />
        </div>
      ) : null}

      {tab === 'files' && g.storage ? (
        <GroupFiles group={g} storage={g.storage} isAdmin={isAdmin} onChanged={refresh} />
      ) : null}

      {tab === 'settings' ? (
        <div className="space-y-5">
          {isAdmin ? (
            <Panel
              title={t('Group info', '群资料')}
              description={t('Only the owner and admins can change these.', '只有群主和管理员可以修改。')}
            >
              <GroupIdentityField key={g.group_id} group={g} onDone={refresh} />
            </Panel>
          ) : null}
          <Panel
            title={t('How I receive this group', '我如何接收此群')}
            description={t('Changes apply to future messages only.', '改动只影响之后的消息。')}
            {...(bound.size === 0 ? { tone: 'warn' as const } : {})}
          >
            {bound.size === 0 ? (
              <p className="text-sm text-warn">
                {t(
                  'None of your agents receives this group, so sends to it are refused. Choose at least one.',
                  '你没有任何 Agent 接收此群，群发会被拒绝。请至少选一个。',
                )}
              </p>
            ) : null}
            <ReceivePicker
              name={`receive-${g.group_id}`}
              all={mine.receive_all ?? false}
              hIds={[...bound]}
              endpoints={endpoints}
              onChange={(all, next) =>
                act.mutate(() =>
                  api.put(
                    `/v1/me/groups/${g.group_id}/bindings`,
                    all ? { receive_all: true, h_ids: [] } : { h_ids: next },
                  ),
                )
              }
            />
          </Panel>
          <NicknameField key={g.group_id} groupId={g.group_id} nickname={mine.nickname} act={act} />
          <Panel title={t('Notifications', '通知')}>
            <SettingsSwitch
              checked={mine.muted}
              onChange={(muted) => act.mutate(() => api.patch(`/v1/me/groups/${g.group_id}/me`, { muted }))}
              title={t('Mute', '静音')}
              description={t(
                'No notices for this group; messages still arrive.',
                '不再提醒本群消息；消息照常送达。',
              )}
            />
          </Panel>
          <Panel title={t('Invitations', '邀请')}>
            {isAdmin ? (
              <SettingsSwitch
                checked={g.invite_policy === 'open'}
                onChange={(open) =>
                  act.mutate(() =>
                    api.patch(`/v1/me/groups/${g.group_id}/policy`, {
                      member_invite_policy: open ? 'open' : 'admin_approval',
                    }),
                  )
                }
                title={t('Members can invite directly', '成员可直接邀请')}
                description={t(
                  'When off, members’ invitations wait for an admin to approve.',
                  '关闭后，成员发出的邀请要等管理员批准。',
                )}
              />
            ) : (
              <p className="text-sm text-fg-2">
                {g.invite_policy === 'open'
                  ? t('Members can invite people directly.', '成员可以直接邀请人。')
                  : t('Invitations from members need an admin’s approval.', '成员发出的邀请需要管理员批准。')}
              </p>
            )}
            <AdminReadDisclosure />
          </Panel>
          <HistoryVisibility group={g} isOwner={mine.role === 'owner'} act={act} />
          <Panel tone="danger" title={t('Leave the group', '退出群组')}>
            {mine.role === 'owner' ? (
              <p className="text-sm text-muted">
                {t(
                  'To leave, first transfer ownership to a member under Members.',
                  '群主要退群，先在「成员」里把群主转让给一位成员。',
                )}
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 text-sm text-muted">
                  {t(
                    'You will no longer see its messages; files already downloaded stay where they are.',
                    '之后看不到本群消息；已下载的文件不受影响。',
                  )}
                </p>
                <Button
                  variant="danger"
                  disabled={leave.isPending}
                  onClick={() => {
                    if (
                      confirm(
                        t(
                          'Leave the group? You will no longer see its messages; files already downloaded stay where they are.',
                          '退出群组？之后看不到本群消息；已下载的文件不受影响。',
                        ),
                      )
                    )
                      leave.mutate();
                  }}
                >
                  {t('Leave group', '退出群组')}
                </Button>
              </div>
            )}
            {leave.isError ? <ErrorBox error={leave.error} /> : null}
          </Panel>
        </div>
      ) : null}
    </div>,
  );
}

/**
 * Name and #slug (the pane's heading), who is in it and one action. Somebody who has not accepted yet gets no
 * roster, so the avatar stack only shows for members.
 */
function GroupHeader({ group, action }: { group: GroupDetail; action?: ReactNode }) {
  const t = useT();
  const faces = group.members.filter((m) => m.status === 'active').slice(0, 5);
  return (
    <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <GroupGlyph size={40} />
        <div className="min-w-0 space-y-1">
          <h2 className="break-words text-lg font-semibold text-fg">
            {group.display_name} <span className="text-sm font-normal text-muted">#{group.slug}</span>
          </h2>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted">
            {faces.length > 0 ? (
              <span className="flex -space-x-1.5" aria-hidden="true">
                {faces.map((m) => (
                  <span key={m.membership_id} className="rounded-full ring-2 ring-bg">
                    <Avatar name={m.display_label} seed={m.handle} size={24} />
                  </span>
                ))}
              </span>
            ) : null}
            <span>{memberCount(t, group.active_member_count)}</span>
            {group.description ? <span className="min-w-0 break-words">· {group.description}</span> : null}
          </div>
          {group.history_visible !== undefined ? (
            <p className="text-xs text-dim">{historyStatus(t, group.history_visible)}</p>
          ) : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

/** Owners and admins rename the group and change its #slug; both follow the server's caps. */
function GroupIdentityField({ group, onDone }: { group: GroupDetail; onDone: () => void }) {
  const t = useT();
  const slugErrorId = useId();
  const [name, setName] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api.patch<GroupDetail>(`/v1/me/groups/${group.group_id}`, {
        ...(name?.trim() && name.trim() !== group.display_name ? { display_name: name.trim() } : {}),
        ...(slug?.trim() && slug.trim().toLowerCase() !== group.slug
          ? { slug: slug.trim().toLowerCase() }
          : {}),
      }),
    onSuccess: () => {
      setName(null);
      setSlug(null);
      onDone();
    },
  });
  const slugProblem =
    save.error instanceof ApiFailure &&
    save.error.body.code === 'VALIDATION_FAILED' &&
    save.error.body.details?.field === 'slug'
      ? /in use/.test(save.error.body.message)
        ? t(
            'Another group already uses this slug. Choose a different one.',
            '这个短代码已被其他群组使用，请换一个。',
          )
        : t(
            'A slug has 2–32 characters: lowercase letters, digits, “-” or “_”, starting with a letter or digit.',
            '短代码 2–32 个字符：小写字母、数字、“-”或“_”，以字母或数字开头。',
          )
      : null;
  const changed = name !== null || slug !== null;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('Group name', '群名')} hint={t('Every member sees it.', '所有成员都看得到。')}>
          <Input
            value={name ?? group.display_name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
          />
        </Field>
        <Field
          label={t('Slug', '短代码')}
          hint={t(
            'Used as #slug when sending. Lowercase letters, digits, “-” or “_”; unique on this server.',
            '发消息时用作 #短代码。小写字母、数字、“-”或“_”，在本服务器上唯一。',
          )}
        >
          <Input
            value={slug ?? group.slug}
            onChange={(e) => setSlug(e.target.value)}
            maxLength={32}
            aria-invalid={slugProblem ? true : undefined}
            aria-describedby={slugProblem ? slugErrorId : undefined}
          />
        </Field>
      </div>
      {slugProblem ? (
        <p id={slugErrorId} role="alert" className="text-sm text-danger">
          {slugProblem}
        </p>
      ) : save.isError ? (
        <ErrorBox error={save.error} />
      ) : null}
      <div className="flex justify-end">
        <Button disabled={!changed || save.isPending} onClick={() => save.mutate()}>
          {t('Save', '保存')}
        </Button>
      </div>
    </div>
  );
}

function NicknameField({
  groupId,
  nickname,
  act,
}: {
  groupId: string;
  nickname: string | null;
  act: { mutate: (fn: () => Promise<unknown>) => void };
}) {
  const t = useT();
  const [value, setValue] = useState<string | null>(null);
  return (
    <Panel
      title={t('My name in this group', '我在群里的名字')}
      description={t('Only group members see it.', '只有群成员看得到。')}
    >
      <div className="flex gap-2">
        <Input
          aria-label={t('My name in this group', '我在群里的名字')}
          value={value ?? nickname ?? ''}
          onChange={(e) => setValue(e.target.value)}
          maxLength={64}
        />
        <Button
          className="h-9"
          disabled={value === null}
          onClick={() => {
            act.mutate(() => api.patch(`/v1/me/groups/${groupId}/me`, { nickname: value || null }));
            setValue(null);
          }}
        >
          {t('Save', '保存')}
        </Button>
      </div>
    </Panel>
  );
}

/**
 * Promoting or demoting an admin stays a visible button (the common, reversible change); handing over ownership
 * and removing somebody sit in the row's menu, each behind a confirmation.
 */
function MemberActions({
  groupId,
  member: m,
  iAmOwner,
  act,
}: {
  groupId: string;
  member: GroupDetail['members'][number];
  iAmOwner: boolean;
  act: { mutate: (fn: () => Promise<unknown>) => void };
}) {
  const t = useT();
  // Roles and ownership only apply to somebody who has accepted; the server knows no one else.
  const roles = iAmOwner && m.status === 'active';
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {roles ? (
        <Button
          variant="ghost"
          onClick={() =>
            act.mutate(() =>
              api.patch(`/v1/me/groups/${groupId}/members/${m.user_id}`, {
                role: m.role === 'admin' ? 'member' : 'admin',
              }),
            )
          }
        >
          {m.role === 'admin' ? t('Remove admin', '取消管理员') : t('Make admin', '设为管理员')}
        </Button>
      ) : null}
      <Menu
        label={t(`Actions for ${m.display_label}`, `对 ${m.display_label} 的操作`)}
        items={[
          roles
            ? {
                label: t('Make owner', '转让群主'),
                onSelect: () => {
                  if (
                    confirm(
                      t(
                        `Transfer ownership to ${m.display_label}? You will become an admin.`,
                        `把群主转让给 ${m.display_label}？转让后你会变成管理员。`,
                      ),
                    )
                  )
                    act.mutate(() =>
                      api.patch(`/v1/me/groups/${groupId}/members/${m.user_id}`, { role: 'owner' }),
                    );
                },
              }
            : null,
          {
            label: m.status === 'invited' ? t('Withdraw', '撤回邀请') : t('Remove', '移除'),
            danger: true,
            onSelect: () => {
              const ask =
                m.status === 'invited'
                  ? t(`Withdraw the invitation to ${m.display_label}?`, `撤回对 ${m.display_label} 的邀请？`)
                  : t(`Remove ${m.display_label}?`, `移除 ${m.display_label}？`);
              if (confirm(ask))
                act.mutate(() => api.post(`/v1/me/groups/${groupId}/members/${m.user_id}/remove`));
            },
          },
        ]}
      />
    </div>
  );
}

/** "Files: 1.2 GB of 2 GB" and a bar; warns from 90 % (ADR 0029). Every member sees it. */
function StorageBar({ storage }: { storage: { used_bytes: number; limit_bytes: number } }) {
  const t = useT();
  const share = storage.limit_bytes > 0 ? storage.used_bytes / storage.limit_bytes : 0;
  const percent = Math.min(100, Math.round(share * 100));
  const warn = share >= 0.9;
  const used = formatBytes(storage.used_bytes);
  const limit = formatBytes(storage.limit_bytes);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className={warn ? 'font-medium text-warn' : 'text-fg-2'}>
          {t(`Files: ${used} of ${limit}`, `文件：已用 ${used}，共 ${limit}`)}
        </span>
        <span className="text-xs tabular-nums text-dim">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={t('Group file space used', '群文件空间用量')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={t(`${used} of ${limit}`, `已用 ${used}，共 ${limit}`)}
        className="h-2 overflow-hidden rounded-full bg-hover"
      >
        <div
          className={`h-full rounded-full ${warn ? 'bg-warn' : 'bg-accent'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/**
 * The Files tab: the group's used space for every member, and for the owner and admins the stored files, largest
 * first, each removable for everyone (the message stays; ADR 0029). Senders are named as the viewer knows them.
 */
function GroupFiles({
  group,
  storage,
  isAdmin,
  onChanged,
}: {
  group: GroupDetail;
  storage: { used_bytes: number; limit_bytes: number };
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const { currentH } = useSession();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const files = useQuery({
    queryKey: ['group', group.group_id, 'files'],
    queryFn: () => api.get<GroupFilesResult>(`/v1/me/groups/${group.group_id}/files`),
    enabled: isAdmin,
  });
  const remove = useMutation({
    mutationFn: (attachmentId: string) =>
      api.delete<{ removed: true; freed_bytes: number }>(
        `/v1/me/groups/${group.group_id}/files/${encodeURIComponent(attachmentId)}`,
      ),
    onSuccess: (res) => {
      setNotice(
        t(
          `Removed · freed ${formatBytes(res.freed_bytes)}`,
          `已移除 · 释放了 ${formatBytes(res.freed_bytes)}`,
        ),
      );
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setNotice(null), 6_000);
      onChanged();
      qc.invalidateQueries({ queryKey: ['mailbox'] });
    },
  });
  const shown = files.data?.storage ?? storage;
  return (
    <div className="space-y-5">
      <Panel
        title={t('File space', '文件空间')}
        description={t(
          'Files sent to this group count here until they are removed. When it is full, messages with files are refused; text still goes through.',
          '发到本群的文件会一直计入这里，直到被移除。满了以后带文件的消息会被拒收，纯文字照常发送。',
        )}
      >
        <StorageBar storage={shown} />
        {isAdmin ? null : (
          <p className="text-sm text-muted">
            {t('Only the owner and admins can remove files.', '只有群主和管理员可以移除文件。')}
          </p>
        )}
      </Panel>
      {isAdmin ? (
        <Panel
          title={t('Stored files', '已存的文件')}
          description={t(
            'Largest first. Removing a file frees space for everyone; the message stays and shows the file as removed.',
            '按大小排列。移除文件会为全群腾出空间；消息还在，文件显示为已移除。',
          )}
        >
          {notice ? (
            <p
              role="status"
              className="rounded-lg border border-ok-line bg-ok-bg px-3 py-2 text-sm font-medium text-ok"
            >
              {notice}
            </p>
          ) : null}
          {remove.isError ? <ErrorBox error={remove.error} /> : null}
          {files.isLoading ? <Loading /> : null}
          {files.isError ? <ErrorBox error={files.error} retry={() => files.refetch()} /> : null}
          {files.data && files.data.files.length === 0 ? (
            <p className="text-sm text-muted">
              {t('No files are stored for this group.', '本群没有存储的文件。')}
            </p>
          ) : null}
          {files.data && files.data.files.length >= 200 ? (
            <p className="text-xs text-dim">
              {t('Showing the 200 largest files.', '只显示最大的 200 个文件。')}
            </p>
          ) : null}
          {files.data && files.data.files.length > 0 ? (
            <ul className="-mx-5 -mb-5 border-t border-line">
              {files.data.files.map((file) => (
                <li
                  key={file.attachment_id}
                  className="flex min-w-0 items-center gap-3 border-b border-line px-5 py-3 last:border-b-0"
                >
                  <FileText size={16} className="shrink-0 text-muted" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    {/* the name downloads the file through the message it came with; with no agent, open the message */}
                    {currentH ? (
                      <a
                        className="block truncate text-sm font-medium text-fg underline-offset-2 hover:text-accent-fg hover:underline"
                        href={mailboxUrl(
                          currentH.h_id,
                          `/drops/${encodeURIComponent(file.drop_id)}/attachments/${encodeURIComponent(file.attachment_id)}`,
                        )}
                        download
                        title={t(`Download ${file.safe_name}`, `下载 ${file.safe_name}`)}
                      >
                        <span className="untrusted">{file.safe_name}</span>
                      </a>
                    ) : (
                      <NavLink
                        className="block truncate text-sm font-medium text-fg underline-offset-2 hover:text-accent-fg hover:underline"
                        to={`/app/inbox/${encodeURIComponent(file.drop_id)}?group=${group.group_id}`}
                        title={file.safe_name}
                      >
                        <span className="untrusted">{file.safe_name}</span>
                      </NavLink>
                    )}
                    <div className="truncate text-xs text-muted">
                      {formatBytes(file.byte_size)} · <span className="untrusted">{file.from_label}</span> ·{' '}
                      <NavLink
                        className="underline-offset-2 hover:text-fg hover:underline"
                        to={`/app/inbox/${encodeURIComponent(file.drop_id)}?group=${group.group_id}`}
                        title={t(
                          `Open the message · ${f.dateTime(file.sent_at)}`,
                          `打开这条消息 · ${f.dateTime(file.sent_at)}`,
                        )}
                      >
                        {f.short(file.sent_at)}
                      </NavLink>
                    </div>
                  </div>
                  <IconButton
                    label={t(`Remove ${file.safe_name}`, `移除 ${file.safe_name}`)}
                    disabled={remove.isPending}
                    onClick={() => {
                      if (
                        confirm(
                          t(
                            'Remove this file for everyone in the group? The message stays.',
                            '为群里所有人移除这个文件？消息会保留。',
                          ),
                        )
                      )
                        remove.mutate(file.attachment_id);
                    }}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}

/** A Panel whose body opens on demand, for secondary tools such as exports. */
function DisclosurePanel({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="card group rounded-xl border border-line">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-5 py-4 text-base font-semibold text-fg hover:bg-hover [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={16}
          aria-hidden="true"
          className="shrink-0 text-muted transition-transform group-open:rotate-90"
        />
        {summary}
      </summary>
      <div className="px-5 pb-5">{children}</div>
    </details>
  );
}

/**
 * Date-ranged download of this group's timeline.
 *
 * The response is NDJSON behind `Content-Disposition: attachment`, which `api` cannot read, so `downloadExport`
 * fetches it with the session cookie and saves it under the server's filename. A server refusal (too many
 * drops, rate limit, expired session) is shown here instead of being saved to disk.
 *
 * `include_group_history` is the same explicit opt-in as the 「查看本群全部消息」 toggle above, and carries the
 * same framing: read-only, audited as its own action, and offered to an owner/admin only. The server enforces
 * all three — it also refuses the flag outright for an agent credential — so hiding the box from a plain member
 * is a matter of not offering what they cannot have, not a control.
 */
function GroupExport({
  hId,
  groupId,
  isAdmin,
  agentLabel,
  crossAgent,
}: {
  hId: string;
  groupId: string;
  isAdmin: boolean;
  agentLabel: string;
  crossAgent: boolean;
}) {
  const t = useT();
  const uid = useId();
  const [range, setRange] = useState(defaultExportRange);
  const [wholeHistory, setWholeHistory] = useState(false);
  const period = exportDayRange(range.from, range.to);
  const history = wholeHistory && isAdmin;
  const download = useMutation({
    mutationFn: (p: { since: string; until: string; history: boolean }) =>
      downloadExport(hId, {
        scope: 'group',
        group_id: groupId,
        since: p.since,
        until: p.until,
        include_body: true,
        ...(p.history ? { include_group_history: true } : {}),
      }),
  });
  // The admin history covers the whole group, so which of my agents received what stops being the question.
  const reach = history
    ? ''
    : crossAgent
      ? t('Covers every agent on your account.', '涵盖你账号下的所有 Agent。')
      : t(`Covers only the current agent “${agentLabel}”.`, `只涵盖当前 Agent「${agentLabel}」。`);

  return (
    <div className="space-y-3">
      <p className="text-sm leading-5 text-muted">
        {history
          ? t('Messages of the chosen days, with bodies.', '所选日期内的消息，含正文。')
          : t(
              'Messages of the chosen days that reached your agents, with bodies.',
              '所选日期内投递到你的 Agent 的消息，含正文。',
            )}
      </p>
      {isAdmin ? (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-fg-2">
          <input type="checkbox" checked={wholeHistory} onChange={(e) => setWholeHistory(e.target.checked)} />
          {t('Export full history (admin)', '导出全部历史（管理员）')}
        </label>
      ) : null}
      {history ? (
        <p className="rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-xs leading-5 text-warn">
          {t(
            'Includes messages you never received; this export is recorded in the audit log.',
            '包含你没收到过的消息；这次导出会记入审计日志。',
          )}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-42 space-y-1.5">
          <label htmlFor={`${uid}-from`} className="block text-sm font-medium text-fg-2">
            {t('Start date', '开始日期')}
          </label>
          <Input
            id={`${uid}-from`}
            type="date"
            value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
        </div>
        <div className="w-42 space-y-1.5">
          <label htmlFor={`${uid}-to`} className="block text-sm font-medium text-fg-2">
            {t('End date', '结束日期')}
          </label>
          <Input
            id={`${uid}-to`}
            type="date"
            value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
        </div>
        <Button
          className="h-9"
          disabled={!period || download.isPending}
          onClick={() => {
            if (period) download.mutate({ ...period, history });
          }}
        >
          <Download size={14} aria-hidden="true" />
          {download.isPending ? t('Exporting…', '正在导出…') : t('Download .jsonl', '下载 .jsonl')}
        </Button>
      </div>
      {download.isError ? <ErrorBox error={download.error} /> : null}
      {period ? (
        <p className="text-xs leading-5 text-dim">
          {t('Both dates included; one JSON object per line. ', '含首尾两天；每行一条 JSON。')}
          {reach}
        </p>
      ) : (
        <p className="text-xs leading-5 text-warn">
          {t(
            `The end date cannot be before the start date, and the span cannot exceed ${EXPORT_MAX_DAYS} days; export longer periods in parts.`,
            `结束日期不能早于开始日期，跨度也不能超过 ${EXPORT_MAX_DAYS} 天；更长的区间请分段导出。`,
          )}
        </p>
      )}
    </div>
  );
}

/** Every active member may invite; whether that lands as an invitation or a request depends on the policy. */
function InviteBox({ group, isAdmin, onDone }: { group: GroupDetail; isAdmin: boolean; onDone: () => void }) {
  const t = useT();
  const errorId = useId();
  const [raw, setRaw] = useState('');
  const [result, setResult] = useState<InviteOutcome[] | null>(null);
  const needsApproval = group.invite_policy === 'admin_approval' && !isAdmin;
  const invite = useMutation({
    mutationFn: (handles: string[]) =>
      api.post<GroupDetail>(`/v1/me/groups/${group.group_id}/invite`, { handles }),
    onSuccess: (res) => {
      setResult(res.invites ?? []);
      setRaw('');
      onDone();
    },
  });
  const handles = parseHandles(raw);
  const label = needsApproval
    ? t('Request to invite new members', '申请邀请新成员')
    : t('Invite new members', '邀请新成员');
  return (
    <Panel title={label}>
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (handles.length > 0) invite.mutate(handles);
        }}
      >
        <HandleField
          label={label}
          hideLabel
          value={raw}
          onChange={(next) => {
            setRaw(next);
            setResult(null);
          }}
          placeholder={t('@wang @li, separated by spaces or commas', '@wang @li，用空格或逗号分隔')}
          hint={
            needsApproval
              ? t(
                  'An admin approves your invitation first; until then the person is not told.',
                  '需要管理员先批准；批准前对方不会收到邀请。',
                )
              : t('Each person joins once they accept.', '对方接受后才算入群。')
          }
          errorId={invite.isError && handlesProblem(invite.error) ? errorId : undefined}
          action={
            <Button type="submit" className="h-9" disabled={handles.length === 0 || invite.isPending}>
              {needsApproval ? t('Submit invite request', '提交邀请申请') : t('Invite', '邀请')}
            </Button>
          }
        />
        {invite.isError ? <InviteError error={invite.error} id={errorId} /> : null}
        {result ? (
          <div className="space-y-1.5 rounded-lg border border-line bg-surface-2 p-3">
            <InviteOutcomes invites={result} />
            {result.some((r) => r.outcome === 'requested') ? (
              <p className="text-xs text-warn">{t('Waiting for an admin to approve.', '等待管理员批准。')}</p>
            ) : null}
          </div>
        ) : null}
      </form>
    </Panel>
  );
}

/** Admin-only queue: approving admits somebody to every other member's mailbox, so only a person decides it. */
function JoinRequests({ group, onDone }: { group: GroupDetail; onDone: () => void }) {
  const t = useT();
  const f = useFormat();
  const decide = useMutation({
    mutationFn: (v: { userId: string; decision: 'approve' | 'reject' }) =>
      api.post(`/v1/me/groups/${group.group_id}/requests/${v.userId}/decide`, { decision: v.decision }),
    onSuccess: onDone,
  });
  if (group.join_requests.length === 0) return null;
  return (
    <Panel
      tone="warn"
      title={t(
        `Join requests awaiting approval (${group.join_requests.length})`,
        `待批准的入群申请（${group.join_requests.length}）`,
      )}
      description={t('Approving sends them an invitation.', '批准后对方会收到邀请。')}
    >
      <ul className="-mx-5 -mb-5 border-t border-line">
        {group.join_requests.map((r) => (
          <li
            key={r.invitee_user_id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-5 py-3 last:border-b-0"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Avatar name={r.invitee_display_name || r.invitee_handle} seed={r.invitee_handle} />
              <div className="min-w-0">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate text-sm font-medium text-fg">
                    {r.invitee_display_name || `@${r.invitee_handle}`}
                  </span>
                  <span className="truncate text-sm text-muted">@{r.invitee_handle}</span>
                </div>
                <div className="truncate text-xs text-dim">
                  {t(`Requested by @${r.invited_by_handle}`, `由 @${r.invited_by_handle} 提出`)} ·{' '}
                  <span title={f.dateTime(r.created_at)}>{f.short(r.created_at)}</span>
                </div>
              </div>
            </div>
            <div className="ml-auto flex gap-1.5">
              <Button
                variant="primary"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ userId: r.invitee_user_id, decision: 'approve' })}
              >
                {t('Approve', '批准')}
              </Button>
              <Button
                disabled={decide.isPending}
                onClick={() => decide.mutate({ userId: r.invitee_user_id, decision: 'reject' })}
              >
                {t('Reject', '拒绝')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {decide.isError ? <ErrorBox error={decide.error} /> : null}
    </Panel>
  );
}

/**
 * Shown to somebody who has not accepted yet. They deliberately do not get the roster, so this panel relies on
 * the group name, who invited them and the member count only.
 */
function InviteAccept({
  group,
  endpoints,
  onDone,
  onGone,
}: {
  group: GroupDetail;
  endpoints: Array<{ h_id: string; label: string; device: { label: string }; is_default_receiver: boolean }>;
  onDone: () => void;
  /** After declining: the group is no longer visible to me. */
  onGone: () => void;
}) {
  const t = useT();
  const [receiveAll, setReceiveAll] = useState(true);
  const [hIds, setHIds] = useState<string[]>(
    endpoints.filter((e) => e.is_default_receiver).map((e) => e.h_id),
  );
  const accept = useMutation({
    mutationFn: () =>
      api.post(
        `/v1/me/groups/${group.group_id}/accept`,
        receiveAll ? { receive_all: true } : { receive_all: false, h_ids: hIds },
      ),
    onSuccess: onDone,
  });
  const decline = useMutation({
    mutationFn: () => api.post(`/v1/me/groups/${group.group_id}/decline`),
    // Once declined the group is no longer visible to me, so refetching it would only report NOT_FOUND.
    onSuccess: onGone,
  });
  return (
    <Panel
      tone="warn"
      title={
        group.invited_by_handle
          ? t(
              `@${group.invited_by_handle} invited you to this group.`,
              `@${group.invited_by_handle} 邀请你加入这个群。`,
            )
          : t('You are invited to this group.', '你被邀请加入这个群。')
      }
      actions={<Chip tone="warn">{t('Invitation', '待回应邀请')}</Chip>}
    >
      <FieldGroup label={t('Receive it with:', '用哪些 Agent 接收：')}>
        <ReceivePicker
          name={`accept-${group.group_id}`}
          all={receiveAll}
          hIds={hIds}
          endpoints={endpoints}
          onChange={(all, next) => {
            setReceiveAll(all);
            setHIds(next);
          }}
        />
      </FieldGroup>
      <AdminReadDisclosure />
      {endpoints.length === 0 ? <NeedsAgentNote what="join" /> : null}
      <div className="flex gap-2">
        <Button
          variant="primary"
          className="h-9"
          disabled={(receiveAll ? endpoints.length === 0 : hIds.length === 0) || accept.isPending}
          onClick={() => accept.mutate()}
        >
          {t('Join', '加入')}
        </Button>
        <Button className="h-9" disabled={decline.isPending} onClick={() => decline.mutate()}>
          {t('Decline', '拒绝')}
        </Button>
      </div>
      {accept.isError ? <ErrorBox error={accept.error} /> : null}
      {decline.isError ? <ErrorBox error={decline.error} /> : null}
    </Panel>
  );
}

/**
 * "All my agents" (the default, and it includes agents paired later) or an explicit selection. Picking "only
 * selected" keeps the agents that receive now, so switching modes never silently drops an agent.
 */
function ReceivePicker({
  name,
  all,
  hIds,
  endpoints,
  onChange,
}: {
  name: string;
  all: boolean;
  hIds: string[];
  endpoints: Array<{ h_id: string; label: string; device: { label: string } }>;
  onChange: (all: boolean, hIds: string[]) => void;
}) {
  const t = useT();
  const option = (on: boolean) =>
    `flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
      on ? 'border-accent/40 bg-selected' : 'border-line hover:bg-hover'
    }`;
  return (
    <div className="space-y-2">
      <label className={option(all)}>
        <input type="radio" name={name} className="mt-1" checked={all} onChange={() => onChange(true, [])} />
        <span className="min-w-0">
          <span className="font-medium text-fg">{t('All my agents', '我的所有 Agent')}</span>{' '}
          <span className="text-xs text-accent-fg">{t('Recommended', '推荐')}</span>
          <span className="block text-xs text-muted">
            {t(
              `Including agents you pair later (${endpoints.length} now).`,
              `包括之后新配对的 Agent（当前 ${endpoints.length} 个）。`,
            )}
          </span>
        </span>
      </label>
      <label className={option(!all)}>
        <input
          type="radio"
          name={name}
          className="mt-1"
          checked={!all}
          onChange={() => onChange(false, hIds.length > 0 ? hIds : endpoints.map((e) => e.h_id))}
        />
        <span className="min-w-0">
          <span className="font-medium text-fg">{t('Only selected agents', '只用选中的 Agent')}</span>
          <span className="block text-xs text-muted">
            {t('Agents you pair later do not join this group.', '之后新配对的 Agent 不会加入这个群。')}
          </span>
        </span>
      </label>
      {!all ? (
        <div className="space-y-0.5 pl-7">
          {endpoints.map((e) => (
            <label
              key={e.h_id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg hover:bg-hover"
            >
              <input
                type="checkbox"
                checked={hIds.includes(e.h_id)}
                onChange={(ev) =>
                  onChange(false, ev.target.checked ? [...hIds, e.h_id] : hIds.filter((x) => x !== e.h_id))
                }
              />
              <span className="min-w-0 truncate">{e.label}</span>
              <span className="min-w-0 truncate text-dim">{e.device.label}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
