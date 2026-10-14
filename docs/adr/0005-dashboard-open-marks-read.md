# 0005. Opening a drop in the dashboard marks it read

- Status: Accepted
- Date: 2026-09-24

## Context

The dashboard required a separate "Mark as read" click after opening a drop (a 2026-09-19 decision), so drops a
person had plainly read stayed unread. Agents, by contrast, may read a drop through the account-wide view or while
handling something else, and must not change state as a side effect.

## Decision

When a person opens a drop in the dashboard and any of their agents received it, the page marks it read once,
through the same explicit `PATCH …/state` call the button used (since ADR 0007 that is the person's state, shared
by all their agents). An admin view of a drop none of their agents received and later pages of a long body are
never touched. "Mark as unread" stays. API, MCP and CLI reads keep
AGENTS.md rule 2: they never auto-mark.

## Consequences

The server keeps one rule for reads; the convenience lives in the one client used by people. Supersedes the
earlier dashboard rule that opening a drop does not mark it read.
