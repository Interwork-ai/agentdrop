# Architecture decision records

One file per decision that is expensive to reverse or easy to forget, in the
[MADR](https://adr.github.io/madr/) shape: context, decision, consequences. Number them in order
(`NNNN-short-title.md`), never renumber, and never edit an accepted record's decision — supersede it with a new
record and set the old one's status to `Superseded by NNNN`. Link the record from the code or doc it governs.

| # | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-two-audiences.md) | Text for people and text for models are written separately | Accepted |
| [0003](0003-experimental-switch.md) | Experimental features sit behind one build-time switch | Accepted |
| [0004](0004-compatibility-and-migrations.md) | Client/server compatibility window and expand-only migrations | Accepted |
| [0005](0005-dashboard-open-marks-read.md) | Opening a drop in the dashboard marks it read | Accepted |
| [0006](0006-groups-receive-with-all-agents.md) | Groups receive with all of the member's agents by default | Accepted |
| [0007](0007-one-reader-per-account.md) | All agents of an account are one reader | Accepted |
| [0008](0008-direct-sends-reach-all-agents.md) | A plain send to a person reaches all of their agents | Accepted |
| [0009](0009-feishu-group-bot-notices.md) | Feishu notices go through a group-bot webhook, sent by the server | Accepted |
| [0010](0010-content-encryption-at-rest.md) | Message content is encrypted at rest with server-managed envelope keys | Accepted |
| [0011](0011-agent-take-over.md) | An agent can take over another agent of the same account | Accepted |
| [0012](0012-public-email.md) | A person can publish one email on their profile | Accepted |
| [0013](0013-people-only-external-identity.md) | Other accounts see people, not their agents | Accepted |
| [0014](0014-relationships-need-an-agent.md) | Relationships need a paired agent | Accepted |
| [0015](0015-losing-agents-and-own-notices.md) | Losing agents never strands a person or a group; nobody is told about their own sends | Accepted |
| [0016](0016-replies-and-catching-up.md) | A drop may name the drop it answers; a person's own reply or group post marks what it answers read | Accepted |
| [0017](0017-seen-in-an-agent.md) | Each item is seen once inside an agent, at a moment the person is there | Accepted |
| [0018](0018-mark-all-read.md) | A person can mark everything read at once | Accepted |
| [0019](0019-agent-marks-read-after-showing.md) | An agent marks a drop read after showing it to the user who asked for it | Accepted |
| [0020](0020-ask-before-reading-related-drops.md) | The model may offer to read a related drop, and reads it only when the user agrees | Accepted |
| [0021](0021-acknowledge-what-you-start.md) | When the user starts on a received request, the agent tells the sender | Accepted |
| [0022](0022-group-history-visible-to-members.md) | The group owner decides whether new members can see earlier messages | Accepted |
| [0023](0023-claude-code-mod.md) | In Claude Code with mods, what is waiting is a live list above the prompt | Accepted |
| [0024](0024-harness-adapters-and-omp.md) | One adapter per harness, and oh-my-pi (omp) as the fifth | Accepted |
| [0025](0025-band-lists-what-is-new-to-the-session.md) | The Claude Code band lists what is new to the session, not everything unread | Accepted |
| [0026](0026-show-a-drop-before-acting-on-it.md) | The agent shows a received drop to the user before acting on it | Accepted |
| [0027](0027-band-rows-stay-two-minutes-and-on-it-shows-the-drop.md) | Band rows stay two minutes, five at most; "On it" shows the drop it answers | Accepted |
| [0028](0028-catch-up-command.md) | `/agentdrop-read`: catch up on messages, in detail where it matters | Accepted |
| [0029](0029-group-file-space.md) | Every group has a file space; a full group refuses files, an admin frees space | Accepted |
| [0030](0030-my-space.md) | My space: what a person keeps for themselves, readable from every agent of theirs | Accepted |
| [0031](0031-quieter-model-context.md) | The model gets the pending list when it changes, not on every prompt | Accepted |
| [0032](0032-terminal-read-marks-read.md) | Reading a drop in a terminal marks it read | Accepted |
| [0033](0033-own-group-posts-not-in-inbox.md) | What a person posts to a group stays out of their own inbox | Accepted |
| [0034](0034-invitee-connected-on-first-pairing.md) | Someone who opened an invite link before pairing is connected once they pair | Accepted |
| [0036](0036-account-recovery-without-email.md) | Getting back into an account from a paired device or a recovery code, without email or an administrator | Accepted |
| [0037](0037-workbuddy-harness.md) | WorkBuddy as the sixth harness, configured from a static reading of its bundle | Accepted |
