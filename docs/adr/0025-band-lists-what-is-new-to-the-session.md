# 0025. The Claude Code band lists what is new to the session, not everything unread

- Status: Accepted
- Date: 2026-10-08
- Refines: ADR 0023 (the band above the prompt) and ADR 0017 (seen in an agent)
- Refined by: ADR 0027 (a row stays two minutes, five at most)

## Context

ADR 0023 made the band a live list of everything unread, deliberately outside the seen record. People open several
Claude Code sessions in a row: the first showed its start notice and the band with its buttons; the second started a
minute later and listed exactly the same rows again, although nothing new had arrived. Since showing never marks a
drop read (ADR 0005, 0019), the same drops came back in every new session until the person read or put off each one.
That broke "a notice announces each item once".

## Decision

- The band of a session lists a drop only when it was not seen inside an agent before that session started: not
  seen at all yet, or first seen after the session started (by its own start notice or a prompt, here or in a
  session open at the same time). What an earlier session or another machine already showed is left to the
  `/agentdrop` pane, which still lists everything unread, and to the dashboard.
- "When first seen" comes from two sources. The account's seen record (ADR 0017) says whether; the CLI keeps a local
  log per account of when each drop was first recorded as seen on this machine (written by the start and prompt
  hooks when their claim adds it; hashes and times only, newest 1000). `agentdrop band` prints `seen_at` per drop:
  null not seen, 0 seen before anything this machine logged (another machine, or earlier), else the local time.
- The mod remembers when its session started; a drop first seen up to 15 s before that still counts as the
  session's, because its own start hook may record it a moment before the mod sees the start.
- A group row stands for the group's drops new to the session: its count, people, newest time and "Mark read" follow
  them; a group with none left has no row.
- Showing still marks nothing read. Data without `seen_at` (an older CLI, or a server without a seen record) lists
  everything, as before.

## Consequences

Opening another session no longer repeats what the person was just shown. A drop that arrives while several
sessions are open still appears in all of them until it is read or put off; once one session's prompt records it as
seen, sessions started afterwards leave it out. The status line and the hooks are unchanged.
