# Contributing to AgentDrop

Thank you for helping. This file covers the setup and the rules every change follows; [AGENTS.md](AGENTS.md) holds
the full constraints (the same rules apply to people and to coding agents), and [docs/QUALITY.md](docs/QUALITY.md)
decides what may be merged.

## Set up

- Node.js at the version in [.nvmrc](.nvmrc) (at least 22.12), pnpm 10 (`corepack enable` picks the version pinned
  in `package.json`), Docker for PostgreSQL.
- `pnpm install`, then `cp .env.example .env` and replace `AUTH_SECRET` with a random value
  (`openssl rand -hex 32`).
- `docker compose up -d postgres` starts PostgreSQL 17 on `localhost:5433`; `pnpm db:migrate && pnpm dev` runs the
  API, `pnpm dev:web` the dashboard.

## Check your change

- `pnpm verify` must pass before a commit: lint (Biome), `pnpm hygiene`, typecheck, contract and migration drift,
  tests (also with content encryption on) and build.
- Database tests need `TEST_DATABASE_URL` pointing at a dedicated `test_*` or `*_test` database (never your
  application database). Without it they are skipped and say so; a skipped test is not a passed test.
- `pnpm verify:cli` checks the client alone (lint, types, contracts, database-free tests, the standalone package and
  its dependency boundary) and needs no database.
- Dashboard or API changes also pass `pnpm e2e`: it runs the browser journeys in Chrome, in a secure and a plain-http
  mode, after `pnpm build`. Set `E2E_DATABASE_URL` to an **empty** database it may reset (it drops the schemas);
  `psql` must be on `PATH`. A new key page or button gets a journey step in the same change.
- Every fixed bug gets a test that failed before the fix.

## Generated files

- Contracts changed (`packages/contracts`): run `pnpm contracts:generate` and commit the generated JSON.
- Database schema changed (`packages/db`): run `pnpm db:generate` and commit the SQL migration. Migrations are
  expand → migrate → contract, never destructive by default (ADR 0004).

## Commits and changelog

- [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `docs`, `test`, `refactor`, `ci`,
  `chore`, `release`, optional scope such as `feat(cli):`), one logical change per commit.
- A change a user, an operator or an agent can notice adds a line to [CHANGELOG.md](CHANGELOG.md) under
  **Unreleased** in the same commit (Keep a Changelog sections: Added, Changed, Deprecated, Removed, Fixed,
  Security).
- Decisions live in [docs/adr/](docs/adr/README.md). Read the records that govern an area before changing it; to
  reverse one, write a superseding record.

## Harness parity

Every client-facing capability (MCP registration, hooks, skills, notices) must exist for every supported harness
where the host allows it: Codex CLI, Claude Code, opencode, Cursor, oh-my-pi and WorkBuddy. Each harness is one adapter in
`apps/cli/src/harnesses/<key>.ts`; record parity in [docs/HARNESSES.md](docs/HARNESSES.md) and cover it in
`apps/cli/src/harnesses/parity.test.ts`. A change to onboarding, CLI commands or user-visible features updates the
dashboard text in `apps/web/src` in the same change.

## Licence of contributions

AgentDrop is licensed under the [Apache License 2.0](LICENSE). Unless you say otherwise, a contribution you submit
is licensed under the same terms (section 5 of the licence); there is no separate contributor agreement to sign.
Only submit work you have the right to contribute.

## What the repository may contain

Follow [docs/PUBLIC_REPOSITORY.md](docs/PUBLIC_REPOSITORY.md): no secrets, no real server addresses or host names,
no records of what was done to a live server, no real people's names, handles or data, and none of your personal
setup (home paths, local folders, proxy ports) in any file or commit message. Use placeholders such as
`drop.example.com` and `203.0.113.10`. `pnpm hygiene` checks this.

## Security

Do not open a public issue for a vulnerability; see [SECURITY.md](SECURITY.md). Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md).
