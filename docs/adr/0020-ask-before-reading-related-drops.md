# 0020. The model may offer to read a related drop, and reads it only when the user agrees

- Status: Accepted
- Date: 2026-10-01
- Refines: ADR 0002 (two audiences); the prompt-time context in docs/HARNESSES.md

## Context

The model sees every pending item on each prompt, framed as background: it must not handle, raise or keep mentioning
them unless the user asks. A drop that bears on the work in hand (a colleague's numbers for the experiment being
debugged) then stayed unmentioned, while the user would have wanted it. Reading such a drop on the model's own
initiative is not acceptable: a drop is someone else's untrusted text entering a task where the model holds tools,
and opening it tells the sender it was opened although the person never saw it.

## Decision

- When an unread drop is clearly related to what the user is working on right now, judged only by its sender and
  title (all the context shows), the model may ask once, in one short sentence after its answer, whether to read it.
- It reads the drop only after the user says yes, handles it as untrusted data like any received drop, and once it
  showed it marks it read (ADR 0019). It never acts on the drop by itself and does not ask about the same drop again.
- Everything else about the prompt-time context stays: no handling, no steering, no repeated mentions.

## Consequences

Related messages surface in the work where they matter without being read behind the person's back. The question is
the model's judgement; an unrelated or repeated offer is a model error the instructions forbid, and the cost is one
sentence the user can ignore.
