import type { AttachmentMeta } from '@agentdrop/contracts';
import { Download, FileImage, FileText, FileX } from 'lucide-react';
import { useState } from 'react';
import { formatBytes } from '../lib/bytes.js';
import { useT } from '../lib/lang.js';

/**
 * One attachment tile. Raster images are shown inline because that is what an image is for; everything else stays
 * a named file. Nothing here is executed: the server sends image bytes with their real type and `nosniff`, and
 * downgrades script-capable formats (SVG, HTML) to a plain download, so they cannot render. A file removed after the
 * drop was sent (ADR 0029: a group admin freed the group's file space) keeps its name and size but has no download.
 */
export function AttachmentTile({
  a,
  href,
  inGroup = false,
}: {
  a: AttachmentMeta;
  href: string;
  /** The drop went to a group, so a removed file was removed by one of its admins. */
  inGroup?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const removed = a.removed === true;
  const isImage = !removed && /^image\/(png|jpeg|gif|webp|bmp|tiff|avif|heic)\b/i.test(a.content_type);
  const Icon = removed ? FileX : isImage ? FileImage : FileText;
  return (
    <div
      className={`rounded-lg border border-line bg-surface p-2.5 ${isImage && open ? 'sm:col-span-2' : ''}`}
    >
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
          <Icon size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={`truncate text-sm font-medium ${removed ? 'text-muted line-through' : 'text-fg'}`}
            title={a.safe_name}
          >
            {a.safe_name}
          </div>
          <div className="truncate text-xs text-muted">
            {removed
              ? inGroup
                ? t('Removed by a group admin · no longer available', '已被群管理员移除 · 无法再下载')
                : t('Removed · no longer available', '已移除 · 无法再下载')
              : `${a.content_type} · ${formatBytes(a.byte_size)}`}
          </div>
        </div>
        {removed ? null : (
          <a
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
            href={href}
            download
            aria-label={t('Download', '下载')}
            title={t('Download', '下载')}
          >
            <Download size={16} />
          </a>
        )}
      </div>
      {isImage ? (
        <button
          type="button"
          className="mt-2.5 block w-full cursor-zoom-in overflow-hidden rounded-md border border-line bg-bg"
          onClick={() => setOpen((v) => !v)}
          title={open ? t('Collapse', '收起') : t('Click to enlarge', '点击放大')}
        >
          <img
            src={href}
            alt={a.safe_name}
            loading="lazy"
            className={`mx-auto block h-auto w-auto object-contain transition-[max-height] duration-200 ${
              open ? 'max-h-[70vh]' : 'max-h-48'
            }`}
          />
        </button>
      ) : null}
    </div>
  );
}
