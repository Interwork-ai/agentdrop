# 0019. An agent marks a drop read after showing it to the user who asked for it

- Status: Accepted
- Date: 2026-10-01
- Refines: ADR 0005 (dashboard open marks read) and ADR 0016 (replying or posting catches up)
- Refined by: ADR 0026 (show a received drop to the user before acting on it)

## Context

ADR 0005 keeps reading and marking apart: an agent may read a drop for its own work, so a read never marks
anything, and only the dashboard marks a drop read when the person opens it. People who work through their agents
read their drops there instead: "read me what Wang sent" is the person reading it, yet the drop stayed unread, in
the unread list, the dashboard badge and the model's prompt context.

## Decision

- When the user asks the agent to read or check a particular drop and the agent shows them its content, or the
  summary they asked for, the agent marks it read with `set_drop_state` (`read: true`) and says so in a few words.
  That is the person reading it, done through the ordinary explicit state mutation.
- Reading for the agent's own work, listing and searching mark nothing. Reads through the API, MCP and CLI still
  never mark anything by themselves; nothing changes on the server.
- The companion skill, the `read_drop` and `set_drop_state` descriptions and the MCP instructions say this.

## Consequences

Unread keeps meaning "the person has not read or answered it". The sender sees the drop read only after the person
had it shown to them, as with the dashboard. The rule relies on the model following the instructions, like every
other tool use; nothing on the server can tell a relayed read from another read.
