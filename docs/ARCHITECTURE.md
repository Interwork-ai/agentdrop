# Architecture

For people changing the code. `docs/plan/SPEC.md` is the design baseline; this document describes what is built.

## 1. Shape

```
  Codex / Claude Code ──stdio──▶ agentdrop mcp (bridge, one process per client connection)
                                        │  HTTPS, Bearer <H credential>
                                        ▼
  Browser ──cookie session──▶  Fastify API ──▶ domain use-cases ──▶ PostgreSQL 17
                                        │                              │
                                        └──▶ StorageProvider (fs | S3) └──▶ outbox ──▶ worker
```

One modular monolith. The API is thin: it authenticates, parses, resolves a *scope*, and calls a domain use-case
inside a transaction. The dashboard and the MCP bridge call the same use-cases; there is no second authorization
implementation for the web.

| Package | Responsibility | Must not import |
|---|---|---|
| `packages/contracts` | Zod schemas → JSON Schema / OpenAPI, error codes with `next_action` (written for the calling agent; the dashboard maps codes to its own Chinese text), limits, name rules | anything app-specific |
| `packages/db` | Drizzle schema, migrations, `withTx`, the LISTEN helper (`listen.ts`) | domain |
| `packages/domain` | rules and use-cases (identity, contacts, directory, send, read, approvals, groups, attachments) | MCP, React, Codex/Claude specifics |
| `packages/security` | path allowlist, sensitive-file rules, review hints, safe names | db |
| `packages/storage` | `StorageProvider`: FsStorage (dev), S3Storage (prod) | db |
| `packages/client` | typed HTTPS client used by the bridge and CLI | db, domain |
| `packages/mcp` | tool registration from contracts, result encoding | db, domain |
| `apps/api` | routes, principals, Better Auth adapter, static dashboard | – |
| `apps/cli` | pairing, profiles, credential store, `mcp` bridge entry, `connect`, `doctor` | – |
| `apps/web` | React dashboard | – |
| `apps/worker` | outbox consumer, sweeps | – |

## 2. Identity model

```
User (app_users) ─┬─ Device (devices: random installation_id per bridge install)
                  │     └─ H / HarnessEndpoint (unique per user+device+harness+profile)
                  │            ├─ h_credentials (hash only, scoped to this H, expires)
                  │            └─ connections (bridge instances: diagnostics only)
                  ├─ recipient_routes (one default, any number of named aliases → an H of mine)
                  ├─ contacts (per direction: status, blocked, private remark, preferred route; legacy auto_approve retained for compatibility)
                  └─ group_memberships ──▶ group_bindings (which of MY endpoints receive that group)
```

Two principals, never mixed:

- `HPrincipal` from `Authorization: Bearer adh_…` — fixed `{userId, hId}`; routes under `/v1/h/*`. Credentials carry
  scopes `mailbox` and `manage`; the relationship routes (`/v1/h/requests`, `/v1/h/contacts/*`, `/v1/h/groups/*`)
  require `manage` and can bind only the credential's own H. Ordinary mailbox list/read uses the owning user's
  account scope when `cross_h_mailbox_enabled` is on (the default), but sending and state mutation stay fixed to
  the credential H. Clients may request `endpoint_scope=current` for endpoint-local reads such as Stop notices.
- `UserPrincipal` from the Better Auth session cookie — routes under `/v1/me/*`; mailbox views take an explicit
  `:h_id` and verify ownership; state-changing requests need a trusted `Origin` or `Sec-Fetch-Site: same-origin`.

Both resolve to the same `MailboxScope { userId, hId, via }` before calling a mailbox use-case. That scope carries
the current H for attribution/mutation and the server-resolved read policy; it never accepts an arbitrary H from an
H-credential request.

Pairing: `POST /v1/pairing/start` (CLI, unauthenticated, rate limited) → the human opens `/pair?code=…` with a session
→ `decidePairing` locks the pairing row, registers the device once per installation and the endpoint once per
(user, device, harness, profile) → `POST /v1/pairing/poll` issues the credential exactly once and marks the row
consumed. Re-pairing the same profile yields a new credential for the *same* H.

