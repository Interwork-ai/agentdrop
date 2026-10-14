import { randomUUID } from 'node:crypto';
import { fstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { AgentDropError, type ApiClient } from '@agentdrop/client';
import {
  type DirectoryEntry,
  type GroupCard,
  LIMITS,
  type PersonCard,
  type SendResult,
  type SendTarget,
  searchKey,
  type UploadFileResult,
} from '@agentdrop/contracts';
import { safeFilename } from '@agentdrop/security';
import { readLanguage } from '../locale.js';
import type { Output } from '../output.js';
import { readProfile } from '../store.js';
import { clientFor, resolveDropId } from './mail.js';
import { checkFiles, formatBytes, SpaceRefusal, spaceErrorText, uploadFiles } from './space.js';

/**
 * `agentdrop send <@handle | #group | me>`: a message from a terminal or a CI job, without an agent. The recipient
 * is resolved through the same directory the agents' directory_lookup uses (exact @handle or #slug; a plain name
 * only when exactly one entry is called that), `me` is the person's own space (ADR 0030). Files obey upload_file's
 * allowlist and sensitive-file rules. One request_id per invocation, reused on a retry, so a retried send never
 * delivers twice.
 *
 * Everything printed here is read by a person: English, or Chinese after `agentdrop settings --language zh`.
 */

type Tr = (en: string, zh: string) => string;
function translator(): Tr {
  const zh = readLanguage() === 'zh';
  return (en, zhText) => (zh ? zhText : en);
}

/** A title derived from the body's first line stops here (a typed one may use the server's full limit). */
export const DERIVED_TITLE_MAX = 80;

// biome-ignore lint/suspicious/noControlCharactersInRegex: titles must not carry control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** --title, else the body's first non-empty line (cut at 80 with "…"), else the first file name (+N more). */
export function deriveSendTitle(opts: { title?: string; body: string; files: string[] }): string {
  const clean = (s: string) => s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const cut = (s: string, max: number) => {
    const chars = [...s];
    return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`;
  };
  const given = clean(opts.title ?? '');
  if (given) return [...given].slice(0, LIMITS.TITLE_MAX_CHARS).join('');
  const line = clean(opts.body.split('\n').find((l) => l.trim()) ?? '');
  if (line) return cut(line, DERIVED_TITLE_MAX);
  const first = opts.files[0];
  if (!first) return '';
  const name = safeFilename(basename(first));
  return cut(opts.files.length > 1 ? `${name} +${opts.files.length - 1}` : name, DERIVED_TITLE_MAX);
}

/** Who a message goes to, as the person named it and as the server takes it. */
export interface Recipient {
  target: SendTarget;
  kind: 'person' | 'group' | 'self';
  /** For people: "Wang @wang", “Core team” #core, or my space. */
  label: string;
}

function personLabel(p: Pick<PersonCard, 'display_label' | 'handle'>): string {
  return `${p.display_label} @${p.handle}`;
}
function groupLabel(t: Tr, g: Pick<GroupCard, 'display_name' | 'slug'>): string {
  return t(`“${g.display_name}” #${g.slug}`, `「${g.display_name}」#${g.slug}`);
}
function entryLabel(t: Tr, e: DirectoryEntry): string {
  return e.kind === 'person' ? personLabel(e) : groupLabel(t, e);
}

/**
 * `me`, `@handle`, `#slug`, or a name. Handles and slugs match exactly (both are unique, so never a guess); a plain
 * name must be the handle, slug, remark, nickname or group name of exactly one entry, otherwise the person is asked
 * to pick the @handle or #slug. Nobody outside the directory (contacts, people in my groups, my groups) is found.
 */
export async function resolveRecipient(
  t: Tr,
  client: ApiClient,
  raw: string,
  contactsUrl: string,
): Promise<Recipient> {
  const wanted = raw.trim();
  if (!wanted)
    throw new SpaceRefusal(
      t('Say who gets it: @handle, #group or me.', '请说明发给谁：@handle、#群 或 me。'),
    );
  if (wanted.toLowerCase() === 'me')
    return { target: { type: 'self' }, kind: 'self', label: t('your space', '我的空间') };
  if (wanted.startsWith('#')) {
    const slug = wanted.slice(1).toLowerCase();
    const res = await client.directoryLookup({
      query: slug,
      kind: 'group',
      limit: LIMITS.DIRECTORY_LIMIT_MAX,
    });
    const group = res.entries.find(
      (e): e is GroupCard => e.kind === 'group' && e.slug.toLowerCase() === slug,
    );
    if (!group)
      throw new SpaceRefusal(
        t(
          `You are not in a group #${slug}. agentdrop group list shows your groups and invitations (accept one with agentdrop accept #${slug}).`,
          `你不在群 #${slug} 里。agentdrop group list 会列出你的群和收到的邀请（接受邀请：agentdrop accept #${slug}）。`,
        ),
      );
    return { target: group.target, kind: 'group', label: groupLabel(t, group) };
  }
  const handleOnly = wanted.startsWith('@');
  const name = handleOnly ? wanted.slice(1) : wanted;
  const res = await client.directoryLookup({
    query: name,
    ...(handleOnly ? { kind: 'person' as const } : {}),
    limit: LIMITS.DIRECTORY_LIMIT_MAX,
  });
  const key = searchKey(name);
  if (res.viewer.handle.toLowerCase() === key)
    return { target: { type: 'self' }, kind: 'self', label: t('your space', '我的空间') };
  if (handleOnly) {
    const byHandle = res.entries.find(
      (e): e is PersonCard => e.kind === 'person' && e.handle.toLowerCase() === key,
    );
    if (byHandle) return { target: byHandle.default_target, kind: 'person', label: personLabel(byHandle) };
    throw notFound(t, `@${name}`, contactsUrl);
  }
  // A plain word may be one person's handle and another's nickname: every exact fit counts, none wins by kind.
  const named = res.entries.filter((e) =>
    e.kind === 'person'
      ? [e.handle, e.display_label, e.display_name, e.remark ?? ''].some((v) => searchKey(v) === key)
      : [e.slug, e.display_name, e.my_nickname ?? ''].some((v) => searchKey(v) === key),
  );
  const only = named[0];
  if (named.length === 1 && only)
    return {
      target: only.kind === 'person' ? only.default_target : only.target,
      kind: only.kind,
      label: entryLabel(t, only),
    };
  if (named.length > 1)
    throw new SpaceRefusal(
      t(
        `"${name}" could be ${named.length} recipients: ${named.map((e) => entryLabel(t, e)).join(', ')}. Give the @handle or #group.`,
        `「${name}」对应 ${named.length} 个收件人：${named.map((e) => entryLabel(t, e)).join('、')}。请给出 @handle 或 #群。`,
      ),
    );
  throw notFound(t, name, contactsUrl);
}

function notFound(t: Tr, who: string, contactsUrl: string): SpaceRefusal {
  return new SpaceRefusal(
    t(
      `${who} is not one of your contacts or groups yet. Add them on ${contactsUrl} (send a contact request or an invite link); once they accept, send again.`,
      `${who} 还不是你的联系人或群。在 ${contactsUrl} 添加（发联系人申请或邀请链接），对方接受后再发送。`,
    ),
  );
}

/** One sentence for the person, by error code; file and network failures are worded as in `agentdrop space`. */
export function sendErrorText(t: Tr, err: unknown, profile: string, file?: string): string {
  if (err instanceof AgentDropError) {
    switch (err.code) {
      case 'PATH_NOT_ALLOWED':
        if (file && /outside|no allowed/.test(err.message)) return allowFolderText(t, file, profile);
        break;
      case 'NOT_A_CONTACT':
      case 'BLOCKED':
        return t(
          'This person cannot receive your messages (not a contact any more, or blocked); nothing was sent.',
          '对方无法接收你的消息（已不是联系人，或已屏蔽）；没有发出。',
        );
      case 'NO_DELIVERY_ROUTE':
      case 'ROUTE_UNAVAILABLE':
      case 'PREFERRED_ROUTE_UNAVAILABLE':
      case 'GROUP_RECIPIENT_UNAVAILABLE':
        return t(
          'Nobody there can receive it right now (no paired agent takes it); nothing was sent.',
          '那边目前没有能接收的 Agent；没有发出。',
        );
      case 'GROUP_STORAGE_FULL':
        return t(
          "The group's file space is full; a group admin can remove old files in the dashboard. Nothing was sent.",
          '群文件空间已满，群管理员可以在网页上删除旧文件。没有发出。',
        );
      case 'RATE_LIMITED':
        return t(
          'Too many messages in a short time; wait a minute and send again.',
          '短时间内发送太多，请一分钟后再发。',
        );
      case 'IDEMPOTENCY_CONFLICT':
        return t(
          'This send clashed with an earlier one; send it again.',
          '这次发送与之前的冲突了，请重新发送。',
        );
      case 'VALIDATION_FAILED': {
        const issues = err.details?.issues;
        const about = (field: string) =>
          Array.isArray(issues) &&
          issues.some(
            (i) => i && typeof i === 'object' && String((i as { path?: unknown }).path ?? '').includes(field),
          );
        if (about('reply_to') || /reply_to/.test(err.message))
          return t(
            'You cannot reply to that message (you cannot read it); nothing was sent.',
            '无法回复那条消息（你读不到它）；没有发出。',
          );
        if (about('mentions')) return t('Mentions only work in a group message.', '只有群消息才能 @ 成员。');
        return t('The server refused this message; nothing was sent.', '服务器拒绝了这条消息；没有发出。');
      }
    }
  }
  return spaceErrorText(t, err, profile);
}

/** The exact command that allows the file's folder, unless that folder is one no command may allow. */
function allowFolderText(t: Tr, file: string, profile: string): string {
  let folder: string;
  try {
    folder = dirname(realpathSync.native(resolve(file)));
  } catch {
    folder = dirname(resolve(file));
  }
  let home = homedir();
  try {
    home = realpathSync.native(home);
  } catch {
    /* keep the plain path */
  }
  if (folder === home || folder === '/')
    return t(
      'That file is outside the folders this profile may upload from, and its folder (your home folder or the root) cannot be allowed as a whole. Move it into a project folder first.',
      '这个文件不在此配置允许上传的文件夹里，而它所在的（主目录或根目录）不能整体允许。请先把它移到某个项目文件夹里。',
    );
  const quoted = /[^\w./-]/.test(folder) ? `"${folder.replace(/(["\\$`])/g, '\\$1')}"` : folder;
  return t(
    `That file is outside the folders this profile may upload from. Allow its folder, then send again: agentdrop allow-dir add ${quoted} --profile ${profile}`,
    `这个文件不在此配置允许上传的文件夹里。允许它所在的文件夹后再发送：agentdrop allow-dir add ${quoted} --profile ${profile}`,
  );
}

