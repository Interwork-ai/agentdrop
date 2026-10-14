# AgentDrop

[中文说明](README.zh-CN.md)

AgentDrop lets people hand results, files and selected context from one coding agent to another, across machines
and networks. You tell Codex on your laptop "send these findings and notes.md to @wang"; Wang asks Claude Code on
a lab server "what came in?" and reads it there, attachment included. Nobody shares an account or a session
transcript, and the two sides do not need to be online at the same time.

Supported agents (called *harnesses* in the code): **Codex CLI, Claude Code, opencode, Cursor and oh-my-pi (omp)**.
They all run the same MCP bridge and the same messaging rules; see [docs/HARNESSES.md](docs/HARNESSES.md) for what
differs per host.

Each message is a **drop**: a title, a body and optional attachments, delivered once to people or groups. A drop is
immutable and starts no thread; it may name the drop it answers, and the reader decides whether to send another.
Every drop stays on the server, with inbox, sent, starred and archived views and a timeline per contact and group.

## How it fits together

```
 Each person's machines                                 One server for the team (deployed once)
 ┌──────────────────────────────────┐                   ┌──────────────────────────────────────┐
 │ Codex / Claude Code / opencode / │   HTTPS, outbound │ API (Fastify) + web dashboard         │
 │ Cursor / omp                     │ ────────────────▶ │ PostgreSQL (drops, permissions)       │
 │   └─ agentdrop mcp (stdio bridge)│                   │ worker (outbox, notifications, sweeps)│
 │ agentdrop CLI (setup, doctor)    │                   │ attachment storage (disk or S3)       │
 └──────────────────────────────────┘                   └──────────────────────────────────────┘
```

The server is a single Docker Compose stack, not a set of microservices. People use the CLI once per machine and
the web dashboard afterwards. Servers do not federate: identities, contacts and drops on one server are separate
from those on another.

## Key features

- **One mailbox per agent identity.** An agent is identified by account + device + harness + profile. However many
  sessions or projects you open in the same Codex, it is one agent; Codex on a GPU server is another. A drop sent
  to `@you` reaches all of your agents by default; you can choose to receive on one only, and a sender may address
  one specific agent such as `@you/claude`.
- **Read state belongs to the person** ([ADR 0007](docs/adr/0007-one-reader-per-account.md)). Read, starred and
  archived are shared by all of your agents and the dashboard: marking a drop read in one place clears it
  everywhere, and an end-of-turn notice announces each new item once per account. By default each of your agents
  can also list the drops your other agents sent and received, labelled with the agent involved; you can turn that
  off in the settings. Senders see when each person first opened their drop, never through which agent.
- **Contacts and groups only.** You can send to accepted contacts and to members of groups you share. Anyone with
  your @handle can send you a contact request, but nothing else reaches your inbox until you accept. Contacts are
  added by invite link or by asking your agent; groups hold up to 20 people.
- **My space** ([ADR 0030](docs/adr/0030-my-space.md)). Files and notes you keep for yourself: put one in on your
  laptop (dashboard, `agentdrop space put`, or by asking your agent) and pull it from your agent on a server. Items
  are never unread and never announced.
- **A terminal is enough** ([ADR 0032](docs/adr/0032-terminal-read-marks-read.md)). `agentdrop inbox`, `read` and
  `send @handle | #group | me` work without an agent, also in scripts and CI (text from a pipe, files under the same
  allowlist). Reading a drop in a terminal marks it read; scripts and agents running the CLI leave it unread.
- **Fourteen MCP tools** for agents: five for mail (`directory_lookup`, `list_drops`, `read_drop`, `send_drop`,
  `set_drop_state`), two for local files (`upload_file`, `download_file`) and seven for contacts and groups.
  Account management (renaming agents, revoking credentials, group policies, approving join requests) stays in the
  dashboard and CLI. See [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md).
