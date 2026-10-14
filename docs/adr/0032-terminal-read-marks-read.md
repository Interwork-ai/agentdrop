# 0032. Reading a drop in a terminal marks it read

- Status: Accepted
- Date: 2026-10-13
- Refines: ADR 0005 (dashboard open marks read) and ADR 0019 (an agent marks a drop read after showing it)

## Context

ADR 0005 and ADR 0019 cover the two places a person reads a drop: the dashboard, which marks it read when it is
opened, and an agent, which marks it read after showing it to the user who asked. The third place stayed out:
`agentdrop read <id>` in a terminal. A person who read a drop there still found it unread in the dashboard badge,
in every agent's notices and in `agentdrop inbox`, and had to add `--mark-read` or mark it again elsewhere.

The same command is also run by programs: scripts, CI jobs, the Claude Code mod (which passes `--mark-read`
itself) and agents calling the CLI through a shell tool, which read for their own work. Those must keep the rule of
AGENTS.md semantic 2: a read never marks anything by itself.

## Decision

- `agentdrop read` marks an unread drop read when a person reads it at a terminal: plain text is printed, both stdin and
  stdout are an interactive terminal (a TTY), and it runs outside a known agent shell (`CLAUDECODE=1`, `OPENCODE=1`,
  `CODEX_SANDBOX`, or `AGENTDROP_UNATTENDED=1`). Agent shell tools rarely give a command a terminal on stdin, so the
  stdin check also covers harnesses that set no marker. It uses the ordinary explicit state mutation (`PATCH …/state` with `read: true` and the
  `state_version` just read, as `set_drop_state` does), and says so in one line in the person's language.
- Nothing is marked when stdout is not a terminal (a pipe, a file, a shell tool), with `--json` (output for
  programs), with `--keep-unread`, for a drop that is already read, or for a drop none of the person's agents
  received (sent only, or readable only as group history): that drop is printed and nothing else happens, no error.
- `--mark-read` keeps forcing it anywhere (the Claude Code mod relies on it); it cannot be combined with
  `--keep-unread`.
- Nothing changes on the server, the API or MCP: `read_drop` still never marks anything, and the rule lives in the
  one CLI command a person reads with, as ADR 0005 put the dashboard's rule in the dashboard.

`agentdrop send` (the terminal and CI counterpart to `send_drop`) and the setup offer to allow the current folder for
uploads came in the same change; they follow existing rules (directory resolution, the upload allowlist and the
sensitive-file rules, idempotent request ids) and need no decision of their own.

## Consequences

Unread keeps meaning "the person has not read it", wherever they read. A person who wants to look without
marking adds `--keep-unread`. Detection is a heuristic: an agent that runs commands in a pseudo-terminal without one
of the markers would mark what it reads; such an environment should set `AGENTDROP_UNATTENDED=1`, as it already
should for end-of-turn notices.
