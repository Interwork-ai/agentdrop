# 0034. Someone who opened an invite link before pairing is connected once they pair

- Status: Accepted
- Date: 2026-10-13
- Refines: ADR 0014 (relationships need a paired agent) and its 2026-09-28 revision

## Context

Since ADR 0014, opening an invite link without a paired agent (including signing up through it) records the link
owner's contact request, and the person accepts it on Contacts after pairing. In practice the person had already
said yes by opening the link; after the long setup step they had to come back to Contacts and accept a second time.
Until they did, the inviter only saw "waiting for them to accept", and many never came back to the page.

## Decision

- When someone opens a live invite link without a paired agent, both rows of the pending request remember the link
  (`contacts.invite_link_id`, an expand-only nullable column). If the owner had already asked them by handle and
  that request is still pending, opening the link records it on that request too: opening the link is the
  person's acceptance.
- When the person pairs an agent (the pairing approval, `decidePairing`, in its transaction), every such request is
  accepted, as if they had clicked Accept (`acceptInviteRequestsOnPairing` in `packages/domain`). In practice this
  is the first pairing; it applies equally to someone who had removed all their agents and pairs again.
- Only while the link is still live: not expired, not revoked, its owner neither suspended nor deleted, and neither
  side has blocked the other. Otherwise the request stays pending for the person to decide on Contacts, as before.
  Requests made by handle alone carry no link and stay pending. A request asked again by handle after a removal
  starts without a link.
- The inviter is told the usual way an accepted request is announced (outbox `contact.accepted`: the person's
  nickname and @handle). They see a person, never the invitee's agent, its name, harness or how many there are
  (ADR 0013).
- Idempotent: a later pairing finds nothing left to accept, changes no row and announces nothing again. The link's
  use was counted when it was opened, not again on pairing.
- People see what will happen. The contact view carries `from_invite_link` (true only for a pending request that
  the pairing will accept). The dashboard's invite page says the person becomes a contact as soon as they pair an
  agent; Contacts shows the same on the invitee's request and "connected as soon as they set up an agent" on the
  inviter's side. The inviter learns nothing new from it: a request that came from their own link and is still
  pending already meant the person had no agent when they opened it.

## Consequences

Onboarding through a link is one step again: open the link, sign up, pair, and the two are contacts. A link
revoked before the invitee pairs still stops the automatic connection, which keeps revocation meaningful. The
request remains a normal request until then: the person can still decline it, and the owner can withdraw it.
