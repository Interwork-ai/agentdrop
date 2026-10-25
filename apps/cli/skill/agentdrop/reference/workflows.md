# AgentDrop workflows with example calls

All examples are MCP tool calls against the `agentdrop` server. Field names are exact.

## 1. Send text to one person

```
directory_lookup {"query": "老王"}
→ entries[0] = { kind:"person", user_id:"7841…", display_label:"老王·实验合作", handle:"wang",
                 default_target:{type:"user", user_id:"7841…"},
                 default_target_label:"@wang", default_endpoint:null,
                 alternatives:[{route_id:"…", alias:"research", label:"Research", harness_key:"other", auto:false, target:{type:"route", route_id:"…"}}] }
send_drop {
  "request_id": "codex-20260917-162400-a1b2",
  "targets": [{"type": "user", "user_id": "7841…"}],
  "payload": {"payload_version": 1, "kind": "text", "title": "训练不稳定排查结论",
              "body": "已经排除数据顺序；还需验证梯度累积设置。", "attachment_ids": [], "extensions": {}}
}
→ outcome "delivered" | "needs_approval" (+ approval_url) | "not_sent" (+ error)
```

Send to the person using `default_target`. Their receiving agents, names, harnesses and counts are private.
`alternatives` contains only named entries they published; use an entry when the user names it, such as
"send to @wang/research". Report delivery to the person or entry, never claim which of their agents received it.
If `preference_problem` is set, the user's remembered published entry is gone: ask which entry to use; do not
fall back silently. Old automatic addresses are no longer available to other people.

## 2. Send with a file

```
upload_file {"path": "/Users/me/projects/paper/notes.md"}
→ { attachment_id:"c0ff…", safe_name:"notes.md", byte_size:1234, sha256:"…", review_hints:[] }
send_drop { …, "payload": { …, "kind": "file", "attachment_ids": ["c0ff…"] } }
```

`review_hints` are informational on the default server: binary, archive, executable, and other uploaded formats still
send autonomously. A server with a custom organization policy may return `needs_approval`; if it does, never resend.

## 2.4 Keep something in the user's own space

```
upload_file {"path": "/Users/me/projects/paper/figures.zip"}           → attachment_id "d00d…"
send_drop {"request_id": "space-…", "targets": [{"type": "self"}],
           "payload": {"payload_version": 1, "kind": "file", "title": "figures.zip",
                       "body": "for the workstation", "attachment_ids": ["d00d…"]}}
# later, from another machine of the same user:
list_drops {"view": "space", "limit": 1}                               → newest item first
download_file {"drop_id": "…", "attachment_id": "…"}
```

The self target stands alone. The item reaches every agent of the user, read, with no notice and no reply.

## 2.5 Reply to a drop

```
read_drop {"drop_id": "5e1a…"}            # the drop being answered, e.g. from @wang
send_drop {
  "request_id": "codex-20260917-170500-c3d4",
  "targets": [{"type": "user", "user_id": "7841…"}],          # or the group it came through
  "payload": {"payload_version": 1, "kind": "text", "title": "Re: 训练不稳定排查结论",
              "body": "梯度累积确认是原因，修复见 commit 3f2a1c9。", "attachment_ids": [], "extensions": {},
              "reply_to": "5e1a…", "progress": "done"}
}
```

Acknowledging a drop the user starts working on is the same call, before the work, where the drop was asked: to its
author for a direct drop, or as a quoted reply in the group with the author mentioned:

```
send_drop {
  "request_id": "codex-20260917-170200-ack1",
  "targets": [{"type": "group", "group_id": "…"}],             # the group it came through (direct: {"type":"user",…})
  "payload": {"payload_version": 1, "kind": "text", "title": "Re: 训练不稳定排查结论",
              "body": "收到，我先复现梯度累积的问题，今天给你结果。", "attachment_ids": [], "extensions": {},
              "reply_to": "5e1a…", "progress": "started", "mentions": ["wang"]}
}
```

`reply_to` must be a drop the user may read (otherwise VALIDATION_FAILED `reply_to`, nothing sent). The recipient sees
which drop it answers; the answered drop becomes read for the user. Posting to a group also marks that group's
earlier drops read for the user. On the user's sent drops, `replies` counts the answers and names who sent them,
each with the latest `progress` they gave. `progress` (`started`, `done`, `declined`, `needs_info`) goes only with
`reply_to`, and only on replies to drops that asked for something.

## 3. Send to a group

```
directory_lookup {"query": "论文", "kind": "group"}
→ { kind:"group", group_id:"…", display_name:"论文讨论组", slug:"paper", member_count:3, current_h_receives:true }
send_drop { "targets": [{"type": "group", "group_id": "…"}], … }
→ recipients:[{type:"group", label:"#paper", endpoint_count:2, address:null, endpoint_label:null, harness_key:null}]
```

