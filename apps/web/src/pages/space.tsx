import type { AttachmentMeta, SpaceDeleteResult } from '@agentdrop/contracts';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { FileText, FolderLock, Paperclip, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  api,
  type DropDetail,
  type DropSummary,
  type Endpoint,
  type ListDrops,
  mailboxUrl,
  newRequestId,
  type SendResult,
} from '../lib/api.js';
import { humanError } from '../lib/error-text.js';
import { formatBytes, plural, useFormat } from '../lib/format.js';
import { type Translate, useT } from '../lib/lang.js';
import { mailboxKey, useSession } from '../lib/session.js';
import { spaceTitle } from '../lib/space.js';
import { AttachmentTile } from '../ui/attachment-tile.jsx';
import { EmptyState, IconButton, PageToolbar, Panel } from '../ui/layout.jsx';
import { NeedsAgentNote } from '../ui/needs-agent.jsx';
import { Button, ErrorBox, Field, Loading, Textarea } from '../ui/primitives.jsx';

/** Mirrors LIMITS in @agentdrop/contracts (the web bundle imports it type-only). */
const MAX_FILES = 10;
/** 64 KiB of UTF-8 holds at least this many characters of any script. */
const NOTE_MAX_CHARS = 20_000;
const PAGE = 20;

/**
 * My space (ADR 0030): what the person keeps for themselves, readable from every agent of theirs, for example to move
 * a file from a laptop to a server. Items are sent to the `self` target, so they are read on arrival and never
 * announced; this page never changes read state. Deleting an item revokes it and frees its files.
 */
