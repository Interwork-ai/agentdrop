import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { AgentDropError, ApiClient } from '@agentdrop/client';
import type { DropSummary, RecipientStatus, ResolvedRecipient } from '@agentdrop/contracts';
import { loadCredential } from '../credentials.js';
import { readLanguage } from '../locale.js';
import { networkFetch } from '../network.js';
import { CLI_VERSION, type Output, terminalText } from '../output.js';
import { readDevice, readProfile } from '../store.js';
import { validateServerUrl } from './login.js';

/**
 * Read-side and quick-response commands so the daily loop never needs the dashboard:
 *   agentdrop inbox / read / pending / requests / accept / decline / approvals / approve
 * Viewing needs no MCP at all; the agent tools remain for composing and sending.
 */
/** Fixed words in the person's language (English unless `agentdrop settings --language zh`). */
type Tr = (en: string, zh: string) => string;
function translator(): Tr {
  const zh = readLanguage() === 'zh';
  return (en, zhText) => (zh ? zhText : en);
}

const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The shortest id prefix a command takes: `agentdrop inbox` shows eight characters. */
export const MIN_ID_PREFIX = 4;

/**
 * A drop id as a person types it: the full id, or its first characters (at least four, as `agentdrop inbox`
 * shows them), looked up among the newest drops of the inbox and of sent. A full id is used as given, no lookup.
 */
export async function resolveDropId(client: ApiClient, raw: string): Promise<string> {
  const t = translator();
  const id = raw.trim().toLowerCase();
  if (FULL_ID.test(id)) return id;
  if (!/^[0-9a-f-]+$/.test(id) || id.replace(/-/g, '').length < MIN_ID_PREFIX)
    throw new Error(
      t(
        `give the message id, or at least its first ${MIN_ID_PREFIX} characters as agentdrop inbox shows them`,
        `请给出消息 id，或者至少它的前 ${MIN_ID_PREFIX} 个字符（agentdrop inbox 里显示的那样）`,
      ),
    );
  const [inbox, sent] = await Promise.all([
    client.listDrops({ view: 'inbox', limit: 50 }),
    client.listDrops({ view: 'sent', limit: 50 }),
  ]);
  const matches = [...new Set([...inbox.drops, ...sent.drops].map((d) => d.drop_id))].filter((d) =>
    d.startsWith(id),
  );
  if (matches.length === 0)
    throw new Error(
      t(
        `no recent message starts with ${id}; check the id with agentdrop inbox`,
        `最近的消息里没有以 ${id} 开头的；用 agentdrop inbox 核对一下 id`,
      ),
    );
  if (matches.length > 1)
    throw new Error(
      t(
        `${matches.length} messages start with ${id}; give a few more characters`,
        `有 ${matches.length} 条消息以 ${id} 开头；请多给几个字符`,
      ),
    );
  return matches[0] as string;
}

export function clientFor(profileName: string): { client: ApiClient; agentName: string } {
  const t = translator();
  const profile = readProfile(profileName);
  if (!profile)
    throw new Error(
      t(
        `profile "${profileName}" not found; agentdrop endpoint list shows the ones on this computer`,
        `找不到配置「${profileName}」；agentdrop endpoint list 会列出这台电脑上的配置`,
      ),
    );
  const credential = loadCredential(profile.credential_ref);
  if (!credential)
    throw new Error(
      t(
        `the key for "${profileName}" is missing; pair it again with agentdrop setup`,
        `配置「${profileName}」的密钥丢失了；请用 agentdrop setup 重新配对`,
      ),
    );
  const baseUrl = validateServerUrl(profile.server_url, readDevice()?.allow_http === true);
  return {
    client: new ApiClient({
      baseUrl,
      fetch: networkFetch(baseUrl),
      credential,
      userAgent: `agentdrop-cli/${CLI_VERSION}`,
    }),
    agentName: profile.agent_name,
  };
}

