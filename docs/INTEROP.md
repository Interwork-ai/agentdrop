# Real-client interoperability record

Date: 2026-09-17. Single machine (macOS), two accounts, two paired endpoints, one local API.
This is the PR-03 acceptance "Codex → Claude Code and Claude Code → Codex on real clients". It is **not** a
two-machine / two-network test; that remains open (see "Not tested").

| Component | Version |
|---|---|
| Codex CLI | codex-cli 0.154.0 |
| Claude Code | 2.1.274 |
| Node.js (bridge) | v23.11.0 (Node 24 LTS is the release target) |
| MCP TypeScript SDK | @modelcontextprotocol/server 2.0.0 / client 2.0.0 |
| PostgreSQL | 17.9 (local install) |
| AgentDrop | 0.2.0-dev, commit of this file |

## Setup

- API: `pnpm dev` on `http://localhost:3210`, dashboard via Vite on `http://localhost:5173` (proxying `/v1`, `/api`).
- Alice: signed up in the browser, then `agentdrop login` + `agentdrop endpoint add --harness codex --profile codex
  --label 小码`; the pairing code was approved on the dashboard `/pair` page (default receiver = 小码).
- Bob: signed up via API, `agentdrop endpoint add --harness claude-code --profile cc --label 科研助手`, approved via API.
- Alice invited @bob in the dashboard; Bob accepted; Alice set the private remark "老王·实验合作".
- Neither contact was marked auto-approve, so first sends went through the browser approval page.
- Client configs were passed per invocation (`codex exec -c mcp_servers.agentdrop…`, `claude -p --mcp-config …
  --strict-mcp-config`) with `AGENTDROP_CONFIG_DIR` pointing at throw-away profile directories, so no user-level
  Codex/Claude configuration on this machine was modified.

## Run 1: Codex (Alice) → Claude Code (Bob)

Prompt to Codex: look up "老王" with `directory_lookup`, then `send_drop` with request_id `codex-walk-001`.

Codex output (verbatim last message):

```
outcome: needs_approval
request_id: codex-walk-001
approval_url: http://localhost:5173/approvals/8839487b-e38d-4bc2-8fbf-945ea65b41c0
```

Alice approved on the dashboard ("批准并投递" → "已投递。"). Then Claude Code as Bob:

```
TITLE=训练不稳定排查结论 FROM=Alice (@alice) BODY=已经排除数据顺序；还需验证梯度累积设置。 READ_AFTER=true VIEWER=科研助手
```

Database after the run: one delivery to 科研助手 with `read_at` set and `state_version = 1`; audit trail
`drop.send (needs_approval) → approval.approve → drop.send (delivered) → drop.read`. Bob's bridge registered a
connection with `client_name = claude-code`; Alice's with `codex-mcp-client 0.154.0`.

## Run 2: Claude Code (Bob) → Codex (Alice)

```
OUTCOME=needs_approval REQUEST=cc-walk-001 APPROVAL=http://localhost:5173/approvals/25a35fd0-…
```

Bob approved via the API (`{"status":"delivered"}`). Codex as Alice:

```
TITLE=回复：梯度累积 FROM=老王·实验合作 (@bob) BODY=我这边 batch 8 复现了；建议先固定 seed。 VIEWER=小码
```

Note the author label: Alice's private remark ("老王·实验合作") is applied in her own view only; Bob's run above saw
"Alice (@alice)".

## Observations

- Both clients loaded the seven-tool `standard` toolset from the bridge and called tools with schema-valid input on
  the first attempt; no retries were needed.
- `codex exec` was run with `-s read-only`; the MCP bridge does not need filesystem access for text drops.
- Claude Code required `--allowedTools mcp__agentdrop__…` (or a permission mode) in headless mode; interactive use
  prompts per tool as usual.
- Token usage reported by Codex for run 1: 39,711 (prompt + tool schemas + results).

## Not tested

- Two machines on different networks (SSH/remote GPU host as a separate Device).
- Interactive sessions with tool search / lazy loading enabled.
- Attachments through the real clients (the bridge file tools are covered by the black-box MCP test only).
- Windows.

## Cursor MCP adapter smoke (2026-09-19)

The locally installed Cursor CLI `2025.09.18-7ae6800` successfully loaded AgentDrop via
`cursor-agent mcp list-tools agentdrop`: all five core tools were returned and the shared bridge registered one
connection. The configuration was produced by `agentdrop connect cursor`, using an npm-installed tarball and an
isolated HOME with a fake local HTTP API/profile. The MCP child used the normal user config layout; no real user
credentials or messages were involved. Cursor filters custom inherited environment variables, so custom
`AGENTDROP_*` locations must be supplied explicitly in the MCP entry's `env` if needed.

This verifies host config loading, MCP initialization and tool discovery in that installed CLI version. It does
not verify model-driven tool calls, real users exchanging messages, current Cursor IDE Skills discovery, or
Cloud/SSH environments. Shared stdio tests separately cover both toolsets for the four harness identities.

## OpenCode global plugin load smoke (2026-09-19)

OpenCode CLI `1.3.0` loaded the generated global `agentdrop.js` plugin through `opencode debug config` with an
isolated HOME/XDG config root. This verifies the managed plugin is valid JavaScript and discoverable at the
documented global plugin path. Unit tests separately verify `session.idle`, throttled CLI invocation, TUI toast
arguments, MCP config preservation, idempotent replacement and scoped removal. A real TUI `session.idle` event and
visible toast have not yet been exercised against a live model session.

## oh-my-pi (omp) live smoke (2026-10-02)

omp `18.2.5` against a local AgentDrop server built from this tree, with a profile paired through `agentdrop endpoint
add --harness omp` in isolated CLI directories. `agentdrop connect omp` wrote the MCP entry and the managed
extension into a relocated agent directory (`PI_CODING_AGENT_DIR`); omp itself ran with its normal configuration from
a temporary project whose `.omp/mcp.json` was that entry, with `--no-extensions -e <generated extension>` and a small
fast model. A second person sent the drops.

- `omp -p --no-session --mode json "…"` (stdin closed: omp reads piped stdin as the prompt): the extension ran
  `pending --hook-output prompt-context` once, marked unattended; the model named the sender and title from the
  injected context without a tool call. Asked to use `list_drops`, it read `xd://mcp__agentdrop_list_drops` and
  called it through the bridge; the result listed the drop. No session-start or end-of-turn call was made.
- TUI in tmux: starting omp showed "AgentDrop: new … @wang · "Split C numbers for the paper"" (session start); a drop
  sent before the next prompt appeared under that prompt; a drop sent while the model was answering appeared after
  the answer (end-of-turn preview) and was not repeated at the next prompt; the model listed all three titles from
  its context. The saved session file holds no AgentDrop context entry (the context goes into the turn's system
  prompt).
- After `/new`, a notice shown at once was replaced by omp's own "New session started" line while the items were
  recorded as seen; the extension therefore no longer handles `session_switch`, and the next prompt showed the
  waiting drop (re-run after the change).
- The bridge was a 0.5.8-versioned build, so the server's compatibility rule showed the own agent as `[other]`.

Not tested: other omp versions, RPC/ACP modes, named omp profiles, Windows.
