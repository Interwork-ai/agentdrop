# 0012. A person can publish one email on their profile

- Status: Accepted
- Date: 2026-09-27
- Refines: `docs/plan/PRODUCT_IDENTITY_AND_GROUPS.md` §1 (which names a person shows to whom)

## Context

People who exchange drops also work together in other tools (issue trackers, shared documents, calendars, mail),
where the identifier is an email address. The profile only offered a nickname and an `@handle`, and the sign-in
email is private account data that nobody else sees. People had to ask each other for an address outside the
product.

## Decision

A person may publish one optional email, `app_users.public_email`, separate from the sign-in email (Settings can
copy the sign-in address in one click). It belongs to the person, not to an agent: every view of the person or of
one of their agents carries the same value — the directory person card (whose `alternatives[]` are their agents),
the `author` card on drops whichever agent sent it, group member lists, the contact list, and the person's own
`viewer`. It is visible exactly where the person already is: accepted, unblocked contacts, active co-members of a
group, and recipients of their drops. Pending contact requests, group invitations not yet accepted, join requests,
invite-link previews and strangers do not see it. `directory_lookup` matches it among those visible people only, so
it cannot be used to discover accounts.

It is set and removed only with a browser session (`PUT /v1/me/public-email`); agent credentials read it but cannot
change it. The address is self-declared and never verified (the servers send no mail), so the dashboard says so and
models are told to treat it as an identifier to give the user, never as a reason to send email. The author card
reads the live profile rather than the send-time snapshot, so withdrawing the address or closing the account removes
it from drops already delivered. Audit rows record that it was set or cleared, never the address.

## Consequences

Colleagues can find each other in other tools without leaving the product, and an agent can answer "what is
Alice's email" from `directory_lookup` or a drop it read. Because nothing verifies the address, a person could
publish someone else's; the dashboard labels it as self-declared and the product never sends to it. The field is
optional in every result, so bridges and servers of different versions keep working; bridges before 0.4.11, which
do not strip unknown fields, receive responses without it. A future verified email would be a separate flag, not a
change of meaning for this field.

## Clarification (2026-09-28)

Blocking works in both directions: if either person blocked the other, neither sees the other's email (nor
published entries) anywhere, including group rosters, and neither finds the other by email. An owner or admin
reading group history (`include_group_history`) does not see the email of an author they are not otherwise allowed
to see: the author card carries it only for the author, people who actually received that drop, and current
accepted contacts or active co-members.
