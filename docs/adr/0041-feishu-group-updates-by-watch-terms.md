# 0041. Updates that bots post in Feishu groups, pushed to the members who watch for them

- Status: Accepted
- Date: 2026-10-31
- Refines: ADR 0039 (the server's own Feishu app), ADR 0007 (the person is the state unit), AGENTS.md rule 6

## Context

Teams keep Feishu groups where bots post what happens in their repositories: pull requests, pushes, CI runs,
releases. A busy repository posts dozens of messages a day, most of them irrelevant to any one person, so people mute
the groups and miss the few updates that concern their work. They want those few as soon as they are posted, in the
places they already look: their agent and Feishu.

The server's Feishu app (ADR 0039) already holds a WebSocket to Feishu. Once its bot is in a group and has the scope
for other bots' messages, Feishu pushes each bot message to the worker as it is posted.

## Decision

- **Source.** A member adds the AgentDrop bot to a Feishu group; adding a bot is a Feishu permission the group
  already controls. The bot posts one message saying what it does there. From then on the worker takes every
  message *a bot* posts in that group (`im.message.receive_v1`, `sender_type` other than `user`). Messages people
  write are ignored even when Feishu delivers them, so nobody's chat is read. The app needs
  `im:message.group_bot_msg:readonly` (other bots' messages in groups) and `im:chat.members:read`.
- **Watch terms.** A person who linked their Feishu account (ADR 0039) keeps a list of watch terms: up to 30 words
  or phrases, each 2–64 characters, such as a repository name, a directory, a ticket prefix or their own name. Set in
  the dashboard (Settings → Feishu) or with `agentdrop settings --feishu-watch` (an agent may run it when the person
  asks). Matching is a case-insensitive substring test over the message's text, title and link addresses; no model
  decides relevance on the server.
- **Who receives.** A person receives an update only if, at the moment it is posted, they are linked, have a term it
  matches, and are a member of that Feishu group (the worker asks Feishu for the member list, cached for two
  minutes). Nobody receives anything from a group they could not already read in Feishu.
- **Delivery.** Each match is a direct drop from the built-in @agentdrop assistant to that person, sent at once, like
  the CLI update reminders: it reaches the inbox, Feishu cards, browser push and the agents' notices through the
  existing paths, and expires after 30 days like every assistant drop. Its title names the group and the update's
  first line; its body says which terms matched, then the message text as received, its links, and a link to the
  group. `request_id` is `feishu-update:<message id>:<person>`, so a redelivered event sends nothing twice.
  At most 30 such drops per person per hour; the rest are skipped and counted in the log.
- **Nothing received is trusted.** The message text is external data in a drop body like any other; no surface
  executes it or follows instructions in it. Text is capped (8,000 characters) and control characters are removed.
- **Turning it off.** Remove the terms, unlink Feishu, or remove the bot from the group. A person who removed the
  assistant as a contact receives nothing (the send is refused, as for update reminders).

## Consequences

- Real time: an update reaches the people who watch for it seconds after the bot posts it, whether or not any of
  their computers are on.
- The update's text leaves Feishu for the AgentDrop server and is stored as a drop of each recipient (encrypted at
  rest when the server encrypts content, ADR 0010). It already left the repository host for Feishu.
- Relevance is only as good as the terms. Inferring interest from commits, CODEOWNERS or reviews, ranking with a
  model, reading Feishu documents and taking updates straight from GitHub or GitLab are not part of this decision.
- Only groups in the app's own tenant work (a self-built app); external groups need the app's external sharing.
