# 0022. The group owner decides whether new members can see earlier messages

- Status: Accepted
- Date: 2026-10-02
- Refines: SPEC §3.4 (history, leaving and rejoining) and its 2026-09-22 admin-history exception; ADR 0006
  (groups receive with all agents), ADR 0012 (public email) and ADR 0013 (people only)

## Context

A member only sees the drops delivered to them, from the moment they joined (SPEC §3.4). That is the right default
for a group whose members did not write for a wider audience. Many groups are the opposite: a project or lab group
where someone joining later needs the decisions and files that were shared before, and members had to forward old
drops one by one. The owner and admins could already read the whole history (the 2026-09-22 exception), but only
as an explicit, audited admin act, never as a member.

## Decision

A group has one setting, `groups.history_visible`, with exactly two values:

- **off** (default, also for every existing group): members see only what reached them since they joined.
- **on**: every *active* member may read the group's whole history — every drop sent to the group, before and
  after they joined — read-only.

Only the **owner** changes it (dashboard, browser session: `PATCH /v1/me/groups/{id}/policy` with
`history_visible`; admins and members get `FORBIDDEN`). The creator may set it when creating the group in the
dashboard (`POST /v1/me/groups` with `history_visible`); the agent tool `group_create` does not take it. Every
member and invitee sees the current value (`history_visible` on the group views and `group_*` tool results); it
applies to everyone who joins later and to current members who joined after some drops were sent.

Authorization stays one predicate. `loadAuthorizedDrop` gains a source next to `group_admin`: when no delivery
authorizes the read and the viewer is not the sender, a drop that was sent to a history-visible group (a group grant
for that group on any delivery of the drop; grant revocation ignored, exactly like the admin rule) is readable by any
active member of that group, as `sources: ['group_history']`. The per-H boundary is the admin rule's: with
account-wide reads off, only through an H bound to the group. It is checked before the admin rule, so an owner or
admin of a history-visible group reads it as a member does. Lists (`group_id` timeline, including search within it),
detail, attachment download and the group export all follow it; the group timeline of an ordinary member includes
the history without any flag, and `include_group_history` keeps its meaning (explicit, audited) for owners/admins of
groups where the setting is off.

Read-only and quiet: such a drop produces no delivery, so it has no read/star/archive state, `set_drop_state`
refuses it (`NOT_FOUND`: mutations still need a delivery with a valid grant), it never counts as unread, never enters an inbox list or
the end-of-turn/prompt-time context, and no notice, browser push or Feishu message announces it. A member who
left and rejoined, or who changed the agent that receives the group, may still have an old delivery of an earlier
drop, but its grant was revoked: like any revoked delivery it authorizes nothing and carries no state, so that drop
is history for them too. Every path that writes per-person state (`set_drop_state`, mark all as read, and the
send's own catch-up and `reply_to` mark of ADR 0016) changes only deliveries with a valid grant; the same holds for
an owner or admin reading through `group_admin`. Turning the
setting on or off delivers nothing and notifies nobody. Member reads are ordinary access, audited as `drop.read` /
`drop.export` like any other read; the admin-history audit entries are unchanged and not written for them.

People only (ADR 0013) and the email rule (ADR 0012) apply as for the admin path: no other person's agent
attribution, no author email from a drop the viewer did not receive unless the author is otherwise visible to them
(contact or active co-member).

Blocks do not filter the history, for the same reason they do not filter a group: group fan-out never consults a
block (a block is about a person, and the group refuses to seat two people either of whom blocked the other), so a
member's ordinary group timeline already shows every drop sent to the group. The history follows it: a reader who
blocked an earlier member (possible once that member left) still sees that member's earlier drops to the group,
under the author card as today, which a block in either direction strips of the public email; the agent
attribution is absent anyway. Hiding them would make the history the one group view that applies blocks, and an
owner who opened the history to give newcomers the group's decisions would give them a version with holes nobody
can see.

Members who left or were removed see nothing of it. Switching the setting off removes the earlier drops again for
members who joined later; drops actually delivered to a member stay theirs.

The side projections (`reply_to` titles, reply counts, the "replied to «…»" wording of push and Feishu) follow the
predicate including this source, because a member can open those drops directly: a reference to one names it. They
still leave the admin role out, since admin reads are explicit and audited (ADR 0016).

## Consequences

An owner can make a group's past available to newcomers with one switch, and take it back. The history is read on
demand, so it costs nothing per member and changes no unread count. A member cannot tell from the timeline alone who
received an earlier drop; they see the author and the group, as any member of the group would. Bridges and CLIs
before 0.5.9 parse `sources` against an enum without `group_history`; the server reports `group` to them instead,
so their results still parse. Expand-only migration `0026_group_history_visible` adds the column with default false.
