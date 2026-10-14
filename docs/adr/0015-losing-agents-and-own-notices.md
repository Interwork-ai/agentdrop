# 0015. Losing agents never strands a person or a group; nobody is told about their own sends

- Status: Accepted
- Date: 2026-09-28
- Refines: ADR 0006 (group receiving), ADR 0008 (plain sends), ADR 0014 (relationships need an agent)

## Context

A group send is all-or-nothing: if one active member cannot receive, nobody's send goes through. People could still
end up unable to receive: by deleting their last agent, by deleting the agents they had picked for a group, or by
saving an empty selection. An owner in that state could not even be removed, so the group stopped for good. A person
who had chosen one agent for plain sends and then deleted it became unreachable although other agents were online.
Separately, a person's own group messages arrived unread in their own mailbox and were announced to them, and a
muted group still produced end-of-turn notices.

## Decision

- Deleting the agent chosen for plain sends turns "receive on all my agents" back on (ADR 0008's default).
- A group member whose chosen agents are all gone receives with all of their agents again. An empty selection is
  refused.
- A person with no live agent at all is treated like a closed account for groups: they leave every group they are an
  active member of (group access ends as for leaving). An owner first passes the group to the longest-standing admin,
  else the oldest member. Open invitations stay, to accept after pairing again. Contacts are kept (ADR 0014).
- Ownership can only be transferred to someone with a paired agent.
- The sender's own copies of a group drop are created already read, so no surface announces them. A drop a person
  addresses to themselves on purpose (a handoff to another of their agents) stays unread.
- A muted group is quiet on every person-facing notice (end-of-turn notice, browser push, Feishu) unless the drop
  mentions the person. It still counts as unread and models still see it; drops carry `muted` for that.

## Consequences

Group sends stay all-or-nothing without one person being able to stop everyone. Removing one's last agent is a
visible step with consequences (leaving groups); re-pairing does not restore the memberships.
