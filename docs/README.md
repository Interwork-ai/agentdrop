# Documentation index

| I want to… | Read |
|---|---|
| use AgentDrop as a person (pairing, contacts, sending, groups, approvals, FAQ) | [USER_GUIDE.md](USER_GUIDE.md) |
| know what the agent-side tools do and how they fail | [MCP_TOOLS.md](MCP_TOOLS.md) |
| run a server for a team, back it up, upgrade it | [DEPLOY.md](DEPLOY.md) |
| operate it: accounts, suspension, sign-up mode, audit log | [ADMIN.md](ADMIN.md) |
| try it on a server without a domain (http on a high port) | [DEPLOY_TRIAL.md](DEPLOY_TRIAL.md) |
| understand the code before changing it | [ARCHITECTURE.md](ARCHITECTURE.md), then `AGENTS.md` at the repo root |
| know what is implemented, tested, untested, unsupported | [STATUS.md](STATUS.md) |
| see the real-client interop evidence | [INTEROP.md](INTEROP.md) |
| check that Codex / Claude Code / opencode / Cursor / oh-my-pi / WorkBuddy get the same capabilities | [HARNESSES.md](HARNESSES.md) |
| publish a new CLI version | [RELEASE.md](RELEASE.md) |
| know why things are the way they are | [adr/](adr/README.md) (decision records; they win over anything older) |
| change the dashboard's look | [DESIGN.md](DESIGN.md) |
| keep the product's behaviour consistent for people | [PRODUCT_PRINCIPLES.md](PRODUCT_PRINCIPLES.md) |
| know what a commit may contain, and what never | [PUBLIC_REPOSITORY.md](PUBLIC_REPOSITORY.md) |
| contribute a change | [CONTRIBUTING.md](../CONTRIBUTING.md), [QUALITY.md](QUALITY.md) |
| read the original v0.2 design and the content-encryption plan | [plan/](plan/) (historical; the ADRs supersede it) |

In-product documentation for end users lives at `/app/help` on a running server (the 使用说明 page).

CLI command help: `apps/cli/README.md` or `agentdrop --help`. HTTP contract: `packages/contracts/json/openapi.json`.
