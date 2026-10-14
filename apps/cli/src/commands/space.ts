import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { AgentDropError, type ApiClient } from '@agentdrop/client';
import {
  type AttachmentMeta,
  type DropSummary,
  LIMITS,
  type ListDropsInput,
  type OriginAgent,
  type SendResult,
  type UploadFileResult,
} from '@agentdrop/contracts';
import { openAllowedFile, safeFilename } from '@agentdrop/security';
import { downloadAttachment, FileExistsFailure, uploadLocalFile } from '../files.js';
import { readLanguage } from '../locale.js';
import type { Output } from '../output.js';
import { downloadsDir } from '../paths.js';
import { readProfile } from '../store.js';
import { clientFor } from './mail.js';

/**
 * `agentdrop space put | list | get | rm`: the person's own space (ADR 0030) from a terminal. An item is a drop sent
 * to the single target `self`: it reaches every agent of the account, is read on arrival and is announced nowhere,
 * so a file put in on one machine can be pulled down on another. Uploads obey the same path policy as upload_file;
 * downloads are verified, never executed or extracted, and never overwrite a file unless asked to.
 *
 * Everything printed here is read by a person: English, or Chinese after `agentdrop settings --language zh`.
 */

type Tr = (en: string, zh: string) => string;
function translator(): Tr {
  const zh = readLanguage() === 'zh';
  return (en, zhText) => (zh ? zhText : en);
}

const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Pages of the space searched for an id prefix: the 200 newest items. */
const PREFIX_PAGES = 4;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Local time, minutes: what a person reads as "when". */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function originText(t: Tr, origin: OriginAgent | null): string {
  return origin
    ? t(
        `from ${origin.agent_name} [${origin.harness_key}]`,
        `来自 ${origin.agent_name} [${origin.harness_key}]`,
      )
    : t('from the dashboard', '来自网页');
}

/** Title of a new item: --title, else the first file's name (+N more), else the note's first line. */
export function deriveTitle(opts: { title?: string; files: string[]; note?: string }): string {
  const clean = (s: string) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: titles must not carry control characters
    s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
  const cut = (s: string) => [...s].slice(0, LIMITS.TITLE_MAX_CHARS).join('');
  const given = clean(opts.title ?? '');
  if (given) return cut(given);
  const first = opts.files[0];
  if (first) {
    const name = safeFilename(basename(first));
    return cut(opts.files.length > 1 ? `${name} +${opts.files.length - 1}` : name);
  }
  const line = clean((opts.note ?? '').split('\n').find((l) => l.trim()) ?? '');
  return cut(line);
}

