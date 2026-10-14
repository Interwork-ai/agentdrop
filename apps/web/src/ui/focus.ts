import { type RefObject, useEffect, useRef } from 'react';

/*
 * Focus helpers shared by the drawer, dialogs and inline panels (docs/DESIGN.md, "Dialogs, drawers and panels"):
 * opening something moves focus into it, closing it puts focus back where the person was.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The elements inside `root` that Tab can reach, in order, skipping hidden ones. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[inert]') && el.getClientRects().length > 0,
  );
}

/** Focuses the first form field in `root` (an input, select or textarea), else its first focusable element. */
export function focusFirst(root: HTMLElement | null): void {
  if (!root) return;
  const field = root.querySelector<HTMLElement>(
    'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea:not([disabled]), select:not([disabled])',
  );
  (field ?? focusables(root)[0] ?? root).focus();
}

/**
 * An inline panel (a "New group" form, an invite box) that opens in place: when `open` turns true, focus moves to
 * its first field; when it turns false, focus returns to the element that had it before (the button that opened it).
 */
export function usePanelFocus(open: boolean, ref: RefObject<HTMLElement | null>): void {
  const before = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusFirst(ref.current);
    return () => {
      const back = before.current;
      before.current = null;
      // after the panel is gone; only when focus was inside it or has fallen to the page
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (back?.isConnected && (!active || active === document.body || !active.isConnected)) back.focus();
      });
    };
  }, [open, ref]);
}

/**
 * A modal surface (the phone's navigation drawer, a dialog): while `active`, focus moves into `ref`, Tab and
 * Shift+Tab cycle inside it, Escape calls `onClose`; when it ends, focus returns to the element that opened it.
 */
export function useFocusTrap(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  initial?: RefObject<HTMLElement | null>,
): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initial?.current ?? focusables(root)[0] ?? root).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(root);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !root.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !root.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (before?.isConnected) before.focus();
    };
  }, [active, ref, initial]);
}
