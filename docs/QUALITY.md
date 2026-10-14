# Quality: tests, gates, acceptance

AgentDrop is run as a professional product: nothing reaches a live server that has not been proven the way a person
will use it, on the configuration that server actually has. This file says which checks exist, which ones gate what,
and what a person still checks by hand. It is binding for every contributor, human or agent (see `AGENTS.md`).

Why it exists: unit and API tests can all pass while a page breaks in the browser. The dashboard must work on a
plain-http origin as well as on https: a deployment reachable only over plain http has no secure-context APIs (for
example `crypto.randomUUID`), and only a check that opens the page in a browser on that origin sees the difference.
The practices below follow the sources listed at the end.

## 1. Layers

A pyramid, not an ice-cream cone: most behaviour is proven in fast, hermetic tests; a few browser journeys prove
that the pieces work together; live checks prove the deployment. A failure found at a high layer gets a test at the
lowest layer that can reproduce it (§7).

> Basis: Google's 70/20/10 guidance and the "ice-cream cone" anti-pattern (Google Testing Blog, *Just Say No to
> More End-to-End Tests*); hermetic small tests and larger tests for fidelity such as deployment configuration
> (*Software Engineering at Google*, ch. 11 and 14); "push tests down the pyramid" (Vocke, *The Practical Test
> Pyramid*).

| Layer | What it proves | Command | Where it runs |
|---|---|---|---|
| Static | formatting, lint, types, generated contracts and migrations are current | `pnpm lint`, `pnpm typecheck`, `pnpm contracts:check`, `pnpm db:check` | every commit, CI `verify` |
| Unit | domain rules, formatters, CLI logic (network route, hooks, config edits) with injected dependencies | `pnpm test` | every commit, CI `verify`, `cli (22/24)` |
| Integration | API routes and domain use-cases against real PostgreSQL (`TEST_DATABASE_URL`, one database per worker; tests that need it say so when skipped); all unit + integration files together about 30 s locally | `pnpm test` | every commit, CI `verify` |
| Package | the published CLI bundle installs, and a real MCP stdio handshake works | `pnpm verify:cli`, release workflow | CI `cli`, every tag |
| Browser journeys | the built dashboard + API + PostgreSQL in Chrome, every key journey, **as a secure context and on a plain-http origin** (about 35 s locally) | `pnpm e2e` (`scripts/e2e/run.mjs`) | CI `e2e`, before every release |
| Live acceptance | the deployed server, signed in as the fixed QA accounts, key journeys on that server's real origin | `pnpm smoke:live <target>` (`scripts/live-smoke.mjs`) | after every deploy, on every live server |
| Harness interop | Codex, Claude Code, opencode really load the bridge, hooks and skill | `docs/INTEROP.md` procedure | per release, manual (§6) |

## 2. Key journeys

These are the paths a person or agent must never find broken. `pnpm e2e` covers all of them in both contexts;
`pnpm smoke:live` covers the ones marked **L** on a live server.

- Sign in (**L**), sign out (**L**), switch language (**L**).
- Inbox (**L**), open a drop, star it right after opening on a slow network (**L**, without the delay), Reply
  from a drop into the composer (**L**), sent (**L**), starred, archived (**L**).
- Reply: "Replying to" in the composer, "Reply to «…»" and the reply count on the other side, the original marked
  read for the replier; posting in a group marks its earlier drops read (ADR 0016).
- Compose from the navigation, pick a recipient, send, "Delivered", Send another (**L**).
- Contacts: open a contact, "Send a drop" (**L**), create an invite link, accept a contact request.
- Groups: open a group, its timeline, members (**L**), "Write to the group" (**L**).
- My agents (**L**), approvals (**L**), settings (**L**), help (**L**), admin.
- A person without an agent: the pairing banner, the composer's explanation, approving a device on `/pair`.
- Server: `/health/live` version, `/health/ready` database + storage, hosted CLI tarball (**L**).

**Rule:** a change that adds a key page, button or flow adds its step to a journey in `scripts/e2e/journeys/` (and to
`scripts/live-smoke.mjs` when it can run on live data without touching real people) in the same commit. Locators
are what a person sees: roles, labels, visible text; never CSS classes.

> Basis: end-to-end tests only for the journeys that carry the product's value (Vocke); user-facing locators, test
> isolation, the same suite across environments via projects/base URLs (Playwright *Best practices*, *Locators*,
> *Projects*); the two origins exist because configuration is a leading cause of outages (*SWE at Google*, ch. 14).

## 3. Gates

| Moment | Must pass | Blocks |
|---|---|---|
| Commit | `pnpm verify` (lint, typecheck, contracts, db drift, all tests, build); `pnpm e2e` when `apps/web`, `apps/api` routes or `packages/contracts` changed | the commit |
| Push to `main` / pull request | the CI jobs its changes need (`scripts/ci-changes.mjs`): `hygiene` always; `verify` for any code; `cli (22)` for the client; `e2e` for the dashboard, the API and what lies under them; dependencies, toolchain or workflow changes run everything | the next release |
| Release (`pnpm release X.Y.Z`, patch by default) | `pnpm verify` locally (the script runs it); the last CI run on `main` green | the tag |
| Release tag | `server-artifacts`: every CI job (`verify`, `cli (22, 24)`, `e2e`) on the tagged commit, then the image and runtime tarball from it | the image |
| Deploy | the release tag's `server-artifacts` run green; the image it built; pre-deploy database backup taken by the deploy script | the deploy |
| Deploy done | `pnpm smoke:live <target> --expect-version X.Y.Z` green for every live server; result recorded in the deployment log | reporting the deploy as done |

