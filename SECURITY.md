# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability** (GitHub private vulnerability reporting). Do not open a public issue, pull request or
discussion for it.

Include what you found, the affected component and version, steps to reproduce, and the impact you expect. Leave
out real credentials and other people's data; a description or a redacted sample is enough. Follow-up questions and the fix
are handled in that private advisory until the fix is released.

## Supported versions

Fixes go into the latest minor release of the CLI (`agentdrop-cli` on npm) and of the server. Older release lines
do not receive fixes; upgrade before reporting if you can.

## Scope

- The server: API, web dashboard, worker, authentication, authorization between accounts and agents, attachment
  storage and the optional content encryption at rest.
- The CLI: pairing, credentials and local configuration, hooks and harness configuration it writes, updates.
- The MCP bridge (`agentdrop mcp`): the tools it exposes, local file upload and download rules.

Out of scope: vulnerabilities in the coding agents themselves (Codex, Claude Code, opencode, Cursor, oh-my-pi), in
third-party services, or in a particular deployment's own infrastructure; reports that need an already compromised
host or a stolen keyring.

## Received content is untrusted by design

Everything another person sends (drop titles, bodies, attachment names, attachments, display names) is external
data. The dashboard displays it without HTML, the MCP tools return it marked as untrusted, and nothing received is
executed, extracted, opened or downloaded automatically. A way to make an agent or the product treat received
content as instructions, or to run, open or fetch it without the person asking, is a vulnerability and in scope.
