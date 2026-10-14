# Dashboard design rules

Every dashboard page follows these; `apps/web/src/lib/design-tokens.test.ts` enforces the colour, contrast, type
and date-formatting parts.

**Tokens only.** Surfaces `bg / surface / surface-2 / surface-3`, lines `line / line-strong`, text
`fg / fg-2 / muted / dim`, accent `accent / accent-fg / on-accent`, the keyboard focus ring `focus`, interaction
`hover / selected`, states
`ok / warn / danger / info` with `-bg` and `-line` (for example `bg-warn-bg text-warn ring-warn-line`), avatars
`avatar-1…6`. Never a raw palette colour (`amber-`, `rose-`, `emerald-`, `sky-`…), `white/[x]` tints, `black`, or hex
in `.tsx`: the light theme only knows the tokens.

**Contrast, both themes.** Text tokens (`fg`, `fg-2`, `muted`, `dim`, `accent-fg` and the four state colours) reach
4.5:1 on `bg`, `surface`, `surface-2`, `surface-3`, and hover/selected over a surface; state text on its own `-bg`
and `accent-fg` on accent tints too; the focus ring 3:1 on every surface. The test computes this from the CSS
variables in `index.css`, so a new or changed token is checked in the dark and the light theme alike. Need a lighter
grey? There is none: `dim` is the floor.

**Type scale.** `text-xs` 12 · `text-sm` 13 (default UI text) · `text-base` 14 (reading text, message bodies) ·
`text-md` 16 (page and pane titles) · `text-lg` 20 (a drop's title, profile names) · `text-xl` 28 (entry pages;
the sign-in hero headline may go to `lg:text-4xl`, and the product page's (`pages/landing.tsx`) hero headline to
`lg:text-5xl`; nothing else goes above `text-xl`).
No `text-[Npx]`, nothing below 12 px, no uppercase tracked labels: labels are sentence case `text-sm font-medium
text-fg-2`, section captions `text-xs text-dim`.

**Structure.** One `PageToolbar` per page or pane (h-14; back button below `lg` on detail panes; actions on the right;
search/filters in its second row). List/detail pages use `SplitView` (list 360 px from `lg`). Cards are `Panel`
(flat surface, hairline, 12 px radius, `px-5` padding); a danger zone is `Panel tone="danger"`. Lists use
`listRowClass`, `ListLabel`, `Avatar`, `Chip`. Filters and tabs use `Segmented` (`asTabs` for tabs). Row actions go
into a `Menu`; icon-only buttons are `IconButton` with a label. Empty panes use `EmptyState`. Key/value details use
`MetaList`. All from `apps/web/src/ui/layout.tsx` and `ui/primitives.tsx`.

**Spacing and size.** 4 px grid; controls h-8 (compact) or h-9 (forms); page content `p-4 md:p-6`, max width
`max-w-3xl` for reading and forms, `max-w-5xl` for settings-like pages; one accent-filled primary action per view.

**Dialogs, drawers and inline panels** (`ui/drawer.tsx`, `ui/focus.ts`). Opening one moves focus into it and
closing it returns focus to the control that opened it. A modal surface (the phone's navigation drawer, a dialog)
is `role="dialog"` with `aria-modal`, comes right after its trigger in the DOM, keeps Tab inside (`useFocusTrap`),
closes on Escape and makes the rest of the page `inert`; its backdrop closes it on a click but is not a Tab stop.
An inline panel that opens in place (New group, Invite) focuses its first field and gives focus back on close
(`usePanelFocus`). Every workspace page starts with a "Skip to content" link to `#main-content`.

**Links inside a sentence** are underlined (`underline underline-offset-2`), not told apart by colour alone
(WCAG 1.4.1); standalone links (a list of files, a nav item, an icon link) may underline on hover only. Example UI
on the product page uses no headings, so the page outline stays h1 → h2 → h3.

**Combobox** (`ui/combobox.ts`). A field that searches and picks from suggestions (the composer's recipients) is
the ARIA combobox pattern: the input is `role="combobox"` with `aria-expanded`, `aria-controls`,
`aria-activedescendant`; suggestions are `role="option"` in a `role="listbox"`; ↓/↑ move, Enter picks, Escape
clears the highlight, a click picks without taking focus; a polite live region says how many matches there are.
Notes and warnings about the results sit outside the listbox.

**Lists and keyboard shortcuts.** A list of messages is a list (`ul`/`li`); each row's accessible name says state
first, then who, where, what and when ("Unread, from Alice @alice, in Lab #lab, Results, 1 file, 15 min ago"), and
the list is one Tab stop with the selected row focusable. Single-key shortcuts belong to the region that has focus
(j/k and ↑/↓ only while the message list has it) and never fire in a text field; arrow keys never move a selection
while a reading pane or the page should scroll. `/` (search) and Escape (back) are the only page-wide keys.

**Text that changes with the data.** Times, counts and sizes come from `lib/format.ts` in the dashboard's language,
never the browser's locale: `formatShort` for list rows ("3 min", "14:02", "Yesterday", "Sep 25"), `formatDateTime`
for tooltips and details, `formatAgo` in accessible names, `plural(n, one, other)` for English counts (the Chinese
half is written in the `t()` pair), `formatBytes` for sizes. No `toLocale*String` in pages. A count in a toolbar may
carry its breakdown ("37 · 13 unread"). The browser tab names the page with the inbox's unread count
("Inbox (13) · AgentDrop"). A disabled primary action says why in one visible line next to it ("Add a recipient
and a title to send."), not only in a tooltip.

**Unchanged contracts.** Keep accessible names (labels, button text, tab names, placeholders) that
`scripts/e2e/journeys` select by; every string stays a `t('English', '中文')` pair; both themes and 390 px width must
work without horizontal scrolling.
