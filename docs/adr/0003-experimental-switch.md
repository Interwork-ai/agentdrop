# 0003. Experimental features sit behind one build-time switch

- Status: Accepted
- Date: 2026-09-23

## Context

Autorun (queueing new drops into an open harness session) touches security-sensitive paths and depends on host
features in preview (Claude Code channels). It had to be developable without reaching users.

## Decision

`experimentalEnabled()` in `apps/cli/src/experimental.ts` gates every experimental entry point. The published
package is bundled with the switch defined as `false`; `scripts/check-cli-boundary.mjs` fails `pnpm build:cli`
if the bundle still knows an experimental command. From source it needs `AGENTDROP_EXPERIMENTAL=1`.

## Consequences

Experimental code ships in the repository but not to users, and cannot be switched on in a release by any
environment variable. Promoting a feature means removing its gate in a normal release with a changelog entry.
