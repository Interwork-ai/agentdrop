# 0023. In Claude Code with mods, what is waiting is a live list above the prompt

- Status: Accepted
- Date: 2026-10-02
- Refines: ADR 0017 (seen in an agent: the status line), ADR 0019 (the agent marks read after showing), ADR 0020
  (ask before reading), ADR 0021 (acknowledge what you start)
- Refined by: ADR 0025 (the band lists what is new to the session, not everything unread), ADR 0027 (rows stay two
  minutes, five at most; On it shows the drop), ADR 0028 (`/agentdrop-read`)

## Context

The Claude Code status line (ADR 0017) is one line of text: it can say *that* something is waiting, not let the
person act on it. Acting meant typing a sentence to Claude ("read what Wang sent", "tell Wang I'm on it") or
leaving for the dashboard. Claude Code 2.1.287 added mods: a plugin module that registers handlers for
`session.start`, `command.run` and `ui.render`, and can draw interactive elements (text, buttons with hotkeys) in
the band above the prompt and in a pane, run local programs, submit a prompt as the user, keep a small store and
show toasts. Older Claude Code versions have none of this.

## Decision

On Claude Code 2.1.287 or later, `agentdrop connect claude-code` installs the AgentDrop mod instead of the status
line. Earlier versions keep the status line, unchanged.

