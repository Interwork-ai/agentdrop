import type { AttachmentMeta, DirectoryEntry } from '@agentdrop/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CheckCircle2, FileText, Paperclip, Send, ShieldCheck, UsersRound, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  ApiFailure,
  api,
  type DirectoryLookupResult,
  type DropDetail,
  mailboxUrl,
  newRequestId,
  type SendResult,
  type SendTarget,
} from '../lib/api.js';
import { humanError } from '../lib/error-text.js';
import { formatBytes, plural } from '../lib/format.js';
import { type Translate, t as tNow, useT } from '../lib/lang.js';
import { isAssistant, personName } from '../lib/people.js';
import { progressLabel, REPLY_PROGRESS, type ReplyProgress, replyTitle } from '../lib/reply.js';
import { mailboxKey, useSession } from '../lib/session.js';
import { useCombobox } from '../ui/combobox.js';
import { Avatar, Chip, IconButton, MetaList, PageToolbar, Panel } from '../ui/layout.jsx';
import { NeedsAgentNote } from '../ui/needs-agent.jsx';
import { Button, ErrorBox, Field } from '../ui/primitives.jsx';

interface RecipientChip {
  key: string;
  label: string;
  sub: string;
  kind: 'person' | 'group' | 'route';
  target: SendTarget;
  problem?: string | null;
  /** Group chips: who can be @mentioned in it (active members, from the directory card). */
  members?: Array<{ handle: string; display_label: string }>;
}

/** Why a person cannot receive a plain send right now, or null when they can. */
function notReachable(e: { contact_status: string }, t: Translate): string | null {
  if (e.contact_status === 'invited')
    return t('Not a contact yet: they need to accept your invitation', '还不是联系人，对方接受邀请后才能发');
  if (e.contact_status === 'requested')
    return t('They asked to connect: accept them on Contacts first', '对方申请加你，先在联系人页接受');
  if (e.contact_status === 'blocked') return t('Blocked', '已屏蔽');
  return null;
}

const handoffTemplates = (t: Translate) => [
  {
    label: t('Deliver results', '交付结果'),
    hint: t('Hand over the results together with the next steps', '把成果和下一步一起交给对方'),
    title: t('Delivery: ', '交付：'),
    body: t(
      "Done\n[Summarize what you're delivering]\n\nKey findings\n[Conclusions and limits the other side needs to know]\n\nDeliverables\n[Related files, links or verification results]\n\nSuggested next steps\n[What you want their agent to do next]",
      '已完成\n[总结交付的结果]\n\n关键结论\n[对方需要知道的结论与限制]\n\n交付物\n[相关文件、链接或验证结果]\n\n建议下一步\n[希望对方 Agent 继续做什么]',
    ),
  },
  {
    label: t('Ask for help', '请求协作'),
    hint: t('Explain the context, the task and what done looks like', '说明上下文、任务和完成标准'),
    title: t('Request for help: ', '协作请求：'),
    body: t(
      "Goal\n[What we're trying to get done together]\n\nContext so far\n[Current progress, constraints and references]\n\nWhat I need from you\n[The specific task and its scope]\n\nExpected delivery\n[Result format, definition of done and timing]",
      '目标\n[我们要共同完成什么]\n\n已有上下文\n[当前进展、相关约束与参考资料]\n\n需要你协作\n[明确的任务与范围]\n\n预期交付\n[结果格式、完成标准与期望时间]',
    ),
  },
  {
    label: t('Needs a decision', '需要决策'),
    hint: t('Lay out the options so a person can decide quickly', '列出选项，让人快速做决定'),
    title: t('Decision needed: ', '需要决策：'),
    body: t(
      'Question to decide\n[The specific question a person needs to confirm]\n\nOptions\n[Benefits, costs and risks of each option]\n\nRecommendation\n[Preferred option and why]\n\nPlease confirm\n[Ask the receiving agent to report to its owner and reply with the decision]',
      '待决策问题\n[需要人类确认的具体问题]\n\n可选方案\n[各方案的收益、代价与风险]\n\n建议\n[推荐方案与理由]\n\n请确认\n[请接收方 Agent 向其负责人报告，并回复决定]',
    ),
  },
];

/** One choice in the recipient list: a group, a person (their default entry) or one of their published entries. */
type Choice =
  | { key: string; kind: 'group'; entry: Extract<DirectoryEntry, { kind: 'group' }> }
  | { key: string; kind: 'person'; entry: Extract<DirectoryEntry, { kind: 'person' }> }
  | {
      key: string;
      kind: 'route';
      entry: Extract<DirectoryEntry, { kind: 'person' }>;
      route: Extract<DirectoryEntry, { kind: 'person' }>['alternatives'][number];
    };

