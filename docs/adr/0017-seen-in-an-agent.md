# 0017. Each item is seen once inside an agent, at a moment the person is there

- Status: Accepted
- Date: 2026-10-01
- Refines: ADR 0007 (one "already shown" record per account) and ADR 0009 (Feishu and push share that record)
- Details: docs/HARNESSES.md, "Seen in an agent"

## Context

People who work through agents should see every item that reaches them (drops, requests, invitations, join
requests, approvals) while they work, inside the agent session. The end-of-turn notice was announced once per
account and counted as soon as anything displayed it, and four things made that display miss the person:

- It appeared in whichever session ended a turn first. People run several sessions at once, so it often landed in a
  pane running a long task in the background; once shown there, no other session showed it again.
- Browser push and Feishu recorded the item in the same record. A push accepted by the push service, while the
  laptop slept or notifications were silenced, kept the item out of every agent session.
- A drop arriving during a long turn waited for that turn to end, wherever that was.
- The notice sat under the agent's long answer and scrolled away with the next prompt.

Both Codex (rust-v0.159.3) and Claude Code show a hook's `systemMessage` to the person at `UserPromptSubmit`,
`SessionStart` and `Stop`. Only the first two are moments the person is certainly at that session.

## Decision

- A separate per-account record, "seen in an agent", is written only at a presence moment: when the person submits
  a prompt or starts, resumes or clears a session (not a compaction). There the hook shows what is not seen yet and
  claims everything pending, atomically on the server. Browser push and Feishu never write it.
- The end of a turn still shows what is not seen yet, as a preview, once per host session; it claims nothing. When
  the person next types in that same session, the preview was right above the input, so those items are recorded
  as seen without being repeated. A prompt in another session shows them once.
- Claude Code gets an optional status line, `agentdrop statusline`, listing what is not seen yet (installed only when
  the person has none; never replacing theirs). It claims nothing.
- Unattended runs (scripts, CI, `claude -p`, `codex exec`) neither show nor claim anything.
- A seen claim also merges into the older shared record, so CLIs before this change and the push/Feishu cross-event
  dedupe treat the item as shown. Against an older server, CLIs keep the earlier end-of-turn behaviour.

## Consequences

Each item is still shown to the person once inside an agent ("a notice announces each item once"), but "once" now
means at a moment they are there, not wherever it first happened to print. A person may get a push and later the
same item in their agent; that is intended, push and Feishu reach them away from the agent. A preview may appear
in several sessions before the person types anywhere; each session shows it at most once. Cursor and opencode have
no presence moment yet, so their end-of-turn notices are previews once per conversation (Cursor) or machine
(opencode) until they get one. The model's prompt context is unchanged.