/**
 * Text piped in (`echo … | agentdrop send`, `< notes.md`, or a program writing to it); never a terminal or
 * /dev/null. A shell pipe or a file is read to its end. A socket (what Node and some tools hand a child) is read only
 * if something arrives within `waitMs`: a shell tool that leaves stdin open and silent must not hang the send.
 */
export async function readPipedStdin(
  stream: NodeJS.ReadableStream & { destroy?: () => void } = process.stdin,
  waitMs = 1000,
): Promise<string | null> {
  let kind: 'read' | 'wait' | null = null;
  try {
    const st = fstatSync(0);
    kind = st.isFIFO() || st.isFile() ? 'read' : st.isSocket() ? 'wait' : null;
  } catch {
    return null;
  }
  if (kind === null) return null;
  if (kind === 'read') {
    try {
      return readFileSync(0, 'utf8');
    } catch {
      return null;
    }
  }
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let started = false;
    const timer = setTimeout(() => {
      if (started) return;
      stream.removeAllListeners('data');
      stream.destroy?.();
      done(null);
    }, waitMs);
    stream.on('data', (chunk: Buffer | string) => {
      started = true;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => {
      clearTimeout(timer);
      done(Buffer.concat(chunks).toString('utf8'));
    });
    stream.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
  });
}

