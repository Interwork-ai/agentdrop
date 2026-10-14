# 0013. Other accounts see people, not their agents

- Status: Accepted
- Date: 2026-09-28
- Supersedes: the external agent discovery and attribution in SPEC §3, PRODUCT_IDENTITY_AND_GROUPS §1–2,
  and ADR 0008's directory presentation; delivery rules in ADR 0006–0008 remain in force.

## Context

Automatic addresses, agent signatures, delivery counts and group endpoint totals let a contact or group member
discover which tools another person uses and how many agents they have. Communication is between people; the
receiving person should decide which of their agents receives it without exposing that configuration.

## Decision

External identity is the person's nickname, handle and optional public email. Other accounts cannot discover
automatic agent addresses, names, harnesses, signatures, receiving mode or endpoint counts. This applies to
directory cards, sends and retries, saved history, exports, receipts, approvals and errors, as well as all clients.
The owner retains their own agent inventory, original sender and receiving-agent attribution.

A plain person target still follows the recipient's receiving policy (all agents by default). Automatic routes
remain usable within the owner's account, but another account cannot send to one or save it as a preference.
Existing preferences for automatic routes are ignored; future person sends follow the recipient's policy.
Explicitly published named entries remain available with their chosen label and address, without details about
the destination agent. Unavailable named-entry preferences still fail explicitly rather than silently rerouting.

Group limits continue to count actual destination Hs internally and sends remain all-or-nothing. Clients display
people and whether receiving capacity is exceeded, without reporting the number of receiving agents. The existing
per-person repair status remains available under its existing authorization. No general reply-to-origin feature
is added; the built-in assistant's existing receipt behavior must continue through a narrowly scoped internal path.

Compatibility fields remain present in this release: external `endpoint_label` and `harness_key` become null,
agent signatures are null outside the owner's account, and deprecated counts no longer report private H totals.
Group capacity uses optional `endpoints_over_limit`; the legacy `endpoint_total` carries only 0 or limit + 1.
Recipient `endpoint_count` represents people for external targets, while owner-only attribution retains H counts.
Readers must not recover private details from historical snapshots or cached idempotent results. No stored history
or deliveries are deleted and this privacy change requires no migration. ADR 0004's field-removal deprecation
window remains in force; this release uses a minor version for the changed targeting and presentation behavior.

## Consequences

Contacts can send to a person or their explicitly published entry, but cannot select an automatically enumerated
agent. Existing cached automatic addresses stop working across accounts. Endpoint changes and agent take-over
remain private receiving decisions. People can still choose to disclose tool information in their own message
content or named-entry labels; the service does not infer or publish it for them.