## 3. Message model

```
drops (immutable body, author snapshot, target snapshot, content hash)
  └─ deliveries (one per (drop, H); read/starred/archived + state_version, kept equal across one person's Hs)
        └─ delivery_grants (why this H may read: direct via route_id | group via membership+binding; revocable)
send_requests (unique (origin_h_id, request_id): idempotency + stored result)
approvals (pending human decision: envelope, content hash, private endpoint snapshot, origin_kind)
mailbox_heads / mailbox_events (per-H revision and ordered events; they back the per-person event stream for the
retention window, ADR 0040)
attachments ─ drop_attachments (an attachment belongs to at most one drop)
outbox_events (derived side effects only)
audit_events (ids, actions, sizes; never content)
```

### The authorization predicate

The mailbox authorization helper in `packages/domain/src/mailbox/authorization.ts` evaluates the current scope:

```
drop exists AND not revoked AND (no expires_at OR expires_at > now)
AND (
  drop.origin_h_id = current_h_id
  OR exists valid delivery(drop, current_h_id)
  OR (
    cross_h_mailbox_enabled AND endpoint_scope != current
    AND (drop.origin belongs to current user OR exists valid delivery to any H owned by current user)
  )
)
```

Detail and attachment downloads call the read predicate. List queries embed the same conditions so a list never
shows what detail would refuse. `set_drop_state` changes the person's state (ADR 0007): it needs a drop the
caller may see through a delivery or the person's own send (history-only and admin reads give no state), then
writes the same flags and version to every delivery of that drop to any of the person's Hs. Responses include `origin_agent`, the
owner-visible `deliveries[]`, and privacy-bounded `recipients[]`, so clients explain which Agent actually sent or
received the record without exposing another user's private device inventory.

### Sending

`sendDrop` (`packages/domain/src/mailbox/send.ts`) in one transaction:

1. Reserve `(origin_h_id, request_id)` with `INSERT … ON CONFLICT DO NOTHING`. If the row exists, lock it, compare
   the content hash, and return the stored result (`IDEMPOTENCY_CONFLICT` on mismatch). This is why a retry after the
   recipient changed their default route never re-delivers.
2. `resolveTargets`: deduplicate and sort targets (groups first) so locks are taken in a fixed order.
   - `user` → my remembered preference (must still be a route the peer publishes; else
     `PREFERRED_ROUTE_UNAVAILABLE`) or the peer's default route (`NO_DELIVERY_ROUTE` if none). Route rows are
     locked `FOR UPDATE`.
   - `route` → a published named route of someone I may send to.
   - `group` → lock the group row; every active member must have ≥1 usable binding, else
     `GROUP_RECIPIENT_UNAVAILABLE` for the whole send. The aggregate number of distinct endpoints is capped.
   The result is a map `hId → grants[]` (one delivery per H even when reached twice) plus recipient labels and a
   private snapshot of users/groups/versions/endpoints.
3. Attachments must be `ready`, owned by the sending H and within the per-drop byte limit.
4. Approval policy (`defaultApprovalPolicy`) allows autonomous sends after contact/group authorization, including
   every successfully uploaded attachment. `reviewHintApprovalPolicy` remains an optional stricter deployment hook;
   only a configured policy can write an `approvals` row and return `needs_approval`.
5. `commitDrop`: insert drop → deliveries + grants (sorted by H) → bump mailbox revisions (heads locked in H order)
   → outbox event → audit → update `send_requests` with the result.

`decideApproval` re-runs step 2 and compares versions **and** the endpoint snapshot; any difference refreshes the
preview and returns `STALE_APPROVAL` (committed, then reported), so the human re-approves against what would
actually happen. Expiry and rejection are persisted as `not_sent` for the same `request_id`.

### Groups and generations