/**
 * Sends once and, when the network or the server failed in between, again with the same request_id: the server
 * answers a repeat with the drop it already made, so nothing is delivered twice. When every attempt failed, the
 * request is looked up once before the failure is reported.
 */
export async function sendWithRetry(
  client: ApiClient,
  input: Parameters<ApiClient['sendDrop']>[0],
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<SendResult> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 1000;
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await client.sendDrop(input, 120_000);
    } catch (err) {
      last = err;
      const transient =
        err instanceof AgentDropError &&
        (err.code === 'NETWORK_ERROR' || err.code === 'UPSTREAM_UNAVAILABLE' || err.code === 'RATE_LIMITED');
      if (!transient) throw err;
      if (attempt + 1 < attempts) await new Promise((done) => setTimeout(done, delayMs * (attempt + 1)));
    }
  }
  const status = await client.sendRequestStatus(input.request_id).catch(() => null);
  if (status?.outcome === 'delivered' && status.drop_id) {
    const identity = await client.identity();
    return {
      outcome: 'delivered',
      request_id: input.request_id,
      drop_id: status.drop_id,
      recipients: [],
      approval_url: null,
      retryable: false,
      error: null,
      viewer: identity.viewer,
    };
  }
  throw last;
}

export interface SendOptions {
  profile: string;
  to: string;
  title?: string;
  body?: string;
  files?: string[];
  replyTo?: string;
  /** Text piped in; defaults to `readPipedStdin()` when no body was given. */
  stdin?: () => string | null | Promise<string | null>;
  retryDelayMs?: number;
}