export function SpacePage() {
  const { me, currentH } = useSession();
  const t = useT();
  const qc = useQueryClient();
  const hId = currentH?.h_id ?? '';
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announce = (text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 6_000);
  };
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const list = useInfiniteQuery({
    queryKey: mailboxKey(hId, 'space'),
    queryFn: ({ pageParam }) =>
      api.get<ListDrops>(
        mailboxUrl(
          hId,
          `/drops?view=space&limit=${PAGE}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        ),
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!hId,
  });

  const remove = useMutation({
    mutationFn: (dropId: string) =>
      api.delete<SpaceDeleteResult>(mailboxUrl(hId, `/space/${encodeURIComponent(dropId)}`)),
    onSuccess: (res) => {
      announce(
        res.freed_bytes > 0
          ? t(
              `Deleted · freed ${formatBytes(res.freed_bytes)}`,
              `已删除 · 释放了 ${formatBytes(res.freed_bytes)}`,
            )
          : t('Deleted', '已删除'),
      );
      // Take it out of the list first and forget its detail: refetching the detail of a deleted item would only 404.
      qc.setQueryData<InfiniteData<ListDrops>>(mailboxKey(hId, 'space'), (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p) => ({
                ...p,
                drops: p.drops.filter((x) => x.drop_id !== res.drop_id),
              })),
            }
          : old,
      );
      qc.removeQueries({ queryKey: mailboxKey(hId, 'space-item', res.drop_id) });
      qc.invalidateQueries({ queryKey: mailboxKey(hId, 'space') });
    },
  });

  if (!me) return null;
  const endpoints = me.endpoints.filter((e) => !e.revoked_at);
  const items = (list.data?.pages ?? []).flatMap((p) => p.drops);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageToolbar title={t('My space', '我的空间')} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full min-w-0 max-w-3xl space-y-5 p-4 md:p-6">
          <p className="text-sm leading-6 text-muted">
            {t(
              'Keep files and notes for yourself and pick them up on any of your agents, for example to move a file from your laptop to a server.',
              '把文件和备注留给自己，在你的任何一个 Agent 上都能取用，比如把笔记本上的文件挪到服务器上。',
            )}
          </p>
          {endpoints.length === 0 ? (
            <NeedsAgentNote what="send" />
          ) : (
            <PutIn
              key={hId}
              endpoints={endpoints}
              defaultH={hId}
              onDone={(fromH) => {
                announce(t('Kept in My space', '已放进我的空间'));
                qc.invalidateQueries({ queryKey: mailboxKey(hId, 'space') });
                if (fromH !== hId) qc.invalidateQueries({ queryKey: mailboxKey(fromH, 'space') });
              }}
            />
          )}

          {notice ? (
            <p
              role="status"
              className="rounded-lg border border-ok-line bg-ok-bg px-3 py-2 text-sm font-medium text-ok"
            >
              {notice}
            </p>
          ) : null}
          {remove.isError ? <ErrorBox error={remove.error} /> : null}
          {list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : null}

          {hId ? (
            <section aria-label={t('Items in my space', '我的空间里的条目')} className="space-y-3">
              {list.isLoading ? <Loading /> : null}
              {list.data && items.length === 0 ? (
                <div className="card rounded-xl border border-line">
                  <EmptyState icon={<FolderLock size={20} />} title={t('Nothing here yet', '这里还是空的')}>
                    {t(
                      'Put a file or a note in above. Your agents can also put things here and fetch them when you ask.',
                      '在上面放进文件或备注。你也可以让 Agent 把东西放进来，需要时再让它取。',
                    )}
                  </EmptyState>
                </div>
              ) : null}
              {items.length > 0 ? (
                <ul className="card overflow-hidden rounded-xl border border-line">
                  {items.map((d) => (
                    <SpaceItem
                      key={d.drop_id}
                      d={d}
                      hId={hId}
                      endpoints={me.endpoints}
                      deleting={remove.isPending && remove.variables === d.drop_id}
                      onDelete={() => {
                        if (
                          confirm(
                            t(
                              `Delete “${d.title}” from My space? It disappears from all of your agents; files you already downloaded stay where they are.`,
                              `从我的空间删除「${d.title}」？它会从你所有的 Agent 上消失；已下载的文件不受影响。`,
                            ),
                          )
                        )
                          remove.mutate(d.drop_id);
                      }}
                    />
                  ))}
                </ul>
              ) : null}
              {list.hasNextPage ? (
                <Button onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                  {list.isFetchingNextPage ? t('Loading…', '加载中…') : t('Load more', '加载更多')}
                </Button>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Choose files and/or write a note, pick which agent of mine puts it in, and keep it. */
function PutIn({
  endpoints,
  defaultH,
  onDone,
}: {
  endpoints: Endpoint[];
  defaultH: string;
  onDone: (fromH: string) => void;
}) {
  const t = useT();
  const [fromH, setFromH] = useState(defaultH || endpoints[0]?.h_id || '');
  const [files, setFiles] = useState<AttachmentMeta[]>([]);
  const [note, setNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);
  const from = endpoints.find((e) => e.h_id === fromH);
  // One request_id per submitted draft, as in the composer: a retry after a network error never keeps it twice.
  const requestId = useRef(newRequestId());
  const submittedDraft = useRef<string | null>(null);
  const noteId = useId();
  const title = spaceTitle(files, note);

  async function onFiles(list: FileList | null) {
    if (!list || !fromH) return;
    const room = MAX_FILES - files.length;
    const chosen = Array.from(list);
    if (chosen.length > room) {
      setUploadError(t(`Up to ${MAX_FILES} files per item.`, `每个条目最多 ${MAX_FILES} 个文件。`));
      if (room <= 0) return;
    } else setUploadError(null);
    setUploading(true);
    try {
      for (const f of chosen.slice(0, room)) {
        const meta = await api.upload<AttachmentMeta>(mailboxUrl(fromH, '/attachments'), f);
        setFiles((prev) => [...prev, meta]);
      }
    } catch (err) {
      setUploadError(humanError(err).text);
    } finally {
      setUploading(false);
    }
  }

  const put = useMutation({
    mutationFn: () => {
      const draft = JSON.stringify({ fromH, note, files: files.map((f) => f.attachment_id) });
      if (submittedDraft.current !== null && submittedDraft.current !== draft)
        requestId.current = newRequestId();
      submittedDraft.current = draft;
      return api.post<SendResult>(mailboxUrl(fromH, '/drops'), {
        request_id: requestId.current,
        targets: [{ type: 'self' }],
        payload: {
          payload_version: 1,
          kind: files.length ? 'file' : 'text',
          title,
          body: note,
          attachment_ids: files.map((f) => f.attachment_id),
          extensions: {},
        },
      });
    },
    onSuccess: () => {
      const from = fromH;
      setFiles([]);
      setNote('');
      setUploadError(null);
      requestId.current = newRequestId();
      submittedDraft.current = null;
      onDone(from);
    },
  });

  const canPut = !!fromH && !!title && !uploading && !put.isPending;
  const busy = uploading || put.isPending;

  return (
    <Panel
      title={t('Put something in', '放进去')}
      description={t(
        'Files count against the upload space of the agent that puts them in; deleting an item frees it.',
        '文件占用放入它的那个 Agent 的上传空间；删除条目即可释放。',
      )}
    >
      {/* one line by default: the sidebar's agent puts it in; "Change" opens the picker only when wanted */}
      {picking && endpoints.length > 1 ? (
        <Field label={t('Put in from', '放入自')}>
          <select
            aria-label={t('Agent that puts it in', '放入的 Agent')}
            className="h-9 w-full rounded-lg border border-line-strong bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent/60"
            value={fromH}
            disabled={busy}
            // biome-ignore lint/a11y/noAutofocus: the person just asked to change it
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setPicking(false);
                requestAnimationFrame(() => changeRef.current?.focus());
              }
            }}
            onChange={(e) => {
              setFromH(e.target.value);
              // an upload belongs to the agent that made it, so it cannot go out from another one
              setFiles([]);
              setUploadError(null);
              setPicking(false);
              requestAnimationFrame(() => changeRef.current?.focus());
            }}
          >
            {endpoints.map((e) => (
              <option key={e.h_id} value={e.h_id}>
                {e.label} · {e.device.label}
              </option>
            ))}
          </select>
        </Field>
      ) : from ? (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-fg-2">
          <span>{t('Put in from', '放入自')}</span>
          <span className="break-words font-medium text-fg">{from.label}</span>
          <span className="text-dim">· {from.device.label}</span>
          {endpoints.length > 1 ? (
            <button
              ref={changeRef}
              type="button"
              disabled={busy}
              aria-label={t('Change the agent that puts it in', '更换放入的 Agent')}
              className="rounded-md px-1 font-medium text-accent-fg hover:underline disabled:opacity-40"
              onClick={() => setPicking(true)}
            >
              {t('Change', '更换')}
            </button>
          ) : null}
        </p>
      ) : null}

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
            if (!busy && fromH) void onFiles(e.dataTransfer.files);
          }}
          className={`relative flex cursor-pointer items-center gap-3 rounded-xl border border-dashed px-4 py-3.5 transition-colors ${
            dragging
              ? 'border-accent bg-accent/8'
              : 'border-line-strong bg-surface hover:border-accent/40 hover:bg-accent/5'
          }`}
        >
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
            <Paperclip size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-fg-2">
              {uploading ? t('Uploading…', '上传中…') : t('Choose files', '选择文件')}
            </span>
            <span className="block text-xs text-dim">
              {t(
                `Or drop them here. Up to 50 MiB per file and ${MAX_FILES} files per item`,
                `也可以把文件拖到这里。每个文件 ≤ 50 MiB，每个条目最多 ${MAX_FILES} 个`,
              )}
            </span>
          </span>
          <input
            className="sr-only"
            type="file"
            multiple
            onChange={(e) => {
              void onFiles(e.target.files);
              e.target.value = '';
            }}
            disabled={busy || !fromH || files.length >= MAX_FILES}
          />
        </label>
        {uploadError ? <p className="text-xs text-danger">{uploadError}</p> : null}
        {files.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {files.map((f) => (
              <li
                key={f.attachment_id}
                className="flex min-w-0 items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2"
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
                  disabled={put.isPending}
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

      <div className="space-y-1.5">
        <label htmlFor={noteId} className="text-sm font-medium text-fg-2">
          {t('Note (optional)', '备注（可选）')}
        </label>
        <Textarea
          id={noteId}
          rows={3}
          maxLength={NOTE_MAX_CHARS}
          value={note}
          disabled={put.isPending}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t(
            'What it is, or a snippet you want on the other machine',
            '它是什么，或者想带到另一台机器上的一段文字',
          )}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 truncate text-xs text-dim" title={title}>
          {title
            ? t(`Kept as “${title}”`, `保存为「${title}」`)
            : t('Choose a file or write a note first.', '先选择文件或写一段备注。')}
        </p>
        <Button variant="primary" className="h-9" disabled={!canPut} onClick={() => put.mutate()}>
          {put.isPending ? t('Putting in…', '正在放入…') : t('Put in', '放进去')}
        </Button>
      </div>
      {put.isError ? (
        <ErrorBox
          error={put.error}
          retry={() => {
            if (canPut) put.mutate();
          }}
        />
      ) : null}
    </Panel>
  );
}

/** One kept item: its note, its files with download links, when and from which of my agents, and Delete. */
function SpaceItem({
  d,
  hId,
  endpoints,
  deleting,
  onDelete,
}: {
  d: DropSummary;
  hId: string;
  endpoints: Endpoint[];
  deleting: boolean;
  onDelete: () => void;
}) {
  const t = useT();
  const fmt = useFormat();
  // The list carries only a preview and a file count; the detail has the whole note (first part) and the files.
  const detail = useQuery({
    queryKey: mailboxKey(hId, 'space-item', d.drop_id),
    queryFn: () =>
      api.get<{ drop: DropDetail }>(
        mailboxUrl(hId, `/drops/${encodeURIComponent(d.drop_id)}?max_chars=2048`),
      ),
    staleTime: 60_000,
  });
  const full = detail.data?.drop;
  const note = full ? full.body_chunk : d.preview;
  const truncated = full ? full.next_offset !== null : false;
  return (
    <li className="border-b border-line px-4 py-3.5 last:border-b-0">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-base font-medium text-fg">{d.title}</h2>
          <p className="mt-0.5 text-xs text-dim">
            <span title={fmt.dateTime(d.created_at)}>{fmt.short(d.created_at)}</span>
            {' · '}
            {putBy(d, endpoints, t)}
          </p>
        </div>
        <IconButton label={t(`Delete ${d.title}`, `删除 ${d.title}`)} disabled={deleting} onClick={onDelete}>
          <Trash2 size={15} />
        </IconButton>
      </div>
      {note ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-fg-2">
          {note}
          {truncated ? '…' : ''}
        </p>
      ) : null}
      {d.attachment_count > 0 ? (
        <div className="mt-3">
          {detail.isError ? <ErrorBox error={detail.error} retry={() => detail.refetch()} /> : null}
          {full ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {full.attachments.map((a) => (
                <AttachmentTile
                  key={a.attachment_id}
                  a={a}
                  href={mailboxUrl(hId, `/drops/${d.drop_id}/attachments/${a.attachment_id}`)}
                />
              ))}
            </div>
          ) : detail.isLoading ? (
            <p className="text-xs text-dim" aria-busy="true">
              {t(
                `${plural(d.attachment_count, 'file', 'files')} · loading…`,
                `${d.attachment_count} 个文件 · 加载中…`,
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Which of my agents put it in (own attribution only: the person's own agents, ADR 0013). */
function putBy(d: DropSummary, endpoints: Endpoint[], t: Translate): string {
  const origin = d.origin_agent;
  if (!origin) return t('from the dashboard', '来自网页');
  const e = endpoints.find((x) => x.h_id === origin.h_id);
  const name = e ? `${e.label} · ${e.device.label}` : origin.agent_name;
  return t(`from ${name}`, `来自 ${name}`);
}
