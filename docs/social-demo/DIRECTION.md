# AgentDrop — remove the human relay

## Brief and scope

A 15-second, English, 16:9 social video for X, based on a problem → send → requested read → inbox → brand
story. The only demonstrated surfaces are illustrated Codex CLI and Claude Code conversations, and the actual
web inbox component. Use the current checkout's documented behavior. People and experiment data are fictional;
contacts and paired clients are assumed. This is an illustrative product walkthrough, not a live model or
cross-machine recording. No publishing, live messaging, installation walkthrough or other campaign work.

## Direction choice

Three candidate directions:

| Direction | Light / type | Motif / camera | Transition / sound |
|---|---|---|---|
| Remove the human relay (chosen) | Graphite, bold editorial headlines | Human copy-paste chain, tight conversation cards | Match cut between file cards, 120 BPM plucked electronics |
| A parcel's journey | Pale paper, small monospaced labels | Files as parcels, continuous tracking shot | Spatial travel, soft percussive ticks |
| Two desks | Alternating light/dark, restrained captions | Two people in split-screen workspaces | Simultaneous panel updates, quiet ambient bed |

Choose the first because a two-second visible problem suits muted social viewing. It keeps one readable action
per shot. The previous 34-second film opens with a brand statement, uses a chapter strip, wide centered terminals
and a 96 BPM score. This version starts with the human relay, uses asymmetric close-ups without chapters, a routed
line background, persistent file positions across sender/reader cuts, and a faster score.

## Devices derived from the product

- Because this connects different people's agents, large owner labels explicitly say Wang's Codex and Alice's
  Claude Code; these are editorial scene labels, not private recipient metadata returned by the product.
- Because files and context travel together, the same two file cards occupy matching positions across send/read.
- Because a person must request a read, the receiving shot shows that prompt before the body appears.
- Because the inbox shares person-level state, the actual MailboxPage shows the already-read message, with the
  original sender and two attachment tiles. A real row click opens it using the isolated fixture transport.
- Because the product reduces manual relaying, the opening has a broken, stepped copy → chat → paste route, while
  the functional shots have a single jade route. Do not imply that notification timing is instantaneous.

## Frame design

1920 × 1080, 30 fps, 15 seconds. Graphite #0b0f10 and jade #75dcb5 come from apps/web/src/index.css. Manrope is
used for headings, IBM Plex Mono for filenames. Main headline 96–116 px; side headline 76 px; prompts 32 px;
file names 29 px; evidence/disclosure 24 px. Product component scaled 1.75× (14 px body becomes 24.5 px).
Horizontal safe margin 96 px. All essential content above y=940. Disclosure at y=1004. No small terminal dump.
Motion uses deterministic time-driven cubic ease-outs, 0.25–0.5 seconds, without spring bounce. The existing
React seek renderer is sufficient; no new animation dependency or product-code change is required.

## Shot table

| Time | Focal element | Picture and action | On-screen copy | Sound |
|---|---|---|---|---|
| 0–2 | Human relay | Headline readable at frame zero; copy, chat, paste cards illuminate in sequence between the two agents | Humans are still the API between AI agents. | Sparse opening pulses |
| 2–6 | Wang's send | Asymmetric headline and conversation; prompt appears, files are present, delivery confirmation at 4.1 | Send it to Alice. / Wang's Codex | Beat changes at 2; delivery chime at 4.1 |
| 6–10 | Alice's requested read | Match-cut file cards; read prompt first, original context appears at 7.5 | Pick it up in Claude. / Alice's Claude Code | New chord at 6; read chime at 7.5 |
| 10–13 | Actual inbox | Product component opens its real row at 10.5; framing moves toward body and attachments | Files + context, together. / Alice's inbox | Chord at 10; open chime at 10.5 |
| 13–15 | Product and repository | Jade field, logo and short slogan; source URL stays readable until last frame | AgentDrop · Open source / From your agent to theirs. / github.com/Interwork-ai/agentdrop | Resolve at 13, short tail fade |

## Feature evidence and limits

Sending files and context: ../USER_GUIDE.md; supported clients: ../HARNESSES.md. Web view:
../../apps/web/src/pages/mailbox.tsx and ../demo/dashboard.tsx. Person-wide reading: ../adr/0007-one-reader-per-account.md.
Other people's agent metadata stays private (ADR 0013); narrator labels are part of the fictional production.
The shared fixture never falls through to a server or downloads a file. No claims about delivery latency or
experiment accuracy are made; the experiment figures are fictional message content.

## Sources and licensing

Use only the existing logo, product stylesheet, installed Manrope/IBM Plex Mono fonts and Lucide icons.
No fallback artwork or downloaded stock audio. Original synthesized audio is generated by ../demo/audio.py;
font and icon upstream licenses remain applicable. Editorial direction is a production specification, not a
record of a private account, server or campaign operation.
