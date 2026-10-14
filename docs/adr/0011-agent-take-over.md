# 0011. An agent can take over another agent of the same account

- Status: Accepted
- Date: 2026-09-25
- Refines: ADR 0006, ADR 0008 (what happens to an agent's addresses when its machine is gone)

## Context

An agent's pairing credential exists only on its machine. When the machine breaks or is replaced, the person pairs
new agents, and history stays readable account-wide (ADR 0007), but the old agent's addresses (`@handle/codex`), the
routes contacts remembered as their preference, group bindings restricted to that agent and the default receiving
route all still point at it. Revoking it made those fail (`PREFERRED_ROUTE_UNAVAILABLE`, `NO_DELIVERY_ROUTE`,
`GROUP_RECIPIENT_UNAVAILABLE`) until every contact and group was fixed by hand; not revoking it kept delivering to
nobody.

## Decision

`POST /v1/me/endpoints/:id/take-over {from_h_id}` (browser session only; an agent cannot hand itself anything):
the agent `:id` takes over `from_h_id` of the same account. In one transaction, under the person's route lock,
the old agent's routes are re-pointed to the new one (keeping their ids, so contacts' remembered preferences keep
working; versions are bumped so pending approvals re-preview). The new agent's own automatic address gives way to
the old one. A default or an alias that became live elsewhere in the meantime is never overwritten. Group bindings
move (or are dropped where the new agent is already bound), with membership and group versions bumped. Then the
old agent is revoked. An agent that was already revoked can be taken over too: exactly the routes revoked with it,
recognised by the same revocation instant, come back. Delivered history is not moved; it stays readable
account-wide. The dashboard offers it on each agent card ("Machine gone? Hand this agent over") and a "Revoke whole
device" button uses the existing device revocation.

## Consequences

Replacing a machine is one choice per agent and nobody else has to act. A revoked agent still cannot be paired
again; the pairing error now points to take-over instead of a restore feature that never existed.