export async function inboxCommand(
  out: Output,
  opts: { profile: string; view: string; unread?: boolean; limit?: number },
): Promise<void> {
  const { client } = clientFor(opts.profile);
  const t = translator();
  const view = (['inbox', 'sent', 'starred', 'archived'] as const).find((v) => v === opts.view) ?? 'inbox';
  const viewName: Record<typeof view, [string, string]> = {
    inbox: ['Inbox', '收件箱'],
    sent: ['Sent', '已发送'],
    starred: ['Starred', '星标'],
    archived: ['Archived', '已归档'],
  };
  const name = t(...viewName[view]);
  const res = await client.listDrops({
    view,
    ...(opts.unread ? { unread_only: true } : {}),
    limit: opts.limit ?? 20,
  });
  out.result(res, () =>
    res.drops.length === 0
      ? t(`${name}: empty`, `${name}：空`)
      : [
          t(`${name} · ${res.unread_count} unread`, `${name} · 未读 ${res.unread_count}`),
          ...res.drops.map(
            (d) =>
              `${d.read ? ' ' : '*'} ${d.drop_id.slice(0, 8)}  ${localTime(d.received_at ?? d.created_at)}  ${d.author.display_label.padEnd(12)}  ${d.title}${groupLabel(t, d)}${d.attachment_count ? t(`  [${d.attachment_count} file${d.attachment_count > 1 ? 's' : ''}]`, `  [${d.attachment_count} 个附件]`) : ''}${dropRouteLabel(t, d)}${d.recipient_status?.length ? `  · ${receiptLabel(t, d.recipient_status)}` : ''}`,
          ),
          t(
            '(* unread; to read one: agentdrop read <the first characters of its id>)',
            '（* 未读；读取：agentdrop read <id 的前几个字符>）',
          ),
        ].join('\n'),
  );
}

/** An error's code as the Claude Code mod reads it: an error code word, else `FAILED` (never a message). */
export function errorCode(err: unknown): string {
  const raw = err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : null;
  return typeof raw === 'string' && /^[A-Z][A-Z_]*$/.test(raw) ? raw : 'FAILED';
}

/**
 * Marks one drop read for the person: every delivery of it to any of their agents (setDropState compares
 * `expected_version` with the highest version among them, which is the summary's `state_version`). `known` is what
 * the caller already read; without it the drop is read first. A version that moved meanwhile is retried once with
 * the server's current one. Returns whether it was unread.
 */
export async function markDropRead(
  client: ApiClient,
  dropId: string,
  known?: { read: boolean; state_version: number },
): Promise<boolean> {
  const state = known ?? (await client.readDrop({ drop_id: dropId, max_chars: 1 })).drop;
  if (state.read) return false;
  try {
    await client.setDropState({ drop_id: dropId, expected_version: state.state_version, read: true });
  } catch (err) {
    const current = err instanceof AgentDropError ? err.details?.current_version : undefined;
    if (!(err instanceof AgentDropError) || err.code !== 'VERSION_CONFLICT' || typeof current !== 'number')
      throw err;
    await client.setDropState({ drop_id: dropId, expected_version: current, read: true });
  }
  return true;
}

/**
 * Whether `agentdrop read` marks the drop read (ADR 0032). `--mark-read` always asks for it (the Claude Code mod
 * uses it). Otherwise a person reading it in a terminal has read it: plain text printed to an interactive terminal,
 * not `--keep-unread`, not `--json` (output for programs), not a pipe or a shell tool of an agent. Only a drop
 * that is unread and was delivered to one of the person's agents carries state to change: a sent-only drop, or one
 * readable only as group history, is printed and left alone.
 */
export function marksReadOnRead(
  d: { read: boolean; deliveries: unknown[] },
  opts: { markRead?: boolean; keepUnread?: boolean; json: boolean; terminal: boolean },
): 'explicit' | 'terminal' | null {
  if (d.read) return null;
  if (opts.markRead) return 'explicit';
  if (opts.keepUnread || opts.json || !opts.terminal) return null;
  return d.deliveries.length > 0 ? 'terminal' : null;
}

