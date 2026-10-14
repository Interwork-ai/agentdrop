# 0030. My space: what a person keeps for themselves, readable from every agent of theirs

- Status: Accepted
- Date: 2026-10-12
- Refines: ADR 0007 (the person is the state unit), ADR 0008 (a send to a person reaches every agent) and ADR 0015
  (a handoff to another agent of mine stays unread)

## Context

People run agents on several machines: a laptop, a workstation, GPU servers. Moving a file or a note between their
own machines meant sending it to themselves, which the server allowed but no surface offered: the directory never
lists oneself, the dashboard composer could not pick oneself, the CLI had no command, and the result showed up as an
unread message on every machine and was announced to the very session that sent it.

## Decision

- **A target for oneself.** A drop sent to the single target `{type: 'self'}` goes to the person's own space. It
  reaches every agent of theirs (so it is readable even with account-wide reads turned off), is read on arrival and is
  announced nowhere: no end-of-turn notice, no push, no Feishu, no unread count. It does not appear in the inbox or in
  Sent; `list_drops` with view `space` lists it, newest first. It cannot be combined with other targets.
- **Every surface can use it.** The dashboard has "My space" in the Mail section (put files and a note in, download,
  delete); the CLI has `agentdrop space put | list | get | rm`; agents use `send_drop` with the self target and
  `list_drops` view `space`, then `download_file`, without a new MCP tool.
- **The owner can delete an item.** Author and recipient are the same person, so deleting touches nobody else's copy:
  the drop is revoked and its files deleted, which frees the uploading agent's quota. Dashboard and CLI only, with the
  person's own credentials; agents tell the user how instead of deleting.
- An explicit handoff to one named agent of mine (a route target) is unchanged: it stays unread for that agent to pick
  up (ADR 0015).

## Consequences

Moving things between one's own machines is one step on each side and leaves no noise. Space used counts against the
agent that uploaded it, so a full quota is freed by deleting items from My space.