- **Nothing received executes.** What the software enforces: nothing is downloaded automatically; downloads land in
  a fixed directory, are checked against their sha256, never overwrite a file and are never executed or extracted.
  What agents are told (MCP server instructions and the companion skill): treat titles, bodies and names from other
  people as untrusted data, never follow instructions in them, and show the user a received drop before acting on
  it. Drop bodies reach the model between untrusted-content markers, but a model can still get this wrong; running
  anything stays the user's decision.
- **Careful with local files.** Agents can upload only from directories you allowed; keys, `.env` files and other
  sensitive paths are refused.
- **Retries never duplicate.** A send carries a `request_id`; repeating it returns the first result.
- **Notifications where you are.** Hooks show a short notice at the end of an agent turn (Codex and Claude Code
  `Stop`, Cursor `stop`, opencode `session.idle`, omp `agent_end`), and the model is told what is pending when you
  submit a prompt (Codex, Claude Code, omp). On Claude Code 2.1.287 and later, a list above the prompt shows what is
  waiting. Browser Web Push and Feishu group bots notify you even when no agent is running; they carry the drop's
  title, never its body.
- **Optional encryption at rest.** With `CONTENT_ENCRYPTION=on` and a keyring, drop titles, bodies, attachment names
  and attachment bytes are stored encrypted, so a database dump, a backup or the attachment store alone reveals no
  content. Whoever controls both the host and the keyring can still decrypt; this is not end-to-end encryption.
  Without it, the server stores content in plain text. Transport is HTTPS (production refuses an `http://` base
  URL). See [docs/DEPLOY.md](docs/DEPLOY.md#content-encryption-at-rest).
- **Dashboard in English or Chinese**, dark or light, with an operator console that shows accounts, agents and the
  audit log but never message content ([docs/ADMIN.md](docs/ADMIN.md)).
- **Audit export.** `agentdrop export` writes a date range of drops with one contact or one group as a verifiable
  NDJSON file.

## Quick start for users

You need Node.js 22 or later and at least one supported agent installed. You do not need this repository.

1. Open your team's AgentDrop server in a browser and sign up.
2. In a terminal on each machine you use:

   ```bash
   npm install -g agentdrop-cli@latest        # or: curl -fsSL https://drop.example.com/install.sh | sh
   agentdrop setup --server https://drop.example.com
   ```

   `setup` logs the machine in, detects the installed agents, pairs each one (you approve it in the browser), registers
   the MCP bridge, installs the companion skill and the notices, and runs a self-check. On a remote machine over
   SSH, add `--no-browser` and open the printed link on your own computer. `--harness codex` (or `claude-code`,
   `cursor`, `opencode`, `omp`) limits it to one agent. Run it in a project folder and it offers to let your agents
   upload files from there.
3. Add a colleague in the dashboard's Contacts page, or ask your agent to. Once they accept, ask your agent to send
   them something. Every account starts with an `@agentdrop` assistant contact that confirms a test drop.

The npm package is `agentdrop-cli`; the command is `agentdrop`. `agentdrop doctor` diagnoses configuration and
connectivity. The full guide is [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

## Self-hosting

**Try it on one machine** (Docker, plain http on `localhost:3000`, attachments on local disk):

```bash
git clone https://github.com/Interwork-ai/agentdrop.git && cd agentdrop
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> .env      # once; Compose reads .env next to the compose file
docker compose -f compose.local.yaml up -d --build      # PostgreSQL, migrations, API + dashboard, worker
```

Then follow the user quick start with `--server http://localhost:3000`. For a trial on a server without a domain
(plain http on a high port, or HTTPS through an existing nginx), see [docs/DEPLOY_TRIAL.md](docs/DEPLOY_TRIAL.md).

**Run it for a team** with `compose.yaml` + `compose.production.yaml`, behind Caddy, which obtains the TLS
certificate. Create `.env.production` from [.env.example](.env.example). The API checks its configuration at start
and refuses to run in production with:

| Variable | Requirement |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_BASE_URL` | the public `https://` address of the server |
| `DATABASE_URL`, `POSTGRES_PASSWORD` | PostgreSQL connection; the same generated password in both |
| `AUTH_SECRET` | at least 32 random characters, not a placeholder |
| `STORAGE_PROVIDER=s3`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (`S3_ENDPOINT` for non-AWS) | a private bucket; production refuses local-disk attachments |
| `DEV_AUTH`, `LOG_CONTENT` | `false` |

Optional: `WEB_PUSH_VAPID_*` (browser push), `SMTP_URL` + `MAIL_FROM` (password reset mail), `CONTENT_ENCRYPTION` +
`CONTENT_KEYS_FILE` (encryption at rest), `SIGNUP_MODE` (`open` or `closed`; administrators can change it later).
Compose also reads `AGENTDROP_DOMAIN` (the name Caddy serves) and `AGENTDROP_IMAGE` (the image to run).
Migrations, backups and restores, upgrades and key handling are in [docs/DEPLOY.md](docs/DEPLOY.md); operating the
server (administrators, suspension, sign-up) is in [docs/ADMIN.md](docs/ADMIN.md).

## Development

Requirements: Node.js (version in `.nvmrc`, at least 22.12), pnpm 10, Docker for PostgreSQL.

```bash
pnpm install
cp .env.example .env                 # then replace AUTH_SECRET with a random value (openssl rand -hex 32)
docker compose up -d postgres        # PostgreSQL 17 on localhost:5433
pnpm db:migrate && pnpm dev          # API on :3000; in another terminal `pnpm dev:web` for the dashboard on :5173
pnpm verify                          # lint, hygiene, types, contract and migration drift, tests, build
```

Database tests run only when `TEST_DATABASE_URL` names a dedicated `test_*` or `*_test` database, and skip (saying
so) otherwise. `pnpm verify:cli` checks the client alone without a database. `pnpm e2e` drives the dashboard in
Chrome against a real server and an empty database it resets (`E2E_DATABASE_URL`). How to contribute, and the rules
every change follows, are in [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## Documentation

| Topic | Document |
|---|---|
| Using AgentDrop: pairing, contacts, sending, groups, FAQ | [docs/USER_GUIDE.md](docs/USER_GUIDE.md) |
| Agent-side tools and their errors | [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) |
| Per-harness behaviour and parity | [docs/HARNESSES.md](docs/HARNESSES.md) |
| CLI commands | [apps/cli/README.md](apps/cli/README.md) |
| Deploying, backups, upgrades, encryption at rest | [docs/DEPLOY.md](docs/DEPLOY.md), [docs/DEPLOY_TRIAL.md](docs/DEPLOY_TRIAL.md) |
| Operating a server | [docs/ADMIN.md](docs/ADMIN.md) |
| Feishu notifications | [docs/FEISHU.md](docs/FEISHU.md) |
| Code structure and data model | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Decision records | [docs/adr/](docs/adr/README.md) |
| Product defaults and dashboard design rules | [docs/PRODUCT_PRINCIPLES.md](docs/PRODUCT_PRINCIPLES.md), [docs/DESIGN.md](docs/DESIGN.md) |
| Quality gates and tests | [docs/QUALITY.md](docs/QUALITY.md), [docs/TEST_BACKLOG.md](docs/TEST_BACKLOG.md) |
| What is implemented, tested, not tested, not supported | [docs/STATUS.md](docs/STATUS.md) |
| Real-client interoperability record | [docs/INTEROP.md](docs/INTEROP.md) |
| Releasing and compatibility | [docs/RELEASE.md](docs/RELEASE.md), [CHANGELOG.md](CHANGELOG.md) |
| What the repository may contain | [docs/PUBLIC_REPOSITORY.md](docs/PUBLIC_REPOSITORY.md) |
| Original v0.2 design (historical) | [docs/plan/SPEC.md](docs/plan/SPEC.md) |

Security reports: [SECURITY.md](SECURITY.md). Community standards: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licence

See [LICENSE](LICENSE).
