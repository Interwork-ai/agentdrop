# 0040. Events are hints: a resumable per-person event stream

- Status: Accepted
- Date: 2026-10-24
- Refines: ADR 0007 (all agents of an account are one reader), SPEC §7.2–§7.3 (refresh, consistency, outbox)

## Context

Every delivery and every state change already appends an ordered event for each affected agent
(`mailbox_events`, numbered by a per-agent revision taken under the `mailbox_heads` row lock) inside the same
transaction, but nothing reads those events. Every client surface polls instead: the dashboard every 10 s, the
Claude Code mod every 20 s, autorun every 60 s, and hooks at host events. Reactions wait for the next poll, each
surface carries its own loop, and an agent cannot react while a person is away without polling all day.

## Decision

- **One stream per person, delivery stays per agent.** `GET /v1/h/events` (agent credential) and
  `GET /v1/me/endpoints/:h_id/events` (browser session, an owned agent as for every dashboard mailbox route) return
  the events of the agents the caller may read from, resolved with the same `visibleEndpointIds` as lists. Read,
  starred and archived belong to the person (ADR 0007), so the person is the unit a client subscribes as.
- **One cursor, two transports.** Long-poll (`?wait=` up to 25 s; returns at once when events exist) and SSE
  (`Accept: text/event-stream`), the latter a thin wrapper around the same read. A client behind a proxy that
  buffers SSE can use long-poll without changing anything else.
- **The cursor is opaque.** Inside, it is the per-agent revisions the client has seen, the person's
  `directory_revision` and a tag binding it to the person and read scope, in a compact binary form (an 8-byte id
  prefix and a varint per agent, so several hundred agents fit in its 8,192 characters). A cursor of another
  person or scope, a damaged one, one ahead of the server (a restored database) and one that needs events retention
  already swept answer `RESYNC_REQUIRED`, and the client refetches its views. A newly paired agent starts at
  revision 0. The server never issues a cursor it would refuse; a person with so many
  agents that it would not fit gets `NOT_FOUND`, as from a server without the stream. The global
  `mailbox_events.id` is never a cursor: it is assigned before commit, so it does not follow commit order
  (SPEC §7.2).
- **Events carry ids and a type, never content.** Types: `delivery.created`, `delivery.state`, `grant.revoked`,
  `drop.revoked`, `attachment.removed`, `sent.changed` (see the amendment below), and `directory.changed` when the
  person's `directory_revision` moves (contacts, groups and their membership, roles, ownership, policies,
  invitations and join requests, names, and the account-wide read setting). Titles, bodies and names are read
  through the existing endpoints, under the one authorization predicate (AGENTS.md rule 4), so no content reaches a
  reader the predicate would refuse. The stream itself does not re-check each drop: it returns the events written
  to the agents the caller may read from, and an event names only a type and a drop id. Some go to agents that can
  no longer open that drop (`drop.revoked` goes to every agent that held it, and `grant.revoked` to the agent that
  lost it); such a reader learns only that something about an id it was already given changed, and reading the drop
  answers `NOT_FOUND` as anywhere else. `attachment.removed` goes only to agents with a valid grant. The copies of
  one change that ADR 0007 writes for each of a person's agents are written next to each other and coalesced
  within a batch.
- **Wake-up without new infrastructure.** The writing transaction calls `pg_notify('agentdrop_events', user_id)`
  once per affected person; PostgreSQL delivers it on commit. Each API process listens on one connection (TCP
  keepalive and a periodic check reconnect it when it dies silently) and wakes its waiting requests; every waiter
  also re-reads on a timer, which covers a missed notification.
- **A long-lived request stays authorized.** Before writing a batch, and at least every 25 s, an open stream runs
  the same credential or session check as a new request, for the same person and agent; a revoked agent or
  credential, a signed-out session or a suspended or closed account ends it. An SSE stream also ends after at most
  15 minutes; EventSource reconnects through `Last-Event-ID` and the usual checks. An idle stream writes a named
  `ping` event every 25 s, so clients can tell a dead connection from a quiet one, and a client that stops reading
  is cut off instead of buffered.
- **Events are hints; the database is the truth.** Delivery is at least once and consumers are idempotent. A
  client uses the stream to be quicker, never instead of reading: the dashboard keeps its 10 s background refetch,
  so a missing, buffered or dead stream costs it only speed. Clients that only poll keep working unchanged.
- **Retention.** `mailbox_events` keeps a bounded window (default 30 days), swept by the worker.
- **Discovery.** `/.well-known/agentdrop` advertises the protocol version and capabilities (`events`). Current
  clients detect the stream by a `NOT_FOUND` from its route; an older server answers the well-known path with the
  dashboard page (200, HTML), so a reader must accept only a JSON answer.

## Consequences

The dashboard reacts within a second. The Claude Code band and the hidden autorun keep polling: a waiting request
in every agent session would keep a process alive per session. They can follow the stream through one watcher per
machine, decided separately, together with the envelope semantics that tell such a watcher what deserves a
session's attention.

The API holds long-lived connections, at most 20 per person per API process, plus one PostgreSQL connection per
process for LISTEN, which must be a direct or session-mode connection (a transaction-mode pooler accepts LISTEN but
never delivers). `pg_notify` inside the writing transaction takes a
cluster-wide lock at commit, so notifying commits are serialized; that is accepted at this product's write volume.
A later per-person log can replace the vector cursor without changing any client, because the cursor is opaque.

## Amendment (2026-10-26): the author's side

As first accepted, events reached only the agents holding a delivery, so a person's own send (from an agent, the CLI
or a held send approved later) and every change to its read receipts reached their dashboard only through the 10 s
refetch, contrary to "the dashboard reacts within a second". The author's agents now get events too:

- **`sent.changed`** names a drop the person sent. It is written when the drop is committed (also a held send once
  approved) and whenever the author's receipt for one recipient moves: that person first opens or reads it (the
  open of the body, marking it read, or the read implied by their own reply or group post, ADR 0016), or marks it
  unread again before ever opening it. Starring and archiving by a recipient announce nothing.
- It is written to the drop's sending agent only. That is exactly whom the authorization predicate lets read the
  drop as its sender: the sending agent, and with account-wide reads every agent of the author, whose streams
  include the sending agent's events. An agent narrowed to itself does not hear of another agent's sends.
- It carries the drop id and the type, never which recipient, agent or device caused it (ADR 0013): the row's
  agent is the author's own, its delivery id is empty and its payload is `{}`. Who read the drop is read, as
  before, through the drop's receipts.
- New types are added this way, additively: a reader ignores a type it does not know. The dashboard refetches its
  sent view and open drops on `sent.changed`, and treats any other unknown type as a mailbox change;
  `ApiClient.events` passes types through without validating them.
