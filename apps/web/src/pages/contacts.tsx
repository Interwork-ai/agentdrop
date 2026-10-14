import type { DirectoryLookupResult } from '@agentdrop/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Download, Link2, Send, UserPlus, Users, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import {
  api,
  type Contact,
  type CreatedInviteLink,
  defaultExportRange,
  downloadExport,
  EXPORT_MAX_DAYS,
  exportDayRange,
  type InviteLink,
  mailboxUrl,
} from '../lib/api.js';
import { humanInviteError } from '../lib/error-text.js';
import { plural, useFormat } from '../lib/format.js';
import { type Translate, useT } from '../lib/lang.js';
import { isAssistant, personName } from '../lib/people.js';
import { useSession } from '../lib/session.js';
import { usePanelFocus } from '../ui/focus.js';
import {
  Avatar,
  Chip,
  EmptyState,
  IconButton,
  ListLabel,
  listRowClass,
  PageToolbar,
  Panel,
  SplitView,
} from '../ui/layout.jsx';
import { NeedsAgentNote } from '../ui/needs-agent.jsx';
import { Button, copyText, ErrorBox, Input, Loading, PublicEmail } from '../ui/primitives.jsx';

/** The name a person sees for a contact: their own private note first, then the contact's nickname. */
/** The built-in assistant's name in the reader's language (lib/people.ts); everyone else as stored. */
function withAssistantName(data: { contacts: Contact[] }, t: Translate): { contacts: Contact[] } {
  if (!data.contacts.some(isAssistant)) return data;
  return {
    contacts: data.contacts.map((c) =>
      isAssistant(c) ? { ...c, display_name: personName(c, c.display_name, t) } : c,
    ),
  };
}

const contactLabel = (c: Contact) => c.remark || c.display_name || `@${c.handle}`;

/** The one status chip of a contact, or nothing for an ordinary accepted contact. */
function StatusChip({ c, t }: { c: Contact; t: Translate }) {
  if (c.is_system && c.status === 'accepted')
    return <Chip tone="accent">{t('Test assistant', '测试助手')}</Chip>;
  if (c.status === 'requested') return <Chip tone="warn">{t('Awaiting my acceptance', '待我接受')}</Chip>;
  if (c.status === 'invited') return <Chip>{t('Invited', '已邀请')}</Chip>;
  if (c.status === 'blocked') return <Chip tone="danger">{t('Blocked', '已屏蔽')}</Chip>;
  if (c.status === 'group_only') return <Chip>{t('Via a group', '经由群组')}</Chip>;
  return null;
}

