# 0035. The operator overview measures product health from metadata only

- Status: Accepted
- Date: 2026-10-13
- Refines: the operator console (`docs/ADMIN.md`): metadata only, never message content

## Context

The operator overview counted accounts, agents, messages and storage, but none of those numbers says whether the
product works: whether a message one person hands to another gets an answer, whether new accounts get as far as
pairing an agent and writing to someone, or how long a message waits before its recipient reads it. An operator who
wants to know had to query the database by hand, and the easy way to do that reads content.

The console's promise stays: an operator sees who exists and what happened, never what anyone wrote.

## Decision

The overview response gains an optional `product_health` object (`adminProductHealthSchema` in
`packages/contracts/src/admin.ts`), computed by `packages/domain/src/admin/product-health.ts` on each request and
shown in the dashboard's Admin → Overview as "Product health".

### What is read, and what is not

The computation reads only timestamps (`drops.created_at`, `deliveries.received_at`, `deliveries.read_at`,
`app_users.created_at`, `harness_endpoints.created_at`), ids, `drops.reply_to_drop_id`, `app_users.is_system` and the
frozen target ids of a drop (`target_snapshot.user_ids`, `group_ids`, `self`). It never selects a title, body,
extension, attachment, file name, handle, display name or email, and it returns only counts, shares and one duration:
no id, no name, no per-person row. Nothing new is collected or stored; there is no event log and no tracking.

### Common exclusions

A **message to people** is a drop that

- was not written by the built-in assistant (`is_system`),
- is not kept in My space (`target_snapshot.self`, ADR 0030), and
- is addressed to at least one group, or to at least one person who is neither its author nor the assistant.

So a test message to the assistant alone, the assistant's receipts, My space and a handoff to one's own agents are
never counted as messages to people. A message addressed to a group (with or without people beside it) is a **group**
message; any other message to people is **direct**.

### Definitions

All windows end at the time of the request (`now()`); "last 7 days" is `created_at > now() - 7 days`.

| Figure | Definition |
|---|---|
| Answered within 72 h (7 d and 28 d) | Of messages to people sent in the window, the **eligible** ones are those at least 72 h old, or already answered. A message is **answered** when another drop names it in `reply_to`, was written by someone other than its author and not by the assistant, is not in My space, and was created at most 72 h after it. Reported as `answered`, `eligible` and `share = answered / eligible`, null when nothing is eligible. Replies are themselves messages to people and count in the window like any other. |
| People who sent (7 d and 28 d) | Distinct authors of messages to people in the window. |
| Messages sent, last 7 days | Messages to people in the last 7 days, split into direct and group. |
| Activation | Accounts created in the last 28 days, except the assistant (closed accounts included: they signed up). For each: **paired an agent** if one of its agents was paired within 7 days of signing up (revoked later or not); **tried the assistant** if it sent a message addressed to the assistant alone within 7 days; **wrote to a person or group** if it sent a message to people within 7 days. `in_first_week` counts the accounts created less than 7 days ago, whose figures can still grow. |
| Time to read, last 7 days | One entry per message to people delivered in the last 7 days and per recipient person other than its author and the assistant (not per agent: read state belongs to the person, ADR 0007). Delivered at the earliest `received_at` of that person's copies, read at the earliest `read_at`. Reported as `delivered`, `read` and the median of `read − delivered` in whole seconds over the read ones (the mean of the two middle values for an even count), null when none is read. |

`read_at` is the person's read state: the dashboard sets it when the person opens the message (ADR 0005), an agent
after showing it (ADR 0019), a reply or a group post for what it answers (ADR 0016), and "mark all as read"
(ADR 0018). Mark-all shortens no wait but ends many at once, so the median is a guide, not a stopwatch. The separate
`opened_at` (an agent fetched the body for its own work) is deliberately not used.

### Cost

Every query is bounded by a 28-day window on `drops.created_at`; replies are found through `drops_reply_to_idx`,
deliveries through `deliveries_drop_h_uq`, a new account's agents through `harness_endpoints_user_idx`. `drops` has no
index on `created_at` alone, so the window is a sequential scan of `drops`, as the overview's existing "messages in
24 hours / 7 days" counters already are; an index `drops (created_at)` is the remedy if the table grows large.

## Consequences

An operator sees in one place whether messages between people get answered and read, and whether new accounts reach
their first real message, without reading anything anyone wrote. The figures are aggregates over the whole server;
small servers will show small, noisy numbers, which is why every share comes with its "x of y". Anything finer
(per person, per group, per harness, retention curves) is deliberately not offered: it would turn an operator view
into a profile of individual people.