/** One sentence for the person, by error code; anything unrecognised keeps its own message. */
export function spaceErrorText(t: Tr, err: unknown, profile: string): string {
  if (err instanceof FileExistsFailure)
    return t(
      `${err.fileName} already exists there; nothing was overwritten. Add --force to replace it, or choose another folder with --to.`,
      `那里已有 ${err.fileName}，没有覆盖。要替换请加 --force，或用 --to 换一个文件夹。`,
    );
  if (!(err instanceof AgentDropError)) return err instanceof Error ? err.message : String(err);
  switch (err.code) {
    case 'QUOTA_EXCEEDED':
      return t(
        `This agent's upload space is full. Free space by deleting items from your space: agentdrop space list --profile ${profile}, then agentdrop space rm <id> --profile ${profile}.`,
        `这个 Agent 的上传空间已满。删除“我的空间”里的条目即可腾出空间：先运行 agentdrop space list --profile ${profile}，再运行 agentdrop space rm <id> --profile ${profile}。`,
      );
    case 'FILE_TOO_LARGE': {
      const limit = typeof err.details?.limit === 'number' ? formatBytes(err.details.limit) : null;
      return t(
        `The file is larger than this server accepts${limit ? ` (at most ${limit})` : ''}.`,
        `文件超过了服务器允许的大小${limit ? `（最多 ${limit}）` : ''}。`,
      );
    }
    case 'FILE_REMOVED':
      return t(
        'This file was removed after it was put in (deleted from your space, or by a group admin); it can no longer be downloaded.',
        '这个文件放进来之后已被删除（从你的空间删掉，或被群管理员移除），无法再下载。',
      );
    case 'PATH_NOT_ALLOWED':
      if (/sensitive/.test(err.message))
        return t(
          'That file looks like a key or credential, so it is never uploaded.',
          '这个文件看起来是密钥或凭据，不会上传。',
        );
      if (/not exist|not readable/.test(err.message))
        return t('That file does not exist or cannot be read.', '这个文件不存在或无法读取。');
      if (/regular files/.test(err.message))
        return t('Only regular files can be put in, not folders.', '只能放入普通文件，不能放文件夹。');
      if (!/outside|no allowed/.test(err.message))
        return t(
          'That file could not be read safely, so it was not put in.',
          '这个文件无法安全读取，没有放入。',
        );
      return t(
        `That file is outside the folders this profile may upload from. Allow its folder with: agentdrop allow-dir add <folder> --profile ${profile}`,
        `这个文件不在此配置允许上传的文件夹里。允许它所在的文件夹：agentdrop allow-dir add <文件夹> --profile ${profile}`,
      );
    case 'NOT_FOUND':
    case 'FORBIDDEN':
      return t('There is no such item in your space.', '你的空间里没有这个条目。');
    case 'VALIDATION_FAILED':
      return t(
        'The server refused this. It may be older than this CLI and not have My space yet.',
        '服务器拒绝了这个操作。它可能比这个 CLI 旧，还没有“我的空间”。',
      );
    case 'NETWORK_ERROR':
    case 'UPSTREAM_UNAVAILABLE':
      return t(
        `The server could not be reached. Try again later, or run agentdrop doctor --profile ${profile}.`,
        `连不上服务器。请稍后再试，或运行 agentdrop doctor --profile ${profile}。`,
      );
    case 'UNAUTHORIZED':
    case 'ENDPOINT_REVOKED':
      return t(
        `This profile's credential no longer works; pair it again with agentdrop endpoint add --profile ${profile}.`,
        `这个配置的凭据已失效；请用 agentdrop endpoint add --profile ${profile} 重新配对。`,
      );
    default:
      return err.message;
  }
}

/** Runs a space command and turns any failure into the person's sentence. */
async function guarded(profile: string, run: (t: Tr) => Promise<void>): Promise<void> {
  const t = translator();
  try {
    await run(t);
  } catch (err) {
    if (err instanceof SpaceRefusal) throw err;
    throw new SpaceRefusal(spaceErrorText(t, err, profile), err);
  }
}

/** A failure already worded for the person (also used by `agentdrop send`). */
export class SpaceRefusal extends Error {
  readonly code: string | undefined;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.code = cause instanceof AgentDropError ? cause.code : undefined;
  }
}

function spaceList(client: ApiClient, input: { limit: number; cursor?: string }) {
  return client.listDrops({ view: 'space', ...input } as ListDropsInput);
}

/* ------------------------------------------------------------------ put */

