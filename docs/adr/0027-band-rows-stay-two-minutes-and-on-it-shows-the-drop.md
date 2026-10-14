# 0027. Band rows stay two minutes, five at most; "On it" shows the drop it answers

- Status: Accepted
- Date: 2026-10-12
- Refines: ADR 0023 (the band and its buttons), ADR 0025 (what the band lists) and ADR 0026 (show a drop before
  acting on it)

## Context

Two things people ran into with the Claude Code band. First, **On it** sent the acknowledgement without a turn and,
since a reply marks the drop it answers read (ADR 0016), the row went away: the person had told the sender they were
on it without ever seeing what the sender asked. Second, a row stayed on the band until the drop was read or the
person pressed a button: a drop they had glanced at and chose to leave sat above the prompt for the rest of the
session, which is the "keeps reminding" the product avoids (docs/PRODUCT_PRINCIPLES.md). With dozens of new drops
the band filled the space above the prompt.

## Decision

- **On it shows the drop.** After the acknowledgement went out (delivered, already sent, or waiting for the person's
  approval; a reply that was not sent is a toast and opens nothing), the mod opens the `/agentdrop` pane on that drop
  (title, sender, time, body, file names) with the outcome of the acknowledgement as its note, as if the person had
  opened it from the pane: it is marked read for the person if the reply did not already do so. Nothing reaches
  Claude. When the acknowledgement fails, the toast says why and nothing opens; when only reading the drop fails, the
  toast says the acknowledgement was sent. Where the pane sits is Claude Code's choice, not the mod's: docked beside
  the transcript in the fullscreen layout from 110 columns, otherwise above the prompt.
- **A row stays two minutes.** The mod records when each row and each dim line was first drawn on its session's
  band; two minutes later it goes by itself, without the person doing anything, and is put away exactly as **Later**
  puts it away (shared by every session on the machine). A new message is a new row with its own two minutes: a
  direct drop has its own row, and a group row comes back when a newer message arrives in the group. A line's key
  follows its text, so a changed count is a new line.
- **Five rows at most.** The band draws five rows: drops that are the person's to answer (direct, mentioning them,
  replies) take the places before group rows, as the hook notices list them (`noticeOrder`), then the newest; what
  is drawn stays newest first. A row that moves up into view (one above it went) stays at least 30 seconds, whatever
  is left of its two minutes, so it does not flash and go. The rest of a burst is one dim line counting them
  ("and N more new · type /agentdrop to see them"), and they count down together with the rows drawn, so a burst of
  dozens takes five rows and one line for two minutes, then nothing.
- **Several from one person are one row.** Two or more new drops from the same person (by @handle) are stacked
  into one row: who, how many, the newest title ("Wang · 3 new messages · latest «…»"). **Read** asks Claude for all
  of them (ids and the handle only, as for one drop); there is no **On it** on a stack, acknowledging is per drop in
  the pane. Putting the row away, by time, Read or Later, puts away each drop in it, so the next message from that
  person starts a fresh row instead of bringing the old ones back. A stack that only lost a message (read elsewhere)
  keeps the time it had; only a message not seen on the band before starts its two minutes afresh.
- **The countdown waits for the person.** The mod notes when the person last typed in the prompt (`prompt.edit`),
  sent one themselves (`prompt.submit` from the composer or Remote Control; a /loop, a scheduled task or a task
  notification is not the person) or pressed something on the band. A row drawn after five minutes without any of that
  is not counted down: its two minutes start at their next keystroke or press, so a message that arrived while they
  were away is there when they come back. A Claude Code without those hooks counts every row from when it was drawn.
- How others solved the same problem shaped these numbers. Phones stack a burst by conversation and show the newest
  with "N more" (iOS groups by thread identifier, Messages by conversation, Mail by VIP person; Android bundles four
  or more from one app under one summary). Web toasts show a few at once and pause their timers while the page is
  hidden, so nothing expires unseen (Sonner: three visible, paused when the document is hidden). Android's
  notification cooldown quiets a burst from the same source for a minute or two rather than repeating it. The band
  takes each idea where a terminal allows it: a stack per person and per group, a small fixed number of rows, a
  countdown that does not run while nobody is there, and a burst announced once.
- **Read and Look hand the row to Claude.** Pressing either puts the row away at once; the conversation has it now.
- Unread drops that left the band stay unread: the `/agentdrop` pane (inside Claude Code: docked beside the
  transcript in the fullscreen layout, otherwise above the prompt) and the dashboard still list them. The seen record
  and the Stop preview are unchanged.

## Consequences

The band is a short-lived notice per item rather than a to-do list: nothing sits above every prompt for longer than
two minutes, and never more than six lines of it. Someone who wants a drop kept in view has the pane and the dashboard. Codex, opencode and Cursor
have no band; their notices already announce each item once.
