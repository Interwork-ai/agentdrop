# What the repository may contain

This repository may be published. Every file and every commit is written as if it already were: it holds the product
and how to run it, never where it runs, what was done to a live server, who uses it, or how one maintainer happens to
work. This is binding for every contributor, human or agent (see `AGENTS.md`), and `pnpm hygiene` enforces it.

## 1. Never commit

| Kind | Examples | Where it goes instead |
|---|---|---|
| **Secrets** | keys, tokens, passwords, keyrings, `.env` values, QA account passwords, webhook URLs with tokens | the environment, a secret store, the private files below |
| **Where it runs** | real IP addresses and host names (including `*.sslip.io` names built from an IP), server nicknames, filesystem paths on servers, internal platforms, their proxies, docker sockets and volumes | the private operations directory (`$AGENTDROP_OPS_DIR`) |
| **What was done to a live server** | deployment records, rollbacks, migrations applied, backups and their names, image digests of what runs where, data counts, incident notes, drill results | `$AGENTDROP_OPS_DIR/DEPLOY_LOG.md` and `HOSTS.md` |
| **People** | real users' handles, names, emails, machine names, messages, screenshots of live data, whose bug report it was | nowhere in the repository; describe the situation instead ("a Codex user on a proxied Linux host") |
| **The maintainer's own setup** | home directories and local folder names, local proxy ports, personal accounts, personal tool and agent preferences, notes to oneself | the person's own tooling configuration, `.env` (git-ignored), `$AGENTDROP_OPS_DIR` |
| **Site-specific deploy kits** | scripts that only fit one organisation's platform (its mount rules, sockets, proxies) | `$AGENTDROP_OPS_DIR/deploy-kits/`; the repository keeps the generic ones (`deploy/pull-deploy.sh`, compose files) |
| **One operator's defaults** | a personal account as a default (`…_USER:-<someone>`), one host's env-file name or directory layout as the script default, a secret with a default value (`${AUTH_SECRET:-…}`) | generic defaults in the repository; per-host values in the host's untracked `deploy/site.env`; secrets fail closed (`${NAME:?message}`) |
| **Internal working material** | review transcripts, trial notes, early plans and prompts, competitor notes, TODO lists, notes addressed to the maintainer ("decide later"), reference screenshots | git-ignored paths in the checkout (listed in `.gitignore`), the private directory, or an issue |
| **Personal aids** | third-party agent skills, prompts or tools one contributor uses while working | the person's own tooling, or a git-ignored folder such as `vendor/` |
| **Local runtime data** | files a local server wrote (`apps/api/data/`, uploaded attachments), test output, caches | git-ignored; never `git add -A` without looking at what it adds |

Commit messages follow the same rule: they describe the code change, never a rollout, a server or a person.

**Examples are made up.** Tests, fixtures, docs and screenshots use invented people and projects (Alice, Bob, Wang,
Mia, "#lab", "the ablation run"). Never copy a name, handle, project code or message from a real inbox, even into a
test — the private deny list exists because this happened.

## 2. What is fine

- The project's own identity: repository and package names, the container image name, `CODEOWNERS`.
- Placeholders: `example.com` / `.org` / `.net`, `*.test`, `*.example`, `*.invalid`; documentation addresses
  `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`; loopback; private ranges as illustrative test data; paths such
  as `/home/user`, `/Users/me`, `~`.
- Well-known public addresses as test data for "some public address" (`8.8.8.8`, `1.1.1.1`, `1.2.3.4`).
- Recognisable fake secrets in tests of the sensitive-content scanners (`AKIA…EXAMPLE`, a key header without a body).
- Third-party code the product ships, with its licence: bundles carry a third-party notices file generated at build
  time (CLI package and dashboard), so every MIT / ISC / BSD / OFL notice travels with the code.
- Generic operational knowledge: how to deploy, back up, rotate keys, what a platform limitation implies — written
  without naming the site.

## 3. How code stays generic

- Anything site-specific comes from the environment, arguments or a private file, with no default that points at a
  real server. The maintenance scripts read `AGENTDROP_OPS_DIR` (and friends) from the environment or from the
  git-ignored `.env`, so no personal path is written into the repository (`scripts/lib/local-env.mjs`).
- The QA accounts file (`$AGENTDROP_QA_ACCOUNTS`, else `$AGENTDROP_OPS_DIR/qa-accounts.json`) holds both the live
  servers' URLs and the credentials; `scripts/qa-provision.mjs <target> <base-url>` records a new target there.
- Personal agent state (`.claude/`, `.codex/`, `.cursor/`, `.opencode/` in the checkout) is git-ignored; a tool only
  you use goes into your global git excludes (`core.excludesFile`) or `.git/info/exclude`, not into `.gitignore`.
- Deploy scripts take everything that differs between hosts from the environment or the host's untracked
  `deploy/site.env` (env file, compose files, registry user), with generic defaults that fit a fresh self-hosted
  install. No account, path or file name of one operator is a default.
- Secrets are never defaulted: compose files use `${NAME:?…}`, and the server refuses a known placeholder in every
  mode except tests.
- Documentation describes the product and how anyone runs it. Rules that only one maintainer's deployments follow
  (their logs, their servers' checks) live in that maintainer's private directory; `AGENTS.md` only says to read it
  when `AGENTDROP_OPS_DIR` is set.

## 4. Enforcement

`pnpm hygiene` (`scripts/check-public-hygiene.mjs`) runs in `pnpm verify` and in CI. It checks every tracked file
against generic rules (public IPs, IP-derived host names, home paths, real email addresses, credential patterns,
secrets with a default value in compose / shell / env files, and files `.gitignore` declares local-only that are
still tracked) and,
where available, against a **private deny list** of the concrete names that must never appear (real hosts, internal
platforms, people, local folders): `$AGENTDROP_HYGIENE_DENY`, else `$AGENTDROP_OPS_DIR/public-hygiene-deny.txt`. The
deny list is never committed (listing the names would publish them), and hits against it are reported without the
matched text. CI has no deny list, so run `pnpm hygiene` locally before pushing; `pnpm verify` does.

A line that legitimately needs a generic pattern (an address just outside a private range in a range test) carries
`hygiene-allow: <rule> <reason>`; the private deny list has no opt-out.

When a new kind of leak is noticed, add a generic rule if it can be described without naming anything, otherwise add
the name to the private deny list, then fix the files. What a pattern cannot see (a story about one deployment, a
note to the maintainer, a stale claim) is caught by reading: review new docs and comments against §1 before
committing them.

## 5. Publishing

Do not switch this repository to public. Its history predates this policy: earlier commits contain deployment logs,
server addresses and site-specific scripts, and rewriting published history is off limits. To open-source:

1. Start a new repository from a snapshot of the current tree (a single initial commit, no history).
2. Before that commit: `pnpm hygiene` with the private deny list, a full secret scan of the tree (for example
   gitleaks), and a read-through of `docs/plan/` and `docs/adr/` for people, sites and internal decisions. Snapshot
   only tracked files (`git archive HEAD`), so nothing git-ignored can come along.
3. Set the licence: `LICENSE`, the `license` field of `package.json` and `apps/cli/pkg/package.json`, the licence
   named on the product page (`apps/web/src/pages/landing.tsx`), and the image's
   `org.opencontainers.image.licenses` label; repoint npm trusted publishing and the image name to the new
   repository.
4. Treat every credential that ever appeared in the old history as exposed: rotate it.
5. Keep developing in the public repository from then on, under this policy.
