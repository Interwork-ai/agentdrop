import { type ReactNode, useRef } from 'react';
import { useFocusTrap } from './focus.js';

/**
 * A side drawer that is modal while `open` (the phone's navigation): a backdrop that closes it, `role="dialog"`
 * with `aria-modal`, focus moved in and kept inside, Escape closes it, and focus returns to the button that opened
 * it. Place it after the button that opens it in the DOM (docs/DESIGN.md). When closed it is an ordinary `aside`,
 * so the same element can be the static sidebar on wider screens: `className` decides where it shows.
 */
export function Drawer({
  id,
  open,
  onClose,
  label,
  closeLabel,
  className,
  children,
}: {
  id: string;
  open: boolean;
  onClose: () => void;
  /** Accessible name of the dialog while open. */
  label: string;
  /** Accessible name of the backdrop that closes it. */
  closeLabel: string;
  className: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(open, ref, onClose);
  return (
    <>
      {open ? (
        // a pointer convenience only: keyboard users close with Escape or the close button inside
        <button
          type="button"
          tabIndex={-1}
          aria-label={closeLabel}
          onClick={onClose}
          className="fixed inset-0 z-30 bg-bg/70 backdrop-blur-[2px] md:hidden"
        />
      ) : null}
      <aside
        id={id}
        ref={ref}
        className={className}
        {...(open ? { role: 'dialog', 'aria-modal': true, 'aria-label': label } : {})}
      >
        {children}
      </aside>
    </>
  );
}
