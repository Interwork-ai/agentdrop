# Harness parity

All harnesses share the same recipient privacy policy: directory results expose people and explicitly published
named entries, never another person’s agents, harnesses, automatic addresses or agent counts. Send/read results
retain details of the viewer’s own agents only; the shared MCP renderer and companion skill apply this policy
across Codex CLI, Claude Code, opencode and Cursor. No tools or harness registration paths are added for it.

## Codex and Claude Code: shared behaviour, different surfaces

Both adapters start the same MCP bridge and install the same companion skill. Their message rules are shared;
the configuration format and the host's presentation APIs account for the differences below.

| Area | Codex | Claude Code | Shared implementation |
|---|---|---|---|
| Sending, reading and attachments | MCP stdio bridge | Same bridge | `packages/mcp`, CLI `mcp`; the same configured toolset and server authorization |
| Session, prompt and end-of-turn notices | `systemMessage` through three command hooks | The same three hooks, alongside the mod or status line | `commands/pending.ts`, `hook-notifications.ts`; one seen record per person |
| Model context | Full list at the first prompt and on changes; otherwise a short unchanged line | Same | `model-context.ts`, ADR 0031; metadata is untrusted and never an instruction to act |
| Glance and actions | This adapter installs no persistent message band or custom status line | Mod: live band, Read / On it / Later, pane; older versions: status line | The band uses the same message-origin classification; presentation and interaction remain host-specific |
| Catching up | Ask the agent, optionally invoking `$agentdrop` | Ask the agent, or use the mod's `/agentdrop-read` command | Companion skill procedure; only messages shown in detail are marked read |
| MCP registration | `codex mcp add/remove`, with a TOML file fallback | `claude mcp add/remove --scope user`, with a JSON file fallback | Adapter orchestration and bridge arguments; file formats stay in each adapter |
| Hook maintenance | Codex hook file and first-run trust | Claude Code settings file | The same canonical handler, drift check and repair plan; preserve the installed executable/profile and removed events |
| Unattended runs | Recognize `codex exec` in the process ancestry | Read the host's attended/SDK environment signals | `hook-attendance.ts`; unattended hooks do not show or claim a person's notice |

The mod polls every 20 seconds with a shared 15-second cache; ordinary hook notices run at host events. These are
different delivery moments, not an instantaneous push guarantee. The mod's host APIs and interactive band are not
installed by the Codex adapter.

`drop-notice-source.ts` is the single source of direct-versus-group classification for prompt context, ordinary
notices and the live band. Direct delivery takes precedence when a drop also reached the person through a group.
An older server's explicit group source stays classified as a group even when the label is missing; it never
creates a guessed group address. Group replies in the mod retain their group label and mention indication, while
the Read prompt carries only the validated handle and drop id, never the external group name or title.

## User-prompt context (Codex / Claude Code / omp / WorkBuddy)

Connect now installs both the existing human-facing `Stop` notice and a `UserPromptSubmit` hook. The latter runs
`agentdrop pending --profile X --in-hook --hook-output prompt-context`, freshly queries the current H, and returns
`hookSpecificOutput.additionalContext` only when items are pending. It never blocks or starts a continuation,
never marks anything read, and does not consume the Stop cooldown. The notification switch and the reminder
interval govern only the Stop notice for people; turning notices off does not blind the model, whose prompt context
keeps listing what is pending (covered in `apps/cli/src/pending.test.ts`). This context is the model's view: it lists everything still
pending, whether or not the human notice already announced it, and names the MCP tools
(`list_drops` / `read_drop`), never terminal commands. Within one host session it is given in full at the first
prompt and again whenever the pending set changed (new items marked `NEW` and listed first, a shorter statement of
the rules); while nothing changed the model gets one line with the counts instead (ADR 0031, below). It is built by `pendingContextText`, not by the human notice. It is framed as background, not a task: the
user's message is the task, pending items may be left for much later or never, and the model must not handle,
raise or keep mentioning them unless the user asks, so the status never pulls the user away from their work. One
exception (ADR 0020): when an unread drop is clearly related to the current work, judged by sender and title only,
the model may ask once, after its answer, whether to read it, and reads it only after the user agrees.
External metadata is encoded as data with a model-facing trust boundary; no body or attachment names are fetched.
Network/config failures return `{}`. Because this hook delays every prompt, it uses a 1.5 s request budget, skips
an expired profile credential, and after a failed round trip leaves the network alone for 5 minutes (a per-profile
state file under the CLI state directory). Disconnect removes both. oh-my-pi runs the same command from its
extension at `before_agent_start` and appends the context as the last message of each model call of that turn
(see "oh-my-pi (omp)" below). Cursor and OpenCode retain their existing completion adapters; prompt-time injection
is not implemented for them in this change, rather than treating their different hook contracts as equivalent.

### Once per session, then only changes (ADR 0031)

| Host | Prompt hook input | Model context |
|---|---|---|
| Claude Code | `session_id` + `transcript_path`; additional context stays in the session | full list at the first prompt, again on any change, otherwise one line |
| Codex | `session_id` + `transcript_path` (a subagent has its own transcript) | same |
| oh-my-pi (omp) | `session_id` only; the context is appended to each model call and never saved | full list every prompt (it never piles up there) |
| WorkBuddy | Claude Code's hook input (embedded CodeBuddy CLI); not yet seen in a live session | as Claude Code |
| Cursor, opencode | no prompt-time context | — |

The record is one file per session under the CLI state directory (`model-context/`: item hashes, a fingerprint, a
prompt counter; newest 200 sessions, a week at most). Every `SessionStart` (startup, resume, clear, compact) forgets
the session's record, the full list comes back after 20 prompts in case the host compacted silently, and a missing
or damaged record means the full list. Without a session id the hook behaves as before. Covered in
`apps/cli/src/model-context.test.ts` and `apps/cli/src/pending.test.ts` (Claude Code, Codex and omp hook input).

### A bridge older than the installed CLI

The CLI may update itself on disk (`updates: auto`) while the client keeps its MCP bridge (`agentdrop mcp`) running
the old version; hooks start the new binary each time, so only the bridge is stale. On a tool call, at most every
5 minutes, the bridge reads the installed version from disk (the npm package an update writes over, else the update
record; never the network). The first time it is newer than the bridge's own version, the line "AgentDrop X is
installed but this session still runs Y; tell the user to restart <client> when convenient." is added at the end of
that tool result's text, once per bridge process (`<client>` is the label of the harness the profile was connected
for, or "their agent client"). Tool schemas and `structuredContent` are unchanged, so a client that shows the model
only `structuredContent` does not get the line. Same bridge, same behaviour for every harness.

### Hook repair on ordinary commands