**The band.** Above the prompt, `✉ AgentDrop` and one row per item, newest first by when it reached the person; a
new item adds a row (the mod polls every 20 s; every session on the machine shares one 15 s cache per profile, so
many sessions cost one query). Each refresh reads up to 200 unread drops, so a direct drop or a mention is not
hidden behind a busy group. A drop that is the person's to answer — direct, mentioning them, or a reply to their own
drop — gets its own row, naming the person as the viewer knows them, the group, and what it answers. Whether a reply
answers the person's own drop comes from the server (`reply_to.mine`, 0.5.9+): "replied to your «X»" only then; a
reply to someone else's drop is like any other drop (a direct one keeps its row, a group one counts in its group's
row); an older server cannot say, so the reply keeps its row with neutral wording ("replied to «X»"). The rest of a
group is one row per group, with the count and up to three people. Muted groups appear only when they mention the
person. Contact requests, invitations, join requests and approvals are a dim line pointing to the dashboard;
anything beyond the 200 drops read is "N more unread" (when every unread drop was read, the muted ones it skipped
are not "more"; beyond the window the server's count cannot tell them apart). The band disappears when nothing is
waiting, when notices are off (`--notifications off`), during a survey, and in unattended runs. When a refresh
fails, the rows stay for one more poll; after a second failure they go, and one dim line says the inbox cannot be
reached right now, so nothing stale stays pressable. With notices off nothing is said about failures either (the
mod keeps the last `enabled` it saw, and a failure of `agentdrop --json band` also says it). When the agent was
signed out, revoked or never paired (`UNAUTHORIZED`, `ENDPOINT_REVOKED`, `NOT_PAIRED`), waiting does not help: the
rows go at once and the one dim line says the agent is no longer signed in and needs to be connected again. Sessions
starting together with no cache wait up to 5 s for the one that queries and show its result; a call that still
finds another session refreshing fails with `BUSY`, which the mod does not count as a failed refresh.

**The buttons.** The band has no hotkeys: a digit typed into an empty prompt answers Claude's numbered options, and
must never press a row. Per drop row: **Read** submits, as the person, "Read the AgentDrop drop with drop_id … from
@x and tell me what it says": the person asked, so Claude reads it and marks it read (ADR 0019); nothing reaches
Claude before the person presses it (ADR 0020). A prompt submitted as the person carries the person's authority, so
it holds only ids, a handle or group slug that matches the server's own rules, and fixed words: never a title, a
display name or any other text someone else wrote. **On it** sends the ADR 0021 acknowledgement without a turn: to
the author directly, or in the group as a quoted reply mentioning the author (`agentdrop ack`, request id
`ack:<drop_id>:<language>`, so pressing twice sends once, and pressing again after switching language is another
reply rather than a conflict); the title keeps a single "Re:", the toast says what happened (sent, waiting for the
person's approval in the dashboard, not sent), and the person's own drop is refused. If the author has left the
group, the mention is refused by the server; the acknowledgement then goes to the group without the mention: it was
asked there, and the members still see it is in hand (a direct message instead could reach someone who is not a
contact). The mention is part of the reply's content, so a second press after the author changed their handle, or
after the author left and rejoined (the first reply went without the mention, under the `:group` request id), meets
`IDEMPOTENCY_CONFLICT`: that means the person already replied, and the toast says so ("You already replied to
that."); nothing is sent again, one acknowledgement per drop as ADR 0021 asks. **Later** hides the row on this
machine for a week; the "Later" list is shared by every session and merged before each save, and only the newest
200 entries are kept, so reading it back every poll stays bounded. Per group row: **Look** asks Claude to summarize
the group's new messages, **Mark read** marks read exactly the drops that row stands for, each by the ordinary
per-drop state change (ADR 0005; `agentdrop mark-read --drop <id>:<version>`, full drop ids only, never together
with `--group` or `--up-to`), up to eight at a time; a drop that is gone, no longer the person's, or changed again
after the one retry is skipped and counted, and the others are still marked. The toast speaks only when none could
be marked. The mentions and replies listed on rows of their own stay unread. **Later** hides it until a newer
message arrives.

**The pane.** `/agentdrop` (runs immediately, no turn) opens at once with what the band has and refreshes; it lists
the drops even when notices are off, since the person opened it, with hotkeys 1–9 to open one; a group row opens
to that group's unread drops, each one to open, so ordinary group messages are readable there too. Opening one shows
title, sender, local time, body (and says when the body is longer than shown) and file names, and marks it read for
the person on any of their agents, as opening it in the dashboard does; when only the marking fails, the drop is
still shown, with a dim note that it stays unread for now. Every field is someone else's text: control and format
characters are removed before it is drawn, and text is cut between characters, never through a surrogate pair. Nothing in the pane reaches Claude. Failures are told by the
CLI's error code, in the person's language; no server message, id or command reaches the person.

**What the band does not change.** The seen record (ADR 0017) is still claimed only by prompt submit and session
start, and the Stop preview stays; the band is a glance, like the status line it replaces, and does not use up the
seen signal. Hooks, skill and MCP registration are the same as before.

**Install and trust.** The mod ships inside the CLI package (`apps/cli/claude-mod/agentdrop`). Connect copies it
to AgentDrop's data directory as a local marketplace (`agentdrop-local`), stamped with the CLI version, and runs
`claude plugin marketplace add`, `claude plugin install agentdrop@agentdrop-local --scope user` and `claude plugin
update` (install keeps an earlier version that is already installed). Claude Code does not load the marketplace copy
in place: it installs its own copy (`plugins/cache/agentdrop-local/agentdrop/<version>`, observed in 2.1.287). So
after a CLI upgrade any CLI command rewrites the marketplace copy (local files only) and starts a detached worker
(`agentdrop _take-claude-mod`) that runs `claude plugin update` with a 30 s limit, so no hook or poll ever waits on
`claude`; the next session runs the new mod. Only a CLI newer than the copy (by semver) rewrites it: another CLI on
the same machine (`npx` of an older release, a source checkout) leaves it alone, and the same version only repairs a
copy that is incomplete or points to another `claude-mod.json`; connect always installs its own version. One machine
can run Claude Code with several config directories (`CLAUDE_CONFIG_DIR`); they share the one marketplace copy, so
`claude-mod.json` lists every directory the mod was installed into (null for the default one): connect adds the
directory it runs under, disconnect removes it and deletes the copy and `claude-mod.json` only when no directory that
still has the mod installed is left, and the worker runs `claude plugin update` once per listed directory with that directory in its environment. The version
Claude Code took is recorded per directory, only when the update succeeded, and the worker is started at most once
every ten minutes (the claim is a file created exclusively, a stale one replaced under a lock, so of many hooks
starting at once one starts it), so a missing `claude` or a failed update is retried without costing every command a
try. Connect, setup, disconnect and `mcp` never start it, and the worker writes into the marketplace only while it
and `claude-mod.json` still exist and never creates a directory, so a disconnect while it runs leaves nothing
behind. When the person removed the plugin in Claude Code themselves, `claude plugin update` fails with `Plugin
"agentdrop" is not installed` (or `… not found` when the marketplace went too; Claude Code 2.1.287): that is
recorded for the directory, nothing is retried there, and `agentdrop doctor` says the mod was removed in Claude Code
and that `agentdrop connect claude-code` puts it back. The copy is built beside the installed one and renamed into
place (staging directories older than an hour, left by a write that never finished, are removed by the next one); a
failed rewrite is tried again by the next command, and without a complete bundled mod (`hooks/register.js`,
`hooks/rows.js`, `hooks/hooks.json`, `.claude-plugin/plugin.json`) the installed copy is left as it is. The mod
holds no credential: it runs the `agentdrop` CLI recorded in `claude-mod.json` (the executable, profile and Claude
Code config directories, mode 600) with `--json`; the copy carries a `config.json` naming that file's absolute path, so the mod never guesses the config directory. When the `agentdrop` executable moves, ordinary
CLI commands point `claude-mod.json` at the running CLI, as they repair hooks; the commands the mod runs every 20 s
(`band`, `ack`, `mark-read`) skip skill and hook repair. The CLI does every request with the profile's own
credential, so authorization and sender identity stay with the server (AGENTS.md rules 3 and 4). When connect does
not install the mod (older Claude Code, no `claude` found, `--no-cli`, or a failed install), it removes any copy,
`claude-mod.json` and plugin entry left from before and writes the status line, and says so when that cleanup could
not remove the plugin entry either; there is no runtime fallback from a broken mod. `disconnect claude-code`
uninstalls the plugin, removes the marketplace and the copy; without `claude` on `PATH` it still deletes the files
and tells the person the plugin entry may remain.

## Consequences

- Claude Code is the only harness with an interactive band; Codex, opencode and Cursor have no equivalent
  extension surface and keep their hooks and (Claude Code before 2.1.287) the status line. This is a difference
  in presentation, not in behaviour: every action the band offers is also available by asking the agent.
- The band's text is for people: in the person's language, no ids or commands. The prompts the buttons submit are
  the person's words to Claude and name the drop id so Claude reads the right one; they hold nothing anyone else
  wrote, so a hostile title cannot speak to Claude with the person's authority.
- Mods are new in Claude Code; when their API changes, the band can fail while hooks keep working. The fallback
  path (status line) is kept and tested.
