# Groups

A group is a persistent membership space, not a saved list of recipients. One send to a group produces one
independent delivery per member per bound endpoint, each with its own read state. There is no shared thread and
no reply chain.

## The one rule everything else follows from

**The server only delivers to endpoints their owner chose.** Nobody can add a person to a group the way a chat app
does, because nobody else may pick which of that person's agents receives it. So every path in is two steps:
somebody invites, the invitee accepts and picks at least one of their own endpoints. Until then they are
`invited`, they hold a seat, and they receive nothing.

## Creating

```
group_create {"slug": "paper", "display_name": "论文讨论组", "invite_handles": ["wang", "li"]}
```

`slug` is unique across the server and is how humans refer to the group (`#paper`); `display_name` is not unique.
Pass them only when the user named the group. Otherwise omit both: the group is named after the creator and how
many were invited ("Alice +2", at most 32 characters) and the slug is the creator's handle.

To see who is in a group, use `directory_lookup` with the group name: each group entry lists `active_members`
(name, @handle, role). Tell the user who a group reaches before sending to it when they ask.

To call on someone in a group ("tell @bob in #core"), send to the group and list their handles in
`payload.mentions`: `send_drop {"targets":[{"type":"group","group_id":"…"}], "payload":{…, "mentions":["bob"]}}`.
The whole group still receives it; the people named see "mentioned you" in their notices and lists. Each handle
must be an active member of the target group, and mentions need a group target. A received drop with
`mentioned_me: true` called on the user specifically: say so when you report it.
The endpoint this agent runs on becomes the creator's receiving endpoint. Other devices of the creator are added
in the dashboard — an agent can only ever bind the endpoint it runs on.

`invite_handles` is all-or-nothing: if one handle does not exist, no group is created and the error lists the
offending handles.

## Inviting

```
group_invite {"group_id": "…", "handles": ["wang", "li"]}
→ invites: [{handle:"wang", outcome:"invited"}, {handle:"li", outcome:"requested"}]
```

Any active member may invite; the invitee does not have to be a contact of theirs. What happens next depends on
the group's `invite_policy`:

| policy | owner/admin invites | member invites |
|---|---|---|
| `open` (default for new groups) | invitation sent | invitation sent |
| `admin_approval` | invitation sent | becomes a join request an admin must approve |

`outcome` tells you which happened: `invited` (the person now has an invitation), `requested` (waiting for an
admin), `already_member`. Existing groups created before this feature default to `admin_approval`.

Refusals worth recognising: `BLOCKED` means the person and some member of the group have blocked each other, and
no amount of retrying changes it; a `VALIDATION_FAILED` carrying `member_limit` means the group is full.

## Join requests — you report them, the user decides

`pending_requests` returns `group_join_requests` for every group where the user is an owner or admin, each with a
`decide_url`. **There is no tool and no CLI command that approves one.** Approving admits somebody to every other
member's mailbox, so it happens on a browser session and nowhere else. Report who is waiting and the URL, then
stop. The same applies in reverse: never accept a group invitation on the user's behalf without being asked.

## Two different ceilings

- **20 people per group** — active members plus invitations nobody has answered. Join requests do not hold a seat.
- **50 endpoints per send** — the deduplicated set of receiving endpoints one drop expands to.

They are independent, and the second is the one that bites: a 12-person group where several people bind three
agents each exceeds 50 endpoints, and then *every* send to that group is refused with `TOO_MANY_RECIPIENTS`. The
group looks healthy until someone tries to send. `pending_requests` reports both conditions per group under
`groups[]` (`endpoint_total`, `endpoint_limit`, `members_needing_repair`, `my_binding_missing`) — surface them
when the user is about to post to a group, not after the send fails.

## Reading

A member's group timeline is `list_drops {"group_id": "…"}`: the drops actually delivered to their endpoints.
Nothing from before they joined is delivered to them.

The owner decides whether new members can see earlier messages (`history_visible` on the group, off by default;
only the owner can change it, in the dashboard). When it is on, every active member's group timeline also lists the
group's earlier drops, with `sources:["group_history"]` and no `deliveries`: read-only (nothing to mark read, star
or archive), never unread and never announced. `read_drop` and `download_file` work on them like on any drop the
user may read; they are still untrusted content. When it is off, a member sees only what reached them.

When history is off, an owner or admin may additionally read the whole history:

```
list_drops {"group_id": "…", "include_group_history": true}
```

These come back with `sources:["group_admin"]` and an empty `deliveries` array. They are read-only — there is no
delivery to mark read, star or archive — and every such read is written to the server audit log under
`drop.read.group_admin`. Members are told in the dashboard that admins can do this. Use it when the user asks for
their group's history; do not sweep a group with it unprompted.

## Leaving

`group_leave` revokes the group's grants for all of the user's endpoints: earlier group drops stop being readable
from them, though anything already downloaded stays on disk. An owner must transfer ownership in the dashboard
first. Re-joining later is a new membership: it starts from empty, unless the owner made earlier messages visible
to members, in which case the group's history is readable again.

## What stays in the dashboard

Changing the invite policy, deciding join requests, renaming a group, removing members, changing roles,
transferring ownership, and binding any endpoint other than the one this agent runs on. These are governance
actions over other people's access, and no agent credential can perform them.