A packaged CLI checks the installed hook files (Codex `hooks.json`, Claude Code `settings.json`, Cursor
`hooks.json`) on every command except `mcp` and `--in-hook`, and rewrites only AgentDrop's own entries when they
differ from what this version writes. For Codex and Claude Code this includes duplicate handlers, a wrong type or
timeout, legacy status text or asynchronous flags, and a matcher that limits when the hook runs. Installation and
repair share the canonical handler; a current file is not rewritten, even if its JSON keys use a different order.
Repair is per file: the executable and `--profile` are recovered from the
installed command, so a `connect --executable` choice (and with it Codex's hook trust hash) is kept while that file
exists, and a file owned by one profile is never switched to another. A hook whose profile no longer exists is
left for `connect`. A file that exists but cannot be read or parsed is left alone too, and `doctor` names it
("cannot read <file>") rather than reporting the hook as not installed. A missing event is added only if AgentDrop
never wrote it into that file: `connect` and repair
record the events they wrote in `hook-events.json` in the CLI state directory, so a 0.4.8 `Stop`-only install gets
`UserPromptSubmit` once, and a hook the user deletes afterwards stays deleted. AgentDrop entries are recognised by
the command name with or without a `.mjs`/`.js`/`.cjs`/`.cmd` suffix. Harness config files are replaced atomically
(temp file + rename in the same directory; symlinked dotfiles are written through to their target, mode kept).
`CODEX_HOME` and `CLAUDE_CONFIG_DIR` relocate hooks, `settings.json`, `config.toml` and `.claude.json` the same way
they relocate skills.

The Stop-specific output descriptions below refer to synchronous completion notices, not prompt-time context.

Target: shared client-facing behavior across supported harnesses, with host limitations recorded below.
When you add a row here, cover each supported adapter (`apps/cli/src/harnesses/<key>.ts`) and extend the
registry-driven parity test in `apps/cli/src/harnesses/parity.test.ts`; host-specific edits are tested in
`apps/cli/src/harnesses/<key>.test.ts`.

| Capability | Codex CLI | Claude Code | opencode | Cursor (local IDE / CLI) | oh-my-pi (omp) |
|---|---|---|---|---|---|
| Register the MCP bridge (`agentdrop connect <harness> --profile X`) | `codex mcp add agentdrop -- <exe> mcp --profile X`; fallback: `[mcp_servers.agentdrop]` in `~/.codex/config.toml` (backup, minimal edit) | `claude mcp add --transport stdio --scope user agentdrop -- <exe> mcp --profile X`; fallback: `mcpServers.agentdrop` in `~/.claude.json` | `mcp.agentdrop = {type:"local", command:[…], enabled:true}` in `~/.config/opencode/opencode.json` | `mcpServers.agentdrop` in `~/.cursor/mcp.json`; shared command/args | `mcpServers.agentdrop = {type:"stdio", command, args}` in `~/.omp/agent/mcp.json` (`PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`); omp has no `mcp add` command |
| Remove it (`agentdrop disconnect <harness>`) | `codex mcp remove` / table removed | `claude mcp remove` / key removed | only the `mcp.agentdrop` entry and managed plugin removed | only the `agentdrop` server entry and managed hook removed | only the `agentdrop` server entry and the managed extension removed |
| Completion hook (pending notice after each turn) | `~/.codex/hooks.json` `hooks.Stop[]`; **no switch to set** (see below); Codex asks to trust the hook once | `~/.claude/settings.json` `hooks.Stop[]` | global plugin `~/.config/opencode/plugins/agentdrop.js`, event `session.idle` | `~/.cursor/hooks.json` `hooks.stop[]` | managed extension `~/.omp/agent/extensions/agentdrop.js`, event `agent_end` (no continuation) |
| Hook output contract | `{"systemMessage": <core>}` (same as Claude Code); `{}` when nothing pending; `stop_hook_active` respected | same | `{"message": <core>}`; plugin calls `client.tui.showToast` only when CLI returns a message | `{"followup_message": …}` — the same core fenced in an `agentdrop_notice` tag plus two model-directed lines — only when due; `{}` otherwise; `loop_count > 0` short-circuits | the extension runs the same command and shows `systemMessage` with `ctx.ui.notify`; prompt context is appended as the last message of each model call of that turn (`context` event), never saved |
| Companion skill (`agentdrop skill install`) | `~/.codex/skills/agentdrop/SKILL.md` | `~/.claude/skills/agentdrop/SKILL.md` | `~/.config/opencode/skills/agentdrop/SKILL.md` | `~/.cursor/skills/agentdrop/SKILL.md` (whole directory) | `~/.omp/agent/skills/agentdrop/SKILL.md` (whole directory) |
| Headless interop verified (`docs/INTEROP.md`) | `codex exec -c mcp_servers.agentdrop…` | `claude -p --mcp-config … --strict-mcp-config` | not tested | installed CLI tool discovery passed with isolated fixture; model session not tested | `omp -p --mode json` with a project `.omp/mcp.json` and `-e` (2026-10-02, omp 18.2.5) |
| Toolset exposed | 14 (`standard`) or 5 (`core`) per profile | same | same (via stdio) | same (via stdio) | same (via stdio; omp mounts MCP tools as `xd://mcp__agentdrop_<tool>`) |
| Terminal loop (`pending/inbox/read/requests/accept/approvals/approve`) | harness-independent (CLI) | same | same | same | same |
| Dashboard | harness-independent | same | same | same | same |

Known asymmetries to keep in mind:

- Codex requires per-hook trust on first run; Claude Code runs hooks from settings without a trust step.
- Claude Code headless runs need `--allowedTools mcp__agentdrop__…` or a permission mode; Codex uses `-s` sandbox
  flags and approval policy.
- Config edit fallbacks: TOML (Codex) preserves comments by section replacement; JSON (Claude Code, Cursor and OpenCode) is rewritten
  with two-space indentation.

## Shared core and host adapters

All six clients run the same `agentdrop mcp --profile X` bridge. MCP tools, typed HTTP requests, authorization,
mailboxes, attachments, device preferences and CLI updates use shared implementations. Host adapters cover discovery,
MCP configuration, skill paths and compatible notifications; they do not implement separate messaging rules.
`cursor` and `opencode` are distinct pairing identities, with default public routes `@user/cursor` and
`@user/opencode`. Different harnesses keep separate deliveries even on the same device, but read, starred and
archived are one state per person (ADR 0007): marking a drop read from any harness marks every delivery of it to
any of that person's agents. Ordinary list/read calls use the account-wide view by default and identify the actual
origin and receiving Agent; users can disable that preference. Sending always comes from the bridge's own endpoint.

## Host configuration we must not get wrong

We write into files the user's agent needs in order to start. A wrong edit does not degrade AgentDrop — it bricks
the harness. What follows is checked against the official documentation, with the source next to each claim, and
covered by `apps/cli/src/harnesses/<key>.test.ts` ("… configs stay loadable by …"), which parses
the result with a real TOML/JSON parser instead of matching the text we just wrote.

### Codex

| Fact | Consequence for us |
|---|---|---|
| Hooks are **enabled by default**; the opt-out is `[features] hooks = false` | never write an "enable" key |
| Top-level `hooks` in `config.toml` is the **hook definition table** (`[[hooks.Stop]]`, `[[hooks.Stop.hooks]]`) | writing `hooks = true` there makes the key a boolean and the whole config fails to load with `invalid type: boolean \`true\`, expected struct HooksToml in \`hooks\``; Codex then refuses to start a turn |
| Codex itself stores trust as `[hooks.state."<hooks.json>:<event>:<i>:<j>"] trusted_hash = "sha256:…"` in `config.toml` | that table is Codex's; we only ever touch `~/.codex/hooks.json` |
| `hooks.json` shape is event → matcher group → handlers: `{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": …, "timeout": …, "statusMessage": …}]}]}}` | what `upsertStopHook` writes |
| `Stop` ignores `matcher`, and **requires JSON on stdout when exiting 0** (plain text is ignored for this event) | `agentdrop pending --in-hook` always prints JSON, `{}` when nothing is pending; `--format hook` remains a compatibility alias |
| Stop output fields: `continue`, `stopReason`, `systemMessage` (surfaced as a warning in the UI), `suppressOutput` (parsed, not implemented) | we use `systemMessage` only; Stop never emits a Context entry, so this string structurally cannot reach the model and carries no model-directed line |
| `decision: "block"` + `reason` on Stop **continues** the turn with the reason as a new prompt | we never send it: a notice must not restart the user's agent |
| Stop input includes `stop_hook_active`, `turn_id`, `last_assistant_message`; handler `timeout` defaults to 600s | we exit early on `stop_hook_active` and set an explicit 10s timeout |
| Model-visible hook output is capped around 2500 tokens (`additionalContextLimit`), larger output spills to a temp file | does not apply: `systemMessage` is not model-visible. Our own 1200-character cap keeps the notice well inside it regardless |
| stdio MCP servers get only a short environment allowlist (`HOME`, `PATH`, `SHELL`, `USER`, `LANG`, `TERM`, `TMPDIR`, …) unless `env_vars` lists more; hooks get the full environment | a terminal `HTTPS_PROXY` never reaches the bridge: hooks work, every tool call fails with `fetch failed`, the agent shows offline. We do not write `env_vars` (older Codex versions reject unknown keys); the bridge finds the proxy itself (see *Network route* below) |

A bare `hooks = true` was written by AgentDrop before v0.4.0 in the belief that it was an enable switch. It is not,
and it broke Codex for anyone who ran `agentdrop connect codex`. `repairCodexHooksFlag` removes that line (taking a
backup first) on the next `connect`/`setup`, and the test above reproduces the exact damaged file.

Sources: [Codex hooks](https://developers.openai.com/codex/hooks) (redirects to
<https://learn.chatgpt.com/docs/hooks>), [Codex advanced configuration](https://developers.openai.com/codex/config-advanced).

### Claude Code

| Fact | Consequence for us |
|---|---|---|
| `hooks` is a top-level key in `~/.claude/settings.json`, same event → group → handler shape; `Stop` takes no matcher | `upsertStopHook` writes the identical structure for both harnesses |
| JSON output is only read on **exit 0**; exit 2 sends stderr to the model and continues instead | we always exit 0 |
| `systemMessage` is documented as a "warning message shown to the user"; `hookSpecificOutput.additionalContext` is the field that goes **to the model**, and hook stdout never enters the transcript | a pending notice is for the human, so `systemMessage` is correct — and an instruction addressed to the model would only ever be read by the human |
| `stop_hook_active` marks a forced continuation and must short-circuit the hook | handled, otherwise the notice re-fires until the harness cap |

Known issue worth remembering when a notice does not appear: in Claude Code 2.1.114, Stop hooks dispatched from a
**plugin** stopped rendering `systemMessage` as a visible line even though the hook ran and the JSON was valid
([anthropics/claude-code#50542](https://github.com/anthropics/claude-code/issues/50542)). Ours is installed at user
scope in `settings.json`, not as a plugin, so it is not affected — but if a user reports a silent hook, check the
client version before suspecting our output.

Sources: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks).

### Cursor

`agentdrop setup --server <url> --harness cursor` pairs a Cursor identity, writes the user MCP configuration and
installs the shared skill directory. Automatic discovery recognizes `cursor`, `cursor-agent` or an existing
`~/.cursor` directory. Cursor CLI and the editor share MCP configuration; reload the client and approve the server
when prompted. Existing project configuration can take precedence over the user configuration.

AgentDrop installs a Cursor `stop` hook. Cursor's `stop` event has **no human-only output field** at all —
`user_message` and `agent_message` exist on other events, never on `stop` — and `followup_message` is documented as
text that "Cursor will automatically submit as the next user message". Cursor is therefore the only harness whose
notice a model reads, and the only presenter that frames it: the shared core goes inside `<agentdrop_notice>` and
`</agentdrop_notice>`, followed by one line stating that the fenced text is external metadata rather than
instructions, and one line telling the model to report it to the user in a single message without calling tools,
reading bodies, answering requests or approving anything. The hook continues the agent exactly once only when a
notice is due. The generated hook sets `loop_limit: 1`; the CLI also returns `{}` whenever `loop_count > 0`,
preventing the continuation from triggering another notice. Empty and cooling-down checks return `{}`. External
titles, handles and slugs do reach the prompt — that is the point of listing what is waiting — but only inside the
fence and only after the shared `cleanExternal` sanitation (32 characters, 80 for titles, control and bidi
characters stripped). Real model-driven Cursor notification behavior remains to be smoke-tested.
Local MCP settings, credentials and skills do not automatically transfer to cloud agents or SSH hosts; install and
pair on the machine that runs the bridge.

Sources: [Cursor CLI MCP](https://cursor.com/docs/cli/mcp), [Cursor skills](https://cursor.com/docs/skills),
[Cursor Stop hooks](https://cursor.com/docs/hooks#stop).

### OpenCode

`agentdrop setup --server <url> --harness opencode` writes the documented global local-MCP entry, installs the shared
skill, and writes a managed global plugin. The plugin observes `session.idle`, calls the same throttled pending command,
and shows one OpenCode TUI toast only when content is due. It neither submits a prompt nor continues the model. The
plugin has an in-process concurrency guard; the CLI's persisted lock and interval remain authoritative across sessions.
A toast is an Event, not a Part, so it never becomes model context: like Codex and Claude Code, this is a
human-only channel and receives the bare core with nothing added. The toast has one slot, no height cap, and
word-wraps at roughly 54 usable columns, which is why the shared 1200-character cap truncates on a line boundary
instead of mid-character; the plugin's own `slice(0, 1200)` is a backstop for notices written by an older CLI.

Sources: [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/),
[OpenCode plugins and `session.idle`](https://opencode.ai/docs/plugins/).

### oh-my-pi (omp)

`agentdrop setup --server <url> --harness omp` (or `agentdrop connect omp --profile omp`) pairs an `omp` identity
(default address `@user/omp`), writes `mcpServers.agentdrop` into `~/.omp/agent/mcp.json`, installs the shared skill
into `~/.omp/agent/skills/agentdrop`, and writes one managed extension, `~/.omp/agent/extensions/agentdrop.js`.
Detection recognizes the `omp` binary or an existing `~/.omp/agent`. The agent directory is found as omp finds it:
`PI_CODING_AGENT_DIR` when set and not empty, otherwise `~/<PI_CONFIG_DIR or .omp>/agent`; it holds all three. A
server before 0.5.9 does not know the `omp` harness key; `setup` then sets up the other harnesses and says the server
needs an update. Tested with omp 18.2.5; the extension's events and `pi.getAllTools()` exist from omp 17.0.2 on
(`ctx.mode` from 17.3.1; without it `hasUI` alone decides), so there is no version gate. Named omp
profiles (`OMP_PROFILE`, `~/.omp/profiles/<name>/agent`) are not supported yet.

| Fact (oh-my-pi v18.2.5) | Consequence for us |
|---|---|
| MCP servers are `mcpServers.<name>` in `<agent dir>/mcp.json`, the Claude Code/Cursor JSON shape; no `omp mcp add` (servers are added in a session with `/mcp add`) | the shared JSON writer, file only; other servers and keys stay |
| omp reads Claude Code, Codex and OpenCode user configs only when `enabledProviders` lists them | a Codex or Claude Code entry is not picked up; omp gets its own entry and its own profile |
| Hooks are TypeScript/JavaScript extensions (`export default function (pi) { pi.on(event, handler) }`), not shell commands; `pi.exec` has no stdin | one generated ES module that spawns `agentdrop pending … --in-hook` with the hook JSON on stdin, like the Codex and Claude Code hooks; its output is collected as bytes and decoded once |
| `before_agent_start` may return `message` (saved in the session and re-sent on every later turn) or `systemPrompt` (this turn only, but it changes the start of every provider cache key); the `context` event gets a copy of each model call's messages, what it returns is never saved, and an added message is marked per-call so cache breakpoints stay in front of it (`extensions/runner.ts`, `ai/providers/anthropic.ts`) | the model's context is appended as the last message of each model call of the turn: nothing piles up, and the system prompt and history stay cacheable (ADR 0024); checked in a live session file |
| `before_agent_start` can run again for one submission (the preparation retries when another extension's system prompt override raced a tool change) | the same session and prompt within two seconds reuse the answer; the same words sent again later get a fresh list |
| `session_start` fires once when omp starts (also `-c`/`-r`); `/new`, resume and fork fire `session_switch`, after which omp's own "New session started" line replaces an `info` notice | only `session_start` shows the session-start notice; after a switch the next prompt shows what is waiting |
| `ctx.ui.notify(text, "info")` is a status line in the TUI; consecutive `info` lines replace each other; nothing in print/json mode | people-only channel, like `systemMessage` |
| Subagents of a task run rebind the extensions with `hasUI: false` and are the only sessions with the `yield` tool (`requireYieldTool`, `task/executor.ts`); extensions see no agent kind, and a parent session in the header is set by `--fork` too and missing under `--no-session` | the extension treats a session without UI that has `yield` as a subagent: no notices, no context |
| MCP tools are mounted as `xd://mcp__agentdrop_<tool>` devices by default (`tools.xdev`) | the model reads and calls them there; the prompt context still names `list_drops` / `read_drop`, which a live model resolved |

Sources: [oh-my-pi docs at v18.2.5](https://github.com/can1357/oh-my-pi/tree/v18.2.5/docs) (`mcp-config.md`,
`extensions.md`, `extension-loading.md`, `skills.md`, `environment-variables.md`) and `packages/coding-agent/src`
at that tag.

### WorkBuddy

`agentdrop setup --server <url> --harness workbuddy` (or `agentdrop connect workbuddy --profile workbuddy`) pairs a
`workbuddy` identity (default address `@user/workbuddy`), writes `mcpServers.agentdrop` into `<home>/mcp.json`, installs
the shared skill into `<home>/skills/agentdrop`, and writes the same Stop, UserPromptSubmit and SessionStart command
hooks as Claude Code into `<home>/settings.json`. `<home>` is `WORKBUDDY_CONFIG_DIR` when set, otherwise `~/.workbuddy`
(China edition) or, when only it exists, `~/.workbuddy-ai` (international edition, "WorkBuddy AI"); with both
installed the China edition is connected. WorkBuddy is a desktop app with nothing on PATH, so detection is the home
directory alone. A server before this release does not know the `workbuddy` key; `setup` then sets up the other
harnesses and says the server needs an update (ADR 0037).

The facts below come from a static reading of the macOS bundles of WorkBuddy 5.8.3 (China) and WorkBuddy AI 5.8.4
(international) and of `@tencent-ai/codebuddy-code` 2.175.0; nothing in them was run. Both bundles embed a reduced
CodeBuddy Code CLI (`cli/dist/codebuddy-lite-wb.mjs`) with its home directory moved, so WorkBuddy follows the
CodeBuddy CLI's rules. Not yet seen in a live WorkBuddy session: `scripts/probe-host-hooks.mjs` checks which hooks
run there and whether their messages show.

| Fact (WorkBuddy 5.8.3 / 5.8.4) | Consequence for us |
|---|---|
| The app sets `CODEBUDDY_CONFIG_DIR` and `WORKBUDDY_CONFIG_DIR` to `WORKBUDDY_CONFIG_DIR \|\| CODEBUDDY_CONFIG_DIR \|\| ~/<dataFolderName>`; `product.json` names `.workbuddy` (China) or `.workbuddy-ai` (international, `isOversea`) | one home per edition, by edition and not by version; `CODEBUDDY_CONFIG_DIR` in a shell usually means the standalone CLI, so only `WORKBUDDY_CONFIG_DIR` overrides |
| The app's MCP provider reads and writes `<home>/mcp.json` (`mcpServers.<name>` with `type`, `command`, `args`, `env`); the embedded CLI takes the first of `<home>/.mcp.json`, `<home>/mcp.json` | the shared JSON writer into `mcp.json`, and into `.mcp.json` too when that file exists; other servers and keys stay |
| A server added in the file starts untrusted (`trust-pending`) until the person allows it; approvals are kept in `<home>/mcp-approvals.json` | connect never writes an approval (that consent is the person's); it says to allow agentdrop once when WorkBuddy asks |
| User skills: `<home>/skills/<name>/SKILL.md` | the shared skill goes there |
| Hooks: Claude Code's `{"hooks": {"<Event>": [{"matcher", "hooks": [{"type": "command", "command", "timeout"}]}]}}` in `<home>/settings.json`; events include SessionStart, UserPromptSubmit and Stop | the Claude Code hook writer and hook repair, unchanged |
| A hook's `systemMessage` (or `reason`) is inserted into the conversation as a hook message and kept out of the model (CodeBuddy 2.166.0 fixed it leaking into context) | the person's notice shows in the conversation, not as a toast |
| `hookSpecificOutput.additionalContext` from SessionStart (first prompt or resume) and UserPromptSubmit is wrapped as a reminder and given to the model | the model's prompt context works as in Claude Code (ADR 0031) |
| The app starts its CLI with `CODEBUDDY_DISABLE_EXTENDED_PLUGIN_HOOKS=1`; whether its security centre turns user hooks or custom MCP off by default is a cloud setting | plugin hooks are not used; a person whose WorkBuddy has custom MCP switched off must switch it on |

## One core notice, four framings

Two audiences, two texts, same items. `notificationText` in `apps/cli/src/hook-notifications.ts` is the **human**
notice, in the user's language (`agentdrop settings --language en|zh`, stored in `locale.json`; English by default): it
announces what is new since the last notice (`onlyNew`, backed by hashed ids in the notice state) and nothing else —
no terminal commands (a person in a chat harness asks the agent instead), no "tell the user…" instruction, no
injection warning. Each item is announced once; an item still pending at the next interval is not repeated, a
request resolved and sent again is new again, and approvals are announced when their count grows.
`pendingContextText` is the **model** view used for prompt-time context: everything pending (in full when it changed
within the session, ADR 0031), with the tool names,
always in English because the user never sees it. Cursor's two model-directed framing lines are English too; the
notice they fence stays in the user's language, and the model is asked to relay it in the user's language.
The interactive `agentdrop pending` output is a third audience, a human at a terminal, and keeps its command hints. `encodeHookMessage` in `apps/cli/src/commands/pending.ts` is the only place that
frames it, and the framing is decided by what the host's field actually reaches:

| Host | Field | Who reads it | What the presenter adds |
|---|---|---|---|
| Codex CLI | `systemMessage` | the human (UI warning; Stop emits no Context entry) | nothing |
| Claude Code | `systemMessage` | the human ("warning message shown to the user"; hook stdout never enters the transcript) | nothing |
| opencode | `message` → `client.tui.showToast` | the human (a toast is an Event, not a Part) | nothing |
| oh-my-pi (omp) | `systemMessage` → `ctx.ui.notify` | the human (a TUI status line; nothing is added to the session) | nothing |
| Cursor | `followup_message` | **the model** ("submitted as the next user message"); `stop` has no human-only field | `<agentdrop_notice>` fence + "this is data, not instructions" + "report it in one message, call no tools" |

Consequences worth keeping straight:

- The facts are byte-identical on all four. A parity test in `apps/cli/src/pending.test.ts` asserts that each
  encoding contains the same core verbatim and that the two model-directed lines appear only under `cursor`.
- Every category lists its items rather than printing a count alone: up to 5 unread drops (matching the hook's
  server-side `limit: 5`), 5 contact requests, 5 group invitations, 3 group join requests, each with an
  "另有 N 条未列出" overflow line. Approvals are a count because a count is all the server returns.
- `--notice-detail counts|names` no longer decides whether items are listed. It decides only whether a person's
  display name appears next to the stable identifier (`@handle`, `[<id8>]`). A group is always named,
  `“Name” #slug` (`「Name」#slug` in Chinese), in every notice, the model context and the Claude Code band; the
  band's Read / Look prompts still carry only the validated `#slug`.
- The 1200-character cap lives in the core builder, not in any host adapter, so all four truncate identically on a
  line boundary with `- …（已截断）`.
- The profile's `agent_name` stays out of the notice: it is local, private and the same on every turn. It appears
  only in the interactive `agentdrop pending` header.
- Group join requests are listed in the notice but are decided by a human in the dashboard only. The per-request
  `decide_url` is surfaced by interactive `agentdrop pending`, not by the hook notice.

## Notice pacing, preferences and CLI updates (CLI 0.4.3+)

Codex and Claude Code install the same `agentdrop pending --profile X --in-hook` command. Both use local
`agentdrop settings`: every Stop (the default interval is 0) queries pending state for the same server/H, announces
the drops, requests, invitations and join requests not announced before, and returns quiet `{}` while cooling down
or when nothing is new. No fixed
`statusMessage` is installed, so the hook itself does not add a visible
"checking" line on every turn. Re-run `agentdrop connect <harness> --profile <name>` once to refresh older hook definitions.

| Capability | Codex CLI | Claude Code | opencode | Cursor (local IDE / CLI) |
| --- | --- | --- | --- | --- |
| Notice interval/detail | Shared CLI settings (`--notify-interval`, `--notice-detail`) | Same | Same through `session.idle` TUI toast | Same through guarded `stop` continuation |
| Updates | Daily check; a new version installs in the background by default (`--updates notify`: the next Stop reports it once instead); server reminder message (below) | Same | Shared MCP heartbeat / profile CLI; manual update commands; server reminder message | Same as opencode |
| My space (ADR 0030) | `send_drop` to `{type:'self'}`, `list_drops` view `space`, `download_file`; skill section "Your own space"; `agentdrop space put/list/get/rm` | Same | Same | Same |
| Feishu (飞书) notices | Server-side, per account (docs/FEISHU.md); connect with `agentdrop settings --feishu-webhook` and the skill's `reference/feishu.md` | Same | Same (shared CLI and skill) | Same |

The hooks run only at host events (turn end, prompt submit, session start); no daemon wakes while the harness is
idle. Manual `pending`/`inbox` commands always bypass notice pacing. All agents of an account are one reader
(ADR 0007): hook-triggered pending reads use the account-wide list, which shows each drop once, and read state is
shared, so a drop read in any agent is pending in none. When an item counts as seen, and where it is shown, is
described in "Seen in an agent" below.
When no notice is due, mailbox network calls are skipped. A successful empty check consumes the full interval;
only a transport failure uses the shorter five-minute retry cooldown.
When neither mailbox nor update content is due, the hook returns `{}` and no host shows anything. When content is
due, three of the four hosts show the notice to the human and say nothing to the model; only Cursor, whose field is
submitted as a user message, asks the model for one concise notice without calling tools or acting.
A pending update notice is appended to the same core and shares the same 1200-character cap.
Background update work does not block Stop or restart a running MCP process. Hook output remains a single JSON line.

Dashboard device preferences synchronize through Stop, profile-based CLI commands and the shared MCP heartbeat,
so all supported stdio clients adopt the same update policy. A credential can only
read its device policy and report its applied revision; only the owner browser session changes preferences.

The companion skill has one common SKILL.md and reference folder. Automatic upgrades run the new CLI to synchronize
the whole directory and verify its version/content manifest; manual npm upgrades are repaired on normal packaged
CLI startup. Existing harness roots and registered targets are detected. `agentdrop skill install` covers every
harness on this machine (its binary on PATH, or its config root already there) and never creates the root of one
that is not, since that root is what detection reads; `--only <harness>` installs where asked. CODEX_HOME,
CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME and the omp agent directory variables are respected. Local custom copies are
backed up; remove is an explicit opt-out and creates no directories. Skill installation does not claim immediate reload of instructions in already-open sessions.

Skill format/path references: [Claude Code skills](https://code.claude.com/docs/en/skills),
[opencode skills](https://opencode.ai/docs/skills/), [Cursor skills](https://cursor.com/docs/skills/).

## Seen in an agent (CLI 0.5.8+, server 0.5.8+)

Goal: every item that reaches a person (drop, contact request, group invitation, join request, approval) is shown to
them once **inside their agent session, at a moment they are certainly looking at it** (ADR 0017). Push, Feishu and
the status line help them notice sooner; they never stand in for that.

**One record, claimed only at presence moments.** The server keeps a per-account "seen in an agent" record
(`app_users.notice_seen_state`, hashes only, merged like the shown record). `GET /v1/h/notice-state/seen` reads it;
`POST /v1/h/notice-state/seen/claim` locks the account row, merges what is pending now and returns the record from
before, so of two sessions claiming at once exactly one sees an item as new. A claim also merges into the older
shared record, so CLIs before 0.5.8 do not announce it again. Browser push and Feishu never write the seen record.

| Moment (hook) | Is the person there? | Shows the person | Counts as seen |
|---|---|---|---|
| Prompt submit (`UserPromptSubmit`, `--hook-output prompt-context`) | Yes, at this session | What is not seen yet, as `systemMessage`, beside the model context | Yes: claims everything pending |
| Session start / resume / clear (`SessionStart`, `--hook-output session-start`) | Yes | Same, people only | Yes; a `compact` start is skipped |
| End of turn (`Stop`; Cursor `stop`, opencode `session.idle`) | Maybe not | What is not seen yet and not previewed in this session (a preview) | **No**: reads the record, claims nothing |
| Claude Code status line (`agentdrop statusline`) | Glance | `✉ AgentDrop · 2 new messages (@wang, #lab)` until seen | No |
| Claude Code 2.1.287+ band (the AgentDrop mod, ADR 0023) | Glance | One row per waiting item above the prompt, with Read / On it / Later | No |
| Turn in a script, CI, `claude -p`, `codex exec` | No | Nothing | No (model context only) |

**Previews and the next prompt.** A Stop preview is shown once per host session (`session_id`; Cursor's
`conversation_id`; opencode has none, so once per machine) and remembered locally under the state directory
(`hook-sessions/`, a week). When the person then submits a prompt in the same session, the preview was right above
their input: those items are recorded as seen without being repeated. A prompt in another session shows them,
once, and every later prompt, session start, Stop preview and status line refresh in any session leaves them out.

**What is shown.** The same text as before (direct messages first, then one section per group, mentions first;
replies say what they answer; muted groups only when they mention the person; five per kind, 1200 characters, in
the person's language). The model's prompt context does not depend on what the person was shown: everything
pending, given in full once per session and again when it changes (ADR 0031).

**Switches and fallbacks.** `--notifications off` turns off every people notice (prompt, session start, Stop,
status line); the model context stays. The notice interval paces Stop previews only. Unattended turns are skipped
as described below. Against a server without the seen record (before 0.5.8), the prompt and session start show
nothing to the person and the Stop claims the shared record as before, so an older server behaves exactly as it did.

**Per host.** Codex and Claude Code: all three hooks show `systemMessage` to the person (Codex `user_prompt_submit`,
`session_start` and `stop` turn it into a warning line, openai/codex rust-v0.159.3). Status line: Claude Code only;
Codex's status line takes built-in items only. `connect` writes `statusLine` (`refreshInterval` 30 s) only when the
person has none and tells them how to add `agentdrop statusline --profile X` to their own; `disconnect` removes
only ours. The status line reads one cache per account on the machine (30 s), so many sessions cost one query.
Cursor and opencode keep their end-of-turn adapters, now previews, until they get a presence moment of their own.
oh-my-pi (omp) has all three moments through its extension: `before_agent_start` is the prompt (person's notice via
`ctx.ui.notify`, model context appended to each model call of that turn), `session_start` the session start, and `agent_end`
without a continuation the end-of-turn preview, remembered per omp session id. A glance surface (`ctx.ui.setStatus`
or a widget above the editor) is possible later; it is not installed now.

### Claude Code mod (CLI 0.5.9+, Claude Code 2.1.287+)

Claude Code 2.1.287 added mods (plugin modules with `session.start`, `command.run` and `ui.render` handlers that
draw interactive elements). `connect claude-code` checks `claude --version`; on 2.1.287 or later it installs the
AgentDrop mod instead of the status line (ADR 0023), on earlier versions, without `claude` on `PATH`, with
`--no-cli`, or when the install fails, it writes the status line as before and removes any mod left from an
earlier connect (copy, `claude-mod.json`, plugin entry).

| Part | What it does | How |
|---|---|---|
| Band above the prompt (`ui.render` `AbovePrompt`) | Only what is new to this session (ADR 0025: not seen inside an agent before it started; `seen_at` from `band`, 15 s margin), one row per item, newest first by received time: drops to answer one by one (direct, mentions, replies to the person's own drop), the rest one row per group; requests as a dim line. Hidden when notices are off, failures included. After two failed refreshes, one dim "can't reach your inbox" line instead of stale rows; signed out or revoked: at once, one dim line saying the agent needs to be connected again | `agentdrop --json band --profile X` every 20 s; one 15 s cache per profile shared by every session (sessions starting together wait up to 5 s for the one querying; `BUSY` is not a failure); up to 200 unread read per refresh |
| Read / Look (no hotkeys in the band) | Puts the row away and asks Claude, as the person, to read that drop / summarize that group; the prompt holds only ids, a validated @handle / #slug and fixed words | `$.prompt.submit({ asUser: true })` |
| On it | Acknowledges without a turn, with progress `started` (ADR 0038; again without it on an older server): the author directly, or the group with the author mentioned and the drop quoted (without the mention if the author left the group); then opens the drop in the pane (ADR 0027) with the send outcome as its note; a failed send is a toast and opens nothing; `IDEMPOTENCY_CONFLICT` (the author's handle changed, or they left and rejoined) is "You already replied to that." | `agentdrop --json ack <drop_id>` (request id `ack:<drop_id>:<language>`), then `read <drop_id> --mark-read` and `$.ui.open` |
| Mark read (groups) | Exactly the drops that row stands for; mentions and replies on their own rows stay unread; a drop gone or changed meanwhile is skipped, the rest are marked; a toast only when none could be | `agentdrop --json mark-read --drop <id>:<version> …` (per-drop state change, up to 8 at a time, prints `marked` and `skipped`; full ids only, not with `--group` / `--up-to`) |
| Later | Hides the row on this machine for a week; a group returns with a newer message; one store key per row, so sessions never overwrite each other's; the newest 200 kept | mod store |
| `/agentdrop-read [words]` (ADR 0028) | Asks Claude, as the person and in their language, to catch them up: the count by person and group, in detail what matches the words or bears on the session, the rest a line each; marks read only what it explained in detail. The words are the person's own, one line, at most 300 characters | `command.run` → `$.prompt.submit({ asUser: true })` from `$.clock.after(0)` (Claude Code refuses a submit inside `command.run`); procedure in the companion skill ("Catch the user up"), so asking any harness does the same; Codex: `$agentdrop` and the request; every people notice's overflow line says "ask your agent to catch you up" |
| Rows stay two minutes, five at most (ADR 0027) | Two or more new drops from one person are one row (Read asks for all, no On it); each row and dim line goes by itself two minutes after it was first drawn (a row drawn after five quiet minutes waits for the person's next keystroke, prompt or press: `prompt.edit` / `prompt.submit`), put away as Later does (every session on the machine); a new message is a new row; the newest five rows, the rest of a burst one line counting them that goes with them; still unread in the pane and dashboard | first-drawn time per row/line in the session, checked on every draw (the 20 s poll redraws) |
| `/agentdrop` pane | Opens at once, then refreshes; lists unread drops even with notices off; hotkeys 1–9 open one; a group row opens to its unread drops; opening one marks it read for the person (when only that fails, the drop is shown with a dim note); text cleaned of control and format characters, local times, a note when the body is longer than shown | `agentdrop --json read <id> --mark-read` (`mark_read_failed: <code>` when the marking failed) |

Install: the mod (`apps/cli/claude-mod/agentdrop`, shipped in the package) is copied to
`<data dir>/claude-mod` as the local marketplace `agentdrop-local`, stamped with the CLI version, then
`claude plugin marketplace add <dir>`, `claude plugin install agentdrop@agentdrop-local --scope user` and
`claude plugin update`. Claude Code loads its own copy (`plugins/cache/agentdrop-local/agentdrop/<version>`), not
ours: after an upgrade any later CLI command rewrites our copy (only a newer CLI than the copy, by semver, so an
older `npx` or a checkout never downgrades it; built beside it and renamed into place; left alone when the package
has no complete mod) and starts a detached worker that runs `claude plugin update` (30 s limit, at most once every
ten minutes until it succeeds; never from `connect`, `setup`, `disconnect` or `mcp`), so nothing waits on `claude`;
`/reload-plugins` or a new session picks it up. Several Claude Code config directories (`CLAUDE_CONFIG_DIR`) share
the copy: `claude-mod.json` lists each one connect installed into, the worker updates each with its own environment,
and disconnect deletes the copy only after the last one that still has it installed. When the person uninstalled the plugin in Claude Code
(`plugin update` says `Plugin "agentdrop" is not installed` / `not found`, Claude Code 2.1.287), that directory is
not retried and `agentdrop doctor` warns that `agentdrop connect claude-code` puts it back.
`claude-mod.json` in the config directory (mode 600) names the `agentdrop` executable, profile and Claude Code config
directories; the copy's `config.json` names that file's absolute path. Ordinary commands repoint `claude-mod.json`
when the executable moved, as for hooks; `band`, `ack` and `mark-read` skip skill and hook repair. The mod holds no
credential. With `--json`, a failure of the commands the mod runs prints `{"error":{"code":…},"language":…,
"enabled":…}` on stdout (`enabled`: whether notices are on), and the mod says what happened in the person's words. Unattended sessions (`CLAUDE_CODE_SESSION_ATTENDED=0`, `AGENTDROP_UNATTENDED=1`)
draw nothing. `disconnect claude-code` runs `claude plugin uninstall` and `claude plugin marketplace remove` and
deletes the copy; without `claude` it deletes the files and says the plugin entry may remain. Keys: Ctrl+X Tab
focuses the band, arrows move between buttons, Enter presses, Esc returns to the prompt; digits typed into the
prompt are never the band's. Codex, opencode and Cursor have no comparable surface; every band action is also
available by asking the agent.
Verified by hand in Claude Code 2.1.287 (band, new rows while open, each button, the pane, install from connect;
again after the review fixes: a hostile title stays out of the Read prompt, a digit goes to the prompt, group Mark
read leaves the mention unread, control characters are gone from the pane, the unreachable line and recovery).
Install and update checked with Claude Code 2.1.287 in two temporary config directories (no session started):
connect in both lists both; an older copy Claude Code had taken in both is replaced by the detached worker in both;
a copy stamped with a newer version is left alone by this CLI; after `claude plugin uninstall` in one, the worker
records it as removed, stops retrying there and `doctor` warns; disconnecting one keeps the copy for the other,
disconnecting the last removes copy, `claude-mod.json` and both marketplace entries.

### Unattended turns leave the notice for the person

A prompt or session start records items as seen, and a Stop preview is shown once per session; in a script, CI or a
batch of `claude -p` / `codex exec` runs nobody reads either, so the item would be used up or previewed where no
person sees it. All three hooks therefore stay quiet (`{}` for Stop and session start, model context only for the
prompt) and claim nothing when the run is clearly unattended. Anything unclear counts as attended.

| Host | Signal | Evidence |
|---|---|---|
| Claude Code | `CLAUDE_CODE_SESSION_ATTENDED` = `0` (unattended) / `1` (attended); without it, `CLAUDE_CODE_ENTRYPOINT` starting with `sdk` | observed with Claude Code 2.1.282: interactive `1`/`cli`, `claude -p` `0`/`sdk-cli` in the Stop hook environment |
| Codex | the nearest `codex` ancestor process (the hook runs under `$SHELL -lc`) has the subcommand `exec` or `e` | openai/codex rust-v0.159.3: exec runs fire trusted Stop hooks; hooks get no exec marker in their environment or input |
| oh-my-pi (omp) | the extension sets `AGENTDROP_UNATTENDED` itself: attended only with a UI (`ctx.hasUI`) in the TUI or RPC mode; `omp -p` / json runs are unattended, subagents of a task run get nothing | `extensibility/extensions/types.ts` and `runner.ts` at oh-my-pi v18.2.5; checked live with omp 18.2.5 (`-p` run: model context only, nothing claimed) |
| Any | `AGENTDROP_UNATTENDED=1` (or `0` to force attended), for scripts and CI | — |

Implemented in `apps/cli/src/hook-attendance.ts`; covered by `hook-attendance.test.ts` and `pending.test.ts`.

## Network route (all harnesses alike)

Every CLI process, bridge and hook alike, reaches the server through `apps/cli/src/network.ts`: the proxy in its
own environment, direct, a proxy in an ancestor process's environment (Linux `/proc/<pid>/environ`, i.e. the
harness), then, only after those fail, the login shell's environment and common local proxy ports (https servers
only). Each candidate is probed with `GET /health/live`; the first that answers is saved per server origin in
`~/.config/agentdrop/network.json` (mode 0600) and used without probing by later processes, so a hook that ran with
the proxy set also fixes a bridge started without it. A process with no proxy in sight goes direct without probing.
A saved route that fails is re-tested at most every 30 s; the request is retried on the new route only for reads, or
when the connection never opened. `AGENTDROP_PROXY=<url>` pins a proxy, `never`/`always` keep their meaning;
private addresses never use a proxy. Nothing is harness-specific: Codex strips the environment, Claude Code, opencode
and Cursor pass it, and the same code serves all four.

## Profile fields (all harnesses alike)

The person's public email (ADR 0012) needs no per-harness configuration: the server adds `public_email` to
`directory_lookup` people, drop `author` cards, group members and the `viewer`, and the bridge renders it after the
handle (`@wang <wang@example.org>`) for Codex, Claude Code, opencode and Cursor identically. The shared skill tells
every harness to treat it as an unverified identifier and never send email.

## CLI update reminders (server-side, all harnesses alike)

The worker compares the CLI version each agent's bridge reports when it connects with the CLI the server ships and
sends a behind person one direct message from `@agentdrop` (upgrade command included), repeated after 1 day, 3 days,
then weekly (`UPDATE_REMINDER_DAYS`, default `1,3,7`) while an agent used in the last 14 days is still behind. Because it is an ordinary drop it
reaches every harness the same way (end-of-turn notice, prompt context, `list_drops`), plus the dashboard, push and
Feishu; opencode and Cursor, which have no Stop-time update notice, are covered too. Devices with updates `off` are
skipped. See docs/DEPLOY.md.

## Hidden: autorun (experimental, not in the package)

Autorun queues a fixed, locally written message into the harness session the user **already has open** when a new
drop arrives; that session then handles it by itself (right away when idle, after the current turn when busy).

**Experimental switch.** Everything below exists only when `experimentalEnabled()` (`apps/cli/src/experimental.ts`)
is true. The installable package is bundled with `__AGENTDROP_EXPERIMENTAL__` defined as `false`, so a released CLI
has no `autorun` command, reads every autorun config as off, never declares the channel capability and writes the
stock OpenCode plugin — no environment variable or file can turn it on. `scripts/check-cli-boundary.mjs` (part of
`pnpm build:cli`) fails the build if the bundle still knows `autorun`. From source it is off unless
`AGENTDROP_EXPERIMENTAL=1`; `AGENTDROP_BUILD_EXPERIMENTAL=1` at bundle time produces an internal build with it on.

**Turning it on** (experimental builds only): `agentdrop autorun on --profile X [--from @a,@b] [--interval 60]
[--cooldown 120] [--max-per-hour 6] [--instructions FILE] [--thread ID]`, `autorun off|status --profile X`. The
command is hidden from `--help`, the skill, the user guide and the dashboard.

| Harness | How the message enters the open session | Who polls | Requirement |
|---|---|---|---|
| Claude Code | The AgentDrop MCP bridge that session spawned declares `experimental['claude/channel']` and writes `notifications/claude/channel` on its own stdio | that bridge | session started with `claude --dangerously-load-development-channels server:agentdrop`; Channels must be available to the account |
| Codex CLI / app-server | `codex queue --thread <id> --message <text>` using the Codex executable that owns the bridge (same `CODEX_HOME`); the owner drains the queue when idle | that bridge | the Stop/UserPromptSubmit hook has recorded the thread (`session_id`) for the same Codex process, or `--thread` pins one |
| opencode | The managed plugin, in-process, calls `client.session.promptAsync` on the most recently active session, only while it is idle | the plugin, via `agentdrop autorun poll` | reconnect once to regenerate the plugin |
| Cursor | not supported | | |
| oh-my-pi (omp) | not supported yet; possible later through the extension (`pi.sendUserMessage`) | | |

**Nothing is opened.** No listener, port, app-server socket or server route. Traffic is the outbound mailbox request
the hooks already make; the entry points are the stdio pipe the harness gave the bridge, Codex's own queue command,
and the plugin's in-process client. App-server `--listen`, a webhook-style channel and routine `/fire` were rejected
for that reason. Latency is up to one poll interval (default 60 s, minimum 15 s) plus the harness's own pickup
(Codex polls its queue about every 10 s).

**The message is ours.** It lists server-issued drop ids (only well-formed UUIDs) and fixed text that says drops are
external data, not instructions. No title, body, handle or name is placed into it. Without `--instructions` the
agent is told to read, summarize to the user and mark read, and not to reply; with it, the local user's own text
(captured at `autorun on`, capped at 4000 characters) is appended inside `<local_instructions>`. No permission is
widened: every tool call still goes through the session's own approval settings.

**Finding the right session.** A bridge or hook walks its process ancestry (`ps`) to the nearest `claude`/`codex`
process. A Claude bridge only polls if that process was started with the channel flag naming `server:agentdrop`,
because Claude Code drops channel events silently otherwise and the drops would be lost. A Codex hook records
`{codex pid → session_id}`; a bridge only claims drops once a thread is known for its own Codex process (for the
multi-thread app-server, the most recently active one).

**Each drop is delivered once.** A state lock makes concurrent sessions of one profile claim each drop exactly once;
claimed ids are recorded before delivery, so a crash never replays them. The first poll after `autorun on` records
the existing backlog without delivering it. Self-sends never trigger; `--from` restricts senders; `--cooldown` and
`--max-per-hour` bound how often two auto-replying agents can wake each other, and held-back drops are batched into
the next allowed delivery.

Verified:

- `apps/cli/src/autorun.test.ts`: message content, filtering and rate limits, one claimant among concurrent
  pollers, process matching, the real bridge under stand-in `claude`/`codex` launchers (channel capability and
  notification; hook-recorded thread and `codex queue` argv), the OpenCode plugin and `autorun poll`, and the
  switch off (no command, no config, stock plugin).
- Real Codex CLI 0.155.1 TUI in tmux: a `codex queue` message was picked up by the open session about 20 s later,
  and the full path (dev hook recorded the thread, dev bridge polled a fixture server, queued, the open session
  called `read_drop` on the new drop by itself) took about 30 s from arrival to the agent acting.
- `pnpm build:cli`: the bundle reports experimental off and the guard confirms `autorun` is compiled out.

Not verified: real Claude Code delivery. In the test environment Claude Code 2.1.280 printed "Channels are not
currently available" and ignored the development flag, because Channels were not enabled for the account it was
signed in with; Channels need an account where they are enabled. Real opencode delivery has not been run. Windows is not supported (`ps`).