export async function spacePutCommand(
  out: Output,
  opts: { profile: string; files: string[]; note?: string; title?: string },
): Promise<void> {
  await guarded(opts.profile, async (t) => {
    const note = opts.note ?? '';
    if (opts.files.length === 0 && !note.trim())
      throw new SpaceRefusal(
        t(
          'Nothing to put in: give one or more files, or --note "…".',
          '没有可放入的内容：请给出文件，或用 --note "…" 写一段备注。',
        ),
      );
    if (opts.files.length > LIMITS.MAX_ATTACHMENTS)
      throw new SpaceRefusal(
        t(
          `At most ${LIMITS.MAX_ATTACHMENTS} files go into one item; put the rest in another.`,
          `一个条目最多放 ${LIMITS.MAX_ATTACHMENTS} 个文件，其余的请另放一次。`,
        ),
      );
    if (Buffer.byteLength(note, 'utf8') > LIMITS.BODY_MAX_BYTES)
      throw new SpaceRefusal(
        t(
          `The note is longer than ${formatBytes(LIMITS.BODY_MAX_BYTES)}; put long text in a file instead.`,
          `备注超过 ${formatBytes(LIMITS.BODY_MAX_BYTES)}；长文本请放在文件里。`,
        ),
      );
    const profile = readProfile(opts.profile);
    const { client } = clientFor(opts.profile);
    const identity = await client.identity();
    const allowedDirs = profile?.allowed_dirs ?? [];
    const explain = (err: unknown) => spaceErrorText(t, err, opts.profile);
    const total = checkFiles(opts.files, allowedDirs, identity.limits.max_file_bytes, explain);
    if (total > identity.limits.max_drop_file_bytes)
      throw new SpaceRefusal(
        t(
          `These files add up to ${formatBytes(total)}; one item holds at most ${formatBytes(identity.limits.max_drop_file_bytes)}. Put them in over several items.`,
          `这些文件共 ${formatBytes(total)}，一个条目最多 ${formatBytes(identity.limits.max_drop_file_bytes)}，请分几次放入。`,
        ),
      );
    const uploaded = await uploadFiles(
      client,
      opts.files,
      allowedDirs,
      identity.limits.max_file_bytes,
      explain,
    );
    const title = deriveTitle({
      ...(opts.title ? { title: opts.title } : {}),
      files: opts.files,
      note,
    });
    const request_id = `space-${randomUUID()}`;
    const input = {
      request_id,
      targets: [{ type: 'self' as const }],
      payload: {
        payload_version: 1 as const,
        kind: uploaded.length ? ('file' as const) : ('text' as const),
        title,
        body: note,
        attachment_ids: uploaded.map((u) => u.attachment_id),
        extensions: {},
      },
    };
    const res = await sendOnce(client, input);
    if (res.outcome === 'needs_approval')
      throw new SpaceRefusal(
        t(
          `Not put in yet: it waits for your approval${res.approval_url ? ` at ${res.approval_url}` : ' in the dashboard'}.`,
          `还没有放入：需要你先批准${res.approval_url ? `（${res.approval_url}）` : '（在网页上）'}。`,
        ),
      );
    if (res.outcome !== 'delivered' || !res.drop_id)
      throw new SpaceRefusal(
        t('The server did not keep it; nothing was put in.', '服务器没有保存，未放入任何内容。'),
      );
    const result = {
      drop_id: res.drop_id,
      title,
      files: uploaded.map((u) => ({
        attachment_id: u.attachment_id,
        safe_name: u.safe_name,
        byte_size: u.byte_size,
      })),
      note_chars: [...note].length,
      viewer: res.viewer,
    };
    out.result(result, () =>
      [
        t(
          `Put in your space: ${title}  (${res.drop_id?.slice(0, 8)})`,
          `已放入我的空间：${title}（${res.drop_id?.slice(0, 8)}）`,
        ),
        ...uploaded.map((u) => `  ${u.safe_name}  ${formatBytes(u.byte_size)}`),
        note.trim() ? t(`  note: ${[...note].length} characters`, `  备注：${[...note].length} 字`) : '',
        t(
          `Every agent of yours can get it: agentdrop space get ${res.drop_id?.slice(0, 8)} --profile <profile>`,
          `你的每个 Agent 都能取回：agentdrop space get ${res.drop_id?.slice(0, 8)} --profile <配置名>`,
        ),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  });
}

/**
 * Checks every path with upload_file's policy before any is uploaded, so one refused file does not leave the
 * others half-sent. Returns their total size; a refusal names the file and `explain`s why, for the person.
 */
export function checkFiles(
  files: string[],
  allowedDirs: string[],
  maxFileBytes: number,
  explain: (err: unknown, file: string) => string,
): number {
  let total = 0;
  for (const file of files) {
    try {
      const check = openAllowedFile(file, allowedDirs, maxFileBytes);
      closeSync(check.fd);
      total += check.size;
    } catch (err) {
      throw new SpaceRefusal(`${basename(file)}: ${explain(err, file)}`, err);
    }
  }
  return total;
}

/** Uploads checked files in order through the same path policy as upload_file. */
export async function uploadFiles(
  client: ApiClient,
  files: string[],
  allowedDirs: string[],
  maxFileBytes: number,
  explain: (err: unknown, file: string) => string,
): Promise<UploadFileResult[]> {
  const uploaded: UploadFileResult[] = [];
  for (const file of files) {
    try {
      uploaded.push(await uploadLocalFile(client, { path: file, allowedDirs, maxBytes: maxFileBytes }));
    } catch (err) {
      throw new SpaceRefusal(`${basename(file)}: ${explain(err, file)}`, err);
    }
  }
  return uploaded;
}

/** A transport failure leaves the outcome unknown: ask once by request_id before reporting a failure. */
async function sendOnce(client: ApiClient, input: Parameters<ApiClient['sendDrop']>[0]): Promise<SendResult> {
  try {
    return await client.sendDrop(input, 120_000);
  } catch (err) {
    if (!(err instanceof AgentDropError) || err.code !== 'NETWORK_ERROR') throw err;
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
    throw err;
  }
}

/* ------------------------------------------------------------------ list */

interface SpaceItem {
  drop_id: string;
  title: string;
  created_at: string;
  origin_agent: OriginAgent | null;
  note_preview: string;
  files: Array<Pick<AttachmentMeta, 'attachment_id' | 'safe_name' | 'byte_size'> & { removed: boolean }>;
}

/** Files of each item: summaries carry only a count, so items with files are read once each (body cut to 1 char). */
async function withFiles(client: ApiClient, drops: DropSummary[]): Promise<SpaceItem[]> {
  return Promise.all(
    drops.map(async (d) => {
      const files =
        d.attachment_count > 0
          ? (await client.readDrop({ drop_id: d.drop_id, max_chars: 1 })).drop.attachments.map((a) => ({
              attachment_id: a.attachment_id,
              safe_name: a.safe_name,
              byte_size: a.byte_size,
              removed: a.removed === true,
            }))
          : [];
      return {
        drop_id: d.drop_id,
        title: d.title,
        created_at: d.created_at,
        origin_agent: d.origin_agent,
        note_preview: d.preview,
        files,
      };
    }),
  );
}

export async function spaceListCommand(
  out: Output,
  opts: { profile: string; limit?: number },
): Promise<void> {
  await guarded(opts.profile, async (t) => {
    const limit = Math.min(Math.max(opts.limit ?? LIMITS.LIST_LIMIT_DEFAULT, 1), LIMITS.LIST_LIMIT_MAX);
    const { client } = clientFor(opts.profile);
    const res = await spaceList(client, { limit });
    const items = await withFiles(client, res.drops);
    out.result({ items, next_cursor: res.next_cursor, viewer: res.viewer }, () => {
      if (items.length === 0)
        return t(
          `Your space is empty. Put something in: agentdrop space put <files…> --profile ${opts.profile}`,
          `你的空间是空的。放入内容：agentdrop space put <文件…> --profile ${opts.profile}`,
        );
      const lines = [
        t(`My space · ${items.length} item(s), newest first`, `我的空间 · ${items.length} 条，最新的在前`),
      ];
      for (const item of items) {
        lines.push(`${item.drop_id.slice(0, 8)}  ${when(item.created_at)}  ${item.title}`);
        if (item.files.length)
          lines.push(
            `          ${item.files
              .map((f) =>
                f.removed
                  ? t(`${f.safe_name} (removed)`, `${f.safe_name}（已删除）`)
                  : `${f.safe_name} ${formatBytes(f.byte_size)}`,
              )
              .join(' · ')}`,
          );
        else if (item.note_preview.trim())
          lines.push(`          ${item.note_preview.replace(/\s+/g, ' ').slice(0, 80)}`);
        lines.push(`          ${originText(t, item.origin_agent)}`);
      }
      if (res.next_cursor)
        lines.push(
          t(
            'Older items are not shown; raise --limit to see more.',
            '更早的条目未显示；加大 --limit 可查看更多。',
          ),
        );
      lines.push(
        t(
          `Get one: agentdrop space get <id> --profile ${opts.profile}   Delete one: agentdrop space rm <id> --profile ${opts.profile}`,
          `取回：agentdrop space get <id> --profile ${opts.profile}   删除：agentdrop space rm <id> --profile ${opts.profile}`,
        ),
      );
      return lines.join('\n');
    });
  });
}

/* ------------------------------------------------------------------ get / rm: which item */

/** A full id, or a prefix (at least 4 characters) of exactly one of the newest items; or the latest one. */
async function resolveItem(
  t: Tr,
  client: ApiClient,
  target: { id?: string; latest?: boolean },
): Promise<{ drop_id: string; summary: DropSummary | null }> {
  if (target.id && target.latest)
    throw new SpaceRefusal(t('Give an id or --latest, not both.', 'id 和 --latest 只能给一个。'));
  if (!target.id) {
    const res = await spaceList(client, { limit: 1 });
    const first = res.drops[0];
    if (!first) throw new SpaceRefusal(t('Your space is empty.', '你的空间是空的。'));
    return { drop_id: first.drop_id, summary: first };
  }
  const wanted = target.id.trim().toLowerCase();
  if (FULL_ID.test(wanted)) return { drop_id: wanted, summary: null };
  if (!/^[0-9a-f-]{4,}$/.test(wanted))
    throw new SpaceRefusal(
      t(
        'Give the id shown by agentdrop space list (at least its first 4 characters).',
        '请给出 agentdrop space list 显示的 id（至少前 4 个字符）。',
      ),
    );
  const matches: DropSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PREFIX_PAGES; page += 1) {
    const res = await spaceList(client, { limit: LIMITS.LIST_LIMIT_MAX, ...(cursor ? { cursor } : {}) });
    matches.push(...res.drops.filter((d) => d.drop_id.startsWith(wanted)));
    if (!res.next_cursor) break;
    cursor = res.next_cursor;
  }
  const only = matches[0];
  if (matches.length === 1 && only) return { drop_id: only.drop_id, summary: only };
  throw new SpaceRefusal(
    matches.length === 0
      ? t(`No item in your space starts with ${wanted}.`, `你的空间里没有以 ${wanted} 开头的条目。`)
      : t(
          `${matches.length} items start with ${wanted}; give more characters of the id.`,
          `有 ${matches.length} 个条目以 ${wanted} 开头；请多给几个字符。`,
        ),
  );
}

/* ------------------------------------------------------------------ get */

export async function spaceGetCommand(
  out: Output,
  opts: { profile: string; id?: string; latest?: boolean; to?: string; force?: boolean },
): Promise<void> {
  await guarded(opts.profile, async (t) => {
    const { client } = clientFor(opts.profile);
    const { drop_id } = await resolveItem(t, client, {
      ...(opts.id ? { id: opts.id } : {}),
      ...(opts.latest ? { latest: true } : {}),
    });
    const detail = (await client.readDrop({ drop_id, max_chars: LIMITS.READ_MAX_CHARS })).drop;
    const dir = opts.to ? resolve(opts.to) : join(downloadsDir(), drop_id);
    if (opts.to && existsSync(dir) && !statSync(dir).isDirectory())
      throw new SpaceRefusal(t(`${opts.to} is not a folder.`, `${opts.to} 不是文件夹。`));
    // Names are fixed before anything is written: two files with one name in an item get -1, -2.
    const taken = new Set<string>();
    const plan = detail.attachments.map((a) => {
      const base = safeFilename(a.safe_name);
      const dot = base.lastIndexOf('.');
      let name = base;
      for (let i = 1; taken.has(name); i += 1)
        name = dot > 0 ? `${base.slice(0, dot)}-${i}${base.slice(dot)}` : `${base}-${i}`;
      taken.add(name);
      return { meta: a, name };
    });
    if (!opts.force) {
      const clash = plan.find((p) => !p.meta.removed && existsSync(join(dir, p.name)));
      if (clash) throw new FileExistsFailure(clash.name);
    }
    const { limits } = await client.identity();
    const saved: Array<{ attachment_id: string; safe_name: string; saved_path: string; byte_size: number }> =
      [];
    const removed: string[] = [];
    for (const p of plan) {
      if (p.meta.removed) {
        removed.push(p.name);
        continue;
      }
      try {
        const r = await downloadAttachment(
          client,
          { drop_id, attachment_id: p.meta.attachment_id },
          { dir, maxBytes: limits.max_file_bytes, existing: opts.force ? 'replace' : 'refuse', name: p.name },
        );
        saved.push({
          attachment_id: p.meta.attachment_id,
          safe_name: p.name,
          saved_path: r.saved_path,
          byte_size: r.byte_size,
        });
      } catch (err) {
        if (err instanceof AgentDropError && err.code === 'FILE_REMOVED') removed.push(p.name);
        else throw err;
      }
    }
    if (saved.length === 0 && removed.length > 0)
      throw new SpaceRefusal(
        removed.length === 1
          ? spaceErrorText(t, new AgentDropError('FILE_REMOVED'), opts.profile)
          : t(
              'The files of this item were removed after they were put in; they can no longer be downloaded.',
              '这个条目的文件放进来之后已被删除，无法再下载。',
            ),
        new AgentDropError('FILE_REMOVED'),
      );
    const note = detail.body_chunk;
    out.result(
      {
        drop_id,
        title: detail.title,
        directory: dir,
        saved,
        removed,
        note,
        note_truncated: detail.next_offset !== null,
      },
      () =>
        [
          `${detail.title}  (${drop_id.slice(0, 8)} · ${when(detail.created_at)} · ${originText(t, detail.origin_agent)})`,
          saved.length
            ? t(`Saved ${saved.length} file(s) to ${dir}:`, `已保存 ${saved.length} 个文件到 ${dir}：`)
            : detail.attachments.length === 0
              ? t('No files in this item.', '这个条目没有文件。')
              : '',
          ...saved.map((s) => `  ${s.safe_name}  ${formatBytes(s.byte_size)}`),
          ...removed.map((name) =>
            t(`  ${name}: removed, can no longer be downloaded`, `  ${name}：已删除，无法再下载`),
          ),
          note.trim() ? t('Note:', '备注：') : '',
          note.trim() ? note : '',
          detail.next_offset !== null
            ? t('(the note continues; open it in the dashboard)', '（备注未显示完，可在网页上查看）')
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
    );
  });
}

/* ------------------------------------------------------------------ rm */

export async function spaceRmCommand(out: Output, opts: { profile: string; id: string }): Promise<void> {
  await guarded(opts.profile, async (t) => {
    const { client } = clientFor(opts.profile);
    const { drop_id, summary } = await resolveItem(t, client, { id: opts.id });
    const res = await client.deleteSpaceItem(drop_id);
    out.result({ ...res, title: summary?.title ?? null }, () =>
      summary
        ? t(
            `Deleted from your space: ${summary.title} (${drop_id.slice(0, 8)}); freed ${formatBytes(res.freed_bytes)}.`,
            `已从我的空间删除：${summary.title}（${drop_id.slice(0, 8)}），释放 ${formatBytes(res.freed_bytes)}。`,
          )
        : t(
            `Deleted ${drop_id.slice(0, 8)} from your space; freed ${formatBytes(res.freed_bytes)}.`,
            `已从我的空间删除 ${drop_id.slice(0, 8)}，释放 ${formatBytes(res.freed_bytes)}。`,
          ),
    );
  });
}
