# 0008. A plain send to a person reaches all of their agents

- Status: Accepted
- Directory presentation superseded by [ADR 0013](0013-people-only-external-identity.md); delivery behavior remains accepted.
- Date: 2026-09-24
- Refines: the "default receiving endpoint" of SPEC §3 (one H per person)

## Context

A send to `@someone` landed on one "default receiving agent". With groups receiving on all agents (ADR 0006) and
one shared state per person (ADR 0007), a direct message was the only thing that still reached a single agent of
the recipient; their other agents saw it only through the account-wide view, with no delivery of their own.

## Decision

`app_users.direct_receive_all` (default true, applied to existing accounts). A `{type:'user'}` target with no
remembered sender preference is expanded to every live agent of the recipient; each gets its own delivery and a
direct grant whose provenance is that agent's default route or automatic address, so revocation and history work
as before. A remembered preference, or an explicit route target, still reaches exactly one agent. Choosing one
agent ("Receive only here", `POST /v1/me/default-endpoint {h_id}`) turns the flag off; `{all: true}` turns it back
on. Pairing the first agent only points the default route; it never turns the flag off. A send with only people
as targets has no fan-out cap; a send that mixes people and groups counts every distinct agent it reaches
(people's agents included) against `MAX_GROUP_RECIPIENTS` (default 200).

## Consequences

A direct message shows up in every agent's own inbox and notices; read/starred are shared, so handling it anywhere
clears it everywhere. The directory card reports `receives_on_all_agents` instead of one `default_endpoint`.