/**
 * New message. It goes out from one of MY agents (origin_kind=web): the sidebar's current agent unless the person
 * changes it. Recipients are typed-and-confirmed chips from the authorized directory, picked in an ARIA combobox
 * (ui/combobox.ts); free text never sends. One request_id per composer instance so a retry after a network error can
 * never double-send. Ctrl/Cmd+Enter sends; plain Enter never does (in the recipient field it picks the highlighted
 * match).
 */
export function ComposePage() {
  const { me, currentH } = useSession();
  const t = useT();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [search] = useSearchParams();
  const [fromH, setFromH] = useState(currentH?.h_id ?? '');
  const requestedRecipient = search.get('to');
  const [query, setQuery] = useState((requestedRecipient ?? '').replace(/^[#@]/, ''));
  const [chips, setChips] = useState<RecipientChip[]>([]);
  /** Handles to @mention; only members of a chosen group count, the rest are dropped at send time. */
  const [mentions, setMentions] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<AttachmentMeta[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // one request_id per *submitted draft*: retries of the same content reuse it; editing after a failed attempt
  // rotates it so the server never answers IDEMPOTENCY_CONFLICT for an intentional change
  const requestId = useRef(newRequestId());
  const submittedDraft = useRef<string | null>(null);
  const prefilledRecipient = useRef(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const forwardId = search.get('forward');
  const replyId = search.get('reply');
  const sourceId = replyId ?? forwardId;
  const sourceApplied = useRef<string | null>(null);
  /** A reply names the drop it answers (payload.reply_to) until the person removes that reference. */
  const [replyDropped, setReplyDropped] = useState(false);
  /** Where the work the answered drop asked for stands (ADR 0038); empty for a plain reply. */
  const [progress, setProgress] = useState<ReplyProgress | ''>('');
  const replyTo = replyId && !replyDropped ? replyId : null;
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const titleId = useId();
  const bodyId = useId();
  const reasonId = useId();
  const hintId = useId();
  const [changingFrom, setChangingFrom] = useState(false);
  const recipientInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (currentH && !fromH) setFromH(currentH.h_id);
  }, [currentH, fromH]);

  const source = useQuery({
    queryKey: mailboxKey(currentH?.h_id ?? '', 'compose-source', sourceId),
    queryFn: () =>
      api.get<{ drop: DropDetail }>(
        mailboxUrl(currentH?.h_id ?? '', `/drops/${encodeURIComponent(sourceId ?? '')}?max_chars=2048`),
      ),
    enabled: !!sourceId && !!currentH,
  });
  useEffect(() => {
    if (sourceId && source.data && sourceApplied.current !== sourceId && !title && !body) {
      const drop = source.data.drop;
      sourceApplied.current = sourceId;
      if (replyId) {
        // The reference says which drop this answers, so nothing is quoted: the person writes the answer.
        setTitle(replyTitle(drop.title));
        return;
      }
      const excerpt = `${drop.body_chunk}${drop.next_offset !== null ? tNow('\n[Original truncated; only the first 2048 characters are quoted]', '\n[原文已截断，仅引用前 2048 字符]') : ''}`;
      setTitle(tNow(`Fwd: ${drop.title}`, `转交：${drop.title}`).slice(0, 160));
      setBody(
        `${tNow('Forwarding note\n[Explain how you want them to continue]', '转交说明\n[说明希望对方如何继续]')}${tNow(
          `\n\n—— Quoted source ——\nTitle: ${drop.title}\nSource message: ${drop.drop_id}\n\n`,
          `\n\n—— 引用来源 ——\n标题：${drop.title}\n来源消息：${drop.drop_id}\n\n`,
        )}${excerpt}`,
      );
    }
  }, [source.data, sourceId, replyId, title, body]);

  const dir = useQuery({
    queryKey: ['directory', fromH, query],
    queryFn: () =>
      api.get<DirectoryLookupResult>(
        mailboxUrl(fromH, `/directory?query=${encodeURIComponent(query)}&limit=20`),
      ),
    enabled: !!fromH,
  });

  const candidates = useMemo(() => dir.data?.entries ?? [], [dir.data]);

  const add = useCallback((entry: DirectoryEntry, routeId?: string) => {
    let chip: RecipientChip;
    if (entry.kind === 'group') {
      chip = {
        key: `g:${entry.group_id}`,
        label: entry.display_name,
        sub: tNow(
          `#${entry.slug} · ${plural(entry.member_count, 'member', 'members')}`,
          `#${entry.slug} · ${entry.member_count} 人`,
        ),
        kind: 'group',
        target: entry.target,
        members: (entry.active_members ?? []).map((m) => ({
          handle: m.handle,
          display_label: m.display_label,
        })),
      };
    } else if (routeId) {
      const r = entry.alternatives.find((a) => a.route_id === routeId);
      if (!r) return;
      chip = {
        key: `r:${routeId}`,
        label: `${personName(entry, entry.display_label, tNow)} · ${r.label}`,
        sub: `@${entry.handle}/${r.alias}`,
        kind: 'route',
        target: r.target,
      };
    } else {
      chip = {
        key: `u:${entry.user_id}`,
        label: personName(entry, entry.display_label, tNow),
        // the person, never their agents (ADR 0013)
        sub: `@${entry.handle}`,
        kind: 'person',
        target: entry.default_target,
        problem: entry.preference_problem,
      };
    }
    setChips((c) => (c.some((x) => x.key === chip.key) ? c : [...c, chip]));
    setQuery('');
  }, []);

  /** The list under the "To" row, flattened: a person's published entries follow them as their own options. */
  const choices = useMemo<Choice[]>(
    () =>
      candidates.flatMap((entry): Choice[] =>
        entry.kind === 'group'
          ? [{ key: `g:${entry.group_id}`, kind: 'group', entry }]
          : [
              { key: `u:${entry.user_id}`, kind: 'person', entry },
              ...entry.alternatives.map(
                (route): Choice => ({ key: `r:${route.route_id}`, kind: 'route', entry, route }),
              ),
            ],
      ),
    [candidates],
  );
  const listOpen = Boolean(dir.data) && (query.length > 0 || chips.length === 0);
  const combo = useCombobox({
    count: choices.length,
    open: listOpen,
    query,
    onPick: (i) => {
      const choice = choices[i];
      if (!choice) return;
      if (choice.kind === 'route') add(choice.entry, choice.route.route_id);
      else add(choice.entry);
      recipientInput.current?.focus();
    },
  });

  useEffect(() => {
    if (!requestedRecipient || prefilledRecipient.current || candidates.length === 0) return;
    // `?to=#slug` is a group (the group page's "Write to the group"), `?to=@handle` or a bare handle a person. The
    // marker matters: a group's default slug is its creator's handle.
    const isGroup = requestedRecipient.startsWith('#');
    const normalized = requestedRecipient.replace(/^[#@]/, '').toLowerCase();
    const exact = candidates.find((entry) =>
      isGroup
        ? entry.kind === 'group' && entry.slug.toLowerCase() === normalized
        : entry.kind === 'person' && entry.handle.toLowerCase() === normalized,
    );
    if (exact) {
      prefilledRecipient.current = true;
      add(exact);
    }
  }, [candidates, requestedRecipient, add]);

  async function onFiles(list: FileList | null) {
    if (!list || !fromH) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const f of Array.from(list)) {
        const meta = await api.upload<AttachmentMeta>(mailboxUrl(fromH, '/attachments'), f);
        setFiles((prev) => [...prev, meta]);
      }
    } catch (err) {
      setUploadError(humanError(err).text);
    } finally {
      setUploading(false);
    }
  }

  const mentionable = [
    ...new Map(
      chips
        .flatMap((c) => c.members ?? [])
        .filter((m) => m.handle !== me?.handle)
        .map((m) => [m.handle, m]),
    ).values(),
  ];
  const activeMentions = mentions.filter((h) => mentionable.some((m) => m.handle === h));

  const send = useMutation({
    mutationFn: () => {
      const draft = JSON.stringify({
        fromH,
        targets: chips.map((c) => c.target),
        title,
        body,
        files: files.map((f) => f.attachment_id),
        mentions: activeMentions,
        replyTo,
        progress: replyTo ? progress : '',
      });
      if (submittedDraft.current !== null && submittedDraft.current !== draft)
        requestId.current = newRequestId();
      submittedDraft.current = draft;
      return api.post<SendResult>(mailboxUrl(fromH, '/drops'), {
        request_id: requestId.current,
        targets: chips.map((c) => c.target),
        payload: {
          payload_version: 1,
          kind: files.length ? 'file' : 'text',
          title,
          body,
          attachment_ids: files.map((f) => f.attachment_id),
          extensions: {},
          ...(activeMentions.length ? { mentions: activeMentions } : {}),
          ...(replyTo ? { reply_to: replyTo } : {}),
          ...(replyTo && progress ? { progress } : {}),
        },
      });
    },
    onSuccess: (res) => {
      setResult(res);
      qc.invalidateQueries({ queryKey: mailboxKey(fromH) });
      qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });

  const blocked = chips.some((c) => c.problem);
  const canSend =
    !!fromH &&
    chips.length > 0 &&
    title.trim().length > 0 &&
    !blocked &&
    !send.isPending &&
    !uploading &&
    (!sourceId || source.isSuccess || (replyId !== null && replyDropped));

  /** Why Send is unavailable, in one sentence; null when it can send (docs/PRODUCT_PRINCIPLES.md #16). */
  const missing = [
    chips.length === 0 ? t('a recipient', '收件人') : null,
    title.trim() ? null : t('a title', '标题'),
  ].filter((x): x is string => x !== null);
  const and = t(' and ', '和');
  const sendBlocker = canSend
    ? null
    : !fromH
      ? t('Pair an agent first.', '请先配对一个 Agent。')
      : blocked
        ? t('Remove the recipient marked in red, then choose them again.', '先移除标红的收件人，再重新选择。')
        : uploading
          ? t('Wait for the upload to finish.', '请等附件上传完成。')
          : sourceId && !source.isSuccess && !(replyId !== null && replyDropped)
            ? t('Loading the original message…', '正在读取原消息…')
            : missing.length
              ? t(`Add ${missing.join(and)} to send.`, `填写${missing.join(and)}后才能发送。`)
              : null;

  function onKey(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSend) {
      e.preventDefault();
      send.mutate();
    }
  }

  if (!me) return null;
  const endpoints = me.endpoints.filter((e) => !e.revoked_at);
  const fromEndpoint = endpoints.find((e) => e.h_id === fromH);

  if (result) {
    const delivered = result.outcome === 'delivered';
    return (
      <div className="w-full overflow-y-auto">
        <PageToolbar title={t('New message', '写消息')} />
        <div className="mx-auto w-full max-w-xl p-4 md:p-6">
          <Panel>
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <span
                className={`inline-flex h-12 w-12 items-center justify-center rounded-full ${
                  delivered ? 'bg-ok-bg text-ok' : 'bg-warn-bg text-warn'
                }`}
              >
                {delivered ? <CheckCircle2 size={24} /> : <ShieldCheck size={24} />}
              </span>
              <h2 className="text-lg font-semibold text-fg">
                {delivered
                  ? t('Delivered', '已投递')
                  : result.outcome === 'needs_approval'
                    ? t('Waiting for your approval', '等待你的审批')
                    : t('Not sent', '未发送')}
              </h2>
            </div>
            <MetaList
              items={[
                {
                  label: t('To', '收件'),
                  value: result.recipients
                    .map((r) => {
                      // the built-in assistant in the reader's language (lib/people.ts)
                      const label =
                        r.type === 'user' && isAssistant({ handle: r.address?.split('/')[0] ?? null })
                          ? personName({ handle: 'agentdrop' }, r.label, t)
                          : r.label;
                      return r.endpoint_label ? `${label} → ${r.endpoint_label}` : label;
                    })
                    .join(t(', ', '，')),
                },
              ]}
            />
            {delivered ? (
              <p className="text-sm text-muted">
                {t(
                  "Saved to the recipient's inbox. This doesn't mean they're online or have read it.",
                  '已保存到接收方收件箱；不代表对方在线或已读。',
                )}
              </p>
            ) : null}
            {result.outcome === 'needs_approval' ? (
              <p className="rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn">
                {t(
                  'Not yet delivered to the recipient. Confirm it under Approvals.',
                  '尚未向收件方投递。请在「审批」确认。',
                )}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-center gap-2 pt-1">
              <Button
                variant="primary"
                onClick={() => nav(result.outcome === 'needs_approval' ? '/app/approvals' : '/app/sent')}
              >
                {result.outcome === 'needs_approval'
                  ? t('Go to approvals', '去审批')
                  : t('View sent', '查看已发送')}
              </Button>
              <Button
                onClick={() => {
                  setResult(null);
                  setTitle('');
                  setBody('');
                  setChips([]);
                  setFiles([]);
                  setSelectedTemplate(null);
                  setQuery('');
                  // Keep these guards until navigation clears the source URL; otherwise its effects can refill it.
                  sourceApplied.current = sourceId;
                  prefilledRecipient.current = true;
                  requestId.current = newRequestId();
                  submittedDraft.current = null;
                  nav('/app/compose', { replace: true });
                }}
              >
                {t('Send another', '再发一条')}
              </Button>
            </div>
          </Panel>
        </div>
      </div>
    );
  }

  const row =
    'flex items-start gap-3 border-b border-line px-4 transition-shadow focus-within:shadow-[inset_2px_0_0_var(--color-accent)]';
  const rowLabel = 'w-14 shrink-0 text-sm leading-9 text-muted';
  const bare = 'w-full bg-transparent text-fg placeholder:text-dim';
  // The row around a bare field marks focus with an accent edge; the global focus ring would box the field again.
  const noRing = { outline: 'none' } as const;

  return (
    <form className="w-full overflow-y-auto" onKeyDown={onKey} onSubmit={(e) => e.preventDefault()}>
      <PageToolbar
        title={t('New message', '写消息')}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav(-1)}>
              {t('Cancel', '取消')}
            </Button>
            <Button
              variant="primary"
              disabled={!canSend}
              onClick={() => send.mutate()}
              {...(sendBlocker ? { title: sendBlocker, 'aria-describedby': reasonId } : {})}
            >
              <Send size={14} aria-hidden="true" />
              {send.isPending ? t('Sending…', '发送中…') : t('Send message', '发送')}
            </Button>
          </>
        }
      >
        {sendBlocker && !send.isPending ? (
          <p id={reasonId} className="text-xs text-muted">
            {sendBlocker}
          </p>
        ) : null}
      </PageToolbar>
      <fieldset disabled={send.isPending} className="mx-auto w-full min-w-0 max-w-3xl space-y-4 p-4 md:p-6">
        {endpoints.length === 0 ? <NeedsAgentNote what="send" /> : null}
        {fromEndpoint ? (
          changingFrom && endpoints.length > 1 ? (
            <Field label={t('Send from', '从哪个 Agent 发出')}>
              <select
                aria-label={t('Sending agent', '发件 Agent')}
                className="h-9 w-full rounded-lg border border-line-strong bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent/60"
                value={fromH}
                // biome-ignore lint/a11y/noAutofocus: it replaces the "Change" button the person just pressed
                autoFocus
                disabled={uploading || send.isPending}
                onChange={(e) => {
                  setFromH(e.target.value);
                  setFiles([]);
                  setUploadError(null);
                  setChips([]);
                  setQuery('');
                  setChangingFrom(false);
                }}
              >
                {endpoints.map((e) => (
                  <option key={e.h_id} value={e.h_id}>
                    {e.label} · {e.device.label}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
              <Bot size={14} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0">
                {t('Send from', '发件 Agent')}{' '}
                <span className="font-medium text-fg-2">
                  {fromEndpoint.label} · {fromEndpoint.device.label}
                </span>
              </span>
              {endpoints.length > 1 ? (
                <button
                  type="button"
                  className="rounded-md px-1.5 text-sm font-medium text-accent-fg hover:bg-hover"
                  aria-label={t('Change the sending agent', '更换发件 Agent')}
                  onClick={() => setChangingFrom(true)}
                >
                  {t('Change', '更换')}
                </button>
              ) : null}
            </p>
          )
        ) : null}
        {replyId && !replyDropped ? (
          <div className="flex items-start gap-2 rounded-lg border border-accent/25 bg-accent/8 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              {source.isPending ? (
                <p className="text-muted" role="status">
                  {t('Loading the message you are replying to…', '正在读取你要回复的消息…')}
                </p>
              ) : null}
              {source.isError ? <ErrorBox error={source.error} retry={() => source.refetch()} /> : null}
              {source.data ? (
                <>
                  <p className="break-words font-medium text-accent-fg">
                    {t('Replying to ', '回复')}
                    <span className="untrusted text-fg">
                      {t(`“${source.data.drop.title}”`, `「${source.data.drop.title}」`)}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {t(
                      'They see which message this answers. Sending it also marks that message read for you.',
                      '对方会看到这是在回复哪条消息。发送后，那条消息也会对你标为已读。',
                    )}
                  </p>
                  <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                    {t('Where it stands', '进展')}
                    <select
                      className="h-8 rounded-lg border border-line-strong bg-surface-2 px-2 text-sm text-fg outline-none focus:border-accent/60"
                      value={progress}
                      onChange={(e) => setProgress(e.target.value as ReplyProgress | '')}
                    >
                      <option value="">{t('Just a reply', '只是回复')}</option>
                      {REPLY_PROGRESS.map((p) => (
                        <option key={p} value={p}>
                          {progressLabel(p, t)}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}
            </div>
            <IconButton
              label={t('Remove the reply reference', '移除回复引用')}
              onClick={() => setReplyDropped(true)}
            >
              <X size={14} />
            </IconButton>
          </div>
        ) : null}
        {forwardId && !replyId ? (
          <div className="rounded-lg border border-accent/25 bg-accent/8 px-4 py-3 text-sm">
            <div className="font-medium text-accent-fg">{t('Forwarding', '转交来源')}</div>
            {source.isPending ? (
              <p className="mt-1 text-muted" role="status">
                {t('Loading the original message…', '正在读取原消息…')}
              </p>
            ) : null}
            {source.isError ? <ErrorBox error={source.error} retry={() => source.refetch()} /> : null}
            {source.data ? (
              <>
                <p className="untrusted mt-1 break-words text-fg">{source.data.drop.title}</p>
                <p className="mt-1 text-xs text-muted">
                  {sourceApplied.current === sourceId
                    ? t(
                        "The quote is in the body. This goes out as a separate message and doesn't carry the original attachments.",
                        '引用已放入正文。本次会作为一条独立消息发送，不会附带原附件。',
                      )
                    : t(
                        'Your input was kept and the original was not added to the body. This goes out as a separate message.',
                        '已保留你的输入，原文未加入正文。本次会作为一条独立消息发送。',
                      )}
                </p>
              </>
            ) : null}
          </div>
        ) : null}

        <div className="card overflow-hidden rounded-xl">
          {/* To: chosen recipients as chips, then the search that finds more */}
          <div className={`${row} py-1.5`}>
            <span className={rowLabel}>{t('To', '收件人')}</span>
            <div className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {chips.map((c) => (
                <span
                  key={c.key}
                  className={`inline-flex min-h-7 max-w-full flex-wrap items-center gap-x-1.5 rounded-md py-0.5 pl-2 pr-0.5 text-sm ${
                    c.problem
                      ? 'bg-danger-bg text-danger ring-1 ring-inset ring-danger-line'
                      : c.kind === 'group'
                        ? 'bg-accent/12 text-accent-fg'
                        : 'bg-surface-3 text-fg'
                  }`}
                >
                  {c.kind === 'group' ? (
                    <UsersRound size={13} aria-hidden="true" />
                  ) : c.kind === 'route' ? (
                    <Bot size={13} aria-hidden="true" />
                  ) : null}
                  <span className="untrusted font-medium">{c.label}</span>
                  <span className="text-xs opacity-75">{c.sub}</span>
                  {c.problem ? (
                    <span className="text-xs">
                      {t(
                        `(${c.problem}: choose a receiving entry explicitly)`,
                        `（${c.problem}：请显式选择入口）`,
                      )}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="inline-flex h-6 w-6 items-center justify-center rounded opacity-70 hover:bg-hover hover:opacity-100"
                    aria-label={t(`Remove ${c.label}`, `移除 ${c.label}`)}
                    onClick={() => setChips(chips.filter((x) => x.key !== c.key))}
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
              <input
                ref={recipientInput}
                className={`${bare} h-8 min-w-40 flex-1 text-sm`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('Name, @handle or group', '名字、@handle 或群名')}
                aria-label={t('Search recipients', '搜索收件人')}
                aria-describedby={hintId}
                style={noRing}
                {...combo.inputProps}
                onKeyDown={(e) => {
                  // Backspace in an empty field removes the last recipient, like a mail client
                  if (e.key === 'Backspace' && !query && chips.length) {
                    setChips(chips.slice(0, -1));
                    return;
                  }
                  combo.inputProps.onKeyDown(e);
                }}
              />
            </div>
          </div>
          <p id={hintId} className="sr-only">
            {t(
              'Type a name, nickname, @handle, email or group name; use the arrow keys and Enter to pick.',
              '输入名字、昵称、@handle、邮箱或群名；用方向键和回车选择。',
            )}
          </p>
          {/* announced as the list changes: how many matches, or none */}
          <p className="sr-only" role="status" aria-live="polite">
            {dir.data && listOpen
              ? choices.length
                ? t(plural(choices.length, 'match', 'matches'), `${choices.length} 个结果`)
                : t('No matching contacts or groups', '没有匹配的联系人或群组')
              : ''}
          </p>
          {dir.isPending && fromH ? (
            <p className="border-b border-line px-4 py-2 text-xs text-muted">
              {t('Looking up contacts and groups…', '正在查找联系人和群组…')}
            </p>
          ) : null}
          {dir.isError ? <ErrorBox error={dir.error} retry={() => dir.refetch()} /> : null}
          {dir.data && listOpen ? (
            <div className="max-h-72 overflow-y-auto border-b border-line bg-surface-2 py-1 text-sm">
              {query || chips.length ? null : (
                <p className="px-4 pb-1 pt-1.5 text-xs text-dim">
                  {t(
                    'Search by note, nickname, @handle, email or group name, then pick a recipient',
                    '按备注、昵称、@handle、邮箱或群名搜索，再选择收件人',
                  )}
                </p>
              )}
              {dir.data.ambiguous ? (
                <div className="mx-2 my-1 rounded-md bg-warn-bg px-3 py-1.5 text-xs text-warn">
                  {t(
                    'Several matches share this name. Check the @handle or group slug before choosing.',
                    '有同名候选：请核对 @handle / 群短代码后再选择。',
                  )}
                </div>
              ) : null}
              {choices.length === 0 ? (
                <div className="px-4 py-2 text-muted">
                  {t('No matching contacts or groups', '没有匹配的联系人或群组')}
                </div>
              ) : null}
              <div role="listbox" id={combo.listboxProps.id} aria-label={t('Recipients', '收件人')}>
                {choices.map((c, i) => {
                  const on = i === combo.active;
                  const rowClass = `flex w-full cursor-pointer items-center gap-2.5 py-1.5 pr-4 text-left ${
                    on ? 'bg-selected' : 'hover:bg-hover'
                  }`;
                  if (c.kind === 'group') {
                    const e = c.entry;
                    return (
                      <div key={c.key} {...combo.optionProps(i)} className={`${rowClass} pl-4`}>
                        <span
                          aria-hidden="true"
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/12 text-accent-fg"
                        >
                          <UsersRound size={13} />
                        </span>
                        <span className="min-w-0 truncate font-medium text-fg">{e.display_name}</span>
                        <span className="min-w-0 truncate text-xs text-muted">
                          #{e.slug} · {t(plural(e.member_count, 'member', 'members'), `${e.member_count} 人`)}
                          {e.current_h_receives
                            ? ''
                            : t(' · this agent does not receive', ' · 此 Agent 未接收')}
                        </span>
                        <span className="ml-auto shrink-0">
                          <Chip tone="accent">{t('Group', '群')}</Chip>
                        </span>
                      </div>
                    );
                  }
                  const e = c.entry;
                  if (c.kind === 'route')
                    return (
                      <div
                        key={c.key}
                        {...combo.optionProps(i)}
                        className={`${rowClass} pl-[3.25rem] text-xs`}
                      >
                        <Bot size={12} aria-hidden="true" className="shrink-0 text-muted" />
                        <span className="min-w-0 truncate text-fg-2">{c.route.label}</span>
                        <span className="min-w-0 truncate text-dim">
                          @{e.handle}/{c.route.alias}
                        </span>
                      </div>
                    );
                  return (
                    <div key={c.key} {...combo.optionProps(i)} className={`${rowClass} pl-4`}>
                      <Avatar name={personName(e, e.display_label, t)} seed={e.handle} size={24} />
                      <span className="min-w-0 truncate font-medium text-fg">
                        {personName(e, e.display_label, t)}
                      </span>
                      <span className="shrink-0 text-xs text-muted">@{e.handle}</span>
                      {e.public_email ? (
                        <span className="hidden min-w-0 truncate text-xs text-dim sm:inline">
                          {e.public_email}
                        </span>
                      ) : null}
                      <span
                        className={`ml-auto shrink-0 text-xs ${notReachable(e, t) || e.preference_problem ? 'text-warn' : 'text-muted'}`}
                      >
                        {notReachable(e, t) ??
                          (e.preference_problem
                            ? t('Saved entry no longer works', '记住的入口已失效')
                            : e.preference_applied
                              ? t('To their entry you saved', '发到记住的入口')
                              : null)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          {mentionable.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2 text-xs">
              <span className="text-muted">{t('Mention (optional):', '@ 成员（可选）：')}</span>
              {mentionable.map((m) => {
                const on = mentions.includes(m.handle);
                return (
                  <button
                    key={m.handle}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setMentions(on ? mentions.filter((h) => h !== m.handle) : [...mentions, m.handle])
                    }
                    className={`h-6 rounded-md px-2 font-medium transition-colors ${
                      on
                        ? 'bg-accent/15 text-accent-fg ring-1 ring-inset ring-accent/40'
                        : 'bg-hover text-fg-2 hover:text-fg'
                    }`}
                  >
                    @{m.display_label}
                  </button>
                );
              })}
              <span className="basis-full text-dim">
                {t(
                  'Everyone in the group receives it; those you mention are told so.',
                  '全群都会收到；被 @ 的人会收到“@了你”的提醒。',
                )}
              </span>
            </div>
          ) : null}
          <div className={`${row} py-1.5`}>
            <label htmlFor={titleId} className={rowLabel}>
              {t('Title', '标题')}
            </label>
            <input
              id={titleId}
              style={noRing}
              className={`${bare} h-9 flex-1 text-base font-medium`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={160}
              required
              placeholder={t('What does the other side need to know?', '这次协作需要对方知道什么？')}
            />
          </div>
          <label htmlFor={bodyId} className="sr-only">
            {t('Message', '消息内容')}
          </label>
          <div className="transition-shadow focus-within:shadow-[inset_2px_0_0_var(--color-accent)]">
            <textarea
              id={bodyId}
              style={noRing}
              className={`${bare} block min-h-64 resize-y px-4 py-3 text-base leading-7`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              placeholder={t(
                'Write down the confirmed context, open tasks and the delivery you expect…',
                '写下已确认的上下文、待办和期望的交付…',
              )}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-4 py-2.5 text-xs">
            {!sourceId ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted">
                  {t('Start from a template (optional)', '从模板开始（可选）')}
                </span>
                {handoffTemplates(t).map((template) => (
                  <button
                    key={template.label}
                    type="button"
                    title={template.hint}
                    disabled={!!title || !!body}
                    onClick={() => {
                      setTitle(template.title);
                      setBody(template.body);
                      setSelectedTemplate(template.label);
                    }}
                    className={`h-6 rounded-full border px-2.5 font-medium transition-colors hover:border-accent/50 hover:text-fg disabled:cursor-not-allowed disabled:opacity-45 ${
                      selectedTemplate === template.label
                        ? 'border-accent/50 bg-accent/10 text-accent-fg'
                        : 'border-line-strong text-fg-2'
                    }`}
                  >
                    {template.label}
                  </button>
                ))}
                {selectedTemplate ? (
                  <span className="text-dim">
                    {t('Replace the prompts in brackets before sending.', '发送前替换方括号里的提示。')}
                  </span>
                ) : null}
              </div>
            ) : null}
            <span className="ml-auto text-dim">
              {t('Ctrl/Cmd+Enter sends; Enter adds a new line', 'Ctrl/Cmd+Enter 发送；普通 Enter 只换行')}
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!uploading && fromH) void onFiles(e.dataTransfer.files);
            }}
            className={`relative flex cursor-pointer items-center gap-3 rounded-xl border border-dashed px-4 py-3.5 transition-colors ${
              dragging
                ? 'border-accent bg-accent/8'
                : 'border-line-strong bg-surface hover:border-accent/40 hover:bg-accent/5'
            }`}
          >
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
              <Paperclip size={16} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-fg-2">
                {uploading ? t('Uploading…', '上传中…') : t('Choose attachments', '选择附件')}
              </span>
              <span className="block text-xs text-dim">
                {t(
                  'Or drop files here. Up to 50 MiB per file; uploads may need human approval',
                  '也可以把文件拖到这里。每文件 ≤ 50 MiB；上传后可能需要人工审批',
                )}
              </span>
            </span>
            <input
              className="sr-only"
              type="file"
              multiple
              onChange={(e) => onFiles(e.target.files)}
              disabled={uploading || !fromH}
            />
          </label>
          {uploadError ? <p className="text-xs text-danger">{uploadError}</p> : null}
          {files.length ? (
            <ul className="grid gap-2 sm:grid-cols-2">
              {files.map((f) => (
                <li
                  key={f.attachment_id}
                  className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2"
                >
                  <FileText size={15} className="shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg" title={f.safe_name}>
                      {f.safe_name}
                    </span>
                    <span className="block text-xs text-dim">{formatBytes(f.byte_size)}</span>
                  </span>
                  <IconButton
                    label={t(`Remove ${f.safe_name}`, `移除 ${f.safe_name}`)}
                    onClick={() => {
                      setFiles(files.filter((x) => x.attachment_id !== f.attachment_id));
                      api.delete(mailboxUrl(fromH, `/attachments/${f.attachment_id}`)).catch(() => undefined);
                    }}
                  >
                    <X size={14} />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {send.isError ? (
          <ErrorBox
            error={send.error}
            retry={() => {
              if (canSend) send.mutate();
            }}
          >
            {fullGroupLabel(send.error, chips, t)}
          </ErrorBox>
        ) : null}
        {blocked ? (
          <p className="text-xs text-danger">
            {t(
              "A recipient's saved receiving entry no longer works and won't be rerouted automatically. Remove them and choose an entry again.",
              '有收件人的记住入口已失效，不能自动改投；请移除后重新选择入口。',
            )}
          </p>
        ) : null}
      </fieldset>
    </form>
  );
}

/** A group whose file space refused the send (GROUP_STORAGE_FULL names it by id): which of the chosen groups it is. */
function fullGroupLabel(error: unknown, chips: RecipientChip[], t: Translate): string | null {
  if (!(error instanceof ApiFailure) || error.body.code !== 'GROUP_STORAGE_FULL') return null;
  const groupId = error.body.details?.group_id;
  const chip = chips.find((c) => c.target.type === 'group' && c.target.group_id === groupId);
  return chip ? t(`Full group: ${chip.label}`, `已满的群：${chip.label}`) : null;
}
