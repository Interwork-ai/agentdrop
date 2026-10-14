# 0024. One adapter per harness, and oh-my-pi (omp) as the fifth

- Status: Accepted
- Date: 2026-10-02
- Refines: ADR 0017 (seen in an agent: which host moments count), ADR 0002 (two audiences)

## Context

`agentdrop connect` and `disconnect` branched on `codex | claude-code | cursor | opencode` in every step, and the
same lists were repeated in setup, the skill targets, hook repair, doctor and every help text. Adding a harness
meant finding all of them; missing one left a harness half-installed with no test failing.

oh-my-pi (`omp`, a fork of the pi coding agent) was the next harness to support. It has MCP servers in a JSON file
but no `mcp add` command, and its hooks are TypeScript/JavaScript extensions with events, not shell commands.

## Decision

**Adapters.** Each connectable harness is one module, `apps/cli/src/harnesses/<key>.ts`, listed once in the registry
`apps/cli/src/harnesses/index.ts`. An adapter declares its label, default profile, binaries, config root and skills
root, and implements registering and removing the MCP entry and installing and removing its notice artifacts (hooks,
plugin, extension, mod, status line). Where a host's notice configuration can be repaired in place, the adapter also
describes that file for the startup repair and `doctor`. Everything else stays shared and must not branch on the
harness: the bridge, mailbox rules, notice text (`notificationText`, `pendingContextText`), the skill content, the
network route. Help and error texts derive the harness list from the registry.

**Parity is a test, not a convention.** `apps/cli/src/harnesses/parity.test.ts` connects and disconnects every
registered harness in a sandboxed home and checks the same bridge command, which moments notify whom, and that
nothing is left behind. Its expectation table and readers are keyed by the registry, so a new harness fails it until
its row is written. Host-specific edits are tested in `apps/cli/src/harnesses/<key>.test.ts`.

**omp.** `connect omp` writes `mcpServers.agentdrop` into `~/.omp/agent/mcp.json`, the skill into
`~/.omp/agent/skills/agentdrop`, and one managed extension `~/.omp/agent/extensions/agentdrop.js`. The agent
directory is found the way omp finds it: `PI_CODING_AGENT_DIR` when set and not empty, otherwise
`~/<PI_CONFIG_DIR or .omp>/agent`. The extension runs the same `agentdrop pending --in-hook` commands as the Codex
and Claude Code hooks, with the same hook JSON on stdin:

- `session_start` (the person is there): their notice, through `ctx.ui.notify`.
- `before_agent_start` (a prompt is about to go out): their notice, and the model's pending list kept for this turn.
  omp may run the handler again for the same submission (it retries the preparation when another extension's
  system prompt override raced a tool change), so the same session and prompt within two seconds reuse the answer.
  A person sending the same words again later ("continue") gets a fresh list.
- `context` (every model call of the turn): the pending list appended as the last message of that call.
- `agent_end` without a continuation: the turn's list is dropped, and the end-of-turn preview is shown.

Where the model's list goes was weighed on three costs: whether it accumulates in the session, whether it breaks
the provider's prompt cache, and whether it reaches every model call of the turn.

- A `message` returned from `before_agent_start` is saved in the session and re-sent on every later turn: one copy
  per prompt piles up in the history. Rejected.
- A `systemPrompt` returned from `before_agent_start` holds for the turn only, so nothing accumulates (this was the
  first version). But the system prompt comes before the tools and the whole history in every provider's cache
  key, so each time the list changes, appears or goes away, the next call re-reads the entire conversation
  uncached (on Anthropic, a cache write for all of it). omp itself keeps its system prompt byte-stable for this
  reason and moves its own per-request date and directory line into the messages
  (`session/date-cwd-reminder.ts`).
- The `context` event (chosen) is given a copy of the messages for one call; what it returns is sent and never
  saved (`emitContext` in `extensibility/extensions/runner.ts`; the session file of a live run holds no copy). omp
  marks a message an extension added as per-call, and its Anthropic provider places no cache breakpoint at or after
  such a message (`isPerCallContextMessage` in `ai/providers/anthropic.ts`); the append-only context manager keeps
  the stable prefix up to it. Appended last, the list leaves the system prompt, the tools and the whole history
  cacheable; only the list itself is read uncached each call. The cost is that every call of the turn, also after a
  tool result or in a continuation, ends with the list, so a model may take it for the newest message; its text
  says it is background status, and in a live run the model answered the person's question and ignored it. omp
  also clones the history once per call while any extension listens to `context`.

Subagents of a task run get nothing. omp gives them no UI and, alone among sessions, the `yield` tool their run
must end with; the extension reads that from `pi.getAllTools()`. omp exposes no agent kind to extensions, and a
parent session in the header is no signal: `omp -p --fork` has one, a subagent of an `omp -p --no-session` run has
none. A run without a UI (`omp -p`, json) is unattended: the extension tells the CLI so (`AGENTDROP_UNATTENDED=1`),
nothing is shown or claimed, and the model still gets its context. A session switch
inside a running omp (`/new`, resume, fork) is not a session-start moment: omp's own status line replaces a notice
shown then, while the claim would record the items as seen, so the next prompt shows them instead.

**Compatibility.** `harness_key` gains `omp` (expand-only migration). Clients before 0.5.9 parse it against the old
enum, so the server tells them `other` for an omp agent. From 0.5.9 the bridge reads any harness key it does not know
as `other` itself, so a later harness needs no server shim for newer bridges.

## Consequences

- Adding a harness is one adapter file, a registry entry, a parity row, a harness key (with migration) and the docs;
  the compiler and the parity test point at what is missing.
- omp has all three presence moments (prompt, session start, end of turn), like Codex and Claude Code, through one
  extension instead of command hooks. Tested with omp 18.2.5 (live: `omp -p`, `omp -p --fork`, the TUI with a
  repeated prompt, a tool call and a subagent). There is no version gate: the `context` event, `pi.getAllTools()`
  and the `yield` tool exist from omp 17.0.2 on (names only there, tool infos later; the extension reads both), and
  an omp before 18.2.5 without the per-call cache marker still keeps the history cacheable, since the list is last.
- A new CLI against a server older than a harness key (a 0.5.8 server and `omp`) pairs every other harness, then
  says that this client needs a server update; `setup` tries rather than comparing versions, since a server built
  between releases reports the last released version.
- Not supported yet: named omp profiles (`OMP_PROFILE`), autorun and a glance surface (`setStatus`, a widget above
  the editor) for omp. All are possible later through the same extension.