`GROUP_RECIPIENT_UNAVAILABLE` means a member has no usable receiving endpoint; nothing was sent. Tell the user who
(`details.member_handle`) so they or an admin can fix it. `TOO_MANY_RECIPIENTS` means the group expands to more
endpoints than one send may reach — a group can be under the 20-person limit and still hit it, because members
may bind several agents each. Neither is retryable and neither delivered to anyone.

An owner or admin may read the group's whole history, including drops sent before they joined:
`list_drops {"group_id": "…", "include_group_history": true}`. Those drops come back with `sources:["group_admin"]`
and no deliveries — read-only, and each read is recorded in the server's audit log. Do not use it to trawl a group
on your own initiative; it is for a user who asks to see their group's history.

## 4. Check and read mail

```
list_drops {"view": "inbox", "unread_only": true}
→ drops:[{drop_id, title, preview, author:{display_label, handle}, attachment_count, read, state_version, sources}]
read_drop {"drop_id": "…"}                      # first 4096 chars
read_drop {"drop_id": "…", "offset": 4096}      # continue while next_offset != null
set_drop_state {"drop_id": "…", "expected_version": 0, "read": true}
download_file {"drop_id": "…", "attachment_id": "…"}
→ { saved_path:"~/.local/share/agentdrop/downloads/<drop_id>/results.csv", sha256_verified:true }
```

Reading never marks a drop read; do that explicitly if the user wants. `VERSION_CONFLICT` on `set_drop_state`
means another session changed it: re-list and retry with the new `state_version`.

## 5. Contacts

```
contact_request {"handle": "wang"}          → status "invited" (waiting) | "accepted" (they had invited me)
pending_requests {}                           → contact_requests_received / contact_requests_sent / group_invitations
contact_respond {"user_id": "…", "decision": "accept"}
```

Try it first with the built-in contact `@agentdrop` (every account has it): resolve it with `directory_lookup`,
send a short drop, then `list_drops {}` a few seconds later shows its receipt. A colleague with a known @handle is
added with `contact_request`; they accept with `contact_respond` in their own agent (or the dashboard, or
`agentdrop accept @you`). For someone without an account, or to connect without waiting for them to accept, the
user generates an invite link on the dashboard Contacts page and sends it to them; there is no agent tool for
invite links.

### Removing contacts (user-confirmed, terminal only)

```
agentdrop contact remove @push_test_1 @push_test_2 --profile cc      # step 1: describes them, removes nothing
→ About to remove these 2 contact(s) (nothing removed yet):
  - @push_test_1 · AgentDrop Push Test
    status: accepted; contact since 2026-09-20; 1 drops from them, 0 to them, last 2026-09-20
  …
# show that list to the user and ask; only after they reply "yes":
agentdrop contact remove @push_test_1 @push_test_2 --profile cc --confirm
```

All or nothing: if any handle is not a contact, nothing is removed and the error lists it. Existing drops stay;
the person would have to send a new request to reconnect.

## 6. Groups

```
group_create {"slug": "paper", "display_name": "论文讨论组", "invite_handles": ["wang", "li"]}
  # binds THIS endpoint as my receiver and invites both people in one step
group_invite {"group_id": "…", "handles": ["wang", "li"]}
  # any active member may invite; under an admin_approval group a plain member's invitation becomes a
  # join request instead → invites:[{handle:"wang", outcome:"requested"}]
group_respond {"group_id": "…", "decision": "accept", "nickname": "王同学·RL"}   # binds THIS endpoint only
group_leave {"group_id": "…"}
```

Full details in `reference/groups.md`. The three rules worth carrying: nobody joins until they accept and pick
their own receiving endpoint; a group holds at most 20 people (members plus unanswered invitations); and join
requests are decided by the user in the dashboard — there is no tool for it, so report them and stop.

## 6.5 Exporting a timeline

There is no export tool. It is a CLI command, and it is fine to run it when the user asks for a record of a
correspondence or a group:

```
agentdrop export --contact @wang --since 2026-09-01 --until 2026-10-01 --profile <name>
agentdrop export --group  #paper  --since 2026-09-01 --until 2026-10-01 --profile <name> --out paper.jsonl
```

NDJSON: a header line with the count, one line per drop, and a trailer whose count and digest must match what
was read — the CLI checks this and writes nothing on mismatch, so never treat a failed export as "partial but
usable". The range is `[since, until)` in UTC, ordered by when each drop was written.

A per-contact export contains **direct traffic only**; what you exchanged inside a shared group is exported with
`--group`, not here. Exporting a group's history from before the user joined is dashboard-only and will be
refused over this credential — report that rather than retrying.

## 7. Retrying safely

```
send_drop … → ERROR NETWORK_ERROR (outcome unknown)
send_drop … same request_id → returns the original result if it had committed, or sends now
```

Never generate a second `request_id` for the same message. If the user edits the message, that is a new message
and gets a new id.
