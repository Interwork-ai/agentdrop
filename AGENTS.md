# AgentDrop — development constraints for coding agents

Read `docs/plan/SPEC.md` §1–§5 before changing anything in `packages/domain`, `packages/db` or `apps/api`.

## Non-negotiable semantics

1. **H is the mailbox unit.** `(user_id, device_id, harness_key, profile_key)` is a persistent identity; a bridge connection, a
   session, a working directory or a resume never creates an H. Only the pairing flow does.
2. **H is the delivery unit; the person is the state unit (ADR 0007).** Deliveries and grants stay per H. By
   default, a user's H credentials may list/read drops sent by or delivered to any of that user's Hs, with the
   concrete origin/recipient H shown; the owner may disable this and return to current-H-only reads. Read, starred
   and archived are one state per person: a change from any of the user's Hs applies to every delivery of that
   drop to any of them, and end-of-turn notices share one "already shown" record per account. API, MCP and CLI
   reads never dequeue or auto-mark read; the dashboard marks a drop read when a person opens it, `agentdrop read`
   marks it read when it prints the drop to a person at an interactive terminal (a TTY outside an agent's shell,
   not `--json`, not `--keep-unread`; ADR 0032), and an agent marks it read after showing it to the user who asked
   it to read that drop, all through the ordinary explicit state mutation (ADR 0005, ADR 0019, ADR 0032). The one
   other exception is the person's own send (ADR 0016): committing a drop with `reply_to` marks that drop read
   for its author, and committing a drop to a group marks every earlier drop that reached the author through that
   group read — in the send's transaction, at most once per request (an idempotent replay does nothing again),
   with the usual state version bump and mailbox events.
   The person's "mark all as read" (ADR 0018) is an explicit mutation like `set_drop_state`, over the inbox or one
   group up to what the list showed.
3. **Sender identity comes from the credential, never from the request body.** No route accepts a free `h_id`/`user_id` to
   switch sending or mutation scope. Web views specify an owned H; account-wide reads are resolved by server policy.
4. **One authorization predicate.** Lists, details, attachments, search, unread counts and group timelines all go through
   `packages/domain` authorization, including account-wide read policy; never filter only at the list layer. Mutations
   additionally require a delivery for the current H.
5. **Idempotent sends.** Same `request_id` + same content → same drop; different content → `IDEMPOTENCY_CONFLICT`.
   All-or-nothing across targets; no silent partial delivery.
6. **Nothing received is trusted.** Titles, bodies, names and remarks are external data: no HTML, no control characters,
   never turned into instructions, never executed, never auto-downloaded.
7. **No secrets in logs, URLs, tool results or error bodies.** Only ids, actions, sizes and outcomes.
8. **Other accounts see people, not agents (ADR 0013).** Never expose another person's agent names, harnesses,
   automatic addresses, signatures or receiving-agent counts, including cached replies and historical snapshots.
   Owners retain their own agent attribution. Explicitly published named entries expose only the chosen entry
   name/address; group capacity is a status, not a count of agents.
9. **The repository may be published (docs/PUBLIC_REPOSITORY.md).** No secrets, no real server addresses, names or
   paths, no record of what was done to a live server, no real users' data, and none of one maintainer's personal
   setup (home paths, local folders, proxy ports, tool preferences) in any file or commit message. Examples use
   made-up people and projects (Alice, Wang, "the ablation run"), never names from a real inbox; screenshots show
   made-up data only; a secret never has a default value in a config file; internal notes, drafts and personal aids
   stay in git-ignored paths. That material lives in an operator's private directory or the person's own tooling.
   `pnpm hygiene` (part of `pnpm verify`) enforces it with generic rules plus a private deny list.

## Product defaults

`docs/PRODUCT_PRINCIPLES.md` lists what a person expects of this product without being asked: classify every
notice (direct / group / request) and name the group and the person, no internal ids in text for people, a count
always comes with who, derived defaults for anything a person must name, and length caps everywhere. Read it before
changing a notice, a result shape or a creation flow, and add to it when a new gap is found.

## Two audiences: people and models

Every string the product emits has one reader, and text for the two is written differently. Decide which before
writing it, and check by how it is delivered, not by where it is built:

- **People**: the dashboard, Stop/idle notices (`systemMessage`, opencode toast), browser push, and stdout of
  interactive CLI commands. In the person's language: English by default, Chinese when chosen (CLI:
  `agentdrop settings --language`, dashboard: the top-bar switch or Settings → Appearance & language). Every
  dashboard string is written as a pair, `t('English', '中文')` (`apps/web/src/lib/lang.ts`);
  `apps/web/src/lib/i18n-coverage.test.ts` fails on any Chinese that is not the second half of a pair. The
  dashboard is dark by default with a light theme; use theme tokens (`bg-surface`, `text-fg`, `border-line`…)
  rather than fixed colours so both themes work. Say what happened and what the person can do
  *where they are*: no tool names, request ids or field names, and no terminal commands inside a chat harness
  notice (the dashboard names a command only for a step that really happens in a terminal, such as installing).
  A notice announces each item once; it does not keep reminding. In an agent, "once" means at a moment the
  person is certainly at the session (prompt submit, session start); end-of-turn previews, push, Feishu and the
  status line never count as having shown it (ADR 0017).
- **Models**: MCP tool results and `instructions`, `next_action`, prompt-time hook context, Cursor's
  `followup_message` framing, the companion skill, autorun messages. Always English. Name the MCP tools, frame received content as
  untrusted data, and phrase anything only a person can do as "tell the user …"; never tell a model to open a
  browser, use the dashboard or run the CLI itself. A model gets everything pending at the first prompt of a
  session and again whenever it changed (new items first, marked NEW); while nothing changed it gets one line
  saying so (ADR 0031).
