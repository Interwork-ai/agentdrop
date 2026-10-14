import { type ReactNode, type RefObject, useEffect, useState } from 'react';

/** Native selects in settings forms: the same height, border and focus ring as `Input`. */
export const settingsSelectClass =
  'h-9 w-full rounded-lg border border-line-strong bg-surface-2 px-3 text-sm text-fg transition-[border-color,box-shadow] duration-150 focus:border-accent/60 focus:ring-3 focus:ring-accent/15 focus:outline-none';

/**
 * A panel title followed by a status chip that wraps under it on a narrow screen, instead of sitting in the panel's
 * action slot where it would squeeze the description into a thin column.
 */
export function TitleWithChip({ children, chip }: { children: ReactNode; chip?: ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{children}</span>
      {chip ? <span className="inline-flex font-normal">{chip}</span> : null}
    </span>
  );
}

/** A labelled on/off row inside a Panel: title and one line of explanation on the left, the switch on the right. */
export function SettingsSwitch({
  checked,
  onChange,
  title,
  description,
  badge,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description: string;
  badge?: ReactNode;
  disabled?: boolean;
}) {
  return (
    // relative: the visually hidden checkbox is positioned inside the label; without it, it is placed against the page
    // and makes the whole document taller than the screen, so jumping to a section scrolled the app shell away
    <label
      className={`relative -mx-2 flex items-center justify-between gap-4 rounded-lg px-2 py-2 transition-colors has-[:focus-visible]:bg-hover ${
        disabled ? 'cursor-default' : 'cursor-pointer hover:bg-hover'
      }`}
    >
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-fg">{title}</span>
          {badge}
        </span>
        <span className="mt-0.5 block text-xs text-muted">{description}</span>
      </span>
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-surface-3'
        } ${disabled ? 'opacity-50' : ''}`}
        aria-hidden="true"
      >
        <span
          className={`absolute top-0.5 left-0.5 h-3.5 w-3.5 rounded-full shadow-sm transition-transform ${
            checked ? 'translate-x-4 bg-surface' : 'translate-x-0 bg-muted'
          }`}
        />
      </span>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

/**
 * A segmented control with radio semantics (`radiogroup` / `radio` + `aria-checked`), for a choice that is a
 * setting rather than a filter: the e2e journeys select these by group and option name.
 */
export function RadioSegmented<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: V | null;
  options: Array<{ value: V; label: string; disabled?: boolean }>;
  onChange: (value: V) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-hover p-0.5"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a segmented button row, with radio semantics for the choice
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled || o.disabled}
            onClick={() => (on ? null : onChange(o.value))}
            className={`inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors disabled:cursor-default ${
              on ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg disabled:hover:text-muted'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The id of the section currently at the top of a scrolling page, for highlighting it in an in-page table of
 * contents. `root` is the element that scrolls (the page), not the window.
 */
export function useSectionSpy(ids: readonly string[], root: RefObject<HTMLElement | null>): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join(' ');
  useEffect(() => {
    const scroller = root.current;
    if (!scroller) return;
    const list = key.split(' ');
    // After a jump from the table of contents the picked section stays marked, even when it is too short to reach
    // the top, until the person scrolls on their own.
    let pinned = false;
    let target: string | null = null;
    const onScroll = () => {
      if (pinned) return;
      const top = scroller.getBoundingClientRect().top + 96;
      let current = list[0] ?? null;
      for (const id of list) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= top) current = id;
      }
      // at the very bottom the last section counts as current, even when it is too short to reach the top
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4)
        current = list.at(-1) ?? current;
      setActive(current);
    };
    // Scroll only this page's own scroller: the browser's default anchor jump also scrolls every ancestor, which moved
    // the whole app shell up whenever the target could not reach the top.
    const topOf = (id: string): number | null => {
      const el = document.getElementById(id);
      if (!el) return null;
      const margin = Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
      const top =
        el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - margin;
      return Math.min(Math.max(0, top), scroller.scrollHeight - scroller.clientHeight);
    };
    const jump = (id: string, smooth: boolean) => {
      const top = topOf(id);
      if (top === null) return;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      pinned = true;
      target = id;
      setActive(id);
      scroller.scrollTo({ top, behavior: smooth && !reduce ? 'smooth' : 'auto' });
    };
    // A smooth jump can end off target when the page changed height while it ran: correct it without animation.
    const settle = () => {
      if (!pinned || !target) return;
      const top = topOf(target);
      if (top !== null && Math.abs(scroller.scrollTop - top) > 2) scroller.scrollTo({ top });
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.('a[href^="#"]');
      const id = link ? decodeURIComponent((link.getAttribute('href') ?? '').slice(1)) : '';
      if (!list.includes(id)) return;
      event.preventDefault();
      window.history.replaceState(window.history.state, '', `#${id}`);
      jump(id, true);
    };
    const unpin = () => {
      pinned = false;
    };
    // the fragment changed without a click on this page (a link from elsewhere, back/forward)
    const onHashChange = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (list.includes(id)) jump(id, true);
    };
    // Panels above the target may still be loading and move it: until the person scrolls, types or clicks on the
    // page, keep the target aligned.
    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (pinned && target) settle();
          });
    for (const child of Array.from(scroller.children)) resize?.observe(child);
    // a link to a section (…/settings#clients) opens at that section
    const initial = decodeURIComponent(window.location.hash.slice(1));
    if (list.includes(initial)) jump(initial, false);
    else onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('scrollend', settle);
    scroller.addEventListener('wheel', unpin, { passive: true });
    scroller.addEventListener('touchmove', unpin, { passive: true });
    scroller.addEventListener('pointerdown', unpin);
    window.addEventListener('keydown', unpin);
    document.addEventListener('click', onClick);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('scrollend', settle);
      scroller.removeEventListener('wheel', unpin);
      scroller.removeEventListener('touchmove', unpin);
      scroller.removeEventListener('pointerdown', unpin);
      window.removeEventListener('keydown', unpin);
      document.removeEventListener('click', onClick);
      resize?.disconnect();
    };
  }, [key, root]);
  return active;
}

/** Links of an in-page table of contents, the current section marked. */
export function SectionNav({
  label,
  sections,
  active,
  numbered = false,
}: {
  label: string;
  sections: Array<{ id: string; title: string }>;
  active: string | null;
  numbered?: boolean;
}) {
  return (
    <nav aria-label={label}>
      <ul className="space-y-0.5">
        {sections.map((s, i) => {
          const on = s.id === active;
          return (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                aria-current={on ? 'location' : undefined}
                className={`flex items-baseline gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  on ? 'bg-hover font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'
                }`}
              >
                {numbered ? (
                  <span className="w-4 shrink-0 text-xs tabular-nums text-dim">{i + 1}</span>
                ) : null}
                <span className="min-w-0">{s.title}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