export function ContactsPage() {
  const qc = useQueryClient();
  const params = useParams();
  const nav = useNavigate();
  const t = useT();
  const { me } = useSession();
  // contacts need somewhere to deliver; the server refuses the same actions (AGENT_REQUIRED)
  const noAgent = !(me?.endpoints ?? []).some((e) => !e.revoked_at);
  const contacts = useQuery({
    queryKey: ['contacts'],
    queryFn: () => api.get<{ contacts: Contact[] }>('/v1/me/contacts'),
    select: (data) => withAssistantName(data, t),
  });
  /** Accepting is a dedicated route; declining and withdrawing both delete the pair, like the agent's decline. */
  const respond = useMutation({
    mutationFn: ({ userId, accept }: { userId: string; accept: boolean }) =>
      accept ? api.post(`/v1/me/contacts/${userId}/accept`) : api.delete(`/v1/me/contacts/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts'] }),
  });
  const selected = params.userId ?? null;
  const list = contacts.data?.contacts ?? [];
  // requests are the thing you have to act on, so they get their own sections instead of a badge in a long list
  const incoming = list.filter((c) => c.status === 'requested');
  const outgoing = list.filter((c) => c.status === 'invited');
  const established = list.filter((c) => c.status === 'accepted' || c.status === 'group_only');
  const blocked = list.filter((c) => c.status === 'blocked');
  // the built-in @agentdrop assistant does not count: until a real person is here, point at the invite link
  const noPeople = !!contacts.data && list.every((c) => c.is_system);
  // The invite panel starts open for somebody with nobody to talk to yet, closed otherwise; after that it is theirs.
  // Without an agent nobody can be invited, so the panel stays closed and its buttons are not offered at all.
  const [inviteOpen, setInviteOpen] = useState<boolean | null>(null);
  if (inviteOpen === null && contacts.data) setInviteOpen(noPeople && !noAgent);
  // opened from the toolbar: the handle field takes the focus; opened by default it does not steal it
  const [focusInvite, setFocusInvite] = useState(false);
  // closing the panel puts focus back on the toolbar's "Invite", which comes back once the panel is gone
  const inviteButton = useRef<HTMLButtonElement>(null);
  const [returnFocus, setReturnFocus] = useState(false);
  useEffect(() => {
    if (!inviteOpen && returnFocus) {
      inviteButton.current?.focus();
      setReturnFocus(false);
    }
  }, [inviteOpen, returnFocus]);

  const listPane = (
    <>
      <PageToolbar
        title={t('Contacts', '联系人')}
        actions={
          // while the panel is open its own "Invite" button is the one to press, so this one steps aside
          inviteOpen || noAgent ? null : (
            <Button
              ref={inviteButton}
              aria-expanded={false}
              onClick={() => {
                setFocusInvite(true);
                setInviteOpen(true);
              }}
            >
              <UserPlus size={14} aria-hidden="true" />
              {t('Invite', '邀请')}
            </Button>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {inviteOpen && !noAgent ? (
          <InvitePanel
            autoFocus={focusInvite}
            onClose={() => {
              setReturnFocus(true);
              setInviteOpen(false);
            }}
          />
        ) : null}
        {contacts.isLoading ? <Loading /> : null}
        {contacts.isError ? <ErrorBox error={contacts.error} retry={() => contacts.refetch()} /> : null}

        {incoming.length > 0 ? (
          <section>
            <ListLabel>
              <span className="inline-flex items-center gap-1.5 text-warn">
                <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true" />
                {t(`Requests received (${incoming.length})`, `收到的申请（${incoming.length}）`)}
              </span>
            </ListLabel>
            <div className="space-y-2 px-3 pb-3">
              {noAgent ? <NeedsAgentNote what="contacts" /> : null}
              {incoming.map((c) => (
                <div
                  key={c.user_id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warn-line bg-surface-2 p-3"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar name={c.display_name} seed={c.handle} />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-fg">{c.display_name}</div>
                      <div className="truncate text-xs text-muted">@{c.handle}</div>
                      {c.from_invite_link && noAgent ? (
                        <div className="text-xs text-dim">
                          {t(
                            'From an invite link you opened: you become contacts as soon as you pair an agent.',
                            '来自你打开的邀请链接：配对 Agent 后自动成为联系人。',
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="ml-auto flex gap-1.5">
                    <Button
                      variant="primary"
                      disabled={respond.isPending || noAgent}
                      onClick={() => respond.mutate({ userId: c.user_id, accept: true })}
                    >
                      {t('Accept', '接受')}
                    </Button>
                    <Button
                      disabled={respond.isPending}
                      onClick={() => respond.mutate({ userId: c.user_id, accept: false })}
                    >
                      {t('Decline', '拒绝')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {outgoing.length > 0 ? (
          <section>
            <ListLabel>
              {t(`Invitations sent (${outgoing.length})`, `我发出的邀请（${outgoing.length}）`)}
            </ListLabel>
            {outgoing.map((c) => (
              <div key={c.user_id} className="flex items-center gap-3 border-b border-line px-4 py-3">
                <Avatar name={c.display_name} seed={c.handle} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-sm font-medium text-fg">{c.display_name}</span>
                    <span className="truncate text-sm text-muted">@{c.handle}</span>
                  </div>
                  <div className="truncate text-xs text-dim">
                    {c.from_invite_link
                      ? t(
                          'Opened your invite link: connected as soon as they set up an agent',
                          '已打开你的邀请链接：对方配对 Agent 后自动成为联系人',
                        )
                      : t('Waiting for them to accept', '等待对方同意')}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  disabled={respond.isPending}
                  onClick={() => respond.mutate({ userId: c.user_id, accept: false })}
                >
                  {t('Withdraw', '撤回')}
                </Button>
              </div>
            ))}
          </section>
        ) : null}
        {respond.isError ? <ErrorBox error={respond.error} /> : null}

        {established.length > 0 ? (
          <section>
            <ListLabel>{t(`Contacts (${established.length})`, `联系人（${established.length}）`)}</ListLabel>
            {established.map((c) => (
              <ContactRow key={c.user_id} c={c} />
            ))}
          </section>
        ) : null}
        {blocked.length > 0 ? (
          <section>
            <ListLabel>{t(`Blocked (${blocked.length})`, `已屏蔽（${blocked.length}）`)}</ListLabel>
            {blocked.map((c) => (
              <ContactRow key={c.user_id} c={c} />
            ))}
          </section>
        ) : null}

        {noAgent ? null : <InviteLinks />}
        {noPeople ? (
          <EmptyState
            icon={<Users size={20} />}
            title={t('No people in your contacts yet', '还没有真人联系人')}
          >
            {noAgent
              ? t(
                  'Contacts are the people you exchange messages with. Once your first agent is paired, you can invite colleagues here by link or @handle.',
                  '联系人就是和你互发消息的人。配对第一个 Agent 之后，就能在这里用链接或 @handle 邀请同事。',
                )
              : t(
                  'Create an invite link above and send it to a colleague: once they sign up and pair an agent, you become contacts. You can also invite someone by @handle; you can exchange messages after they accept. Want to try it first? Ask your agent to send something to @agentdrop and a receipt comes back within seconds.',
                  '生成上面的邀请链接发给同事：对方注册并配对 Agent 后，你们就成为联系人。也可以输入对方的 @handle 邀请，对方接受后才能互发。想先试试？让 Agent 发一条给 @agentdrop，几秒内会收到回执。',
                )}
          </EmptyState>
        ) : null}
      </div>
    </>
  );

  return (
    <SplitView
      listLabel={t('Contacts', '联系人')}
      showDetail={!!selected}
      list={listPane}
      detail={
        selected ? (
          <>
            <PageToolbar
              title={t('Contact', '联系人')}
              backLabel={t('Back to contacts', '返回联系人')}
              onBack={() => nav('/app/contacts')}
            />
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ContactDetail key={selected} userId={selected} onRemoved={() => nav('/app/contacts')} />
            </div>
          </>
        ) : (
          <EmptyState icon={<Users size={20} />} title={t('Select a contact', '选择一个联系人')}>
            {t(
              'Notes are visible only to you. Send to a person or a named entry they published.',
              '备注只你可见。可以发给对方本人，或对方发布的具名入口。',
            )}
          </EmptyState>
        )
      }
    />
  );
}

/** A contact in the list. The accessible name reads "label @handle email status", in that order. */
function ContactRow({ c }: { c: Contact }) {
  const t = useT();
  const label = contactLabel(c);
  return (
    <NavLink to={`/app/contacts/${c.user_id}`} className={({ isActive }) => listRowClass(isActive)}>
      <div className="flex items-center gap-3">
        <Avatar name={label} seed={c.handle} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-sm font-medium text-fg">{label}</span>
            <span className="truncate text-sm text-muted">@{c.handle}</span>
          </div>
          {c.public_email ? <div className="truncate text-xs text-dim">{c.public_email}</div> : null}
        </div>
        <span className="shrink-0">
          <StatusChip c={c} t={t} />
        </span>
      </div>
    </NavLink>
  );
}

function ContactDetail({ userId, onRemoved }: { userId: string; onRemoved: () => void }) {
  const qc = useQueryClient();
  const { me, currentH } = useSession();
  const t = useT();
  const nav = useNavigate();
  const contacts = useQuery({
    queryKey: ['contacts'],
    queryFn: () => api.get<{ contacts: Contact[] }>('/v1/me/contacts'),
    select: (data) => withAssistantName(data, t),
  });
  const c = contacts.data?.contacts.find((x) => x.user_id === userId);
  const dir = useQuery({
    queryKey: ['directory', currentH?.h_id, 'contact', c?.handle],
    queryFn: () =>
      api.get<DirectoryLookupResult>(
        mailboxUrl(
          currentH?.h_id ?? '',
          `/directory?query=${encodeURIComponent(`@${c?.handle}`)}&kind=person&limit=5`,
        ),
      ),
    enabled: !!currentH && !!c,
  });
  const card = dir.data?.entries.find((e) => e.kind === 'person' && e.user_id === userId);
  const [remark, setRemark] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch<Contact>(`/v1/me/contacts/${userId}`, { ...patch, expected_version: c?.version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['directory'] });
      setRemark(null);
    },
  });
  const action = useMutation({
    mutationFn: async (kind: 'accept' | 'remove' | 'block' | 'unblock') => {
      if (kind === 'accept') return api.post(`/v1/me/contacts/${userId}/accept`);
      if (kind === 'remove') return api.delete(`/v1/me/contacts/${userId}`);
      return api.post(`/v1/me/contacts/${userId}/block`, { blocked: kind === 'block' });
    },
    onSuccess: (_d, kind) => {
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['directory'] });
      if (kind === 'remove') onRemoved();
    },
  });
  if (contacts.isLoading) return <Loading />;
  if (!c) return <EmptyState icon={<Users size={20} />} title={t('Contact not found', '联系人不存在')} />;
  const label = contactLabel(c);
  const remarkValue = remark ?? c.remark ?? '';
  // Their published named entries only; their agents are never shown (ADR 0013).
  const entries = card?.kind === 'person' ? card.alternatives.filter((a) => !a.auto) : [];
  const remembered = entries.find((a) => a.route_id === c.preferred_route_id)?.route_id ?? null;
  const problem = c.preferred_route_id && card?.kind === 'person' ? card.preference_problem : null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-4 md:p-6">
      <header className="flex items-start gap-4">
        <Avatar name={label} seed={c.handle} size={56} />
        <div className="min-w-0 flex-1 space-y-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="min-w-0 break-words text-lg font-semibold text-fg">{label}</h2>
            <StatusChip c={c} t={t} />
          </div>
          <div className="text-sm text-muted">@{c.handle}</div>
          {c.remark && c.remark !== c.display_name ? (
            <div className="text-sm text-muted">
              {t('Public nickname: ', '公开昵称：')}
              <span className="text-fg-2">{c.display_name}</span>
            </div>
          ) : null}
          {c.public_email ? <PublicEmail email={c.public_email} /> : null}
        </div>
      </header>

      {c.status === 'requested' ? (
        <Panel tone="warn">
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-sm text-fg-2">
              {t('This person invited you to be a contact.', '对方邀请你成为联系人。')}
            </p>
            <div className="flex gap-1.5">
              <Button
                variant="primary"
                disabled={!(me?.endpoints ?? []).some((e) => !e.revoked_at)}
                onClick={() => action.mutate('accept')}
              >
                {t('Accept', '接受')}
              </Button>
              <Button onClick={() => action.mutate('remove')}>{t('Decline', '拒绝')}</Button>
            </div>
          </div>
        </Panel>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {c.status === 'accepted' && currentH ? (
          <Button
            variant="primary"
            onClick={() => nav(`/app/compose?to=${encodeURIComponent(`@${c.handle}`)}`)}
          >
            <Send size={14} aria-hidden="true" />
            {t('Send a message', '发消息')}
          </Button>
        ) : null}
        {c.status === 'blocked' ? (
          <Button onClick={() => action.mutate('unblock')}>{t('Unblock', '取消屏蔽')}</Button>
        ) : (
          <Button onClick={() => action.mutate('block')}>{t('Block', '屏蔽')}</Button>
        )}
        {/* somebody who only asked to connect is answered with Decline above; there is no contact to remove yet */}
        {c.status === 'requested' ? null : (
          <Button
            variant="danger"
            onClick={() => {
              if (
                confirm(
                  t(
                    'Remove this contact? Messages already delivered will not be recalled.',
                    '移除联系关系？已投递的消息不会被撤回。',
                  ),
                )
              )
                action.mutate('remove');
            }}
          >
            {t('Remove contact', '移除联系')}
          </Button>
        )}
      </div>
      {action.isError ? <ErrorBox error={action.error} /> : null}

      {c.is_system ? (
        <Panel title={t('Built-in test contact', '内置测试联系人')}>
          <p className="text-sm leading-6 text-fg-2">
            {t('Ask your agent to send anything to @', '让 Agent 发任何东西给 @')}
            {c.handle}
            {t(
              ' and a receipt (title, attachment names and sizes, body length) comes back within seconds. It does not send attachments back, and messages expire after 30 days. Remove or block it when you no longer need it; invite @',
              '，几秒内会收到一条回执（标题、附件名与大小、正文字数）；它不回传附件，往来消息 30 天后自动过期。不需要时可以移除或屏蔽，之后通过「邀请」输入 @',
            )}
            {c.handle}
            {t(' again to add it back.', ' 可以再加回来。')}
          </p>
        </Panel>
      ) : null}

      <Panel
        title={t('Private note', '仅我可见的备注')}
        description={t(
          'Never written into a message and never shown anywhere the contact can see. Clear it to show their nickname again.',
          '不写入消息、不出现在对方看到的任何地方；删除备注后回退显示昵称',
        )}
      >
        <div className="flex gap-2">
          <Input
            aria-label={t('Private note', '仅我可见的备注')}
            value={remarkValue}
            onChange={(e) => setRemark(e.target.value)}
            maxLength={64}
            placeholder={t('Alex · lab collaboration', '老王·实验合作')}
          />
          <Button
            className="h-9"
            disabled={remark === null || update.isPending}
            onClick={() => update.mutate({ remark: remarkValue })}
          >
            {t('Save', '保存')}
          </Button>
        </div>
      </Panel>

      {c.status === 'accepted' && (entries.length > 0 || problem) ? (
        <Panel
          title={t('Send to', '发给')}
          description={t(
            'They decide which of their agents receive what you send. A named entry is one they published; if it stops working, sending tells you instead of redirecting.',
            '对方决定投到自己哪个 Agent。具名入口是对方主动发布的；入口失效时，发送会明确提示，不会悄悄改投。',
          )}
        >
          <div role="radiogroup" aria-label={t('Send to', '发给')} className="space-y-1">
            <RouteOption
              checked={!remembered && !problem}
              onChange={() => update.mutate({ preferred_route_id: null })}
              label={t('The person (default)', '对方本人（默认）')}
              address={`@${c.handle}`}
            />
            {entries.map((a) => (
              <RouteOption
                key={a.route_id}
                checked={remembered === a.route_id}
                onChange={() => update.mutate({ preferred_route_id: a.route_id })}
                label={a.label}
                address={`@${c.handle}/${a.alias}`}
              />
            ))}
          </div>
          {problem ? (
            <p className="text-sm text-danger">
              {t(
                `The remembered entry no longer works (${problem}). Choose again.`,
                `记住的入口已失效（${problem}）。请重新选择。`,
              )}
            </p>
          ) : null}
        </Panel>
      ) : null}
      {update.isError ? <ErrorBox error={update.error} /> : null}

      {currentH ? (
        <ContactExport
          key={userId}
          hId={currentH.h_id}
          userId={userId}
          agentLabel={currentH.label}
          crossAgent={me?.cross_h_mailbox_enabled ?? false}
        />
      ) : null}
    </div>
  );
}

function RouteOption({
  checked,
  onChange,
  label,
  address,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  address: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
        checked ? 'bg-selected' : 'hover:bg-hover'
      }`}
    >
      <input type="radio" name="pref" checked={checked} onChange={onChange} />
      <span className="min-w-0 truncate text-fg">{label}</span>
      <span className="ml-auto min-w-0 truncate text-muted">{address}</span>
    </label>
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
      <div className="space-y-3 px-5 pb-5">{children}</div>
    </details>
  );
}

/**
 * Date-ranged download of the traffic with one contact.
 *
 * This replaced a 「与 TA 的往来」 list that read the last 20 inbox items and filtered them client-side by
 * author: it showed only what was received, only while it stayed inside that window, and counted group traffic
 * as one-to-one. There is no peer filter on the list endpoint, so the honest version of that question is this
 * export, which the server answers over the whole range and without conflating the two kinds of delivery.
 *
 * The response is NDJSON behind `Content-Disposition: attachment`, which `api` cannot read, so `downloadExport`
 * fetches it with the session cookie and saves it under the server's filename. A server refusal (too many
 * drops, rate limit, expired session) is shown here instead of being saved to disk.
 */
function ContactExport({
  hId,
  userId,
  agentLabel,
  crossAgent,
}: {
  hId: string;
  userId: string;
  agentLabel: string;
  crossAgent: boolean;
}) {
  const uid = useId();
  const t = useT();
  const [range, setRange] = useState(defaultExportRange);
  const period = exportDayRange(range.from, range.to);
  const download = useMutation({
    mutationFn: (p: { since: string; until: string }) =>
      downloadExport(hId, {
        scope: 'peer',
        peer_user_id: userId,
        since: p.since,
        until: p.until,
        include_body: true,
      }),
  });

  return (
    <DisclosurePanel summary={t('Export messages with this contact', '导出与 TA 的往来记录')}>
      <p className="text-sm leading-5 text-muted">
        {t(
          'Direct messages both ways, with titles and bodies; group messages are exported from the group page.',
          '双向的直接往来，含标题与正文；群消息请到群页面导出。',
        )}
      </p>
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
            if (period) download.mutate(period);
          }}
        >
          <Download size={14} aria-hidden="true" />
          {download.isPending ? t('Exporting…', '正在导出…') : t('Download .jsonl', '下载 .jsonl')}
        </Button>
      </div>
      {download.isError ? <ErrorBox error={download.error} /> : null}
      {period ? (
        <p className="text-xs leading-5 text-dim">
          {t(
            'Both dates are included and messages are matched by send time. The file has one JSON object per line; the first line gives the count.',
            '两端日期都算在内，按消息的发出时间计算；文件每行一条 JSON，首行写明条数。',
          )}{' '}
          {crossAgent
            ? t('Covers every agent on your account.', '涵盖你账号下的所有 Agent。')
            : t(`Covers only the current agent "${agentLabel}".`, `只涵盖当前 Agent「${agentLabel}」。`)}
        </p>
      ) : (
        <p className="text-xs leading-5 text-warn">
          {t(
            `The end date cannot be before the start date, and the range cannot exceed ${EXPORT_MAX_DAYS} days. Export longer periods in parts.`,
            `结束日期不能早于开始日期，跨度也不能超过 ${EXPORT_MAX_DAYS} 天；更长的区间请分段导出。`,
          )}
        </p>
      )}
    </DisclosurePanel>
  );
}

