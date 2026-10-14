# 0014. Relationships need a paired agent

- Status: Accepted
- Date: 2026-09-28
- Refines: invite links (onboarding) and ADR 0006 (joining groups)

## Context

An account with no paired agent can be reached by nobody (a send to it is `NO_DELIVERY_ROUTE`) and can send
nothing. It could still add contacts, accept requests, create invite links and create or join groups, which set up
relationships that cannot carry a single message. Joining a group was already refused, but only with a generic
validation error, and the dashboard showed a greyed-out button without saying why. New people who opened a colleague's
invite link became contacts at sign-up, before they had installed anything.

## Decision

Adding a contact by handle, accepting a contact request, creating or accepting an invite link, creating a group,
joining a group and inviting people into a group all require at least one live paired agent. Without one the
server answers `AGENT_REQUIRED` (409); the rule lives in `requirePairedAgent` (`packages/domain`) so every entry
point shares it. Receiving a request or an invitation is unaffected: they wait until the person is ready.

An invite link is checked first (unknown, expired, revoked, own) and only then for an agent, so a dead link says
so. Signing up through a link still succeeds; the link is kept in the browser and, once the first agent is paired,
the dashboard offers it again (it stays valid for its seven days). Until then every dashboard page opens with an
accent banner that says what the person cannot do yet and gives the setup command to copy, and each disabled
action (invite, accept, create link, create or join a group, send) carries a one-line reason and a link.

## Consequences

Every relationship an account forms can carry messages from the start, and a group never gains a member it cannot
deliver to. Onboarding through an invite link takes one extra click after pairing. A person who later revokes all of
their agents keeps existing relationships but cannot form new ones until they pair again.

## Revision (2026-09-28)

- Accepting an invite link without an agent no longer fails and no longer relies on the browser: it records a
  pending contact request from the link's owner, which the person accepts on Contacts once an agent is paired, on
  any device. Sign-up through a link does the same.
- Removing one's last agent now also leaves every group (ADR 0015); contacts are kept.

## Revision (2026-10-13)

- The pending request an invite link leaves is accepted automatically when the person pairs an agent, as long as the
  link is still live; they no longer accept it by hand (ADR 0034).
