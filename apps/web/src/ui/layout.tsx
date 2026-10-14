import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../lib/lang.js';

/*
 * Layout primitives shared by every dashboard page (docs/DESIGN.md). Pages compose these
 * instead of inventing their own headers, split panes, cards or tabs, so spacing, type and colour stay consistent.
 * Only theme tokens are used here: surfaces, lines, fg/muted/dim, accent and the ok/warn/danger/info states.
 */

/** The one header row of a page or pane: back button on small screens, title, optional count, actions. */
export function PageToolbar({
  title,
  count,
  onBack,
  actions,
  children,
  sticky = true,
  backLabel,
}: {
  title: ReactNode;
  /** A number, or a short summary such as "37 · 13 unread". */
  count?: number | string;
  /** Shown below `lg` only: returns from a detail pane to its list. */
  onBack?: () => void;
  /** Accessible name of the back button, for example "Back to contacts". */
  backLabel?: string;
  actions?: ReactNode;
  /** A second row (search, filters) under the title. */
  children?: ReactNode;
  sticky?: boolean;
}) {
  const t = useT();
  return (
    <div className={`${sticky ? 'glass sticky top-0 z-10' : ''} border-b border-line`}>
      <div className="flex h-14 items-center gap-2 px-4 md:px-5">
        {onBack ? (
          <IconButton label={backLabel ?? t('Back', '返回')} className="-ml-1.5 lg:hidden" onClick={onBack}>
            <ArrowLeft size={16} />
          </IconButton>
        ) : null}
        <h1 className="min-w-0 truncate text-md font-semibold text-fg">{title}</h1>
        {count !== undefined ? (
          <span className="rounded-md bg-hover px-1.5 text-xs font-medium tabular-nums text-muted">
            {count}
          </span>
        ) : null}
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
      {children ? <div className="space-y-2.5 px-4 pb-3 md:px-5">{children}</div> : null}
    </div>
  );
}

/**
 * A list beside its detail. From `lg` both show (the list at a fixed width); below it only one does: the detail when
 * `showDetail`, otherwise the list. Every list/detail page uses this so the widths and breakpoints are the same.
 */
export function SplitView({
  list,
  detail,
  showDetail,
  listLabel,
}: {
  list: ReactNode;
  detail: ReactNode;
  showDetail: boolean;
  listLabel?: string;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section
        aria-label={listLabel}
        className={`${showDetail ? 'hidden lg:flex' : 'flex'} min-h-0 w-full shrink-0 flex-col border-line bg-surface lg:w-[360px] lg:border-r`}
      >
        {list}
      </section>
      <section className={`${showDetail ? 'flex' : 'hidden lg:flex'} min-h-0 min-w-0 flex-1 flex-col bg-bg`}>
        {detail}
      </section>
    </div>
  );
}

