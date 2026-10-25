# 0038. A reply can say where the asked-for work stands

- Status: Accepted
- Date: 2026-10-25
- Refines: ADR 0016 (replies name the drop they answer), ADR 0021 (acknowledge what you start)

## Context

ADR 0021 has an agent reply once when the user starts on a received request and again with the result. The
sender learns both only by reading prose: "on it", "done", "can't do this" and "which dataset?" all arrive as a
reply with a body, and the drop they sent shows a reply count and who replied, nothing more. Every comparable
system models this as state (A2A tasks, MCP tasks, LangChain's agent inbox decisions, Linear's agent sessions),
and people asked to see at a glance whether something they sent is in hand.

A server-side task engine with its own lifecycle was considered and rejected: AgentDrop has no threads by design,
nobody is obliged to answer, and a state machine that a remote agent could move would also be a way to push
prompts into someone's session (the A2A `INPUT_REQUIRED` phishing path).

## Decision

- **A reply may carry `payload.progress`**: `started`, `done`, `declined` or `needs_info`. Only together with
  `payload.reply_to` (VALIDATION_FAILED `progress` otherwise, nothing sent). Part of the content, so part of
  idempotency, like `reply_to`. It says where the work asked for in the answered drop stands, from the replying
  person's side; the body still says what and why.
- **Readers see it on the reply** as `progress` on the summary and the detail, for anyone who may read the reply.
- **The author of the answered drop sees it on their drop**: each entry of `replies.authors` gains that person's
  latest progress (the most recent of their readable replies that carries one). Same authorization as the reply
  count: only replies the viewer may read count. People only, never their agents (ADR 0013).
- **Notices name it** instead of the bare "replied to": "Wang started on your «X»", "finished", "declined",
  "needs more information about", on every surface that announces a reply (the agent notices, the model's prompt
  context, browser push, Feishu, the dashboard). A reply without progress reads as before.
- **The companion skill sets it** (ADR 0021): `started` on the acknowledgement, then `done` with the result, or
  `declined` when the user decides not to do it, or `needs_info` when the user needs something from the sender
  first. A reply to a drop that asked for nothing carries none.
- **Nothing moves by itself.** Progress is only what a person's reply says; there is no due date, no reminder, no
  transition rule and nothing the receiving side can be made to do. A later reply simply supersedes an earlier one.

## Consequences

- A sender sees "Wang: done" on the drop they sent and in the notice, without opening the reply.
- Old bridges ignore the new result fields; a bridge that does not know `progress` cannot send it, and its replies
  read as before. A server before this release refuses a payload with `progress` (the payload is strict, so
  VALIDATION_FAILED, nothing sent); the skill tells the agent to send the reply again without it.
- Progress is a claim by the replying person, like the body. It is shown as theirs ("Wang: done"), never as a fact
  the product checked.
