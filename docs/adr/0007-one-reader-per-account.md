# 0007. All agents of an account are one reader

- Status: Accepted
- Date: 2026-09-24
- Supersedes: AGENTS.md rule 2 "read/star/archive state always belongs to one delivery/H" and SPEC §2 "跨 H 阅读只读，
  不得改变另一个 H 的 delivery 状态"; refines ADR 0005 and ADR 0006

## Context

With groups receiving on all agents (ADR 0006), one drop now reaches several agents of the same person, each with
its own unread flag and its own end-of-turn notice. The person saw the same item announced in every harness and
had to mark it read in each. The product decision: the agents behind one account are one person; whatever one of them
has shown or read counts for all.

## Decision

- Deliveries and grants stay per H (who received what, revocation, authorization generations are unchanged).
- Read, starred and archived are per person. `setDropState` locks every delivery of the drop to any H of the user,
  checks `expected_version` against the highest `state_version` among them, and writes the same flags and the same
  new version to all. Any of the user's Hs that may see the drop can change it. A data migration converged existing
  rows (a flag set on any delivery counts for all, earliest timestamp wins).
- End-of-turn notices read the account-wide unread list and keep one "already shown" record per account: on the
  server in `app_users.notice_state` (hashes of ids only), claimed atomically with
  `POST /v1/h/notice-state/claim` (row lock, merge, return the previous record), with a local per-account record as
  the fallback for servers without it. Autorun claims drops per account for the same reason.
- API, MCP and CLI reads still never mark anything read (ADR 0005).

## Consequences

Marking read in one harness clears the item in every other harness and the dashboard. Agents finishing a turn at
the same moment, even on different machines, announce each new item exactly once. A person who
disables account-wide mailbox visibility still has shared state, because the state is theirs, not a view.
