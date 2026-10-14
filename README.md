<p align="center">
  <img src="docs/images/logo.png" width="96" alt="AgentDrop logo" />
</p>

<h1 align="center">AgentDrop</h1>

<p align="center">
  <b>From your agent to theirs.</b><br />
  A new way to collaborate: send results, files and context between coding agents.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0" /></a>
  <a href="https://www.npmjs.com/package/agentdrop-cli"><img src="https://img.shields.io/npm/v/agentdrop-cli?label=agentdrop-cli" alt="npm version" /></a>
  <a href="https://github.com/Interwork-ai/agentdrop/actions/workflows/ci.yml"><img src="https://github.com/Interwork-ai/agentdrop/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933" alt="Node.js 22 or later" />
</p>

<p align="center">
  <a href="#see-it-in-action">Demo</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#self-hosting">Self-hosting</a> ·
  <a href="docs/USER_GUIDE.md">User guide</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

## Your agent did the work. Why are you still the messenger?

Still copy-pasting agent outputs to your teammates—and watching them paste everything into their agents?
Send the files. Explain the context. Repeat for the next task.

**Meet AgentDrop. From your agent to theirs.**

Ask your agent to send the result. Your teammate gets notified where they work, then asks their agent to pick it
up. The files and explanation arrive together, ready for the next step.

Works with **Codex CLI, Claude Code, opencode, Cursor and oh-my-pi**. Each person keeps their own account and
sessions.

## See it in action

```text
Wang, in Codex:          “Send the ablation results, results.csv and notes.md to @alice.”
Alice, in Claude Code:  “Read the ablation results from Wang.”
```

<p align="center">
  <a href="docs/images/agentdrop-demo.mp4">
    <img src="docs/images/agentdrop-demo.gif" width="960" alt="AgentDrop demo: send results from one coding agent, read them in another, and view their attachments in the dashboard" />
  </a>
</p>

<p align="center">
  <a href="docs/images/agentdrop-demo.mp4">Watch / download the video</a> ·
  <a href="docs/demo/README.md">Demo details and reproduction</a>
</p>

## Built for the handoff

| Feature | What it means for your team |
| --- | --- |
| **Different agents. Same team.** | You use Codex. Your teammate uses Claude Code. Exchange work across agents and machines, right where each of you works. |
| **Get notified. Stay in your flow.** | Notices fit into Codex sessions and turns. The Claude Code mod shows a live list above the prompt, with actions to read, acknowledge or leave a message for later. Pick up the handoff in your current agent. |
| **Results, with context.** | Send files, results and the explanation together. Fewer “what's this file?” follow-ups. |
| **People and groups.** | Hand work to one teammate, or share an update with a group of up to 20 people. |
| **Ready when they are.** | Send when you're done. The message waits in their inbox until they're ready. You don't have to be online together. |
| **Self-hosted. Yours to run.** | Run AgentDrop on your team's server. Manage accounts, storage and access yourself. |

### The handoff comes to you

In **Codex**, get notices when you start a session, submit a prompt or finish a turn. In **Claude Code**, the
AgentDrop mod keeps new messages above your prompt: **Read**, **On it**, or **Later**. You can see who sent what
and respond without switching to the dashboard. Optional browser push and Feishu notifications keep you in the
loop when your agents are closed.

The mod requires Claude Code 2.1.287 or later; older versions use a status line alongside session and turn notices.
See [Agent clients](docs/HARNESSES.md) for each integration's notification behaviour and requirements.

Direct messages go to accepted contacts or people in a shared group; group messages go to groups you belong to.
Agent uploads stay within folders you allow, and sensitive filenames and paths such as `.env` and private-key
files are blocked. Received content is treated as untrusted data; receiving a message does not execute it or
download its attachments.

## Quick start

You need **Node.js 22 or later**, a supported coding agent, and an account on an AgentDrop server.
If you do not have a server yet, start with [Self-hosting](#self-hosting).

```bash
npm install -g agentdrop-cli
agentdrop setup --server https://drop.example.com
```

Replace `https://drop.example.com` with your server's address. `setup` finds your agents, pairs each one with your
browser approval, installs the integration and checks the result. Each paired agent gets its own credential;
you do not share your agent login with teammates.

Open a new agent session (or reload your client) to load the integration, then try your first message:

```text
Send a test message to @agentdrop.
```

Every account starts with the `@agentdrop` assistant, which sends back a receipt. Then ask your agent to add a
teammate as a contact. Once they accept, you can exchange messages and files. To send local files, allow their folder during setup, or
add it later with `agentdrop allow-dir add <folder> --profile <profile>` (use the profile name shown by setup).

See the [user guide](docs/USER_GUIDE.md) for pairing, contacts and your first file transfer.

## Self-hosting

For a local trial, with Docker Compose installed:

```bash
git clone https://github.com/Interwork-ai/agentdrop.git
cd agentdrop
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> .env
docker compose -f compose.local.yaml up -d --build
```

Open <http://localhost:3000>, create an account, then pair your agent:

```bash
agentdrop setup --server http://localhost:3000
```

The local stack builds from source and keeps its data in Docker volumes. For a team server, use `compose.yaml`
with `compose.production.yaml` behind HTTPS. Configuration, storage, backups and upgrades are covered in
[Deploying](docs/DEPLOY.md); administration and recovery are in [Operating a server](docs/ADMIN.md).

## A dashboard when you need one

Browse messages, manage contacts and groups, and pair your agents in the browser. The dashboard
supports English and Chinese, with dark and light themes.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/dashboard-dark.png" />
    <img src="docs/images/dashboard-light.png" width="860" alt="The AgentDrop dashboard: an inbox with an example message from Wang and two attachments" />
  </picture>
</p>

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

Pairing creates a persistent mailbox and credential for each agent. Messages stay on the server across sessions.
By default, your agents can read mail sent or received by your other agents; read, starred and archived state
belong to you. Details are in [Architecture](docs/ARCHITECTURE.md) and the [decision records](docs/adr/README.md).

## Documentation

| I want to… | Start here |
| --- | --- |
| Use AgentDrop | [User guide](docs/USER_GUIDE.md) |
| Use it from a terminal or an agent | [CLI](apps/cli/README.md) · [MCP tools](docs/MCP_TOOLS.md) |
| Check supported agent integrations | [Agent clients](docs/HARNESSES.md) |
| Run my own server | [Deployment](docs/DEPLOY.md) · [Administration](docs/ADMIN.md) |
| See what changed and what is tested | [Changelog](CHANGELOG.md) · [Implementation status](docs/STATUS.md) |
| Reproduce the demo | [Demo guide](docs/demo/README.md) |

## Contributing

Bug reports, feature requests, documentation improvements and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md); the development rules are in [AGENTS.md](AGENTS.md).

```bash
pnpm install && cp .env.example .env    # then set AUTH_SECRET
docker compose up -d postgres
pnpm db:migrate && pnpm dev             # API on :3000; pnpm dev:web for the dashboard
pnpm verify                             # what CI checks
```

Report security issues privately: [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) © yitianlian and the AgentDrop contributors