/**
 * A person at a terminal: both stdin and stdout are a TTY, and this is not the shell tool of an agent that sets a
 * known marker (Claude Code sets CLAUDECODE, opencode OPENCODE, a sandboxed Codex command CODEX_SANDBOX;
 * AGENTDROP_UNATTENDED=1 says it for any other). Agent shell tools rarely give a command a terminal on stdin, so
 * the stdin check covers harnesses without a marker. A pipe, a file or a shell tool without a terminal is never a
 * person reading.
 */
export function personAtTerminal(
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY: boolean = process.stdout.isTTY === true,
  stdinIsTTY: boolean = process.stdin.isTTY === true,
): boolean {
  if (!stdoutIsTTY || !stdinIsTTY) return false;
  if (env.AGENTDROP_UNATTENDED === '1' || env.CLAUDECODE === '1' || env.OPENCODE === '1' || env.CODEX_SANDBOX)
    return false;
  return true;
}

export async function readCommand(
  out: Output,
  opts: {
    profile: string;
    dropId: string;
    markRead?: boolean;
    keepUnread?: boolean;
    /** A person reads the output at a terminal; defaults to `personAtTerminal()`. */
    terminal?: boolean;
  },
): Promise<void> {
  const t = translator();
  if (opts.markRead && opts.keepUnread)
    throw new Error(
      t('give --mark-read or --keep-unread, not both', '--mark-read 和 --keep-unread 只能选一个'),
    );
  const { client } = clientFor(opts.profile);
  const id = await resolveDropId(client, opts.dropId);
  const res = await client.readDrop({ drop_id: id, max_chars: 8192 });
  const d = res.drop;
  // read is the person's state (ADR 0007): unread on any of their agents is unread, whichever agent this is.
  // The drop was read either way: a failed marking is noted (`mark_read_failed`, its code), never fatal.
  let markFailed: string | null = null;
  let marked = false;
  const mode = marksReadOnRead(d, {
    ...(opts.markRead ? { markRead: true } : {}),
    ...(opts.keepUnread ? { keepUnread: true } : {}),
    json: out.json,
    terminal: opts.terminal ?? personAtTerminal(),
  });
  if (mode) {
    try {
      marked = await markDropRead(client, id, { read: d.read, state_version: d.state_version });
    } catch (err) {
      // A drop no agent of this person received (NOT_FOUND from the state call) has no state: printed, nothing more.
      if (!(mode === 'terminal' && err instanceof AgentDropError && err.code === 'NOT_FOUND'))
        markFailed = errorCode(err);
    }
  }
  const state = (read: boolean) => (read ? t('read', '已读') : t('unread', '未读'));
  const list = (items: string[]) => items.join(t('; ', '；'));
  const result = markFailed
    ? { ...res, mark_read_failed: markFailed }
    : marked
      ? { ...res, marked_read: true }
      : res;
  out.result(result, () =>
    [
      markFailed ? t("(couldn't mark it read; try again later)", '（未能标为已读，稍后再试）') : '',
      `${d.title}`,
      t(
        `from ${d.author.display_label} @${d.author.handle} · ${localTime(d.created_at)} · ${state(d.read || marked)}`,
        `来自 ${d.author.display_label} @${d.author.handle} · ${localTime(d.created_at)} · ${state(d.read || marked)}`,
      ),
      d.reply_to ? t(`reply to "${d.reply_to.title}"`, `回复：「${d.reply_to.title}」`) : '',
      d.replies?.count
        ? t(
            `replies: ${d.replies.count}${d.replies.authors?.length ? ` (${d.replies.authors.map((a) => a.display_label).join(', ')})` : ''}`,
            `收到回复：${d.replies.count} 条${d.replies.authors?.length ? `（${d.replies.authors.map((a) => a.display_label).join('、')}）` : ''}`,
          )
        : '',
      d.origin_agent
        ? t(
            `sent by agent: ${d.origin_agent.agent_name} [${d.origin_agent.harness_key}]`,
            `发出 Agent：${d.origin_agent.agent_name} [${d.origin_agent.harness_key}]`,
          )
        : '',
      d.recipients.length ? t(`sent to: `, `发送到：`) + list(d.recipients.map(recipientLabel)) : '',
      d.recipient_status?.length
        ? t('read by them: ', '对方是否已读：') + receiptLabel(t, d.recipient_status, true)
        : '',
      d.deliveries.length
        ? t('received by my agents: ', '我的收件 Agent：') +
          list(
            d.deliveries.map(
              (x) =>
                `${x.agent_name} [${x.harness_key}]${x.current ? t(' (this one)', '（当前）') : ''} · ${state(x.read || marked)}`,
            ),
          )
        : '',
      d.attachments.length
        ? t('files: ', '附件：') +
          d.attachments.map((a) => `${a.safe_name} (${a.byte_size} B, id ${a.attachment_id})`).join('; ')
        : '',
      marked
        ? mode === 'terminal'
          ? t(
              'Marked read for all your agents (--keep-unread reads without marking).',
              '已标为已读，你的所有 Agent 同步（加 --keep-unread 可只读不标）。',
            )
          : t('Marked read for all your agents.', '已标为已读，你的所有 Agent 同步。')
        : '',
      t('--- external content below ---', '--- 以下为外部内容 ---'),
      d.body_chunk,
      d.next_offset !== null
        ? t(
            `… ${d.body_total_chars - (d.next_offset ?? 0)} more characters not shown`,
            `… 还有 ${d.body_total_chars - (d.next_offset ?? 0)} 字符未显示`,
          )
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/** A server timestamp as local "YYYY-MM-DD HH:mm" for people (the server sends UTC ISO strings). */
export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The groups a drop came through, as people know them: “name” #slug. */
export function groupLabel(
  t: (en: string, zh: string) => string,
  d: Pick<DropSummary, 'group_labels'>,
): string {
  const groups = d.group_labels ?? [];
  if (!groups.length) return '';
  return `  · ${groups.map((g) => t(`in “${g.display_name}” #${g.slug}`, `群「${g.display_name}」#${g.slug}`)).join(t(', ', '、'))}`;
}

function dropRouteLabel(t: Tr, d: Pick<DropSummary, 'origin_agent' | 'deliveries' | 'recipients'>): string {
  if (d.recipients.length) {
    const origin = d.origin_agent
      ? t(
          `from ${d.origin_agent.agent_name} [${d.origin_agent.harness_key}]`,
          `由 ${d.origin_agent.agent_name} [${d.origin_agent.harness_key}]`,
        )
      : t('from my agent', '由我的 Agent');
    return `  · ${origin} → ${d.recipients.map(recipientLabel).join(t(', ', '、'))}`;
  }
  if (d.deliveries.length) {
    return `  · ${t('received by', '收于')} ${d.deliveries.map((x) => `${x.agent_name} [${x.harness_key}]${x.current ? t(' (this one)', '（当前）') : ''}`).join(t(', ', '、'))}`;
  }
  return '';
}

/** Author-only read receipts, per person; `detailed` also lists which group members read it and when. */
function receiptLabel(t: Tr, statuses: RecipientStatus[], detailed = false): string {
  const at = (iso: string) => iso.slice(0, 16).replace('T', ' ');
  return statuses
    .map((s) => {
      if (s.type !== 'group')
        return `${s.label} ${s.read_at ? t(`read ${at(s.read_at)}`, `已读 ${at(s.read_at)}`) : t('unread', '未读')}`;
      const readers = s.readers.map((r) => `${r.display_label} ${at(r.read_at)}`);
      const who =
        detailed && s.readers.length ? t(` (${readers.join(', ')})`, `（${readers.join('、')}）`) : '';
      return `${s.label} ${s.read_count}/${s.member_count} ${t('read', '已读')}${who}`;
    })
    .join(t('; ', '；'));
}

function recipientLabel(r: ResolvedRecipient): string {
  if (r.endpoint_label) {
    return [r.address ?? r.label, r.endpoint_label, r.harness_key ? `[${r.harness_key}]` : null]
      .filter(Boolean)
      .join(' · ');
  }
  // Older servers report agent counts here; only the group label is stable across versions.
  return r.label;
}

export async function requestsCommand(out: Output, opts: { profile: string }): Promise<void> {
  const { client } = clientFor(opts.profile);
  const r = await client.pendingRequests();
  const t = translator();
  const names = (items: string[]) => items.join(t(', ', '、')) || t('none', '无');
  out.result(r, () =>
    [
      t('Contact requests to me: ', '联系人申请（待我接受）：') +
        names(r.contact_requests_received.map((p) => `${p.display_name} @${p.handle}`)),
      t('My requests (waiting for them): ', '我发出的申请（等对方）：') +
        names(r.contact_requests_sent.map((p) => `${p.display_name} @${p.handle}`)),
      t('Group invitations: ', '群邀请：') +
        names(r.group_invitations.map((g) => `“${g.display_name}” #${g.slug}`)),
      t(
        'Accept: agentdrop accept @handle | #slug   Decline: agentdrop decline …',
        '接受：agentdrop accept @handle | #slug   拒绝：agentdrop decline …',
      ),
    ].join('\n'),
  );
}

/** `accept @handle` / `accept #slug` — resolves the target from the pending list; groups bind this profile's endpoint. */
export async function respondCommand(
  out: Output,
  opts: { profile: string; target: string; decision: 'accept' | 'decline' },
): Promise<void> {
  const { client } = clientFor(opts.profile);
  const t = translator();
  const accept = opts.decision === 'accept';
  const r = await client.pendingRequests();
  if (opts.target.startsWith('#')) {
    const slug = opts.target.slice(1);
    const g = r.group_invitations.find((x) => x.slug === slug);
    if (!g) throw new Error(t(`no pending invitation to #${slug}`, `没有待处理的 #${slug} 群邀请`));
    const res = await client.groupRespond({ group_id: g.group_id, decision: opts.decision });
    const group = t(`“${res.display_name}” #${res.slug}`, `「${res.display_name}」#${res.slug}`);
    out.result(res, () =>
      accept
        ? res.current_h_receives
          ? t(
              `Joined ${group}; this agent receives its messages.`,
              `已加入${group}，这个 Agent 会收到群消息。`,
            )
          : t(
              `Joined ${group}; this agent does not receive its messages (change it in the group's settings in the dashboard).`,
              `已加入${group}；这个 Agent 不接收群消息（可在网页的群设置里修改）。`,
            )
        : t(`Declined the invitation to ${group}.`, `已拒绝${group}的邀请。`),
    );
    return;
  }
  const handle = opts.target.replace(/^@/, '');
  const p = r.contact_requests_received.find((x) => x.handle === handle);
  if (!p)
    throw new Error(
      t(`no pending contact request from @${handle}`, `没有来自 @${handle} 的待处理联系人申请`),
    );
  const res = await client.contactRespond({ user_id: p.user_id, decision: opts.decision });
  const who = `${res.display_name} @${res.handle}`;
  out.result(res, () =>
    res.status === 'accepted'
      ? t(`${who} is now a contact; you can send to each other.`, `${who} 已是联系人，你们可以互发消息了。`)
      : accept
        ? t(`${who}: ${res.status}`, `${who}：${res.status}`)
        : t(`Declined the request from ${who}.`, `已拒绝 ${who} 的申请。`),
  );
}

export async function approvalsCommand(out: Output, opts: { profile: string }): Promise<void> {
  const { client } = clientFor(opts.profile);
  const r = await client.approvalsPending();
  const t = translator();
  out.result(r, () =>
    r.approvals.length === 0
      ? t('No sends waiting for approval.', '没有待审批的发送。')
      : r.approvals
          .map(
            (a) =>
              `${a.approval_id.slice(0, 8)}\n  ${a.title} → ${a.recipients.map((x) => x.label).join(', ')}\n  ${t('why: ', '原因：')}${a.reasons.join('; ')}\n  ${a.body_preview.slice(0, 120)}`,
          )
          .concat(
            t(
              'Approve: agentdrop approve <id>   Reject: agentdrop approve <id> --reject',
              '批准：agentdrop approve <id>   拒绝：agentdrop approve <id> --reject',
            ),
          )
          .join('\n'),
  );
}

/**
 * Human confirmation at a real terminal. The prompt is read from /dev/tty, not stdin, so a model driving a shell
 * tool (no controlling terminal) cannot approve its own send; that is the whole point of the approval.
 */
export async function approveCommand(
  out: Output,
  opts: { profile: string; id: string; reject?: boolean; yes?: boolean },
): Promise<void> {
  const { client } = clientFor(opts.profile);
  const t = translator();
  const r = await client.approvalsPending();
  // An exact id wins; a prefix must name exactly one approval, or the human would confirm a send they did not pick.
  const exact = r.approvals.find((x) => x.approval_id === opts.id);
  const matches = exact ? [exact] : r.approvals.filter((x) => opts.id && x.approval_id.startsWith(opts.id));
  if (matches.length !== 1)
    throw new Error(
      matches.length === 0
        ? t('no pending approval with that id', '没有这个 id 的待审批发送')
        : t(
            'several approvals start with that id; give a few more characters',
            '有多条待审批以这个 id 开头；请多给几个字符',
          ),
    );
  const a = matches[0] as (typeof matches)[number];
  const decision = opts.reject ? 'reject' : 'approve';
  if (!opts.yes) {
    const answer = askTty(
      [
        `${decision === 'approve' ? t('Approve and deliver', '批准并投递') : t('Reject', '拒绝')}${t(': ', '：')}${a.title}`,
        `  ${t('to: ', '收件：')}${a.recipients.map((r) => r.label).join(', ')}`,
        `  ${t('why: ', '原因：')}${a.reasons.join('; ')}`,
        `  ${t('preview: ', '摘要：')}${a.body_preview.slice(0, 200).replace(/\n/g, ' ')}`,
        t('Confirm? [y/N] ', '确认？[y/N] '),
      ].join('\n'),
    );
    if (answer.trim().toLowerCase() !== 'y') {
      out.result({ status: 'cancelled' }, () => t('Cancelled; nothing changed.', '已取消，未做任何改变。'));
      return;
    }
  } else if (!process.stdin.isTTY) {
    throw new Error('--yes is only accepted from an interactive terminal');
  }
  try {
    const res = await client.approvalDecide(a.approval_id, decision);
    out.result(res, () =>
      res.status === 'delivered'
        ? t('Delivered.', '已投递。')
        : res.status === 'rejected'
          ? t('Rejected; nothing was sent.', '已拒绝，没有发出。')
          : t(`Status: ${res.status}`, `状态：${res.status}`),
    );
  } catch (err) {
    if (err instanceof AgentDropError && err.code === 'STALE_APPROVAL' && err.details?.closed === true) {
      throw new Error(
        t(
          'The recipients changed while this waited for approval, so this send was cancelled; ask your agent to send it again.',
          '收件人在审批期间发生了变化，这次发送已取消；请让 Agent 重新发送。',
        ),
      );
    }
    if (err instanceof AgentDropError && err.code === 'STALE_APPROVAL') {
      throw new Error(
        t(
          'The recipients changed after the preview, which is now refreshed; run agentdrop approvals again, check it, then approve.',
          '收件目标在预览后发生了变化，已刷新预览；请再次运行 agentdrop approvals 核对后重新批准。',
        ),
      );
    }
    throw err;
  }
}

function askTty(prompt: string): string {
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r+');
  } catch {
    throw new Error(
      'approval requires an interactive terminal (no /dev/tty available); open a real terminal and run this command yourself',
    );
  }
  try {
    writeSync(fd, terminalText(prompt));
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, buf.length, null);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