/** The one card style: a flat surface, a hairline, 12 px corners. */
export function Panel({
  title,
  description,
  actions,
  icon,
  tone,
  children,
  className = '',
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  /** A danger zone or a warning gets a coloured hairline, nothing louder. */
  tone?: 'danger' | 'warn';
  children?: ReactNode;
  className?: string;
  id?: string;
}) {
  const line =
    tone === 'danger' ? 'border-danger-line' : tone === 'warn' ? 'border-warn-line' : 'border-line';
  return (
    <section id={id} className={`card scroll-mt-20 rounded-xl border ${line} ${className}`}>
      {title ? (
        <header className="flex flex-wrap items-start gap-3 px-5 pt-4">
          {icon ? (
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent-fg">
              {icon}
            </span>
          ) : null}
          {/* on a narrow screen the actions wrap under the title instead of squeezing it into a column */}
          <div className="min-w-[12rem] flex-1">
            <h2 className="text-base font-semibold text-fg">{title}</h2>
            {description ? <p className="mt-0.5 text-sm leading-5 text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      {children ? <div className={`space-y-4 px-5 ${title ? 'pb-5 pt-4' : 'py-5'}`}>{children}</div> : null}
    </section>
  );
}

/** A row in a list pane: hover and selected states, dividing hairline. Wrap it in a link or button. */
export const listRowClass = (selected: boolean) =>
  `relative block w-full border-b border-line px-4 py-3 text-left transition-colors ${
    selected ? 'bg-selected' : 'hover:bg-hover'
  }`;

/** A small section label inside a list (for example "Requests (2)"). Sentence case, not shouted. */
export function ListLabel({ children }: { children: ReactNode }) {
  return <div className="px-4 pb-1.5 pt-4 text-xs font-medium text-dim">{children}</div>;
}

const AVATAR_TONES = [
  'bg-avatar-1',
  'bg-avatar-2',
  'bg-avatar-3',
  'bg-avatar-4',
  'bg-avatar-5',
  'bg-avatar-6',
] as const;

/** Initial on a colour chosen from the handle, so a person looks the same everywhere. */
export function Avatar({
  name,
  seed,
  size = 32,
}: {
  name: string;
  /** Stable key for the colour, usually the @handle. */
  seed: string;
  size?: 24 | 28 | 32 | 40 | 56;
}) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  const tone = AVATAR_TONES[h % AVATAR_TONES.length];
  const initial = Array.from(name.trim() || seed)[0]?.toUpperCase() ?? '?';
  const box =
    size === 56
      ? 'h-14 w-14 text-lg'
      : size === 40
        ? 'h-10 w-10 text-md'
        : size === 32
          ? 'h-8 w-8 text-sm'
          : size === 28
            ? 'h-7 w-7 text-xs'
            : 'h-6 w-6 text-xs';
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-fg ${tone} ${box}`}
    >
      {initial}
    </span>
  );
}

/** A compact label: `#group`, `@you`, a state. */
export function Chip({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info';
  title?: string;
}) {
  const t = {
    neutral: 'bg-hover text-fg-2',
    accent: 'bg-accent/12 text-accent-fg',
    ok: 'bg-ok-bg text-ok',
    warn: 'bg-warn-bg text-warn',
    danger: 'bg-danger-bg text-danger',
    info: 'bg-info-bg text-info',
  }[tone];
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-px text-xs font-medium ${t}`}
    >
      {children}
    </span>
  );
}

/** A square icon-only button. `label` is required: it is the accessible name and the tooltip. */
export function IconButton({
  label,
  className = '',
  active = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:pointer-events-none disabled:opacity-40 ${
        active ? 'bg-selected text-accent-fg' : 'text-muted hover:bg-hover hover:text-fg'
      } ${className}`}
      {...props}
    />
  );
}

/**
 * One segmented control for filters and tabs. As tabs (`role="tablist"`) each option is a `tab` with
 * `aria-selected`, which the e2e journeys select by name.
 */
export function Segmented<V extends string>({
  options,
  value,
  onChange,
  label,
  asTabs = false,
  className = '',
}: {
  options: Array<{ value: V; label: string; count?: number }>;
  value: V;
  onChange: (value: V) => void;
  label: string;
  asTabs?: boolean;
  className?: string;
}) {
  const box = `inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-hover p-0.5 ${className}`;
  const item = (on: boolean) =>
    `inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-sm font-medium transition-colors ${
      on ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'
    }`;
  const inner = (o: { label: string; count?: number }) => (
    <>
      {o.label}
      {o.count ? (
        <span className="rounded bg-warn-bg px-1 text-xs tabular-nums text-warn">{o.count}</span>
      ) : null}
    </>
  );
  if (asTabs)
    return (
      <div role="tablist" aria-label={label} className={box}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={o.value === value}
            onClick={() => onChange(o.value)}
            className={item(o.value === value)}
          >
            {inner(o)}
          </button>
        ))}
      </div>
    );
  return (
    <fieldset aria-label={label} className={`m-0 min-w-0 border-0 ${box}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={item(o.value === value)}
        >
          {inner(o)}
        </button>
      ))}
    </fieldset>
  );
}

/** A small popover menu for row actions. Closes on outside click, Escape, or choosing an item. */
export function Menu({
  label,
  items,
  trigger,
  align = 'end',
}: {
  label: string;
  items: Array<{ label: string; onSelect: () => void; danger?: boolean; disabled?: boolean } | null>;
  trigger?: ReactNode;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg px-1.5 text-sm text-muted hover:bg-hover hover:text-fg"
      >
        {trigger ?? <MoreHorizontal size={16} />}
      </button>
      {open ? (
        <div
          id={id}
          role="menu"
          className={`absolute top-full z-30 mt-1 min-w-44 rounded-lg border border-line-strong bg-surface p-1 shadow-xl ${
            align === 'end' ? 'right-0' : 'left-0'
          }`}
        >
          {items.filter(Boolean).map((item) =>
            item ? (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm disabled:opacity-40 ${
                  item.danger ? 'text-danger hover:bg-danger-bg' : 'text-fg hover:bg-hover'
                }`}
              >
                {item.label}
              </button>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}

/** An empty pane: an icon, one sentence of what this is, and at most one action. */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[14rem] w-full flex-1 flex-col items-center justify-center px-6 py-12 text-center">
      {icon ? (
        <span className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-hover text-muted">
          {icon}
        </span>
      ) : null}
      <div className="max-w-sm space-y-2">
        <div className="text-md font-semibold text-fg">{title}</div>
        {children ? <div className="text-sm leading-6 text-muted">{children}</div> : null}
      </div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** Key/value lines for details panes (who, when, where), muted labels, readable values. */
export function MetaList({ items }: { items: Array<{ label: string; value: ReactNode } | null> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.filter(Boolean).map((item) =>
        item ? (
          <div key={item.label} className="contents">
            <dt className="text-muted">{item.label}</dt>
            <dd className="min-w-0 break-words text-fg-2">{item.value}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}