A push compares with the head of the last green CI run on its branch (release commits passed over), so a run
cancelled by a newer push, or a red one, loses no check; an unknown base runs everything. A manual run of `ci`
(workflow_dispatch) runs every job. The server image is no longer built for every push: only for a release tag
or a manual `server-artifacts` run.

Check a CI run with `gh run view <id> --json jobs -q '.jobs[] | .name+" "+.conclusion'`. A red gate is fixed, not
bypassed; if something must ship around it, the reason goes into the deployment log as an open item.

Operators of a deployment should keep a deployment log outside the repository (docs/PUBLIC_REPOSITORY.md): for each
deploy, the version, the migrations it applied, any hand edit of the host's configuration with old and new values,
the backup taken, the live smoke result and open items. The repository records none of this.

**Rollback.** Roll back (`deploy/pull-deploy.sh --rollback` on a compose host, the equivalent step of the platform's
own deploy script elsewhere) when the live smoke fails on a key journey that the previous release passed, when readiness fails, or
when 5xx responses rise after the deploy. Migrations are expand-only (ADR 0004), so the previous image runs against
the new schema. Record the rollback and its reason in the deployment log.

> Basis: required status checks before merge and release gates that re-run the same tests on the release build
> (GitHub *About protected branches*; Google SRE book, *Release Engineering*); a smoke suite on every release and
> after every deployment (SRE book, *Testing for Reliability*; GitLab smoke tests after each deploy); explicit
> rollback criteria when there is no canary fleet (SRE workbook, *Canarying Releases*).

## 4. Test data

- `pnpm e2e` owns its database: it drops and recreates the schemas of `E2E_DATABASE_URL` for each mode and seeds
  alice/bob/carol/dave through the public API. Never point it at a database with real data.
- Integration tests use `TEST_DATABASE_URL` and isolate themselves; a skipped test is reported as skipped, never as
  passed. Test files run in parallel: each vitest worker gets its own database derived from it (`agentdrop_test` →
  `agentdrop_w3_test`, created on first use by `tests/setup/test-database.ts`), so no test may assume it is alone
  on the machine except in its own database.
- `pnpm e2e` runs the secure and plain-http modes side by side (the second on `<E2E_DATABASE_URL>_b`, port + 1) and
  the journeys of a mode concurrently (`E2E_CONCURRENCY`, default half the cores; `1` for debugging).
- Every test creates what it needs through the API; no test depends on another's leftovers or on order.

> Basis: create test data through the API rather than the UI (GitLab *E2E best practices*); hermetic tests that set
> up and tear down their own environment (*SWE at Google*, ch. 11).

## 5. QA accounts on live servers

Each live server has two fixed QA accounts, `@qa_smoke_a` and `@qa_smoke_b` (display names "QA Smoke A/B",
emails `qa-smoke-a@example.com`, `qa-smoke-b@example.com` in the reserved example.com domain), each with one paired
agent that never connects, contacts only of each other, and one group `#qa-smoke` with just the two of them.

- **Isolation.** They are nobody else's contacts and never admins. The live smoke only sends A → B with titles
  starting `[QA smoke]`; B stars and archives it, so B's inbox stays empty. Their agents never connect, so update
  reminders and presence ignore them. Admin user counts include them (two per server).
- **Targets and credentials** live only in a private file outside the repository: `$AGENTDROP_QA_ACCOUNTS`, else
  `$AGENTDROP_OPS_DIR/qa-accounts.json` (mode 0600). Never in the repository, a log or a drop.
- **Provisioning** is idempotent: `node scripts/qa-provision.mjs <target> [base-url]` (the URL on first use) creates what is missing (accounts,
  agents, contact, group) through the public API and saves new passwords before doing anything else. Run it again
  after a server is rebuilt or when the smoke reports a sign-in failure.
- **Cleanup.** The sent `[QA smoke]` drops stay in A's sent view as the record of each run. To reset a server's QA
  data, delete the two accounts from the admin page and provision again.

> Basis: dedicated, pre-provisioned test users for environments where tests cannot create users, plus a second
> user for interactions (GitLab *Test users*); synthetic transactions with real test accounts, isolated from real
> data and with their secrets kept out of logs (Microsoft Engineering Playbook, *Synthetic monitoring*); probes
> perform known, deterministic operations (*SWE at Google*, ch. 14).

## 6. Release acceptance (manual, per release)

Automation does not see everything. Before announcing a release, spend a fixed half hour on what is not automated,
and record the outcome in the deployment log:

