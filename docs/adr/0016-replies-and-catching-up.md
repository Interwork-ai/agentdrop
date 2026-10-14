# 0016. A drop may name the drop it answers; a person's own reply or group post marks what it answers read

- Status: Accepted
- Date: 2026-10-01
- Refines: ADR 0005 (dashboard open marks read) and ADR 0007 (one reader per account); SPEC §1 and §9.5 ("no reply
  threads"; an optional reference was foreseen there as `related_drop_id`)

## Context

People who work mostly through their agents rarely open the dashboard, the only place that marks a drop read
(ADR 0005). Their unread lists only grew: drops they had long answered, and group traffic they had caught up with
by posting in the group, stayed unread forever. Every one of them was announced again in the model's prompt-time
context and filled it. Separately, a drop that answers another had no way to say so, so the person receiving it
had to guess which of their drops it was about.

## Decision

- `payload.reply_to` is an optional `drop_id`: the drop this one answers. It is a reference, not a thread. There is
  no thread view, nobody is obliged to answer, and it grants no access to the original. It is part of the content,
  so part of idempotency. The sender must be able to read the referenced drop under the one authorization
  predicate (account-wide reads included), checked at send and again when a held send is approved; otherwise the
  send is refused with `VALIDATION_FAILED` on `reply_to`, worded the same whether the drop exists or not.
- Readers see `reply_to: { drop_id, title }` only when they may read the original themselves (through a delivery
  or as its sender; an owner/admin's group-history role does not count, since those reads are explicit and
  audited); otherwise null, also once the original expired or was withdrawn. Authors see `replies` on their own
  drops: the count, latest time and authors of the replies they can read. People only, never agents (ADR 0013).
  Browser push and Feishu say "replied to (your) «X»" only when the recipient may read X.
- A person's own send is an explicit act of catching up. When it commits (in its transaction, also when a held send
  is approved later), for its author only, with the usual per-person state change (ADR 0007: every delivery of
  the drop to any of their agents, state version bumped, the same mailbox events as `set_drop_state`):
  1. the drop named in `reply_to` becomes read (no-op if the author has no delivery of it);
  2. for every group target, each drop that reached the author through that group (a live group grant) and was
     created before this send becomes read, including drops that mention them.
  An idempotent replay returns the first result and changes nothing again.

## Consequences

This extends ADR 0005 rather than reversing it: reading through the API, MCP or CLI still never marks anything
read; only explicit actions of the person do (opening a drop in the dashboard, `set_drop_state`, and now
answering or posting). Unread now means "not yet answered or caught up with", which keeps prompt context short for
agent-heavy users. Drops that arrive in a group while a send is held for approval are marked read when it is
approved, since approving is the person acting in that group. AGENTS.md rule 2 states this exception.
