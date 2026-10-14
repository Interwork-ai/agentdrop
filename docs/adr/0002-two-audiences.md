# 0002. Text for people and text for models are written separately

- Status: Accepted
- Date: 2026-09-23

## Context

The same strings used to reach both the person (Stop notice, dashboard) and the model (prompt context, tool
results): people saw `agentdrop inbox --unread（加 --profile）` inside a chat, and models were told to open a browser.
Notices also repeated every pending item after each interval.

## Decision

- Every emitted string has one audience, decided by how it is delivered. People: dashboard, Stop/idle notices,
  push, interactive CLI output. Models: tool results, MCP instructions, `next_action`, prompt-time context,
  Cursor framing, the skill, autorun messages.
- People read their language (English by default, Chinese on request) and are told what happened and what they
  can do where they are; notices announce each item once. Models read English, see everything pending, are pointed
  at tools, and relay person-only steps as "tell the user …".
- The same facts may reach both through separate builders (`notificationText` / `pendingContextText`); the
  dashboard maps error codes to its own sentences instead of showing `next_action`.

## Consequences

Two texts to maintain per fact. Tests guard the split: notice/context tests, the `next_action` audience test and
the dashboard i18n coverage test.
