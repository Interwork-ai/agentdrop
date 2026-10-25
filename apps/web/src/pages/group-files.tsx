import type { GroupFilesResult } from '@agentdrop/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Download, FileText, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { NavLink } from 'react-router';
import {
  api,
  defaultExportRange,
  downloadExport,
  EXPORT_MAX_DAYS,
  exportDayRange,
  type GroupDetail,
  mailboxUrl,
} from '../lib/api.js';
import { formatBytes, useFormat } from '../lib/format.js';
import { useT } from '../lib/lang.js';
import { useSession } from '../lib/session.js';
import { IconButton, Panel } from '../ui/layout.jsx';
import { Button, ErrorBox, Input, Loading } from '../ui/primitives.jsx';

/*
 * A group's file space (ADR 0029) and its export: the files the group stores, largest first, for its owner and admins
 * to free space, and a date-ranged record of its messages.
 */

/** "Files: 1.2 GB of 2 GB" and a bar; warns from 90 % (ADR 0029). Every member sees it. */
export function StorageBar({ storage }: { storage: { used_bytes: number; limit_bytes: number } }) {
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
export function GroupFiles({
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
export function DisclosurePanel({ summary, children }: { summary: string; children: ReactNode }) {
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
export function GroupExport({
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
