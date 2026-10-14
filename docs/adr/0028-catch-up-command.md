# 0028. `/agentdrop-read`: catch up on messages, in detail where it matters

- Status: Accepted
- Date: 2026-10-12
- Refines: ADR 0019 (marks read after showing), ADR 0023 (the Claude Code mod) and ADR 0026 (show a drop before
  acting on it)

## Context

With dozens of unread drops, a person who wants to catch up has to phrase the request each time, and the result
varies: sometimes a list of titles, sometimes every drop retold at length. What they want is the count, the drops
that matter to the work in front of them in detail, and the rest in brief, optionally narrowed to one person,
group or project.

## Decision

- The companion skill (every harness) describes one way to catch the user up: list unread drops, and with a focus
  search for it (read or not); start with the count by person and group; read in full and explain in detail the
  drops that match the focus or bear on the work in the session (as ADR 0026 describes); summarize the rest in a
  line each, by person or group; mark read only the drops explained in detail; act on or reply to none of them
  until the user says so.
- In Claude Code with the mod, `/agentdrop-read [words]` submits that request as the person, in their language. The
  words after the command are the person's own (a person, group, project or anything else to focus on); they are
  cleaned to one line and capped at 300 characters, and nothing anyone else wrote is added to the prompt (ADR 0023).
  The command runs as a prompt, so Claude does the reading with the MCP tools; nothing is read before the person
  types it (ADR 0020). Only the person's own gesture runs it (typed at the terminal or sent through Remote Control);
  a run from anything else submits nothing. Its description follows the person's language once the first refresh
  tells it.
- Other harnesses have no command surface the mod's way; asking the agent to catch up gives the same behaviour
  through the skill. In Codex, custom prompts became skills and a skill is called by `$name` in the message, so
  `$agentdrop` followed by the request ("catch me up, focus on …") loads the skill explicitly.
- Every harness's people notice (Stop / idle, opencode toast) ends its overflow line with a pointer to this: "N more
  new messages not listed; ask your agent to catch you up". It names no tool or command, so it reads the same in
  every host.

## Consequences

Summarized drops stay unread, so they are still in the pane, the dashboard and later catch-ups; only what the person
was actually shown in detail counts as read. The quality of "bears on the work in this session" is the model's
judgement; a focus makes it explicit.
