# 0018. A person can mark everything read at once

- Status: Accepted
- Date: 2026-10-01
- Refines: ADR 0005 (dashboard open marks read), ADR 0007 (one reader per account), ADR 0016 (catching up)

## Context

Unread only shrank one drop at a time: opening it in the dashboard, toggling it, answering it, or posting in its
group. A person returning to a long list of drops they no longer need to look at one by one had no way to clear it,
and every one of them kept appearing in the unread count and in the model's prompt-time context.

## Decision

- `POST …/drops/mark-read` (`/v1/me/endpoints/:h_id/…` for the dashboard, `/v1/h/…` for an H credential) marks read
  every drop that is unread and not archived in the person's inbox, or only those that reached them through
  `group_id`, received no later than `up_to`. Visibility is the inbox's own (account-wide or the current agent, per
  the account's mailbox preference); the change is the person's state on every delivery of each drop to any of
  their agents (ADR 0007), with the state version bumped and the same mailbox events as `set_drop_state`.
- `up_to` is what the list showed when the person clicked (the dashboard sends the newest drop it displays); it is
  compared at the list's millisecond precision, and anything received later stays unread. Archived drops are left
  as they are. One call changes at most `LIMITS.MARK_ALL_READ_MAX` drops and reports `remaining`.
- The dashboard offers it in the inbox ("Mark all as read") and in one group's view ("Mark this group read"), only
  when something is unread and only under the All / Unread filters, where "all" means what is on screen.
- It is an explicit act of the person, like `set_drop_state`; it is not an MCP tool (AGENTS.md keeps seven).

## Consequences

Reading through the API, MCP or CLI still never marks anything read (ADR 0005). Agents keep `set_drop_state` for
single drops; a CLI command or MCP use of the H route can be added later without changing the semantics.