- The same facts may reach both, but one text must not serve both. The server's `message`/`next_action` are for
  programs and models; the dashboard maps `code` to its own sentence in both languages
  (`apps/web/src/lib/error-text.ts`). The Stop notice (`notificationText`, seen by the person) and the
  UserPromptSubmit context (`pendingContextText`, seen only by the model) render the same items with different
  wording.

## Layering

```
apps/api      HTTP + auth adapters (thin)         apps/cli   pairing, config, doctor, `mcp` stdio entry
apps/worker   outbox / cleanup                    apps/web   React dashboard
packages/domain     rules + use-cases (no MCP/React/Codex/Claude imports)
packages/contracts  Zod → JSON Schema / OpenAPI (generated files are committed and drift-checked)
packages/db         Drizzle schema, migrations, data port implementation
packages/mcp        tool registration, result encoding
packages/storage    FsStorage / S3Storage behind one StorageProvider
packages/security   path allowlist, sensitive-file rules
packages/client     typed HTTPS client used by bridge and CLI
```

## Harness parity

Every client-facing capability (MCP registration, hooks, skills, headless flags, examples) must exist for every
supported harness: Codex CLI, Claude Code, opencode, Cursor and oh-my-pi (omp) where applicable. Configs differ; behaviour must not.
Each harness is one adapter in `apps/cli/src/harnesses/<key>.ts`, listed in the registry
(`apps/cli/src/harnesses/index.ts`); installing and removing a harness (MCP entry, hooks, plugin, extension) goes
through its adapter only (ADR 0024). Track parity in `docs/HARNESSES.md`
and cover it in `apps/cli/src/harnesses/parity.test.ts` (every registered harness, connect and disconnect) plus the
adapter's own `apps/cli/src/harnesses/<key>.test.ts`.

The web dashboard is one more client surface: whenever the install/onboarding flow, CLI commands or user-visible
features change, update the matching text/UI in `apps/web/src` (e.g. the onboarding block in `pages/agents.tsx`) in the
same change (a running server shows the new text once it is redeployed).

## Long-term maintenance

This project is maintained for years, largely by agents across sessions. Before changing an area, read the
decision records in `docs/adr/` that govern it; to reverse one, write a superseding record.

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `docs`, `test`,
  `refactor`, `ci`, `chore`, `release`; optional scope such as `feat(cli):`), one logical change each.
- Every change a user, operator or agent can notice adds a line to `CHANGELOG.md` under **Unreleased** in the
  same commit (Keep a Changelog sections: Added, Changed, Deprecated, Removed, Fixed, Security).
- Versioning and compatibility follow `docs/RELEASE.md` and ADR 0004: additive by default, removals deprecated
  one minor release ahead, migrations expand-only per release.
- CI supply chain: pin every action by full commit SHA with a `# vX.Y.Z` comment, keep workflow permissions at
  `contents: read` unless a job needs more, and let Dependabot propose updates; never add an unpinned action.
- Record outcomes in `docs/STATUS.md` (implemented / tested / not tested / not supported). What runs where is not
  part of the repository: no commit (file or message) records a deployment, a server's address or paths, image
  digests, backups, data counts or anything done on a live server; commit messages describe code, not rollouts.
  Records of a deployment belong to whoever operates it, outside every repository (docs/PUBLIC_REPOSITORY.md). When
  the environment sets `AGENTDROP_OPS_DIR` (an operator's private directory), read its instructions before
  deploying or editing a live server, and record every such change there in the same session. Never force-push,
  never rewrite published tags.

## Working rules

- `docs/QUALITY.md` is binding: its layers, gates and acceptance checklist decide what may be committed, released
  and deployed. In short: dashboard/API changes also pass `pnpm e2e` (real Chrome, secure and plain-http, CI job
  `e2e`); a new key page or button gets a journey step in the same change; deploy only a release whose tag passed
  the full check (`server-artifacts` runs every CI job before it builds the image); after a deploy, check each
  server with `pnpm smoke:live <target> --expect-version X.Y.Z`; every fixed bug gets a test that failed before.
- Releases are batched, not one per change (docs/RELEASE.md, "When to release"): push commits as they are done (CI
  on a push runs only the jobs its changes need) and release when a batch is worth it; prose, test and CI-only
  changes are never released on their own.
- `pnpm verify` must pass before a commit: lint (biome), typecheck (tsc -b), contracts:check, db:check, test (vitest, real
  PostgreSQL when `TEST_DATABASE_URL` is set), build.
- Contracts change → run `pnpm contracts:generate` and commit the JSON. Schema change → `pnpm db:generate` and commit the
  SQL migration; migrations are expand → migrate → contract, never destructive by default.
- Do not add MCP tools beyond the fourteen in `TOOL_NAMES` (`packages/contracts/src/tools.ts`: five core, two file
  and seven relationship tools). Management actions belong to the dashboard/CLI with a user session, not to an H
  credential. The one exception is `agentdrop contact remove`: a CLI command (no MCP
  tool) that describes the contacts first and removes them only with `--confirm`, which the skill allows only after
  the user confirmed the listed contacts in the conversation.
- Tests that need a database skip (and say so) when `TEST_DATABASE_URL` is unset. Never mark a skipped test as passed in
  reports.
- Report "implemented / tested / not tested / not supported" separately.