Membership rows are never reactivated: leaving or being removed sets `status` and `revoked_at`, revokes the
bindings, and revokes every grant that came from that membership (`revokeGrantsForMembership`). A direct grant on
the same delivery survives. Re-joining inserts a new row, so old grants can never point at the new membership.
Binding changes revoke only the grants of the removed bindings. All of this runs under the group row lock that
fan-out also takes.

Any active member may invite. `groups.member_invite_policy` decides what a plain member's invitation becomes:
under `open` it is an invitation, under `admin_approval` a `group_join_requests` row an owner/admin must decide.
Owners and admins always invite directly. Handles are resolved before anything is written, and the whole call is
one transaction with a single sorted `bumpDirectoryRevision` — a per-handle bump would order `app_users` updates
by caller-supplied handle order and deadlock against a concurrent invite of the same people in the other order.
Invitations deliberately do **not** bump `groups.version`: no receiving endpoint changed, and that version is what
`decideApproval` compares, so bumping would invalidate unrelated pending sends. `MAX_GROUP_MEMBERS` (default 20)
counts active members plus unanswered invitations; join requests are bounded separately and checked again at
approval time. An invitee who has not accepted is not shown the roster, and nobody can be invited into a group
where they and any active member have blocked each other — group fan-out never consults `canSendTo`, so without
that check a member could rebuild a channel a block closed.

Owners and admins may read the group's whole history, including drops that predate them: `loadAuthorizedDrop`
falls back to `adminReadableGroups` when no delivery authorizes the read, and `list_drops` exposes it only behind
an explicit `include_group_history` together with `group_id`. Such drops carry `sources: ['group_admin']` and no
delivery, so `setDropState` (which requires a delivery for the current H) cannot touch them, and each detail read
is audited as `drop.read.group_admin`.

The owner may also make the history visible to every active member (`groups.history_visible`, ADR 0022). That is
a second fallback in the same predicate, checked before the admin one: `historyReadableGroups` (group grant for a
history-visible group the viewer is an active member of; revocation ignored; same per-H boundary through
`boundThrough`). Drops reached this way carry `sources: ['group_history']`, no delivery, and are ordinary reads (no
admin audit). `listDrops` serves the whole history for a `group_id` inbox timeline whenever
`isHistoryVisibleMember` holds, with the mode folded into the cursor scope so a cursor cannot cross the switch.
`readableDropIds`/`readableThrough` take the viewer and include this source (never the admin role), so `reply_to`
titles and reply counts match what the member can open.

### Export

`planExport` / `readExportChunk` (`packages/domain/src/mailbox/timeline.ts`) run in two phases, and the split is
load-bearing. Phase one resolves the id set, enforces the ceiling and commits the audit row inside a short
transaction; phase two reads bodies with no transaction open. Streaming inside `withTx` would pin one of ten
pooled connections (`packages/db/src/client.ts`) for the whole download, and there is no `statement_timeout` to
cut it short. It also means the header carries a real count before the first byte, and the audit row survives a
client that disconnects mid-stream.

The response is NDJSON with a trailer (`count` + sha256 over the drop lines). Every NDJSON line parses on its
own and the format has no terminator, so without a trailer a truncated download is indistinguishable from a
complete one — unacceptable for something kept as a record.

A peer export is **direct traffic only**, in both directions: inbound is `author = peer` intersected with a live
direct grant of mine, outbound is `origin_h_id ∈ visible endpoints` intersected with
`target_snapshot @> {"user_ids":[peer]}`. Outbound deliberately does not join the peer's deliveries: for a group
send that would disclose which members received which drop, which the group recipient card exists to withhold
(`send.ts` records only `group_ids` in the snapshot, and the card reports a count with no addresses). Using the
author's own frozen snapshot is both cheaper and provably no wider than what the author already saw.
`author_user_id` is only an index prefilter — the authorization is the endpoint scope, so turning off
`cross_h_mailbox_enabled` or asking for `endpoint_scope=current` narrows an export exactly as it narrows a list.