/** The toolbar's "Invite" panel: invite somebody by @handle. Invite links have their own section in the list. */
function InvitePanel({ autoFocus, onClose }: { autoFocus: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const t = useT();
  const errorId = useId();
  const [handle, setHandle] = useState('');
  const panel = useRef<HTMLElement>(null);
  usePanelFocus(autoFocus, panel);
  const invite = useMutation({
    mutationFn: (h: string) => api.post<Contact>('/v1/me/contacts/invite', { handle: h }),
    onSuccess: () => {
      setHandle('');
      qc.invalidateQueries({ queryKey: ['contacts'] });
    },
  });
  // the error names the username that was sent, even after the field was edited
  const [sent, setSent] = useState('');

  return (
    <section
      ref={panel}
      aria-label={t('Invite by @handle', '按 @handle 邀请')}
      className="space-y-2.5 border-b border-line bg-surface-2 px-4 pb-4 pt-3"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-fg">{t('Invite by @handle', '按 @handle 邀请')}</h2>
        <IconButton label={t('Close', '关闭')} className="-mr-1.5 ml-auto" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (handle.trim()) {
            setSent(handle.trim());
            invite.mutate(handle.trim());
          }
        }}
      >
        <Input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder={t('Invite by @handle', '@handle 邀请')}
          aria-label={t('Handle to invite', '邀请 handle')}
          aria-invalid={invite.isError || undefined}
          aria-describedby={invite.isError ? errorId : undefined}
        />
        <Button type="submit" variant="primary" className="h-9" disabled={invite.isPending}>
          {t('Invite', '邀请')}
        </Button>
      </form>
      <p className="text-xs leading-5 text-dim">
        {t(
          'They become a contact once they accept. To invite somebody without an account, create an invite link below.',
          '对方接受后成为联系人。要邀请还没有账号的人，可以在下方生成邀请链接。',
        )}
      </p>
      {invite.isError ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {humanInviteError(invite.error, sent).text}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Shareable contact links, listed with the other invitations I sent. The plain link is shown once, right after it is
 * generated; the list only has status, expiry and how many people used it. Anyone who opens a live link becomes a
 * contact without a further approval.
 */
function InviteLinks() {
  const qc = useQueryClient();
  const t = useT();
  const f = useFormat();
  const [fresh, setFresh] = useState<CreatedInviteLink | null>(null);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const links = useQuery({
    queryKey: ['invite-links'],
    queryFn: () => api.get<{ links: InviteLink[] }>('/v1/me/invite-links'),
  });
  const create = useMutation({
    mutationFn: () => api.post<CreatedInviteLink>('/v1/me/invite-links'),
    onSuccess: (link) => {
      setFresh(link);
      setCopied('idle');
      qc.invalidateQueries({ queryKey: ['invite-links'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/v1/me/invite-links/${id}/revoke`),
    onSuccess: (_d, id) => {
      if (fresh?.link_id === id) setFresh(null);
      qc.invalidateQueries({ queryKey: ['invite-links'] });
    },
  });
  const active = (links.data?.links ?? []).filter((l) => l.status === 'active');

  return (
    <section>
      <div className="flex items-center gap-2 px-4 pb-1.5 pt-3">
        <span
          className="min-w-0 truncate text-xs font-medium text-dim"
          title={t(
            'Whoever opens it becomes your contact: right away if they have an agent, otherwise as soon as they set one up. Valid 7 days, usable by several people, revocable.',
            '对方打开链接即成为联系人；还没有 Agent 的，配对 Agent 后自动成为联系人。7 天有效，可多人使用，随时作废。',
          )}
        >
          {active.length > 0
            ? t(`Invite links (${active.length})`, `邀请链接（${active.length}）`)
            : t('Invite by link', '用链接邀请')}
        </span>
        <Button
          variant="ghost"
          className="-mr-2 ml-auto h-7 px-2"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          <Link2 size={14} aria-hidden="true" />
          {t('Create link', '生成链接')}
        </Button>
      </div>
      {create.isError ? <ErrorBox error={create.error} /> : null}
      {fresh ? (
        <div className="mx-4 mb-3 space-y-2 rounded-lg border border-accent/30 bg-bg p-3">
          <div className="break-all font-mono text-xs text-fg">{fresh.url}</div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() =>
                copyText(fresh.url).then((ok) => {
                  setCopied(ok ? 'copied' : 'failed');
                })
              }
            >
              {copied === 'copied' ? t('Copied', '已复制') : t('Copy link', '复制链接')}
            </Button>
            <span className="min-w-0 flex-1 text-xs text-dim">
              {copied === 'failed'
                ? t('Copy failed. Select the link above by hand.', '复制失败，请手动选择上面的链接。')
                : t(
                    'The link is shown only this once and cannot be viewed after you leave the page.',
                    '链接只显示这一次，离开页面后无法再查看。',
                  )}
            </span>
          </div>
        </div>
      ) : null}
      {active.map((l) => (
        <div key={l.link_id} className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <span
            aria-hidden="true"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-hover text-muted"
          >
            <Link2 size={14} />
          </span>
          <span
            className="min-w-0 flex-1 truncate text-sm text-fg-2"
            title={t(`Created ${f.dateTime(l.created_at)}`, `生成于 ${f.dateTime(l.created_at)}`)}
          >
            {t(
              `Expires ${f.date(l.expires_at)} · used ${plural(l.use_count, 'time', 'times')}`,
              `${f.date(l.expires_at)} 到期 · 已用 ${l.use_count} 次`,
            )}
          </span>
          <Button variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(l.link_id)}>
            {t('Revoke', '作废')}
          </Button>
        </div>
      ))}
      {revoke.isError ? <ErrorBox error={revoke.error} /> : null}
    </section>
  );
}