- [ ] A real Codex, Claude Code and opencode session: tools list, `send_drop` to the QA account, the end-of-turn
      notice, the prompt-time context (`docs/INTEROP.md`).
- [ ] Installing and upgrading the CLI from npm on a Linux host behind an HTTP proxy (`agentdrop doctor` shows the
      route), and on macOS.
- [ ] The dashboard on a phone-sized screen, in the light theme, and in Chinese.
- [ ] Attachments: upload, download, the size limit message.
- [ ] Browser push and Feishu notices, when the release touched notices; click a real notification with the dashboard
      closed (a new window must open on the drop) and with it open in another tab.
- [ ] Anything the release notes promise that no automated step covers.

Exploratory findings become automated steps (§7).

> Basis: item/sprint/release levels of a Definition of Done (Microsoft Engineering Playbook); time-boxed
> exploratory testing whose findings become automated regression tests (Vocke; *SWE at Google*, ch. 14).

## 7. Bugs and regression tests

Every fixed bug gets a test that fails before the fix and passes after it, at the lowest layer that reproduces it:
a unit test for logic, an integration test for an API rule, a journey step for something only a browser shows.
The commit says which test. Example: the plain-http composer crash is covered by the insecure-mode e2e run, which
failed on the old build with `crypto.randomUUID is not a function`; the Star-after-open conflict by the
slow-network star step, which fails without the fix.

> Basis: "if a higher-level test finds a bug that no lower-level test caught, write a lower-level test" (Vocke);
> the Beyoncé Rule, "if you liked it, you should have put a test on it" (*SWE at Google*, ch. 11).

## 8. Flaky tests

A test that sometimes fails is a bug in the test or the product, never noise. Do not add blanket retries. Open an
issue, fix the cause (usually a wait on the wrong thing: wait for what the person would see, not for time), and if it
cannot be fixed within a day, quarantine it by name in the script with the issue link, at most two weeks. The only
built-in waits are for documented behaviour (the sign-in rate limit of 3 per 10 s).
A step that fails only in CI is usually timing a fast laptop hides: reproduce it with `E2E_CPU_THROTTLE=4 pnpm e2e`
(Chrome CPU throttling) and fix the cause; the leave-group 404 was found and fixed that way.

> Basis: flaky results erode trust and retries only defer the cause (*SWE at Google*, ch. 11; Google Testing Blog,
> *Flaky Tests at Google*); quarantine with an owner, an issue and a time limit (Fowler, *Eradicating
> Non-Determinism in Tests*; GitLab *Quarantine process*).

## 9. Metrics

Each deployment log entry states whether the deploy needed a fix or rollback afterwards. From those entries an
operator can track the two DORA stability measures: change failure rate (deploys that needed a fix or rollback) and time to restore.

> Basis: DORA's four keys (dora.dev).

## 10. Not yet in place

The graded work list, with status, is [TEST_BACKLOG.md](TEST_BACKLOG.md).

- Branch protection with required checks on `main` (today releases are cut from direct pushes; the gates above are
  enforced by procedure, not by GitHub).
- Scheduled synthetic runs of the live smoke (a server reachable only from a private network cannot be probed from
  hosted CI).
- Front-end error reporting from real users' browsers (the page error boundary logs to the console only).
- Browser journeys for attachments, mobile layout, group administration, push and Feishu.

## References

- Google Testing Blog, "Just Say No to More End-to-End Tests": https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html
- Software Engineering at Google, ch. 11 (Testing Overview) and ch. 14 (Larger Testing): https://abseil.io/resources/swe-book/html/ch11.html, https://abseil.io/resources/swe-book/html/ch14.html
- Ham Vocke, "The Practical Test Pyramid": https://martinfowler.com/articles/practical-test-pyramid.html
- Google SRE book, Testing for Reliability and Release Engineering: https://sre.google/sre-book/testing-reliability/, https://sre.google/sre-book/release-engineering/
- Google SRE workbook, Canarying Releases: https://sre.google/workbook/canarying-releases/
- Playwright best practices and locators: https://playwright.dev/docs/best-practices, https://playwright.dev/docs/locators
- GitLab end-to-end testing: best practices, test users, smoke tests, quarantine: https://docs.gitlab.com/development/testing_guide/end_to_end/best_practices/, https://docs.gitlab.com/development/testing_guide/end_to_end/best_practices/users/, https://docs.gitlab.com/development/testing_guide/smoke/, https://handbook.gitlab.com/handbook/engineering/testing/quarantine-process/
- Microsoft Engineering Playbook: synthetic monitoring, smoke testing, definition of done: https://microsoft.github.io/code-with-engineering-playbook/automated-testing/synthetic-monitoring-tests/, https://microsoft.github.io/code-with-engineering-playbook/automated-testing/smoke-testing/, https://microsoft.github.io/code-with-engineering-playbook/agile-development/team-agreements/definition-of-done/
- Google Testing Blog, "Flaky Tests at Google": https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html; Martin Fowler, "Eradicating Non-Determinism in Tests": https://martinfowler.com/articles/nonDeterminism.html
- GitHub protected branches and required status checks: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- DORA metrics: https://dora.dev/guides/dora-metrics-four-keys/