Group exports reuse `isGroupAdmin`; full history requires the same explicit `include_group_history` opt-in the
dashboard uses, is refused over an H credential, and is audited as `drop.export.group_admin` rather than folded
into `drop.export`. In a history-visible group (ADR 0022) every member's group export is the whole history without
the flag, audited as an ordinary `drop.export`, with `include_group_history: true` in the header.

## 4. Files

Upload (`POST …/attachments`, `application/octet-stream`): reserve quota under a per-H lock and persist a random
object key in a `staging` row → stream into that key while metering bytes, hashing and sniffing the first 64 KiB →
server-side review hints → mark `ready`. There is no object move between writing bytes and committing the row:
after a crash or a failed finalization, the staging sweep still knows the key to delete. Limits abort the stream
and free the reservation. Download is proxied through the API and
authorized through the drop (`authorizedAttachment`), never by attachment id alone.

The bridge's `upload_file` runs `openAllowedFile`: allowlist by realpath, sensitive-file rules, `O_NOFOLLOW`, fstat
on the descriptor, then re-resolve and compare dev/ino. `download_file` writes to a temp file, verifies the sha256,
then renames into `~/.local/share/agentdrop/downloads/<drop_id>/`, never overwriting.

## 5. MCP bridge

`agentdrop mcp --profile X` loads one profile (server, h_id, credential reference), fetches the live agent name with
a 3 s budget, registers the tools of the profile's toolset (`core` 5 or `standard` 7) from `TOOL_DEFINITIONS`, and
serves stdio. Every tool result carries `structuredContent` plus a text rendering; every error is an `isError`
result with the stable code and `next_action`. `send_drop` maps transport failures to an "unknown outcome" that
first queries `/v1/h/send-requests/:request_id`. Connections are registered after `initialize` (so the client name is
known) and heartbeat every 30 s with jitter; none of that affects permissions.

## 5.1 Notifications

Three channels, all derived from the same events:

1. Completion adapter: `agentdrop connect` installs `agentdrop pending --profile X --in-hook` as a Stop hook in
   `~/.claude/settings.json` / `~/.codex/hooks.json`, a guarded `stop` hook in Cursor, or a `session.idle` plugin in
   OpenCode. After each turn it emits a host-appropriate notice only when something is waiting: `systemMessage`,
   one guarded Cursor `followup_message`, or an OpenCode TUI toast. Re-entrant Stop inputs are ignored.
2. In-band data: every viewer block includes `pending` counts (`pendingCounts`) as structured data, no text nagging.
3. Dashboard badges (10 s polling of contacts/groups/approvals/unread).
4. Outbox events `contact.requested`, `contact.accepted`, `group.invited`, `group.join_requested` (one per
   admin), `drop.delivered`, `approval.created`
   → worker → per-user HTTPS webhook (`app_users.notification_webhook_url`), metadata only, retried with backoff.

Terminal completion without the dashboard: `inbox`, `read`, `requests`, `accept`/`decline`, `approvals`, `approve`
use the H credential (manage scope). `approve` reads its confirmation from `/dev/tty`, so a model driving a shell
tool (no controlling terminal) cannot approve its own send; the server-side approval endpoint is therefore only
reachable by a human at a terminal or through the dashboard session.

## 6. Consistency and refresh

- Mailbox revisions: `mailbox_heads` rows are locked in ascending `h_id` order and incremented per event.
- Cursors: keyset `(received_at, id)` plus a scope hash of `(h_id, view, filters)`; a cursor from another view or H is
  `RESYNC_REQUIRED`.
