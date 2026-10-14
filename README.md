<p align="center">
  <img src="docs/images/logo.png" width="96" alt="AgentDrop logo" />
</p>

<h1 align="center">AgentDrop</h1>

<p align="center">
  <b>A shared mailbox for coding agents.</b><br />
  Tell your agent who a result is for. It waits in their agent's inbox.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0" /></a>
  <a href="https://www.npmjs.com/package/agentdrop-cli"><img src="https://img.shields.io/npm/v/agentdrop-cli?label=agentdrop-cli" alt="npm version" /></a>
  <a href="https://github.com/Interwork-ai/agentdrop/actions/workflows/ci.yml"><img src="https://github.com/Interwork-ai/agentdrop/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933" alt="Node.js 22 or later" />
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#self-hosting">Self-hosting</a> ·
  <a href="docs/USER_GUIDE.md">User guide</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/dashboard-dark.png" />
    <img src="docs/images/dashboard-light.png" width="860" alt="The AgentDrop dashboard: an inbox with a message from Wang that carries two attachments" />
  </picture>
</p>

## Why AgentDrop

Coding agents produce results — experiment tables, review notes, patches, logs — that someone else's agent needs
next. Today that means copying text into chat and attaching files by hand. With AgentDrop, you ask:

```text
You, in Codex on your laptop:        "Send the ablation results and notes.md to @wang"
Wang, in Claude Code on a server:     "What came in?"
```

Wang's agent reads the message and its attachments right where Wang is working. Nobody shares an account or a
session, and the two of you do not need to be online at the same time.

## Features

### Works with the agents you use

**Codex CLI, Claude Code, opencode, Cursor and oh-my-pi.** One command pairs each of them; they all get the same
MCP tools, notices and rules. A terminal works too: `agentdrop inbox`, `read` and `send`, also in scripts and CI.

### Send to people and groups

Send to contacts or to groups of up to 20 people. Strangers can ask to connect, but nothing reaches you until you
accept. Read and starred are one state per person, shared by all your agents and the web dashboard.

### Files, safely

Attach files to any message. Agents upload only from folders you allowed, and never keys, credentials or `.env`
files. Received content is never run or downloaded automatically; agents treat it as untrusted text and show it to
you before acting on it.

### Notices where you are

A short note when your agent finishes a turn, a live list above the prompt in Claude Code, browser push and Feishu
group bots when no agent is open.

### Self-hosted

One Docker Compose stack: API, web dashboard, worker, PostgreSQL. Optional encryption at rest, an admin console that
never shows message content, audit export, and password recovery without email.

## Quick start

You need Node.js 22 or later, one of the agents above, and an account on your team's AgentDrop server.

```bash
npm install -g agentdrop-cli
agentdrop setup --server https://drop.example.com
```

`setup` finds your agents, pairs each one (you approve in the browser), installs the MCP tools, skill and notices,
and checks the result. Then ask your agent: *"Add @wang as a contact and send the results."*

Every account starts with an `@agentdrop` assistant you can send a test message to.

## Self-hosting

Try it on one machine:

```bash
git clone https://github.com/Interwork-ai/agentdrop.git && cd agentdrop
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> .env
docker compose -f compose.local.yaml up -d --build
```

Open <http://localhost:3000>, sign up, and run `agentdrop setup --server http://localhost:3000`.

For a team, run `compose.yaml` with `compose.production.yaml` behind HTTPS, with PostgreSQL and S3-compatible
storage. Configuration, backups, upgrades and encryption are in [docs/DEPLOY.md](docs/DEPLOY.md); running the
server is in [docs/ADMIN.md](docs/ADMIN.md).

## How it works

```text
 Your machines                                  Your team's server
┌─────────────────────────────────┐            ┌────────────────────────────────┐
│ Codex · Claude Code · opencode  │   HTTPS    │ API + web dashboard            │
│ Cursor · oh-my-pi               │ ─────────▶ │ PostgreSQL (messages, access)  │
│   └─ agentdrop mcp (bridge)     │            │ worker (notices, cleanup)      │
│ agentdrop CLI                   │            │ attachments (disk or S3)       │
└─────────────────────────────────┘            └────────────────────────────────┘
```

Each agent gets its own credential and mailbox; a message is delivered once and kept on the server. Details are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the [decision records](docs/adr/README.md).

## Documentation

- [User guide](docs/USER_GUIDE.md) — pairing, contacts, sending, groups, FAQ
- [CLI](apps/cli/README.md) and [MCP tools](docs/MCP_TOOLS.md)
- [Agent clients](docs/HARNESSES.md) — what differs between Codex, Claude Code, opencode, Cursor and oh-my-pi
- [Deploying](docs/DEPLOY.md) and [operating](docs/ADMIN.md) a server
- [Implementation status](docs/STATUS.md) and [changelog](CHANGELOG.md)

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md); the rules every change follows
are in [AGENTS.md](AGENTS.md).

```bash
pnpm install && cp .env.example .env    # then set AUTH_SECRET
docker compose up -d postgres
pnpm db:migrate && pnpm dev             # API on :3000; pnpm dev:web for the dashboard
pnpm verify                             # what CI checks
```

Report security issues privately: [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) © yitianlian and the AgentDrop contributors
