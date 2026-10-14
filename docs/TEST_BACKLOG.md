# Test backlog

What is not automated yet, graded by effort, and what is being written. The policy is in [QUALITY.md](QUALITY.md);
this file is the work list behind its §10. Effort: **S** = hours, reuses an existing harness; **M** = a day or a new
harness piece; **L** = needs outside systems, credentials or money. Update the status in the same commit as the test.

## Where coverage stands (2026-09-30)

| Area | Covered by | Thin spots |
|---|---|---|
| Domain rules, API routes, authorization, idempotency | 33 API integration test files on real PostgreSQL, contracts drift checks | none known |
| CLI, hooks, harness config edits, network route | 24 CLI test files, `verify:cli` on Node 22/24, release package smoke | real harness sessions (manual) |
| MCP bridge | `packages/mcp` unit test, `tests/mcp-bridge.test.ts` | tool-by-tool result wording for models |
| Worker (outbox, push, Feishu, webhook, assistant) | 7 test files with fakes | real push/Feishu delivery (manual) |
| Dashboard | 3 unit tests (error text, i18n coverage, request id) + 6 browser journeys, 326 steps over both contexts (`pnpm e2e`, about 35 s) | admin suspend/close, group ownership transfer and member removal, invite-link revoke/expiry, approvals |
| Live servers | `pnpm smoke:live` with QA accounts after every deploy | no schedule |

## Easy (S): browser journeys on the existing harness

Each is one file in `scripts/e2e/journeys/`, seeded through the API, run in both secure and plain-http contexts.

| Journey | Steps | Status |
|---|---|---|
| `core` | sign in/out, inbox, open + star on a slow network, Reply, sent/archived, compose + send, Send a drop, invite link, group timeline, agents, approvals, settings, help, admin, language, accept contact, pairing banner, `/pair` | done |
| `reply` | Reply from a drop: recipient, "Replying to", "Re:" prefilled; original read for the replier; posting in a group marks earlier group drops read and leaves others' state; "Reply to «…»" opens the original, which shows "1 reply from …"; sent-list indicator (ADR 0016) | done (9 steps, both modes) |
| `mailbox` | search, Unread filter, mark as unread, archive/unarchive, forward, long body "Next part", **attachment upload and download** (bytes match, HTML never rendered) | done (38 steps, both modes) |
| `contacts` | invite by @handle, decline, withdraw, accept, private note persists, block/unblock, remove, **sign-up through an invite link** (ADR 0014), existing person opens a link | done (60 steps, both modes) |
| `groups` | create with invites, accept choosing receivers, decline, write to the group with an @mention, mute, rename + slug, make admin, leave, join request | done (64 steps, both modes; found 2 bugs, fixed) |
| `account` | rename agent, receive-only-here, delete agent (ADR 0015 wording), nickname/email/theme/language persist, admin password-reset link used end to end, sign-up form, wrong password, forgot password | done (46 steps, both modes) |
| `mobile` | phone viewport: list → drop → back, bottom navigation, menu drawer, compose + send, no horizontal overflow; light theme renders the key pages with readable text | done (66 steps, both modes) |
| `mark-read` | "Mark this group read" in a group's view marks that group only; "Mark all as read" clears the rest; the count and the button follow | done (found the millisecond cut-off bug, fixed) |
| `push-click` | notification click opens the drop in a controlled tab and in an uncontrolled one (hard reload), a notice pointing outside the dashboard opens the inbox, the page ignores foreign paths; plain http works without a worker | done (found the uncontrolled-tab bug, fixed) |

## Easy (S): other layers

| Test | Layer | Status |
|---|---|---|
| `newRequestId` without `crypto.randomUUID` (plain-http regression) | web unit | done (`apps/web/src/lib/api.test.ts`) |
| Pairing start limit per address (the journeys raise it to seed) | API integration | done (`apps/api/src/pairing-limit.test.ts`) |
| Every dashboard page string pair has both languages | web unit | done (`i18n-coverage.test.ts`) |
| Live smoke uploads and downloads a small attachment between the QA accounts | live acceptance | todo |
| CI job summary lists failed journey steps with screenshots as an artifact | CI | done for `e2e` (screenshots artifact) |

## Found by these journeys

- "Write to the group" only typed the slug into the recipient search instead of choosing the group (fixed: the group
  page addresses `?to=#slug`, the composer selects the group).
- Leaving a group refetched the group just left and logged a 404 (fixed like Decline: navigate, drop the cache).
- Accessibility note, not fixed yet: the group receive picker nests labels, so its first radio's accessible name
  contains the whole group of options.

## Medium (M)

| Test | Why it is more work | Status |
|---|---|---|
| Accessibility scan (axe-core) on the key pages in both themes | new dependency, triage of existing findings | todo |
| Approvals end to end: an agent send that needs approval, approved and rejected in the dashboard | needs an H credential in the journey (pairing poll) and a send that triggers approval | todo |
| Stop / prompt hook outputs from the real CLI against the e2e server, per harness | spawn the built CLI with a paired profile in a temp config dir | todo |
| MCP tools through the real bridge against the e2e server (list, read, send, state) | spawn `agentdrop mcp` with a paired profile; partly in `tests/mcp-bridge.test.ts` | todo |
| Worker notices end to end with a fake Feishu/webhook receiver | run the worker next to the e2e API | todo |
| Scheduled live smoke on public servers (GitHub Actions cron, QA credentials as a secret) | secret management; a server reachable only from a private network cannot be probed from GitHub | todo |
| Branch protection with required checks `verify`, `cli`, `e2e` on `main` | changes how releases are cut (no direct pushes) | todo, a project policy decision |
| Visual regression of key pages | screenshot baselines are brittle across fonts/OS; do after axe | later |

## Hard (L)

| Test | Blocker |
|---|---|
| Real Codex / Claude Code / opencode sessions in CI | model API keys and cost; stays in the per-release manual checklist (QUALITY.md §6) |
| Real browser push delivery | needs a real push service and a subscribed browser |
| Real Feishu delivery | needs a Feishu app and tenant |
| Load and soak tests | a production-sized dataset and a separate environment |