- Event stream (ADR 0040): `mailbox_events` and `directory_revision` back one resumable stream per person
  (`/v1/h/events`, `/v1/me/endpoints/:h_id/events`), long-poll or SSE behind one opaque cursor (compact binary:
  per-agent revisions, `directory_revision`, a tag binding it to person and scope). Each agent is read through the
  `(h_id, revision)` index and the rows merged by id; a gap in an agent's revisions (retention), a cursor ahead of
  the server or one from another scope is `RESYNC_REQUIRED`. `bumpMailboxes` writes events in input order, so the
  copies of one change for a person's agents are adjacent and coalesce. Events carry ids and types only. The
  writing transaction calls `pg_notify` once per affected person; each API process holds one LISTEN connection
  (`EventHub`, `apps/api/src/events.ts`; TCP keepalive and a `SELECT 1` every 30 s reconnect a silently dropped
  one), and a missed wake-up costs at most one wait period. An open stream re-runs the credential or session check
  before each batch and at least every 25 s, pings when idle for 25 s, stops reading for a client that lags and
  cuts it off after 25 s, and ends after 15 minutes. The worker sweeps events past the retention window.
- Dashboard: 10 s refetch while visible (60 s hidden); query keys include `h_id`; switching H drops the cache.
- Worker: `outbox_events` claimed with `FOR UPDATE SKIP LOCKED` and a lease; exponential backoff; dead-letter after
  8 attempts; handlers are idempotent. Delivery never waits for it.

## 7. What to touch for common changes

| Change | Where |
|---|---|
| New tool input/output | `packages/contracts/src/tools.ts` → `pnpm contracts:generate` → handler in `packages/mcp` → route in `apps/api/src/routes/mailbox.ts` |
| New table/column | `packages/db/src/schema/*.ts` → `pnpm db:generate --name …` → commit SQL; `pnpm db:check` guards drift |
| New read path | must go through the shared current/account-scope authorization helpers and `hasValidGrant` |
| New approval reason | `defaultApprovalPolicy`; keep the reason string human-readable, it is shown on the approval page |
| New client (harness) | `harnessKeyEnum` + `connect` recipe in `apps/cli/src/commands/connect.ts` |

## 8. Client and server boundary

```text
CLI / local files / harness config / MCP bridge
  ├─ packages/client       HTTPS API client
  ├─ packages/mcp          stdio tool registration
  ├─ packages/security     local path and attachment policy
  └─ packages/contracts    versioned protocol, input and output types
                     ↓ HTTPS /v1
API + Web + Worker
  ├─ packages/domain       authorization and business rules
  ├─ packages/db           PostgreSQL, migrations
  └─ packages/storage      server-side file / S3 storage
```

The client never imports domain, db or storage, and carries no server address: `agentdrop setup --server <URL>`
decides which server it talks to. Identities, contacts and messages on different servers are separate; servers do
not federate. `build:cli` checks esbuild's actual dependency graph and fails when server, database or S3 code leaks
into the CLI bundle.

- `pnpm verify:cli`: client lint, types, contract check, database-free tests, the standalone npm package and the
  dependency boundary; reads no `.env` and needs no PostgreSQL. CI runs it on Node 22 for a push that touches the
  client and on Node 22 and 24 for a release, and the npm release
  workflow installs the tarball and performs a real MCP stdio handshake before publishing.
- `pnpm build:server`: API, worker and dashboard, without the CLI.
- `pnpm verify`: the whole product, including real-database integration tests and `db:check`. Database tests skip,
  and say so, without `TEST_DATABASE_URL`; they only run against an explicit `test_*` or `*_test` database, never the
  application's `DATABASE_URL`, and an advisory lock keeps parallel test processes from resetting each other's data.

The Docker image may bundle the CLI tarball: `/install/agentdrop.tgz` serves the version matching the server, while
`/install.sh` installs `agentdrop-cli@latest` from npm either way. `docker build --build-arg INCLUDE_CLI=false`
skips the CLI; the install endpoint then answers 404 with the npm instruction.

`pnpm release X.Y.Z --scope cli` versions the CLI (tag `vX.Y.Z`), `--scope server` the server (tag
`server-vX.Y.Z`), no scope both. The `/v1` protocol's compatibility is independent of either version
(docs/RELEASE.md).
