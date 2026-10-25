import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { ApiFailure, api, type GroupDetail, type InviteOutcome } from '../lib/api.js';
import { useFormat } from '../lib/format.js';
import { type Translate, useT } from '../lib/lang.js';
import { Avatar, Chip, Panel } from '../ui/layout.jsx';
import { NeedsAgentNote } from '../ui/needs-agent.jsx';
import { Button, ErrorBox, Input } from '../ui/primitives.jsx';

/*
 * Bringing people into a group and joining one: inviting by @handle (directly, or as a request an admin approves),
 * deciding join requests, and answering an invitation with the agents that should receive the group.
 */

/** One field, several people: handles may be pasted separated by spaces, commas or Chinese punctuation. */
export function parseHandles(raw: string): string[] {
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

export function InviteOutcomes({ invites }: { invites: InviteOutcome[] }) {
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
export function InviteError({ error, id }: { error: unknown; id?: string }) {
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
export function handlesProblem(error: unknown): boolean {
  if (!(error instanceof ApiFailure)) return false;
  const { code, details } = error.body;
  return (code === 'NOT_FOUND' && Array.isArray(details?.handles)) || details?.field === 'handles';
}

/** Free-text handle entry with chips, so one call can carry several people. */
export function HandleField({
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
export function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1.5 text-sm font-medium text-fg-2">{label}</legend>
      {children}
      {hint ? <span className="block text-xs text-dim">{hint}</span> : null}
    </fieldset>
  );
}

/** Members are entitled to know this before they post, so it sits next to the group settings and the invitation. */
export function AdminReadDisclosure() {
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

/** Every active member may invite; whether that lands as an invitation or a request depends on the policy. */
export function InviteBox({
  group,
  isAdmin,
  onDone,
}: {
  group: GroupDetail;
  isAdmin: boolean;
  onDone: () => void;
}) {
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
export function JoinRequests({ group, onDone }: { group: GroupDetail; onDone: () => void }) {
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
export function InviteAccept({
  group,
  endpoints,
  onDone,
  onLeaving,
  onStay,
  onGone,
}: {
  group: GroupDetail;
  endpoints: Array<{ h_id: string; label: string; device: { label: string }; is_default_receiver: boolean }>;
  onDone: () => void;
  /** As the decline is sent: stop asking for the group (the change may arrive before the answer). */
  onLeaving: (groupId: string) => void;
  /** The decline failed: the group is still mine to see. */
  onStay: (groupId: string) => void;
  /** After declining: the group is no longer visible to me. */
  onGone: (groupId: string) => void;
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
    mutationFn: (groupId: string) => api.post(`/v1/me/groups/${groupId}/decline`),
    // Once declined the group is no longer visible to me, so refetching it would only report NOT_FOUND.
    onMutate: onLeaving,
    onError: (_err, groupId) => onStay(groupId),
    onSuccess: (_data, groupId) => onGone(groupId),
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
        <Button className="h-9" disabled={decline.isPending} onClick={() => decline.mutate(group.group_id)}>
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
export function ReceivePicker({
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
