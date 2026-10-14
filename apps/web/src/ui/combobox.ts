import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

/**
 * The ARIA combobox pattern (an input with a list of suggestions, docs/DESIGN.md "Combobox"), as a hook so the input
 * and the list can live in different places of a layout (the composer's "To" row and the panel under it):
 *
 * - the input is `role="combobox"` with `aria-expanded`, `aria-controls`, `aria-autocomplete="list"` and
 *   `aria-activedescendant` pointing at the highlighted option; focus never leaves the input;
 * - ↓/↑ move the highlight (wrapping), Home/End jump, Enter picks the highlighted option, Escape clears the
 *   highlight (a second Escape is left to the page);
 * - the list is `role="listbox"`, each choice `role="option"` with `aria-selected`; a click picks without moving focus;
 * - the caller renders `status` in a polite live region so "3 results" is announced as the list changes.
 *
 * Typing highlights the first option, so "type a name, press Enter" works.
 */
export function useCombobox({
  count,
  open,
  query,
  onPick,
}: {
  /** How many options the list shows now. */
  count: number;
  /** Whether the list is shown. */
  open: boolean;
  /** The text in the input; a change highlights the first option. */
  query: string;
  onPick: (index: number) => void;
}) {
  const id = useId();
  const listId = `${id}-listbox`;
  const optionId = (i: number) => `${id}-option-${i}`;
  const [active, setActive] = useState(-1);
  const pick = useRef(onPick);
  pick.current = onPick;

  // a new query or a new set of results: highlight the first option when there is text, else nothing
  useEffect(() => {
    setActive(query.trim() && count > 0 ? 0 : -1);
  }, [query, count]);

  // keep the highlighted option in view inside a scrolling list
  useEffect(() => {
    if (active < 0) return;
    document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, id]);

  const shown = open && count > 0;
  const current = shown && active >= 0 && active < count ? active : -1;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!shown) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a < 0 ? (step > 0 ? 0 : count - 1) : (a + step + count) % count));
    } else if ((e.key === 'Home' || e.key === 'End') && shown && current >= 0) {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : count - 1);
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      if (current < 0) return;
      e.preventDefault();
      pick.current(current);
    } else if (e.key === 'Escape' && current >= 0) {
      e.preventDefault();
      e.stopPropagation();
      setActive(-1);
    }
  };

  return {
    inputProps: {
      role: 'combobox' as const,
      'aria-expanded': shown,
      'aria-controls': listId,
      'aria-autocomplete': 'list' as const,
      ...(current >= 0 ? { 'aria-activedescendant': optionId(current) } : {}),
      autoComplete: 'off',
      onKeyDown,
    },
    listboxProps: { id: listId, role: 'listbox' as const },
    optionProps: (i: number) => ({
      id: optionId(i),
      role: 'option' as const,
      'aria-selected': i === current,
      // a click picks without taking focus from the input
      onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault(),
      onClick: () => pick.current(i),
      onMouseMove: () => {
        if (i !== active) setActive(i);
      },
    }),
    active: current,
  };
}
