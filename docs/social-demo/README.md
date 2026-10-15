# AgentDrop — 15-second social demo

[Watch the MP4](../images/agentdrop-social.mp4) · [Silent GIF](../images/agentdrop-social.gif)

An English, 1920 × 1080, 30 fps social edit: the human copy-paste relay → Wang's Codex sends → Alice asks
Claude Code to read → the same message and files in her inbox → AgentDrop and its GitHub repository.
The opening starts with the problem at frame zero. All explanatory copy is burned into the video for muted
viewing; the MP4 also has an original 120 BPM score and three synchronized action tones.

This is an **illustrative product walkthrough**, labeled throughout, with fictional people and experiment data.
The conversations are illustrations, not live model sessions. The inbox mounts the actual `MailboxPage` through
[the existing isolated demo adapter](../demo/dashboard.tsx), clicks the real message row and scrolls to the actual
attachment tiles. Wang and Alice are already contacts and have paired their clients. The message is already read
in the inbox because Alice requested and saw it in her agent. Files are shown as available, never auto-downloaded.

This edit covers the send/read/inbox workflow only. It does not demonstrate installation, other harnesses, groups,
or live cross-machine delivery. It supplements the [34-second README demo](../demo/README.md).

## Reproduce

Requirements: the repository's pinned Node/pnpm dependencies, Python 3, FFmpeg with `ffprobe`, and Google Chrome.
No API credentials, database or AgentDrop server are required. Use `E2E_CHROME` for a compatible Chrome executable.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec tsc -p docs/social-demo/tsconfig.json
node docs/social-demo/build.mjs
python3 docs/demo/audio.py --plan docs/social-demo/plan.json --output tmp/social-demo
node docs/social-demo/build.mjs --serve
```

With that preview running, in another terminal:

```sh
node docs/social-demo/render.mjs --stills
node docs/social-demo/render.mjs
```

The preview is at `http://127.0.0.1:4392`. Its console exposes `await seek(11.5)` and `playFilm()` (silent preview).
The export muxes `tmp/social-demo/master.wav`; playback of the MP4 includes sound.
`plan.json` owns chapter and action times; [DIRECTION.md](DIRECTION.md) records the visual direction and storyboard.
The existing React seek renderer supplies deterministic animation without adding a product dependency.
Intermediate frames and audio evidence stay in the ignored `tmp/social-demo/` directory.

## Verification and sources

The renderer checks forward/backward seeks, the disclosure, sender/reader receipts and repository CTA, and verifies
that both attachment names are inside the scrolling viewport during the final inbox hold. External browser
requests are blocked; page errors fail the export. All browser assertions run before the full frame export and
again as it advances. GIF: 960 × 540, 8 fps, full 15-second silent loop. MP4: H.264/AAC with fast-start metadata.

Visual review includes final encoded frames at 2 fps, transition strips at 10 fps, and full-size send/read/inbox
frames. The audio generator checks duration, loudness, true peak, ducking, asset hashes and action alignment;
these numerical checks do not establish listening quality. Human listening is not recorded as verified.
This production is not an end-to-end network interoperability test.

Feature sources: [user guide](../USER_GUIDE.md), [harness support](../HARNESSES.md),
[person-level state](../adr/0007-one-reader-per-account.md), and the actual
[mailbox](../../apps/web/src/pages/mailbox.tsx). Narrator workspace labels identify each fictional owner; the sender's
receipt names only Alice and never reveals her private receiving-agent metadata.

Assets: the repository logo, graphite/jade theme, installed Manrope and IBM Plex Mono fonts, Lucide icons and
original synthesized music from `../demo/audio.py`. No stock imagery, music or third-party fallback assets.
Original source/media follow the repository's Apache-2.0 license; fonts and icons retain their upstream licenses.
