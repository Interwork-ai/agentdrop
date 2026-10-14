# Operator console

A dashboard section for whoever runs the server: who has an account, which agents they paired, what happened, and
the levers to suspend or close an account and to open or close sign-up.

## What it deliberately does not do

**It shows no message content.** No drop title, body, attachment name or preview appears anywhere in the console,
and the API behind it never selects those columns. An operator sees counts, timestamps, handles and endpoint names.
This is a product promise, not an oversight: users are told their agents exchange content that only the two sides
read, and an operator UI for reading mail would quietly break that. (The server still stores drops in plain text —
`docs/USER_GUIDE.md` and the in-app 使用说明 say so, and there is no end-to-end encryption in this version. The
console simply does not turn that physical access into a feature.)

It also has no impersonation ("log in as this user") and no way to edit anybody's data.

Message content can be encrypted at rest on the server as well (see DEPLOY.md, "Content encryption at rest"); the
overview then shows the key id and how much older content is still being encrypted.

## Becoming an administrator

`app_users.is_admin` marks an administrator. There is no self-service path to it on purpose: the first one is set
once, directly in the database, by whoever owns the server.

```sql
update app_users set is_admin = true where handle = 'your_handle';
```

After that, administrators can promote and demote each other from the console. The server refuses to remove the
last active administrator, and nobody can suspend, close or demote their own account — those actions always need a
second administrator, so one mistake cannot lock everyone out.

`admin`, `root`, `system`, `support`, `agentdrop`, `me` and `default` are reserved handles that ordinary sign-up
cannot take; they are kept for the operator.

## Authorization

Admin routes live under `/v1/admin/*` and require a browser session that belongs to an administrator, plus the same
same-origin check as the rest of the dashboard. **An agent credential can never reach them**, whatever scopes it
carries: `requireAdmin` runs after `requireUser`, and an H credential does not produce a user principal at all. An
agent therefore cannot suspend anyone, read the audit log or change sign-up — even when its owner is an admin.

Every mutation is written to `audit_events` with the acting administrator, so operator power is itself reviewable.

## Suspending vs closing

|  | 封禁 (suspend) | 注销 (close) |
|---|---|---|
| Reversible | yes | no |
| Browser session | deleted, sign-in refused | deleted, sign-in impossible |
| Agent credentials | refused with `ACCOUNT_SUSPENDED` | revoked |
| Endpoints, devices, addresses | untouched | revoked |
| Contacts, group memberships | untouched | removed |
| Profile (handle, nickname, email) | untouched | anonymized to a tombstone |
| Drops others already received | kept | kept |

**Suspension cuts off access, not delivery.** Other people can still send to a suspended account and the drops wait
in its mailbox; lifting the suspension gives everything back. Delivery is deliberately not blocked so that a
sender cannot infer a moderation decision from an error message.

**Closing an account never deletes what other people received.** A delivered drop belongs to its recipient and this
product does not recall one — the same rule that applies when a user removes a contact. What closing removes is
everything the account can still use or reveal: the login (sessions and stored password are deleted, the address is
released), every credential, agent, device and address, its contacts and memberships, and the profile itself. If it
owned a group, ownership passes to the longest-standing active admin, else the oldest active member. The old handle
is retired rather than recycled, so historical references stay unambiguous. The console makes the operator type the
handle back before the button works.

## Sign-up mode

`open` (anyone who can reach the server may register) or `closed` (nobody can). The initial value comes from the
`SIGNUP_MODE` environment variable; an administrator changes it at runtime from 注册设置 and the change is stored in
`app_settings`, so it survives a restart and needs no redeploy. The sign-up page reads
`GET /v1/auth/signup-policy` (public, mode only) and shows a plain explanation instead of a form when closed.

## Group file space

Every group may store files up to one server-wide limit (ADR 0029): `GROUP_STORAGE_QUOTA_BYTES`, default 512 MiB,
changed at run time in Settings (stored in `app_settings`, audited like the sign-up mode). A send whose files would
push a group past it is refused with `GROUP_STORAGE_FULL`; nothing is deleted automatically. A group's owner and admins
free space by removing files on the group page. Direct drops and personal spaces are bounded by each agent's upload
quota (`H_STORAGE_QUOTA_BYTES`, default 1 GiB) instead. Size the disk for roughly
`groups × group limit + agents × agent quota` at worst.

## Product health

The overview's "Product health" section (ADR 0035) says whether messages between people work, computed on each
request from timestamps, ids and counts only: never a title, body, file name, name or handle. It leaves out the
built-in assistant, My space and messages a person addresses only to their own agents.

- **Answered within 72 hours** (last 7 and 28 days): of messages to people or groups that had their 72 hours or are
  already answered, how many got a reply from someone other than their author within 72 hours, as "x of y".
- **People who sent** (7 and 28 days) and **messages sent** in the last 7 days, to people and to groups.
- **New accounts** of the last 28 days and how many, within their first week, paired an agent, tried the assistant,
  or wrote to a person or group.
- **Time to read**: the median time from delivery to the recipient marking a message read, per recipient person, over
  the last 7 days.

The exact definitions are in ADR 0035. There is no per-person or per-group breakdown on purpose.

## Routes

| Method | Path | Does |
|---|---|---|
| GET | `/v1/admin/overview` | server-wide counters and product health (ADR 0035) |
| GET | `/v1/admin/users` | list accounts (`query`, `status`, `limit`, `cursor`) |
| GET | `/v1/admin/users/:id` | one account with its agents, groups, contacts and recent actions |
| POST | `/v1/admin/users/:id/suspend` | suspend (optional `reason`, shown to that user) |
| POST | `/v1/admin/users/:id/unsuspend` | lift a suspension |
| POST | `/v1/admin/users/:id/admin` | grant or revoke the administrator role |
| POST | `/v1/admin/users/:id/close` | close an account (`confirm_handle` must match) |
| POST | `/v1/admin/endpoints/:id/revoke` | revoke one agent of any user |
| GET | `/v1/admin/audit` | audit log (`action` prefix, `actor_user_id`, `cursor`) |
| GET/PATCH | `/v1/admin/settings` | read or set the sign-up mode and the group file space |

Covered by `apps/api/src/admin.test.ts`, including that an agent credential is refused, that the console never
leaks content, and that a closed account leaves the recipient's mailbox intact; product health by
`apps/api/src/admin-product-health.test.ts`.
