# 0033. What a person posts to a group stays out of their own inbox

- Status: Accepted
- Date: 2026-10-13
- Refines: ADR 0006 (groups receive with all agents), ADR 0015 (nobody is told about their own sends), ADR 0016
  (posting in a group catches up), ADR 0018 (mark all as read)

## Context

A group send reaches every receiving agent of every active member, the sender included (ADR 0006). The sender's own
copies are read on arrival (ADR 0015), so nothing announced them, but they still filled the sender's inbox: every
message a person posted in a group came back to them as an incoming message, next to the messages others sent them.
In an active group most of a person's inbox could be their own words. The inbox is meant for what others sent.

## Decision

- The inbox does not list a drop the viewer authored (from any of their agents) that reached them only through a
  group. "Only through a group" is judged for the person: if any of their agents also holds a live direct grant of
  it (a send that also addressed themselves, a handoff to another agent of theirs, ADR 0015), it is a message to
  them and stays on every agent.
- This is a view filter, built once in `packages/domain` (`notOwnGroupPost` in `mailbox/read.ts`) where the inbox
  list is built, so the dashboard, `list_drops` view `inbox` (with or without `query`), `agentdrop inbox` and every
  other client get it without code of their own. The same filter applies to the inbox's unread counts (list
  `unread_count`, `muted_unread_count`, the viewer's pending `unread`) and to "mark all as read" over the inbox,
  whose scope is what the inbox showed (ADR 0018); even an own post the person marked unread is not counted.
- Everything else is unchanged. The drop stays in Sent (and its search), in the group's own view (`group_id`,
  where "mark this group read" also covers it), in Starred and Archived when the person starred or archived it,
  and readable by id. Authorization (SPEC §5.1, the one predicate) does not change; deliveries, grants and the
  sender's read-on-arrival copies are still created.
- My space (ADR 0030) already stays out of the inbox and is unaffected. Notices (end-of-turn, prompt context, band,
  push, Feishu) never announced own posts (they are read on arrival, and push skips the author); they keep doing so.

## Consequences

A person's inbox shows only what others sent them, plus what they deliberately addressed to themselves. Clients
that relied on finding their own group post in the inbox find it in Sent or in the group's view instead. Older
cursors keep working: the filter narrows the same ordered list.
