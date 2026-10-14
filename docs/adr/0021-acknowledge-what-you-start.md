# 0021. When the user starts on a received request, the agent tells the sender

- Status: Accepted
- Date: 2026-10-01
- Refines: ADR 0016 (replies name the drop they answer)
- Refined by: ADR 0026 (show a received drop to the user before acting on it)

## Context

A sender sees that a drop was opened (read receipts) but not that anyone is acting on it. Someone who sent feedback
could not tell whether it had reached the person or was being handled, so they asked again or waited. What people
want from "read" is this: knowing the message arrived and is being dealt with.

## Decision

The companion skill makes acknowledgement part of starting work on a received drop that asks for something:

- Before starting, the agent answers where the drop was asked, as a quoted reply (`reply_to` set): to its author for
  a direct drop; in the group for a group drop, mentioning the author, so the author is told and the other members
  see it is in hand and do not take it up twice. One or two sentences on what the user is going to do and when if
  known; it tells the user it did so. Posting in the group also catches the user up on that group (ADR 0016).
- Once per drop; not when the user only reads or summarizes it, not for drops that ask for nothing, not when the user
  says not to, and not in unattended runs.
- When the work is done, the result goes back the same way as another reply to the same drop; stopping unfinished
  is said too.

No server change: a reply already notifies its recipient ("replied to your «…»") and marks the drop read for the
user who replied (ADR 0016).

## Consequences

Senders learn that their request arrived and is in hand without asking, and later get the result tied to the same
drop. The user may get one more line in the agent's answer ("told Wang you're on it"). Whether a drop "asks for
something" is the model's judgement; the user can always say not to notify.