export async function sendCommand(out: Output, opts: SendOptions): Promise<void> {
  const t = translator();
  try {
    await send(out, t, opts);
  } catch (err) {
    if (err instanceof SpaceRefusal) throw err;
    throw new SpaceRefusal(sendErrorText(t, err, opts.profile), err);
  }
}

async function send(out: Output, t: Tr, opts: SendOptions): Promise<void> {
  const files = opts.files ?? [];
  const piped = opts.body === undefined ? await (opts.stdin ?? readPipedStdin)() : null;
  const body = opts.body ?? (piped ?? '').replace(/\s+$/, '');
  if (files.length === 0 && !body.trim())
    throw new SpaceRefusal(
      t(
        'Nothing to send: give the text with --body "…" (or -m, or pipe it in) and/or files with --file.',
        '没有可发送的内容：用 --body "…"（或 -m，或用管道传入）写正文，和/或用 --file 附上文件。',
      ),
    );
  if (files.length > LIMITS.MAX_ATTACHMENTS)
    throw new SpaceRefusal(
      t(
        `At most ${LIMITS.MAX_ATTACHMENTS} files go into one message; send the rest in another.`,
        `一条消息最多 ${LIMITS.MAX_ATTACHMENTS} 个文件，其余的请再发一条。`,
      ),
    );
  if (Buffer.byteLength(body, 'utf8') > LIMITS.BODY_MAX_BYTES)
    throw new SpaceRefusal(
      t(
        `The text is longer than ${formatBytes(LIMITS.BODY_MAX_BYTES)}; send long text as a file instead.`,
        `正文超过 ${formatBytes(LIMITS.BODY_MAX_BYTES)}；长文本请作为文件发送。`,
      ),
    );
  const profile = readProfile(opts.profile);
  const { client } = clientFor(opts.profile);
  const contactsUrl = `${(profile?.server_url ?? '').replace(/\/+$/, '')}/app/contacts`;
  const recipient = await resolveRecipient(t, client, opts.to, contactsUrl);
  const reply_to = opts.replyTo ? await resolveDropId(client, opts.replyTo) : undefined;
  const allowedDirs = profile?.allowed_dirs ?? [];
  const explain = (err: unknown, file: string) => sendErrorText(t, err, opts.profile, file);
  let uploaded: UploadFileResult[] = [];
  if (files.length) {
    const identity = await client.identity();
    const total = checkFiles(files, allowedDirs, identity.limits.max_file_bytes, explain);
    if (total > identity.limits.max_drop_file_bytes)
      throw new SpaceRefusal(
        t(
          `These files add up to ${formatBytes(total)}; one message holds at most ${formatBytes(identity.limits.max_drop_file_bytes)}. Send them over several messages.`,
          `这些文件共 ${formatBytes(total)}，一条消息最多 ${formatBytes(identity.limits.max_drop_file_bytes)}，请分几条发送。`,
        ),
      );
    uploaded = await uploadFiles(client, files, allowedDirs, identity.limits.max_file_bytes, explain);
  }
  const title = deriveSendTitle({ ...(opts.title ? { title: opts.title } : {}), body, files });
  const input = {
    request_id: `cli-send-${randomUUID()}`,
    targets: [recipient.target],
    payload: {
      payload_version: 1 as const,
      kind: uploaded.length ? ('file' as const) : ('text' as const),
      title,
      body,
      attachment_ids: uploaded.map((u) => u.attachment_id),
      extensions: {},
      ...(reply_to ? { reply_to } : {}),
    },
  };
  const res = await sendWithRetry(client, input, {
    ...(opts.retryDelayMs !== undefined ? { delayMs: opts.retryDelayMs } : {}),
  });
  if (res.outcome !== 'delivered' && res.outcome !== 'needs_approval') {
    if (out.json) out.result(res, () => '');
    throw new SpaceRefusal(
      t('The server did not take this message; nothing was sent.', '服务器没有接收这条消息；没有发出。'),
    );
  }
  out.result(res, () => sendText(t, res, recipient, title, uploaded, body, opts.profile));
}

