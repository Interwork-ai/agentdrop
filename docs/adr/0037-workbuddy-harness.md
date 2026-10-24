# 0037. WorkBuddy as the sixth harness, configured from a static reading of its bundle

- Status: Accepted
- Date: 2026-10-25
- Refines: ADR 0024 (one adapter per harness)

## Context

Tencent WorkBuddy is a desktop agent app with a large user base among people who work in WeCom, Feishu and
WeChat, which is where many AgentDrop users already are. It supports stdio MCP servers and SKILL.md skills, but
the public material on where it keeps them disagreed: articles named `~/.workbuddy`, an integration named
`~/.workbuddy-ai`, and one report found no hook firing on a Windows build. Writing a wrong file would at best do
nothing and at worst break the person's WorkBuddy, and no live WorkBuddy was available to try.

## Decision

The adapter rests on a static reading of the shipped code, without running it: the macOS bundles of WorkBuddy
5.8.3 (China edition) and WorkBuddy AI 5.8.4 (international) and the `@tencent-ai/codebuddy-code` 2.175.0 package.
Both bundles embed a reduced CodeBuddy Code CLI with its home directory moved, so WorkBuddy follows the CodeBuddy
CLI's rules (docs/HARNESSES.md, "WorkBuddy", lists each fact and its consequence):

- **Home.** `WORKBUDDY_CONFIG_DIR`, otherwise `~/.workbuddy`, or `~/.workbuddy-ai` when only it exists. The edition
  decides the folder, not the version; with both editions installed the China edition is connected.
- **MCP.** `mcpServers.agentdrop` in `<home>/mcp.json`, and in `<home>/.mcp.json` as well when that file exists,
  since the embedded CLI reads it first. WorkBuddy holds a server added in the file until the person trusts it;
  connect does not write that approval and tells the person to allow agentdrop once.
- **Skill.** `<home>/skills/agentdrop`.
- **Notices.** Claude Code's three command hooks in `<home>/settings.json`, with Claude Code's hook repair. The
  person's notice (`systemMessage`) appears in the WorkBuddy conversation; the model's context
  (`additionalContext`) reaches the model at session start and at each prompt.
- **Detection.** The home directory alone: WorkBuddy puts nothing on PATH.

`harness_key` gains `workbuddy` (expand-only migration); bridges from 0.5.9 read an unknown key as `other`, and an
older server makes `setup` say the server needs an update, as for omp.

## Consequences

- WorkBuddy gets the same three presence moments as Codex, Claude Code and omp, and the parity test holds it to
  that. What the code says has not been seen in a live session: `scripts/probe-host-hooks.mjs` installs a probe
  hook for each event, logs which ran from which file, and shows whether the messages appear. If a live run shows
  the hooks do not run, the adapter keeps MCP and the skill and the notices are taken out, like Cursor's and
  opencode's missing prompt context.
- A person whose WorkBuddy has custom MCP switched off in its security settings must switch it on; that default is
  set by WorkBuddy's cloud configuration, not by the bundle.
- Not supported: Windows (AgentDrop's CLI is macOS and Linux), connecting both editions at once, the WorkBuddy
  plugin and connector marketplaces, and WorkBuddy's own mailbox and Open API.
