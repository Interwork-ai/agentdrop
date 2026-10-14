# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-09-23

## Context

AgentDrop is meant to live for years and is maintained largely by coding agents across many sessions. Decisions
made in one conversation were so far scattered over `docs/plan/*`, review notes and commit messages, and had to be
rediscovered.

## Decision

Keep decisions that are expensive to reverse in `docs/adr/`, one short record each, and point `AGENTS.md` at them.
Operational facts stay in `docs/STATUS.md`; how-to stays in the other docs.

## Consequences

A new contributor or agent reads the index before changing a governed area. Changing such a decision means
writing a superseding record, which makes the reversal visible.