/** What a person reads after `agentdrop send`: who it reached, the files, or what to do for an approval. */
export function sendText(
  t: Tr,
  res: Pick<SendResult, 'outcome' | 'drop_id' | 'approval_url'>,
  recipient: Recipient,
  title: string,
  uploaded: Array<Pick<UploadFileResult, 'safe_name' | 'byte_size'>>,
  body: string,
  profile: string,
): string {
  const files = uploaded.map((u) => `  ${u.safe_name}  ${formatBytes(u.byte_size)}`);
  if (res.outcome === 'needs_approval')
    return [
      t(
        `Not sent yet: your message to ${recipient.label} waits for your approval. Open ${res.approval_url ?? 'the dashboard'} to check it, or run agentdrop approvals --profile ${profile} in a terminal.`,
        `还没有发出：发给 ${recipient.label} 的消息需要你先批准。打开 ${res.approval_url ?? '网页'} 核对，或在终端运行 agentdrop approvals --profile ${profile}。`,
      ),
      `  ${title}`,
      ...files,
    ].join('\n');
  const head =
    recipient.kind === 'self'
      ? t(`Put in your space: ${title}`, `已放入我的空间：${title}`)
      : t(
          `Sent to ${recipient.label}: ${title}`,
          `已发给${recipient.label.startsWith('「') ? '' : ' '}${recipient.label}：${title}`,
        );
  return [
    head,
    ...files,
    body.trim() ? t(`  text: ${[...body].length} characters`, `  正文：${[...body].length} 字`) : '',
  ]
    .filter(Boolean)
    .join('\n');
}
