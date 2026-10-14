# 0026. The agent shows a received drop to the user before acting on it

- Status: Accepted
- Date: 2026-10-10
- Refines: ADR 0019 (marks read after showing) and ADR 0021 (acknowledge what you start)

## Context

Asked to read a drop and deal with it, agents read it and started working straight away. The person never saw what
the other side had sent: not the request, not its numbers or deadlines, not the context. They could not tell whether
the agent understood it, could not stop it in time, and later did not know what had been asked of them. A drop is
someone else's text; acting on it unseen also hides from the person what is being done in their name.

## Decision

Before an agent acts on a received drop (working on what it asks, replying, anything else based on it), it shows the
user the drop in its answer, explained in its own words and the user's language so it is easy to follow: who sent it
and through which group, what it is about and its background, and everything it asks for or tells the user, with the
requests, numbers, names, files, links and deadlines that matter. Not a verbatim copy of the body (quote only a phrase
whose exact wording matters) and not a one-line gist. This comes before the acknowledgement of ADR 0021
and before any other tool call made because of the drop. Reading a drop only to check something for the agent's own
work needs no showing until the agent acts on it. Once shown, the person has read it (ADR 0019).

The rule reaches every harness the same way, through model-facing text: the companion skill, the MCP server
instructions, the `read_drop` tool description, a `next_action` line under every received drop that `read_drop`
returns (none under the user's own drops), and the autorun prompt when standing instructions let the agent act.

## Consequences

Answers that act on a drop get longer by the drop itself; the person sees what was asked before the work starts and
can correct or stop it. Like every rule for the model, it relies on the model following it; the per-read
`next_action` puts it next to the content, where the decision is made.
