# 0004. Client/server compatibility window and expand-only migrations

- Status: Accepted
- Date: 2026-09-23

## Context

The CLI is installed on users' machines and updates on its own schedule; servers are deployed separately. Both
must keep working across a rolling upgrade and a rollback.

## Decision

- A server release keeps serving the CLI from the previous minor release; a CLI release keeps working against the
  previous minor server (new fields are optional on read, e.g. `group_join_requests ?? []`).
- Database migrations are expand → migrate → contract, never destructive in the release that introduces them, so
  the previous image runs against the new schema and a rollback needs no down-migration. Deploy scripts take a
  database dump first.
- Removing a CLI flag, MCP tool field, `/v1` route or error code is a breaking change: deprecate it in one minor
  release (changelog `Deprecated`), remove it no earlier than the next.

## Consequences

Contract changes are additive by default; deletions take two releases. See docs/RELEASE.md for how this maps to
version numbers.
