# Errors and what to do

Every error carries `code`, `message`, `next_action`, `retryable`. Follow `next_action`; the table adds context.

| code | Meaning | Do |
|---|---|---|
| `NOT_A_CONTACT` | The person has not accepted a contact request (or you never sent one) | `contact_request`, then tell the user to wait for acceptance — or to send them an invite link from the dashboard Contacts page, which connects them as soon as they open it |
| `NO_DELIVERY_ROUTE` | The recipient has no agent that can receive | Tell the user; the recipient must set one in their dashboard, or pick a published entry |
| `PREFERRED_ROUTE_UNAVAILABLE` | The user's remembered entry for this contact was revoked | Ask the user which entry to use now; never switch silently. If the contact replaced a machine, they can hand the old agent over to the new one in their dashboard (My agents), which brings the address back |
| `ROUTE_UNAVAILABLE` | A named entry is revoked or not published to you | Re-run `directory_lookup` and choose again |
| `GROUP_RECIPIENT_UNAVAILABLE` | An active member has no usable endpoint; whole send refused | Tell the user who (`details.member_handle`) |
| `TOO_MANY_RECIPIENTS` | More distinct endpoints than the limit | Split the send |
| `AMBIGUOUS_TARGET` / `ambiguous:true` | Several people/groups share the label | Show candidates with @handle / slug; ask |
| `IDEMPOTENCY_CONFLICT` | Same `request_id` reused with different content | This is a different message: use a new id |
| `VERSION_CONFLICT` | Another session changed the flags | Re-list, retry with the current `state_version` |
| `NEEDS_APPROVAL` / outcome `needs_approval` | Human must approve in the dashboard | Give the URL; do not resend |
| `STALE_APPROVAL` | Targets changed since preview | The user re-approves in the dashboard |
| `ATTACHMENT_NOT_READY` / `ATTACHMENT_NOT_OWNED` | Bad or foreign attachment id | Upload again from this endpoint |
| `PATH_NOT_ALLOWED` | Outside allowed directories or a sensitive file | Tell the user to run `agentdrop allow-dir add <dir> --profile <name>`; never try other paths to get around it |
| `FILE_TOO_LARGE` | Limits | Tell the user the limit from `details` |
| `QUOTA_EXCEEDED` | This agent's upload space is used up | Tell the user to delete items from their own space (dashboard My space, or `agentdrop space rm` in a terminal) |
| `GROUP_STORAGE_FULL` | The group's file space would be exceeded (`details`: group, used, limit) | Tell the user which group is full; a group owner or admin can remove old files in the dashboard, or send without the files |
| `FILE_REMOVED` | The file was removed after the drop was sent | Tell the user it is no longer available; do not retry |
| `RESYNC_REQUIRED` | Cursor from another view / stale | Drop the cursor and list again |
| `UNAUTHORIZED` / `ENDPOINT_REVOKED` | Credential expired or revoked | The user must run `agentdrop endpoint add …` again |
| `NETWORK_ERROR` | Result unknown | Retry with the SAME `request_id` |
| `UPSTREAM_UNAVAILABLE` | Server down | Retry later; suggest `agentdrop doctor` |

Tools missing from the client entirely → the bridge is not connected: the user runs `agentdrop connect codex
--profile …` (or `claude-code`) and restarts the client, then `agentdrop doctor --mcp`.

## Behind an HTTP proxy

The bridge finds its own way to the server. Harnesses start it with a reduced environment (Codex passes only
`HOME`, `PATH`, `SHELL` and a few more), so an `HTTPS_PROXY` set in the user's terminal never reaches it; the hooks
then work while every tool call fails with `fetch failed` and the dashboard shows the agent offline. It tries, and
saves the first route that answers per server in `~/.config/agentdrop/network.json`: the proxy in its own
environment, a direct connection, a proxy in the harness's environment (Linux), and only after those fail, the
proxy in the user's login shell and common local proxy ports (7890, 7897, 10809, 1087, 8118, 3128; https servers
only). Any AgentDrop command or hook that runs with the proxy set also saves it for the bridge. A saved route that
stops working is tested again. `agentdrop doctor` re-tests and shows the route in use.

If `NETWORK_ERROR` persists: tell the user to run `agentdrop doctor` in a terminal, and if it reports no route, to
set `AGENTDROP_PROXY=http://host:port` (an explicit proxy, used as is) in the bridge's environment, then restart the
client. SOCKS proxies are not supported; an HTTP proxy port is needed.

A server on a private address never goes through a proxy: loopback, `10/8`, `172.16/12`, `192.168/16`,
`169.254/16`, `100.64/10`, IPv6 ULA/link-local, a bare hostname, `.local` and `.internal`, plus any host covered by
`NO_PROXY` (CIDR entries included, which Node itself ignores). Override with `AGENTDROP_PROXY=never` (always direct)
or `AGENTDROP_PROXY=always` (only the proxy from the environment).

## The user cannot sign in to the dashboard

Not an MCP error: the agent's credential keeps working when the web password is forgotten. Point the user to the
section "A forgotten AgentDrop password" in the skill: `agentdrop account recover` typed by them in their own
terminal, a recovery code on "Forgot password", email if the server sends it, an administrator last. Never run the
command yourself and never ask for or handle their codes or reset links.
