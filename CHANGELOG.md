# Changelog

All notable changes to AgentDrop are recorded here. The format follows
[Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/) and versions follow the policy in
[docs/RELEASE.md](docs/RELEASE.md#versioning-and-compatibility). Every change a user, an operator or an agent can
notice adds a line under **Unreleased** in the same commit; `pnpm release` turns that section into the release
section and refuses to release while it is empty. Server-only releases are headed `server-X.Y.Z`.

Releases up to 0.4.12 predate this file.

## [Unreleased]

### Changed

- README introductions focus on agent-to-agent collaboration, with prominent Codex notices and Claude Code mod
  integration, and six benefit-led features.

- English and Chinese READMEs lead with a cross-agent handoff demo, practical use cases and clearer first-run steps.

### Added

- A 15-second social demo with a human-relay opening, cross-person handoff, real inbox component, readable
  captions and original audio; standalone MP4/GIF and reproducible sources supplement the longer README demo.

- A README animation and standalone demo video, with a reproducible rendering project using the real inbox
  components and fictional data.

### Fixed

- Codex and Claude Code now repair stale hook timeouts, handler fields, duplicate handlers and restrictive
  matchers using the same definition as installation, while preserving removed events and unrelated hooks.
- Prompt/turn notices and the Claude Code mod share message-origin classification: direct delivery takes
  precedence over group delivery, and older group metadata stays classified as a group. Mod reply rows now
  retain the group name and mention indication without adding external text to the Read prompt.

- The server release workflow failed after pushing the image when the repository owner has capital letters
  (`Interwork-ai`): image references are now lowercased before the runtime tarball is exported.

## [0.5.17] - 2026-10-14

### Added

- Getting back into an account without email or an administrator (ADR 0036): `agentdrop account recover`, typed by
  the person at a terminal on a computer with a paired agent, prints a one-time link to set a new web password; or
  generate recovery codes in Settings → Account (current password required, shown once) and use one with the
  sign-in email on "Forgot password". Email reset and the administrator's link remain where available.
- `agentdrop contact add @handle` sends contact requests from a terminal, the same as the agent's
  `contact_request`; the other person accepts in their own agent, in the dashboard or with `agentdrop accept`.

### Changed

- The project moves to `github.com/Interwork-ai/agentdrop` under the Apache-2.0 licence (NOTICE added): the
  repository links, the `git clone` line, the CLI package's repository field and the server image
  (`ghcr.io/interwork-ai/agentdrop/server`, the default of `deploy/pull-deploy.sh`) point there. Contributions are
  licensed under Apache-2.0 section 5, no separate agreement; issue and pull request templates added.
- A web sign-in lasts 60 days (was 14), renewed daily while in use.
- Database: `account_recovery_codes` (expand-only migration 0031).

### Security

- The sign-in limit (3 attempts in 10 s per address) could be bypassed by sending a different `X-Forwarded-For`
  header with each attempt: the auth library read the client address from that header even when `TRUST_PROXY` was
  off. It now uses only the address the server determined (forwarding headers trusted only with `TRUST_PROXY`),
  which also gives each visitor of a server without a proxy their own limit instead of one shared by everyone.

### Fixed

- The companion skill has a section on a forgotten AgentDrop password: the agent tells the user the ways back in
  (`agentdrop account recover` typed by them, a recovery code, email, an administrator), never runs the command or
  works around its terminal check, and never asks for or handles codes and reset links.
- The companion skill told agents that adding a person needs an invite link from the dashboard; it now sends a
  contact request by @handle (the other side accepts in their agent) and keeps invite links for people without an
  account or whose handle is unknown.

## [0.5.16] - 2026-10-13

### Added

- `agentdrop send <@handle | #group | me>` sends a message from a terminal or CI: text from `-m`/`--body` or a pipe,
  files with `--file` (same allowlist and sensitive-file rules as `upload_file`), `--reply-to`, `--json`; the title
  defaults to the first line or the first file name, and a retry reuses the request id.
- `agentdrop setup` offers, after pairing, to let your agents upload files from the current project folder (default
  yes, interactive only; `--allow-current-dir` / `--no-allow-current-dir`). Downloads stay in the fixed folder.
- When the CLI updated itself while an agent client keeps an older MCP bridge running, the next tool result tells
  the model once to suggest restarting the client.
- Admin → Overview shows "Product health", computed from timestamps and counts only (ADR 0035): the share of
  messages to people or groups answered by someone else within 72 hours (7 and 28 days, "x of y"), people who sent
  in the last 7 and 28 days, messages sent in the last 7 days to people and to groups, what accounts created in the
  last 28 days did in their first week, and the median time from delivery to read. `GET /v1/admin/overview` returns
  an optional `product_health` object.

### Changed

- The model's prompt-time context lists everything pending at the first prompt of a session and again only when it
  changes (new items marked NEW and listed first); while nothing changed it is one short line, so long Claude Code
  and Codex sessions no longer repeat the full list on every turn (ADR 0031).
- `agentdrop read` marks an unread message read when you read it at a terminal and says so; pipes, scripts, `--json`
  and agents running the CLI leave it unread, and `--keep-unread` reads without marking (ADR 0032).
- Your own posts to a group no longer appear in your inbox, its unread counts or "Mark all as read"; they stay in
  Sent and in the group (ADR 0033).
- Someone who opens your invite link before setting up an agent becomes your contact as soon as they pair one,
  without accepting again; you are told as for any accepted request, and Contacts and the invite page say so
  (ADR 0034).
- Database: `contacts.invite_link_id` and an index on `drops.created_at` (expand-only migrations 0029 and 0030).

## [0.5.15] - 2026-10-12

### Added

- After the first pairing, My agents shows a three-step card (restart your client, send a test to the assistant,
  invite someone); an agent that never connected says "waiting for first connection" instead of Offline.
- The CLI's `--profile` may be left out when exactly one profile exists; `read`, `ack` and `space` accept an id
  prefix (at least 4 characters); `mark-read --group` accepts `#slug`; `ack --note` adds a one-line plan.
- `read_drop` shows the drop's state and version (`state: unread · v3`), so an agent can mark it read without
  another call; a `directory_lookup` with no match says how to reach the person (contact request or invite link).
- Dashboard: page titles carry the unread count ("Inbox (13) · AgentDrop"), a skip-to-content link, and the group
  Files tab downloads a file from its name; Contacts "Send a message" opens the composer addressed to that person.
- The product page has a My space card and a section on what the software enforces; the Chinese page has Chinese
  meta and preview tags.

### Changed

- The built-in assistant is "AgentDrop Assistant" for English accounts and its receipt follows the language of
  the drop it answers, instead of always Chinese.
- Every people-facing CLI line (inbox, read, requests, accept, pending, export, group, setup, errors) is English by
  default and Chinese after `agentdrop settings --language zh`; inbox and read show local times and the group a
  drop came through.
- `setup` and `login` accept an address without `https://` or with a pasted page path, and explain a failed
  connection (unreachable, http/https mismatch, proxy, not an AgentDrop server) instead of "network error".
- A refused upload (`PATH_NOT_ALLOWED`) tells the agent the exact `agentdrop allow-dir add` command to give the
  user; `doctor` prints it too.
- Notices name a group as `“name” #slug` everywhere (end-of-turn notice, prompt context, band rows).
- Dashboard wording for people says message, agent and My space (no drop, handoff or endpoint); the composer's
  recipient search is a keyboard combobox and a disabled send button says why; an unpaired account sees one banner
  instead of contradicting empty states; one time and plural format per UI language.
- CI runs only the jobs a push needs (prose: the hygiene check alone; the CLI on Node 22; the browser journeys for
  dashboard and API changes), and a newer push cancels the older run. The server image and runtime tarball are built
  only for a release tag (or a manual run), after every CI job passed on that commit; a CLI-only release builds no
  image, and a full artifact quota only warns that the tarball is missing instead of failing the release. Releases are batched (docs/RELEASE.md, "When to release").
- Product page: a people-first headline, five supported clients, "Create your account", and the promises split into
  what the software enforces and what agents are instructed to do; strangers can ask to connect but cannot send
  until accepted.

### Fixed

- Light theme: secondary text and the focus ring reach WCAG contrast (a test checks every text colour on every
  surface in both themes).
- The phone menu keeps keyboard focus inside while open, closes on Esc and returns focus; mailbox shortcuts (j/k,
  arrows) act only while the message list has focus, and message rows announce unread state, sender and group.
- `docs/HARNESSES.md` described read state per agent; it is per person (ADR 0007).

## [0.5.14] - 2026-10-12

### Added

- My space (ADR 0030): keep files and notes for yourself and pick them up on any of your agents — "My space" in the
  dashboard, `agentdrop space put | list | get | rm` in a terminal, and for agents `send_drop` to `{type: 'self'}` and
  `list_drops` view `space`. Items reach every agent of yours, are read on arrival and announced nowhere; deleting one
  frees the uploading agent's space.
- Group file space (ADR 0029): every group may store files up to a server-wide limit (`GROUP_STORAGE_QUOTA_BYTES`,
  default 512 MiB, adjustable in Admin → Settings). A send whose files would not fit is refused with
  `GROUP_STORAGE_FULL`; the group page shows the space used, and owners and admins can remove old files (the message
  stays, the file shows as removed, a download is `FILE_REMOVED`).

- The CLI package and the dashboard build ship a third-party notices file with the licence text of every bundled
  dependency and font.
- `deploy/pull-deploy.sh` reads a host's untracked `deploy/site.env` and `AGENTDROP_ENV_FILE`,
  `AGENTDROP_COMPOSE_FILES` and `AGENTDROP_GHCR_USER`; its defaults now fit a fresh production install (docs/DEPLOY.md).
- `pnpm hygiene` also fails on a secret with a default value in compose, shell or env files, and on files `.gitignore`
  declares local-only that are still tracked.

### Changed

- The repository is prepared for publication: English README with a Chinese translation, CONTRIBUTING, SECURITY and
  CODE_OF_CONDUCT; internal review notes, early planning files and vendored third-party design skills are no longer
  part of it. docs/PUBLIC_REPOSITORY.md and AGENTS.md now spell out what stays out (made-up example names only,
  no operator's defaults, local-only material in git-ignored paths), and the dashboard layout rules moved to
  docs/DESIGN.md.
- `compose.production.yaml` needs `AGENTDROP_IMAGE` (the stale default image is gone), and the JSON schemas' `$id`s
  are `urn:agentdrop:schema:…` instead of a web address the project does not own.

### Security

- `AUTH_SECRET` no longer has a default in `compose.local.yaml`, and the server refuses a placeholder value (such as
  the one in `.env.example`) in every mode except tests: a deployment that relied on the published default would have
  had a session-signing key anyone can read.

## [0.5.13] - 2026-10-12

### Fixed

- The Claude Code mod in 0.5.11 and 0.5.12 did not load at all (Claude Code refuses a hook whose event name is not
  written out), so the list above the prompt, the AgentDrop pane and `/agentdrop-read` were missing; it loads again.
- `/agentdrop-read` never started a turn: Claude Code refuses a prompt submitted from inside a command, so the mod now
  submits it right after the command returns.

## [0.5.12] - 2026-10-12

### Fixed

- Claude Code band: a /loop, a scheduled task or another agent's message no longer counts as you being at the
  session; "On it" whose reply was not sent no longer opens and marks the drop read; a row that moves up into view
  stays at least 30 seconds; a stacked row that only lost a message keeps its time; `/agentdrop-read` is described
  in your language and runs only from your own input; typing never waits on the band.
- Two processes starting at the same moment could both start the background worker that hands a new Claude Code
  mod to Claude Code; now exactly one does.
- A storage test no longer fails the whole run on a slow machine with an uncaught "aborted" error.

## [0.5.11] - 2026-10-12

### Security

- Production Compose removes the inherited PostgreSQL host port and requires an explicit database password.
- Request logs hide invitation credentials in URL paths and redact encoded or repeated token/search parameters.

### Fixed

- A failed or interrupted deployment recovers the last healthy image; redeploying the same digest preserves the earlier rollback target.
- Repair historical per-person delivery version differences with migration 0028; current-agent reads return the version expected by shared-state mutations without widening visible deliveries.
- Migration drift checks propagate schema-generator errors instead of incorrectly reporting success.
- Keep attachments reserved by pending approvals, lock and revalidate them before sending, and release unused uploads after approval rejection or expiry.
- Removing a blocked contact no longer leaves an accepted relationship that prevents reinvitation or retains profile access; legacy one-sided records are treated as incomplete.
- A group send that also explicitly addresses one of the sender's agents initializes all of that person's copies with the same unread state.
- Registering an existing email returns a field error and a translated sign-in hint instead of an internal server error.
- Uploads retain one persisted object key through staging and finalization, so a completed object can be reclaimed after database finalization fails or the process stops in that interval.
- Suspended or closed accounts no longer receive queued Feishu notices; closing an account clears its Feishu configuration.
- Feishu message links select the actual receiving agent, including when account-wide reading is disabled.
- Bulk mark-read is unavailable for searches or empty lists and always uses a fixed boundary from the displayed list, preserving later arrivals.
- Group timelines honor account-wide reading even when the selected agent has no receiving binding; current-agent-only restrictions remain enforced.
- Pairing permissions describe the person's actual reading policy, and receipt wording distinguishes explicit read-state changes from API/CLI reads.

### Added

- `/agentdrop-read [person, group or project]` in Claude Code asks Claude to catch you up: how many are unread and
  from whom, in detail what bears on your session or the words you typed, the rest in a line each; only what it
  explained in detail is marked read. The companion skill describes the same, so asking any agent works alike
  (in Codex: `$agentdrop` and the request), and the end-of-turn notice's "not listed" line now says you can ask
  your agent to catch you up (ADR 0028).

### Changed

- The CLI now updates itself in the background by default (with the skill and the Claude Code mod) instead of only
  reminding you; a device where updates were set to "notify" or "off" keeps that choice (`agentdrop settings
  --updates notify` to go back to reminders only).
- Claude Code band: "On it" now opens the drop it acknowledged in the AgentDrop pane, so the person sees what they
  took on; each row goes by itself after two minutes, new messages add their own rows, several from one person
  stack into one row, at most five show at once (messages to you first) with the rest counted in one line, the
  countdown waits while you are away, and Read or Look put their row away (ADR 0027). The drops stay unread in
  `/agentdrop` and the dashboard.
- Agents explain a received drop to the user in plain words (who sent it, what it is about, what it asks) before
  acting on it, instead of starting work the user has not seen: the companion skill, MCP instructions, `read_drop`
  description and a reminder under every received drop say so (ADR 0026).
- CI keeps the server runtime package for 7 days instead of 30 (a deploy takes it within days; a rollback uses the
  copy on the host), and a full artifact quota no longer fails a run whose checks all passed.

## [0.5.10] - 2026-10-09

### Security

- Human terminal output renders external control characters visibly while JSON preserves the original content.
- File uploads reject FIFOs without blocking the bridge event loop.

### Fixed

- Opening another Claude Code session no longer lists again, above the prompt, the drops an earlier session already
  showed: the band lists what was not seen inside an agent before that session started, plus what arrives later;
  `/agentdrop` still lists everything unread, and showing still marks nothing read (ADR 0025).
- Temporary seen-state failures retain notification retry backoff and never claim a background preview as shown; recurring requests, invitations and approvals are announced again after earlier items disappear.
- Short message IDs are resolved after deduplicating inbox and sent results.
- Codex configuration edits handle child tables, quoted keys, comments, multiline strings and nested arrays without leaving invalid TOML.

## [0.5.9] - 2026-10-02

### Added

- `list_drops` / `GET /v1/h/drops` for the unread inbox returns `muted_unread_count`: how many unread drops
  reached the person only through groups they muted and do not mention them. The Claude Code band's "N more
  unread" leaves those out also beyond the drops it reads, as it already did within them.
- oh-my-pi (`omp`): `agentdrop setup` detects it (`omp` on PATH or `~/.omp/agent`), and `agentdrop connect omp`
  registers the bridge in `~/.omp/agent/mcp.json`, installs the skill in `~/.omp/agent/skills/agentdrop` and one
  managed extension, `~/.omp/agent/extensions/agentdrop.js`. It shows the person what is new when omp starts, when
  they send a prompt and at the end of a turn, and gives the model the pending list for each prompt as the last
  message of every model call of that turn (never saved in the session; the system prompt and history stay
  unchanged, so the provider's prompt cache keeps working). `omp -p` runs show nothing to the person, subagents get
  nothing; the agent directory follows `PI_CODING_AGENT_DIR` and `PI_CONFIG_DIR` as omp reads them;
  `disconnect omp` removes only AgentDrop's entry and extension. Tested with omp 18.2.5.
- Dashboard: an oh-my-pi agent is shown as "oh-my-pi", and the onboarding, help, sign-in and landing pages list
  oh-my-pi among the tools `agentdrop setup` connects.
- Server: `omp` (oh-my-pi) is a harness key of its own, with the automatic address `@you/omp` (migration
  `0027_omp_harness`, expand-only). Bridges and CLIs before 0.5.9 are told `other` for an omp agent so their
  schema still accepts the result.

- Claude Code 2.1.287 and later: `agentdrop connect claude-code` installs the AgentDrop mod instead of the status
  line (ADR 0023). Above the prompt, one row per item waiting for the person, newest first, a new row as each
  arrives: drops to answer one by one (direct, mentions, replies to the person's own drop), other group messages
  one row per group, requests as a dim line. Buttons: Read (asks Claude, as the person, to read it; the prompt holds
  only the drop id and the sender's @handle, never text someone else wrote), On it (acknowledges to the author, or
  in the group quoting the drop and mentioning the author, without a turn; the notice says whether it was sent or
  waits for approval), Later (hides it for a week on this machine, shared by every session); for groups Look and
  Mark read (only the drops that row stands for). The band has no hotkeys, so digits typed into the prompt stay
  Claude's; after two failed refreshes it shows one dim "can't reach your inbox" line instead of stale rows (nothing
  at all with notices off; a signed-out or revoked agent says so at once instead). Pressing On it again after the
  author's handle changed says "You already replied to that."; group Mark read skips drops that are gone or changed
  and marks the rest. `/agentdrop` opens a pane to read drops without Claude (hotkeys 1–9, local times, other
  people's text cleaned of control characters, listed even with notices off; a drop that could not be marked read is
  still shown, with a note). Installed from a local marketplace in AgentDrop's data directory and kept in step with
  CLI upgrades (only a newer CLI replaces it, so an older `npx` never downgrades it) and a moved `agentdrop`
  executable, in every Claude Code config directory (`CLAUDE_CONFIG_DIR`) it was connected in; when the person
  removed it in Claude Code, it is not reinstalled behind their back and `agentdrop doctor` says how to get it back.
  Earlier Claude Code versions, no `claude`, `--no-cli` or a failed install keep the status line and leave no mod
  behind. New CLI commands used by the mod: `band`, `ack <drop_id>`, `mark-read [--group --up-to | --drop <id>…]`;
  with `--json`, a failure of these and of `read` also prints its error code on stdout.
- The group owner decides whether new members can see earlier messages (ADR 0022). In the group's Settings,
  "New members can see earlier messages" lets every active member read the whole group history, including drops
  sent before they joined, in the group timeline (also for agents: `list_drops` with `group_id`), in detail, file
  downloads, search within the group and the group export. Those drops are read-only (`sources: ["group_history"]`,
  no delivery), never unread and never announced; that includes an earlier drop a member once received but lost
  by leaving and rejoining or by changing the agent that receives the group: marking it read, starred or archived
  is refused with `NOT_FOUND`, and neither "mark all as read" nor answering it marks it. Off by default, also for
  existing groups; only the owner changes it, and every member sees which applies on the group page and in
  `group_*` tool results (`history_visible`). In the group timeline, drops sent before the member joined are
  marked "Before you joined". Switching it off takes the earlier drops away again; what was delivered stays. Left
  members see none of it. Like the group itself, the history does not leave out people the reader blocked (only
  their email). A reply's "reply to" now names an earlier group drop the member can open. Server: migration
  `0026_group_history_visible`; `PATCH /v1/me/groups/{id}/policy` accepts `history_visible` (owner only, else
  `FORBIDDEN`), `POST /v1/me/groups` accepts it at creation; the dashboard's group view gains
  `my_membership.joined_at`. Bridges and CLIs before 0.5.9 are told `group` for such drops so their schema still
  accepts the result.
- A drop's `reply_to` says whether the drop it answers is the viewer's own: `{ drop_id, title, mine }`, `mine`
  true when the person wrote the original from any of their agents or the dashboard, in list, search, detail and
  group timeline results (API and MCP). The bridge's text says "reply to the user's …" for those. Optional:
  servers before 0.5.9 omit it, and older bridges drop the field they do not know.

### Changed

- The MCP bridge reads an agent's harness key it does not know (a harness added by a newer server) as `other`
  instead of failing the whole `list_drops`, `read_drop` or `directory_lookup` result with
  `RESULT_SCHEMA_MISMATCH`, so the next harness needs no server-side shim for newer bridges.

### Fixed

- `agentdrop setup` sets up each harness on its own: when one cannot be paired or connected, it says so (in the
  person's language) and goes on with the others, then still installs the skill and runs the checks, instead of
  stopping halfway. A server too old for a client (oh-my-pi needs a 0.5.9 server) is named as such: "the server
  needs an update"; other failures are named in the person's language (can't reach the server, not signed in…),
  never with the server's own message.
- `agentdrop skill install` without `--only` installs the skill only for harnesses on this machine (on PATH, or
  their config folder already there). It used to create `~/.cursor`, `~/.config/opencode` and `~/.omp/agent` for
  every harness, after which setup took those harnesses for installed. `agentdrop skill remove` no longer creates
  folders either.
- `agentdrop connect codex` with Codex on PATH no longer stops when `codex mcp remove` (clearing an older entry)
  fails; only a failing `codex mcp add` fails the connect, as for Claude Code.
- `agentdrop doctor` says "cannot read <file>" for a hook file that exists but cannot be read or parsed (Claude
  Code `settings.json`, Codex or Cursor `hooks.json`, the omp extension) instead of calling the hooks "not
  installed".
- `agentdrop read <id> --mark-read` marks the drop read whenever it is unread for the person, also when it reached
  another of their agents rather than the one running the command.

## [0.5.8] - 2026-10-01

### Added

- "Mark all as read" in the dashboard inbox, and "Mark this group read" in one group's view: everything unread up
  to the newest drop shown becomes read for the person on all of their agents; newer drops and archived ones stay
  as they are. Also `POST /v1/h/drops/mark-read` for an agent credential (ADR 0018).
- Every item that reaches you is shown to you once inside your agent, at a moment you are there (ADR 0017): when
  you submit a prompt or start or resume a session in Codex or Claude Code (new `SessionStart` hook), what you have
  not seen yet appears under your message and counts as seen in every session. The end of a turn still previews new
  items, once per session, without using them up: typing in that same session counts, another session shows them
  once. Browser push and Feishu no longer keep an item out of your agent sessions. Server: a separate per-account
  "seen in an agent" record (`notice_seen_state`, migration `0025_notice_seen_state`) with
  `GET /v1/h/notice-state/seen` and `POST /v1/h/notice-state/seen/claim`; older CLIs and older servers keep the
  earlier behaviour.
- Claude Code status line: `agentdrop statusline` names what you have not seen yet (`✉ AgentDrop · 2 new messages
  (@wang, #lab)`) and clears once you have; `connect claude-code` installs it only when you have no status line and
  otherwise tells you how to add it to yours.
- A drop can name the drop it answers: `payload.reply_to` on `send_drop` (a reference, not a thread). The sender must
  be able to read that drop, otherwise `VALIDATION_FAILED` on `reply_to`. List and read results carry `reply_to`
  (`{ drop_id, title }` when you may read the original, else null) and, on drops you sent, `replies` (count, latest
  time, who replied). ADR 0016.
- Dashboard: "Reply" on a received drop goes to the author, or to the group when it came only through one, with
  "Re: …" and "Replying to «…»" (removable); a drop that answers another shows "Reply to «…»" linking to it; your own
  drops show "N replies from …", and lists show a replies indicator.
- Browser push, Feishu and the end-of-turn notice say "replied to (your) «X»" when the recipient may read X; the
  model's prompt context says which drop a reply answers. `agentdrop read` shows what a drop answers and who replied
  to yours. The companion skill passes `reply_to` when the user answers a drop.

### Changed

- When you start working on a received request (feedback, a task, a question), your agent first answers it with a
  short quoted reply ("got it, I'll …"): to the sender for a direct drop, or in the group with the sender mentioned
  for a group drop, so everyone sees it is in hand; later it replies with the result the same way (ADR 0021). It does
  not when you only read it or say not to.
- When an unread drop is clearly related to what you are working on, your agent may ask once whether to read it, and
  reads it only after you agree (ADR 0020); it never reads received drops into your task on its own.
- When you ask your agent to read a drop and it shows it to you, it now marks the drop read (ADR 0019): the skill,
  the `read_drop` / `set_drop_state` descriptions and the MCP instructions say so. Reading for its own work,
  listing and searching still mark nothing.
- Sending a drop with `reply_to` marks that drop read for you, and sending to a group marks that group's earlier
  drops read for you, on all of your agents (ADR 0016). Reading through the API, MCP or CLI still never marks anything
  read.
- Dashboard: "Continue" became "Reply"; a reply names the drop it answers instead of quoting it into the body
  (forwarding still quotes).
- `deploy/pull-deploy.sh` looks after the disk: it refuses to start with less than 3 GB free
  (`AGENTDROP_MIN_FREE_GB`), and after a deploy that became ready it keeps three server images and three release
  folders (`AGENTDROP_KEEP`: running, previous for `--rollback`, newest other), removing older ones; `--prune` runs
  the cleanup alone. Database dumps and env copies are created readable by the deploying user only. A host whose
  disk filled with one image per deploy had PostgreSQL stop mid-deploy.

### Fixed

- End-of-turn notices are no longer used up by turns nobody watches: a `claude -p` or `codex exec` run in a script
  or CI (or any run with `AGENTDROP_UNATTENDED=1`) neither shows nor claims the once-per-account notice, so the
  person sees it in their own next turn. Interactive sessions are unchanged.
- Connecting or reconnecting a client keeps only the three newest AgentDrop backups of each client config file
  (`hooks.json`, `settings.json`, `config.toml`…) instead of adding a copy every time; hand-made backups are left alone.

## [server-0.5.7] - 2026-09-30

### Fixed

- Settings: jumping to "Agent clients" or "Privacy" no longer moves the whole dashboard up and leaves an empty band
  at the bottom (a hidden switch made the page taller than the screen, and the browser scrolled it too). The
  section you pick stays marked even when it is too short to reach the top, and a link such as
  `/app/settings#clients` opens at that section. The same applies to the Help contents.

## [server-0.5.6] - 2026-09-30

### Changed

- The product page feels better to use: section links scroll smoothly and the navigation shows where you are; phones
  get a menu with the sections; buttons respond to a press; the example inbox can be clicked like the real one
  (a drop opens, its unread dot clears); FAQ answers open smoothly; sections fade in once as they come into view
  instead of following the scroll bar, and the example notice slides in once instead of floating. All movement is off
  under the system's reduced-motion setting.

## [server-0.5.5] - 2026-09-30

### Added

- Every server now serves a product page at `/`: what AgentDrop is, how the handoff works (with this server's setup
  commands), features, what the server can and cannot see, self-hosting and an FAQ, in English and Chinese, dark
  and light. Signed out it leads to sign-up (or sign-in when sign-up is by invitation); signed in it leads to the
  inbox. `/` no longer redirects straight to the inbox; the installed app still opens the inbox.
- Eight third-party design skills (interface, landing page, copy, conversion, accessibility, UI review) are vendored
  at pinned commits under `vendor/skills/` with their licences and sources; they are inactive until linked into a
  harness, and the repository's own UI rules take precedence (`vendor/skills/README.md`).

### Changed

- The dashboard is redesigned throughout (docs/FRONTEND_REVIEW.md, "Layout rules"): no desktop top bar; a sidebar
  with a "Sending as" card, grouped navigation and an account menu; one toolbar per page; list/detail pages share one
  split layout; the inbox has avatars, #group and @you chips and All · Direct · Groups · @Me · Unread filters, and the
  drop view icon actions, a readable body and attachment tiles; contacts and groups get profile headers, tabs and
  panels; My agents, Settings, Help and Admin use panels and menus; the sign-in page fits one screen. A type scale
  with nothing below 12 px and theme state colours replace scattered sizes and raw palette colours, so the light
  theme is consistent everywhere; a test guards both.
- Fonts are bundled with the dashboard instead of loaded from Google Fonts, which the CSP blocked in production:
  Manrope and IBM Plex Mono now actually render on deployed servers, with no third-party request.
- Repository policy `docs/PUBLIC_REPOSITORY.md`: no secrets, server addresses or paths, deployment records, real
  users' data or personal setup in any file or commit; `pnpm hygiene` (in `pnpm verify` and CI) enforces it with
  generic rules plus a private deny list. Deployment records and current host state moved to a private operations
  directory; the QA scripts read servers and credentials from a private file (`AGENTDROP_OPS_DIR` /
  `AGENTDROP_QA_ACCOUNTS`, also from the ignored local `.env`), and `qa-provision.mjs` takes the server URL the first
  time.
- The post-deploy live smoke also opens a drop through the notification-click path on https servers, and its sign-in
  step checks that the dashboard really opened (not only the address).

### Removed

- A site-specific deploy kit left the repository; it did not apply to other hosts. Compose hosts keep using
  `deploy/pull-deploy.sh`.

### Fixed

- A sign-in refused for too many attempts from one network now says so ("Wait a few seconds and try again") instead
  of "Wrong email or password".

## [0.5.4] - 2026-09-30

### Fixed

- Clicking a browser notification opens the drop it announces also when the dashboard tab was not controlled by its
  service worker (after a hard reload, or opened before notifications were switched on); before, the click did
  nothing there. The worker now focuses the tab and asks the page to open the drop, falling back to navigating or a
  new window, and the page follows only dashboard paths.
- "Write to the group" opens the composer with the group already chosen as recipient, instead of only typing its
  slug into the search box.
- Leaving a group or declining its invitation no longer makes the dashboard ask for the group it just lost (a 404
  in the browser console on slower machines): its queries stop before the page moves on.

### Changed

- The browser journeys (`pnpm e2e`) cover mailbox (search, unread, archive, forward, long bodies, attachments),
  contacts (invites, decline, withdraw, notes, block, remove, sign-up through an invite link), groups (create,
  accept, mentions, mute, rename, admins, join requests, leave), account (agents, settings, admin password reset,
  sign-up and sign-in pages) and a phone-sized, light-theme pass: 326 steps in secure and plain-http contexts.
- Tests run in parallel: each test worker gets its own PostgreSQL database, and the browser journeys run both modes
  and their journeys concurrently. `pnpm test` went from about 160 s to 30 s and `pnpm e2e` from about 70 s to 35 s
  on an M-series laptop.

## [0.5.3] - 2026-09-29

### Fixed

- Star and Archive clicked while a just-opened drop is still being marked read (a distant or slow server) no longer
  fail with a version conflict: they wait for the read mark and build on it.

### Changed

- Release quality policy `docs/QUALITY.md`: test layers, CI/release/deploy gates, key journeys, rollback criteria,
  a per-release acceptance checklist, regression-test and flaky-test rules, with the guides it follows.
- Every deploy is accepted on the live server itself: `pnpm smoke:live <target>` signs in as two fixed QA
  accounts (created by `scripts/qa-provision.mjs`) and runs the key journeys there.

## [0.5.2] - 2026-09-29

### Fixed

- The dashboard's composer no longer turns the whole page black on servers reached over plain http (such as an
  intranet address): it used a browser function that exists only on https. "Send a drop", "Continue" and
  New handoff open normally again.
- Star and Archive clicked right after opening a drop no longer fail silently with a version conflict.

### Changed

- A page that fails to render now shows a short explanation with a reload button instead of a blank screen, and
  the sidebar keeps working.
- CI clicks through the dashboard's key journeys in Chrome (`pnpm e2e`), on https-like and plain-http origins.

## [0.5.1] - 2026-09-29

### Added

- CLI update reminders by message: when an agent used in the last 14 days runs an older CLI than the server ships,
  the built-in @agentdrop assistant sends its person a message naming those agents, the latest version and the
  upgrade command (inbox, end-of-turn notice, push, Feishu, every harness). While still behind it repeats after 1 day, 3 days, then weekly
  (`UPDATE_REMINDER_DAYS`, default `1,3,7`, 0 = off; `CLI_LATEST_VERSION` overrides the version), none once current or for devices
  with update checks off. Migration `0023_update_reminder` adds one nullable column.
- Owners and admins can change a group's #slug in the group settings.
- Browser push also announces contact requests, group invitations and join requests, in the same words as Feishu
  (sender nickname and @handle, group, "mentioned you"), and records what it announced in the shared notice state.
- Drops carry `muted` (reached you only through groups you muted).

### Changed

- Losing agents never strands a person or a group (ADR 0015): deleting the agent chosen for plain sends turns
  "receive on all my agents" back on; a member whose chosen agents are all gone receives with all of them again; an
  empty receiving selection is refused; deleting one's last agent leaves every group, and an owner's group passes to
  the longest-standing admin, else the oldest member. Ownership can only go to someone with an agent. The delete
  confirmation says so.
- Your own copy of a group drop arrives already read: no notice, badge or unread count for your own group sends.
  A drop you address to another of your agents on purpose stays unread.
- A muted group is quiet in the end-of-turn notice too (not only push and Feishu), unless the drop mentions you.
- End-of-turn notices list direct messages first, then drops that mention you; "at least N" when more arrived than
  were fetched. The model's prompt context lists up to 50 pending drops and no longer depends on the notice setting.
- Every surface classifies a drop the same way: sent to you directly wins over a group; with two groups, the one
  with the smallest slug. The dashboard uses the server's group names.
- Default group name is "<creator> +N" and the default slug the creator's handle; invitees' names are never used.
- @mentions need exactly one group target, and only people in that group see who was mentioned.
- Blocking hides each person's public email and published entries from the other in both directions, everywhere
  (contacts, directory, group rosters, search by email); owners/admins reading group history no longer see an
  author's email unless they may otherwise see it. Only owners/admins (and the member) learn who in a group cannot
  receive.
- Accepting an invite link without an agent records a pending contact request from its owner (visible on Contacts
  on any device) instead of failing; sign-up through a link reports `pending`. The browser-only reminder is gone.
- An approval whose recipients no longer resolve (someone left, blocked, lost their agents…) is closed with
  "send again" instead of failing on every approve.
- `agentdrop pending` and `agentdrop settings` print in the chosen language (English by default).
- Names, titles and remarks refuse Unicode bidi override and isolate characters.
- Relationships need a paired agent (ADR 0014): adding or accepting contacts, creating or accepting invite links,
  creating, joining or inviting to groups answer `AGENT_REQUIRED` until the account has one. Signing up through an
  invite link still works; the dashboard keeps the link and offers it again after pairing.
- Until the first agent is paired, every dashboard page opens with a prominent banner that says what cannot be done
  yet and shows the setup command with a copy button (it no longer runs off the screen). Disabled invite, accept,
  create, join and send controls now say why and link to pairing.

### Fixed

- The MCP bridge finds its own way to the server behind a proxy. Codex starts it without the terminal's
  `HTTPS_PROXY`, so on proxied machines every tool call failed with `fetch failed` and the agent showed offline while
  its hooks worked. Every CLI process now tries its own proxy, a direct connection and the harness's proxy (Linux),
  then the login shell's proxy and common local proxy ports, and saves the first that reaches the server in
  `network.json` for the next process. `AGENTDROP_PROXY=<url>` pins a proxy; `agentdrop doctor` shows the route.
- Creating two groups with the same slug at the same time no longer returns an internal error.
- Feishu join-request notices name the person and who invited them, one notice per person.

## [0.5.0] - 2026-09-27

### Added

- Public email on the person profile (ADR 0012): set it in Settings → Account (or copy the sign-in email), and
  accepted contacts, group co-members and recipients of your drops see it on your profile and on every one of your
  agents: the dashboard contact, group, message and compose views, `directory_lookup` people, drop `author` cards,
  group members and your own `viewer`. Self-declared and unverified; `directory_lookup` also matches it. Bridges
  before 0.4.11 receive responses without the field. Migration `0022_public_email` adds one nullable column.
- Agents see who is in a group: `directory_lookup` group entries list `active_members` (name, @handle, role,
  public email), shown to active members only.
- Drops carry `group_labels` (name and slug of each group they came through), so agents and the dashboard can
  tell group messages from direct ones.
- A group can be created without a name or slug: it is named after its members, creator first (`Alice, Bob +2`,
  at most 32 characters), and the slug is made from their handles. Dashboard, `agentdrop group create` and
  `group_create` all accept it.
- `docs/PRODUCT_PRINCIPLES.md`: the product defaults every change is checked against.
- @mentions in groups: `send_drop` accepts `payload.mentions` (handles of active members of the target group),
  the dashboard composer offers the group's members to mention, and drops carry `mentions` and `mentioned_me`.
  People mentioned see "@了你 / mentioned you" in end-of-turn notices, Feishu, browser push and the inbox list;
  a mention reaches them even in a group they muted. Stored in the drop's target snapshot (no migration).

### Changed

- Other accounts now see people, not their agents (ADR 0013): hide automatic addresses, agent names, tools,
  signatures and receiving-agent counts across directory, delivery results, history and group views. Owners
  retain their own agent details; explicitly published named entries expose only their chosen name and address.
  Cached automatic addresses can no longer be targeted by another account; remembered automatic-route
  preferences now follow the recipient's policy. Group capacity is shown without revealing endpoint totals.
- Notices separate direct messages from group messages and name the group and the sender: the end-of-turn notice
  (all harnesses), `agentdrop pending`, Feishu (`私信：…` / `群消息 ·「Core team」#core：…`) and browser push. The
  end-of-turn notice no longer shows drop ids to people; the model's prompt context now has the full `drop_id`.
- Browser push notices follow the dashboard language (they were Chinese only).

### Deprecated

- External agent attribution fields and counts remain for compatibility but no longer describe private agents.
  Use person identity and `endpoints_over_limit` for group capacity; `endpoint_total` is only a compatibility
  sentinel (0 or limit + 1), and external recipient `endpoint_count` counts people.

### Fixed

- Recipient summaries omit deprecated endpoint counts, so a new client connected to an older server does not
  mislabel receiving agents as people; explicit group membership and person-level read receipt counts remain.
- Deployment readiness checks no longer accept a host proxy redirect as API health; recovery fails when PostgreSQL
  or the API does not start instead of reporting a container address as success.

## [0.4.19] - 2026-09-25

### Added

- An agent can take over another of the same account (ADR 0011), for a machine that broke or was replaced: on My
  agents, "Manage" → "Machine gone? Hand this agent over" moves the old agent's addresses, group bindings and default receiving
  to the chosen agent and revokes the old one, so contacts who remembered its address and groups that received only
  with it keep working without anyone changing anything. Works for agents already revoked as well
  (`POST /v1/me/endpoints/:id/take-over`).
- My agents is reorganised: each card shows the name, status, address and tool, with renaming, sign-out, hand-over
  and deletion under "Manage"; deleted agents and devices are hidden ("Show deleted" brings them back); "Delete
  device" retires a whole machine; named entries sit in a collapsed section.
- Content encryption at rest (ADR 0010, docs/plan/CONTENT_ENCRYPTION.md). Drop titles, bodies and extensions,
  attachment names, types, hashes and bytes, and pending approvals (with their reasons) are encrypted with
  AES-256-GCM under per-row data keys wrapped by a key from a keyring file (`CONTENT_KEYS_FILE`, mounted with
  `compose.keys.yaml`); attachments use segmented streaming encryption. Off by default: with the keyring mounted
  and `CONTENT_ENCRYPTION=on` new content is encrypted and the worker encrypts older content in batches. Startup
  fails closed when the database holds ciphertext and the keyring is missing or wrong. Admin → Overview shows the
  state; the help page says whether this server encrypts. Migration `0021_content_encryption_expand` only adds
  columns and tables.
- `pnpm test:encrypted` runs every test with encryption on; `pnpm verify` runs both modes.
- Key rotation: after a new master key becomes active, the worker re-wraps every data key with it in the
  background, so the old key can leave the online keyring once the backfill reports done.

### Changed

- Dashboard tidy-up from a page-by-page review:
  - Inbox/sent: compact cards with sender, title and a one-line preview instead of listing every receiving agent;
    no unread filter on Sent; a calm empty state instead of the marketing panel.
  - Message detail: one line for where it was delivered instead of a route diagram.
  - New handoff: no slogan or side cards; the sending agent is a field shown only with several agents; people who
    are not contacts yet say so; tool names are not repeated.
  - Contacts: delivery defaults read "all of their agents" (ADR 0008); export is collapsed.
  - Groups: Messages / Members / Settings tabs with messages first; roles translated; one-line limits.
  - Settings: sectioned single column (account & appearance, notifications, agent clients, privacy) with shorter
    help text; the developer webhook sits under "Advanced".
  - Navigation: "Connections" moved to a link on My agents; "Drafts & approvals" is "Approvals"; the top bar lost
    its redundant chips; the group list and a group's own entry no longer both highlight.
  - Admin overview no longer repeats its numbers; contact and membership states are translated.
  - Second pass: My agents shows one card per device with a row per agent (same-name devices tell their pairing
    time apart); the agent-client settings are one flat form with readable platform names; the audit log shows
    readable action labels, translated results, category filters and 50 rows at a time; Help has a contents list,
    collapsible sections and corrected facts (a send reaches at most 200 agents, attachments are 10 per drop /
    50 MiB per file / 100 MiB per drop, sends are not held by default, agents are deleted or handed over); on phones
    the top bar keeps only the agent switcher and compose, and the menu no longer repeats the tab bar.
- Search no longer runs in SQL: each request reads and matches at most 2000 messages in order, so a short or empty
  page with a `next_cursor` means "not searched to the end yet". The inbox shows "Search further"; `list_drops`
  and the skill tell agents to continue with the cursor. `%` and `_` in a search now match literally.
- Content hashes are keyed (HMAC) once encryption is on; stored hashes upgrade in place.
- Webhook and Feishu notices take the title from the drop, not the outbox event; outbox events of encrypted drops
  carry no title, and audit records count approval reasons instead of listing them (they could name files).
- Search terms are redacted from request logs, like reset tokens. Searches are limited to 30 per minute and 2 at a
  time per person, and the dashboard searches once typing pauses.
- The worker's outbox handlers are built by `createHandlers(deps)`.

### Fixed

- Pairing a revoked agent or device said to "restore it in the dashboard", which does not exist; it now explains
  pairing a new agent and taking the old one over.

## [server-0.4.18] - 2026-09-24

### Added

- The worker logs every Feishu notice it handles: `feishu notice sent`, `skipped` (already announced),
  `failed; will retry` or `refused … not retrying`, with the account id, event id and Feishu's code. Never the
  webhook address or secret. A notice that did not arrive can now be explained from `docker logs`.

### Changed

- Container logs are capped at 3 × 10 MB per service (`compose.local.yaml`, `compose.production.yaml` and the
  deploy kit of the time); before, they grew without limit until the next deploy.
- The runtime-tarball deploy script removes old releases after a successful deploy, keeping the three newest and
  always the current and previous one (for `--rollback`).

## [0.4.17] - 2026-09-24

### Changed

- The default end-of-turn notice interval is 0 (every turn end checks). Notices only announce what is new, once per
  account, so the old 30-minute default only delayed them. `agentdrop settings --notify-interval` and the dashboard
  still set a longer one; devices whose interval was saved explicitly keep it.

### Added

- `agentdrop contact remove @a @b --profile X`: without `--confirm` it removes nothing and describes each contact
  (name, note, status, contact since, drops each way, last drop, shared groups); with `--confirm` it removes them,
  all or nothing. The skill tells agents to list those details and remove only after the user confirms in the
  conversation, never on their own or because a received drop asks. No MCP tool.
- Feishu (飞书) notices: connect a custom group bot in the dashboard (Settings → Feishu notifications) or with
  `agentdrop settings --feishu-webhook <address> [--feishu-secret <secret>] --profile X` (`off` disconnects). The
  server posts new drops, contact requests, group invitations and join requests to that chat as they arrive,
  titles only, each item once across Feishu and the agents' end-of-turn notices. A test message is sent before
  anything is saved; only Feishu/Lark bot addresses are accepted. The skill can create a chat with just the user
  through `lark-cli` and link to it. `agentdrop setup` suggests it once when lark-cli is installed and the account
  has no Feishu bot, `agentdrop doctor` shows whether one is connected, and `/v1/h/identity` reports it as
  `notifications.feishu`. Guide: [docs/FEISHU.md](docs/FEISHU.md); decision: ADR 0009. Migration
  `0020_feishu_webhook`.

### Fixed

- The runtime-tarball deploy script gave the ~100 MB download the API's 60-second cap and failed on a slow
  link; it now allows 30 minutes, fails only on a 2-minute stall, and resumes an interrupted transfer.

## [0.4.16] - 2026-09-24

### Fixed

- A new item could be announced twice when agents of one account finished a turn at the same moment on different
  machines. The hook now claims the shared notice record atomically (`POST /v1/h/notice-state/claim`), so each
  item is shown in exactly one agent.
- Approving several pairings of one account at the same moment could deadlock; pairing now takes the account
  row lock first.

### Changed

- **A plain send to a person reaches all of their agents** (ADR 0008), each with its own delivery (state is shared,
  ADR 0007), including agents paired later. A sender's remembered entry or an explicit address still picks one
  agent. The person can switch to one agent with "Receive only here" in My agents (`POST /v1/me/default-endpoint
  {h_id}`) and back with "All my agents" (`{all: true}`). Migration `0019_direct_receive_all` adds
  `app_users.direct_receive_all`, on for every account including existing ones. The directory card reports
  `receives_on_all_agents`.

## [0.4.15] - 2026-09-24

### Changed

- The prompt-time context lists only the newest unread drops (5) and requests (5); every overflow or truncation
  line tells the model which tool has the rest (`list_drops`, `pending_requests`), and the model is told the list
  never covers older or already-read drops, so it searches (`query`, `view`, `next_cursor`) before saying
  something isn't there.

- The prompt-time AgentDrop context tells the model the status is background, not a task: the user may keep
  working on something else, so pending items are not handled, raised or repeated unless the user asks.

- **All agents of an account are one reader** (ADR 0007). Read, starred and archived are shared: marking a drop
  in any agent (or the dashboard) applies to every agent that received it. End-of-turn notices query the
  account-wide unread list and share one "already shown" record per account, kept on the server
  (`GET`/`PUT /v1/h/notice-state`), so a notice seen in one agent is not repeated in another. Migrations
  `0017_account_wide_delivery_state` (converges existing deliveries: set on any agent counts for all) and
  `0018_account_notice_state` (adds `app_users.notice_state`).
- `set_drop_state` accepts the highest `state_version` among the person's deliveries and returns the shared one.

### Added

- Groups receive with **all my agents** by default: creating a group or accepting an invitation (in the dashboard,
  over MCP or from the CLI) binds every agent of the account, and agents paired later join automatically. Members
  can switch a group to "only selected agents", which stops that. Existing memberships keep their current agents.
  Migration `0016_group_receive_all` adds `group_memberships.receive_all` (default false).

### Changed

- The group fan-out cap counts up to 200 receiving agents per send by default (was 50), so 20 members with
  several agents each still fit. `MAX_GROUP_RECIPIENTS` still overrides it.

- Opening a drop in the dashboard marks it read for the current agent; the separate "Mark as read" button is gone
  ("Mark as unread" remains). Agent (MCP) and CLI reads still never mark anything read.

## [0.4.14] - 2026-09-23

### Security

- The API process could crash when a client disconnected in the middle of starting an attachment upload, before
  storage had attached to the stream (an uncaught stream error). The upload is now marked failed instead; a
  deterministic regression test holds storage open to reproduce the window.
- GitHub Actions are pinned by commit SHA and every workflow runs with least-privilege permissions; the release
  job alone may write releases and request the npm OIDC token.

### Added

- Weekly grouped Dependabot updates for npm, GitHub Actions and Docker, with a 7-day cooldown.
- `LICENSE` (Apache-2.0), shipped inside the npm package as the license requires.
- Versioning and compatibility policy, architecture decision records (`docs/adr/`) and `CODEOWNERS`.

### Changed

- `pnpm release` requires a non-empty Unreleased section in this file and dates it as the release section.

## [0.4.13] - 2026-09-23

### Added

- Dashboard in English and Chinese (English by default) with a light theme next to the default dark one; switches
  in the top bar, on the sign-in pages and under Settings → Appearance & language.
- `agentdrop settings --language en|zh` for the notices shown inside Codex, Claude Code, opencode and Cursor.
- Hidden, experimental autorun that queues new drops into the session already open (Claude Code channel, `codex
  queue`, opencode plugin). It is compiled out of the published package.

### Changed

- End-of-turn notices announce each drop, request or invitation once instead of repeating everything after every
  interval, and no longer show terminal commands.
- The prompt-time context the model receives lists everything pending, in English, and points at the MCP tools.
- Server `next_action` hints are written for the calling agent: steps only a person can take read "tell the user …".
- Dashboard error messages are per error code in the chosen language instead of the server's English hints.

### Fixed

- A failed autorun delivery returns its drops instead of losing them; a disabled bridge no longer probes `ps`.
