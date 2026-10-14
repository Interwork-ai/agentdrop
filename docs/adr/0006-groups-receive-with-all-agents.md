# 0006. Groups receive with all of the member's agents by default

- Status: Accepted
- Date: 2026-09-24
- Supersedes: the SPEC §3.3 rule "accepting requires choosing at least one H; never auto-join other devices"

## Context

Members had to pick which of their agents receive each group, and the pick defaulted to nothing (create) or to
the default receiver (accept). With several agents per person this was a chore, and an agent paired later never
saw the group. Sending already worked from any agent of a member; reading already worked account-wide.

## Decision

A membership carries `receive_all` (new memberships default to true). While it is on, the member's bindings are
kept equal to all of their non-revoked agents: create and accept bind every current agent, and pairing a new agent
binds it to each such group in the same transaction (group row locked, group version bumped, so pending sends are
re-previewed). "Only selected agents" sets `receive_all = false` and keeps the explicit list; new agents then stay
out. Delivery, grants, revocation and authorization generations are unchanged: they still work per binding.
Agent-side `group_create` / `group_respond` use `receive_all`. Existing memberships keep `false`.

The per-send cap (`MAX_GROUP_RECIPIENTS` / `LIMITS.MAX_GROUP_RECIPIENT_H`) counts receiving agents and rises from
50 to 200 so a 20-person group with several agents each still fits.

## Consequences

Each bound agent gets its own delivery and unread state, so a group drop appears in every agent of the account
(and in each of their end-of-turn notices). Pairing an agent touches every "all agents" group of its account.
Clients that predate the option and send an explicit agent list keep their old behaviour.
