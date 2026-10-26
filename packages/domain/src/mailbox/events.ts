import {
  AgentDropError,
  EVENT_TYPES,
  EVENTS_CURSOR_MAX,
  EVENTS_LIMIT_DEFAULT,
  EVENTS_LIMIT_MAX,
  type EventsInput,
  type EventsResult,
  type StreamEvent,
} from '@agentdrop/contracts';
import { appUsers, mailboxEvents, mailboxHeads, type Tx } from '@agentdrop/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { sha256Hex } from '../crypto.js';
import type { MailboxScope } from '../principals.js';
import { type EndpointScope, visibleEndpointIds } from './authorization.js';

export { EVENTS_CHANNEL } from './revision.js';

/*
 * The per-person event stream (ADR 0040). Each agent's mailbox events are ordered by a revision taken under its
 * `mailbox_heads` row lock, so for one agent the committed events are always a gap-free prefix in revision order,
 * and their global ids grow with the revision. A cursor is the last revision seen per visible agent; the global id
 * only orders a page and is never part of a cursor (it is assigned before commit, SPEC §7.2).
 */

/** What a cursor says once decoded, for the agents visible now. */
interface EventCursor {
  /** Last revision seen per agent. An agent missing here starts at 0: it was paired after the cursor was made. */
  seen: Map<string, number>;
  /** Last `directory_revision` seen. */
  d: number;
}

const KNOWN_TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);

/** Binds a cursor to (person, visibility): used under another scope it is RESYNC_REQUIRED, never a skip. */
function cursorKey(scope: MailboxScope, endpointScope: EndpointScope): string {
  const narrowedTo = endpointScope === 'current' ? scope.hId : '';
  return sha256Hex(JSON.stringify(['events', scope.userId, endpointScope, narrowedTo])).slice(0, 16);
}

/*
 * Cursor format, base64url of:
 *
 *   1 byte    version (1)
 *   8 bytes   tag: the first 8 bytes of sha256(scope key ‖ body), so a cursor of another person or scope, or a
 *             damaged one, is refused as a whole
 *   body:
 *     varint  d, the last directory_revision seen
 *     varint  n, how many entries follow keyed by an id prefix
 *     n ×     the first 8 bytes of an agent id, varint revision
 *     rest ×  the full 16-byte agent id, varint revision
 *
 * Varints are unsigned LEB128. Only agents with revision > 0 are listed, sorted by id within each part. An agent is
 * listed by its 8-byte prefix unless another agent visible to the person shares that prefix; then it takes the full
 * 16 bytes. Decoding resolves prefixes against the agents visible at that moment: an entry matching none is ignored,
 * and a prefix matching several (an agent paired later that happens to share it) is RESYNC_REQUIRED, never a guess.
 *
 * Within EVENTS_CURSOR_MAX characters (6,144 bytes) fit about 550 agents while their revisions stay below 2^21
 * (11 bytes an entry) and at least 380 whatever their revisions (16 bytes an entry).
 */
const CURSOR_VERSION = 1;
const TAG_BYTES = 8;
const PREFIX_BYTES = 8;

function idPrefix(hId: string): string {
  return hId.replaceAll('-', '').slice(0, PREFIX_BYTES * 2);
}

function cursorTag(key: string, body: Buffer): Buffer {
  return Buffer.from(sha256Hex(Buffer.concat([Buffer.from(key, 'hex'), body])), 'hex').subarray(0, TAG_BYTES);
}

function writeVarint(out: number[], value: number): void {
  let n = value;
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

/** Reads the cursor body front to back; any malformed byte throws, and decodeCursor turns that into a resync. */
class Reader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
  bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new Error('short');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  varint(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.bytes(1)[0] as number;
      value += (b & 0x7f) * scale;
      if (b < 0x80) {
        if (!Number.isSafeInteger(value)) throw new Error('range');
        return value;
      }
      scale *= 0x80;
    }
    throw new Error('range');
  }
}

function encodeCursor(key: string, visible: string[], seen: Map<string, number>, d: number): string {
  const sharing = new Map<string, number>();
  for (const hId of visible) sharing.set(idPrefix(hId), (sharing.get(idPrefix(hId)) ?? 0) + 1);
  const entries = [...seen].filter(([, revision]) => revision > 0).sort(([a], [b]) => (a < b ? -1 : 1));
  const short = entries.filter(([hId]) => sharing.get(idPrefix(hId)) === 1);
  const full = entries.filter(([hId]) => sharing.get(idPrefix(hId)) !== 1);
  const body: number[] = [];
  writeVarint(body, d);
  writeVarint(body, short.length);
  for (const [hId, revision] of short) {
    body.push(...Buffer.from(idPrefix(hId), 'hex'));
    writeVarint(body, revision);
  }
  for (const [hId, revision] of full) {
    body.push(...Buffer.from(hId.replaceAll('-', ''), 'hex'));
    writeVarint(body, revision);
  }
  const bodyBytes = Buffer.from(body);
  const raw = Buffer.concat([Buffer.from([CURSOR_VERSION]), cursorTag(key, bodyBytes), bodyBytes]).toString(
    'base64url',
  );
  // Never hand out a cursor the server would refuse. NOT_FOUND is what clients already read as "no event stream
  // here": they keep polling instead.
  if (raw.length > EVENTS_CURSOR_MAX)
    throw new AgentDropError('NOT_FOUND', 'the event stream is not available for this many agents');
  return raw;
}

function decode(bytes: Buffer, key: string, visible: string[]): EventCursor {
  const body = bytes.subarray(1 + TAG_BYTES);
  if (
    bytes[0] !== CURSOR_VERSION ||
    bytes.length < 1 + TAG_BYTES ||
    !cursorTag(key, body).equals(bytes.subarray(1, 1 + TAG_BYTES))
  )
    throw new Error('tag');
  const byPrefix = new Map<string, string[]>();
  for (const hId of visible) byPrefix.set(idPrefix(hId), [...(byPrefix.get(idPrefix(hId)) ?? []), hId]);
  const visibleSet = new Set(visible);
  const reader = new Reader(body);
  const d = reader.varint();
  const seen = new Map<string, number>();
  const put = (hId: string, revision: number) => {
    if (seen.has(hId)) throw new Error('duplicate');
    seen.set(hId, revision);
  };
  for (let n = reader.varint(); n > 0; n--) {
    const matches = byPrefix.get(reader.bytes(PREFIX_BYTES).toString('hex')) ?? [];
    const revision = reader.varint();
    if (matches.length > 1) throw new Error('ambiguous');
    if (matches[0]) put(matches[0], revision);
  }
  while (!reader.done) {
    const hex = reader.bytes(16).toString('hex');
    const hId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const revision = reader.varint();
    if (visibleSet.has(hId)) put(hId, revision);
  }
  return { seen, d };
}

function decodeCursor(raw: string, key: string, visible: string[]): EventCursor {
  try {
    return decode(Buffer.from(raw, 'base64url'), key, visible);
  } catch {
    // Damaged, foreign or from another scope: the answer never says which.
    throw new AgentDropError('RESYNC_REQUIRED', 'the event cursor is not valid for this scope');
  }
}

interface EventRow {
  hId: string;
  revision: number;
  type: string;
  dropId: string | null;
}

/**
 * The first `n` events by global id after each agent's `seen` revision. Each agent is read through the
 * (h_id, revision) index, at most `n` rows each, and the rows are merged by id: an agent's first `n` events by
 * revision are also its first `n` by id, so its share of the page is always a prefix of its events. The cost follows
 * the person's backlog, never the size of the whole table.
 */
async function eventsAfter(tx: Tx, after: Array<[string, number]>, n: number): Promise<EventRow[]> {
  const cursors = sql.join(
    after.map(([hId, seen]) => sql`(${hId}::uuid, ${seen}::bigint)`),
    sql`, `,
  );
  const { rows } = await tx.execute<{
    h_id: string;
    revision: string | number;
    type: string;
    drop_id: string | null;
  }>(sql`
    select e.h_id, e.revision, e.type, e.drop_id
    from (values ${cursors}) as c(h_id, seen)
    cross join lateral (
      select m.id, m.h_id, m.revision, m.type, m.drop_id from ${mailboxEvents} m
      where m.h_id = c.h_id and m.revision > c.seen
      order by m.revision limit ${n}) e
    order by e.id limit ${n}`);
  return rows.map((r) => ({ hId: r.h_id, revision: Number(r.revision), type: r.type, dropId: r.drop_id }));
}

/**
 * Events after `cursor` for the agents the caller may read from (the same `visibleEndpointIds` as lists, so a
 * cursor never widens what a caller sees: visibility is recomputed on every call). Without a cursor the caller
 * subscribes from now and gets no backlog. Copies of one person-level change, written once per agent (ADR 0007),
 * are coalesced to one event per (type, drop) within a page.
 */
export async function readEvents(
  tx: Tx,
  scope: MailboxScope,
  input: Pick<EventsInput, 'cursor' | 'limit' | 'endpoint_scope'>,
): Promise<EventsResult> {
  const limit = Math.min(input.limit ?? EVENTS_LIMIT_DEFAULT, EVENTS_LIMIT_MAX);
  const { endpointScope, hIds } = await visibleEndpointIds(tx, scope, input.endpoint_scope);
  const key = cursorKey(scope, endpointScope);
  const [user] = await tx
    .select({ directoryRevision: appUsers.directoryRevision })
    .from(appUsers)
    .where(eq(appUsers.id, scope.userId));
  if (!user) throw new AgentDropError('UNAUTHORIZED');
  const heads = new Map(
    (hIds.length
      ? await tx
          .select({ hId: mailboxHeads.hId, revision: mailboxHeads.revision })
          .from(mailboxHeads)
          .where(inArray(mailboxHeads.hId, hIds))
      : []
    ).map((h) => [h.hId, h.revision]),
  );
  const head = (hId: string) => heads.get(hId) ?? 0;

  if (!input.cursor)
    return {
      events: [],
      cursor: encodeCursor(key, hIds, heads, user.directoryRevision),
      has_more: false,
    };

  const cursor = decodeCursor(input.cursor, key, hIds);
  const seen = (hId: string) => cursor.seen.get(hId) ?? 0;
  // A cursor ahead of this database (restored from a backup, or made by hand) claims events that never happened
  // here; following it would skip the ones that happen next.
  if (cursor.d > user.directoryRevision || hIds.some((hId) => seen(hId) > head(hId)))
    throw new AgentDropError('RESYNC_REQUIRED', 'the event cursor is ahead of this server');

  const behind = hIds.filter((hId) => head(hId) > seen(hId));
  const rows = behind.length
    ? await eventsAfter(
        tx,
        behind.map((hId) => [hId, seen(hId)]),
        limit + 1,
      )
    : [];
  const hasMore = rows.length > limit;

  // Retention may have swept events this cursor has not seen, anywhere in an agent's range: they cannot be
  // replayed, so the caller resyncs. Each agent's rows must continue its cursor without a gap, and when the whole
  // backlog fitted, reach its head (rows are read after the heads, so every revision up to the head is committed).
  const last = new Map<string, number>();
  for (const row of rows) {
    if (row.revision !== (last.get(row.hId) ?? seen(row.hId)) + 1)
      throw new AgentDropError('RESYNC_REQUIRED', 'events after this cursor are no longer kept');
    last.set(row.hId, row.revision);
  }
  if (!hasMore && behind.some((hId) => (last.get(hId) ?? seen(hId)) < head(hId)))
    throw new AgentDropError('RESYNC_REQUIRED', 'events after this cursor are no longer kept');

  const next = new Map(cursor.seen);
  const events: StreamEvent[] = [];
  const emitted = new Set<string>();
  for (const row of rows.slice(0, limit)) {
    next.set(row.hId, row.revision);
    if (!KNOWN_TYPES.has(row.type)) continue;
    const id = `${row.type}\u0000${row.dropId ?? ''}`;
    if (emitted.has(id)) continue;
    emitted.add(id);
    events.push({ type: row.type as StreamEvent['type'], drop_id: row.dropId });
  }
  if (user.directoryRevision > cursor.d) events.push({ type: 'directory.changed', drop_id: null });

  return {
    events,
    cursor: encodeCursor(key, hIds, next, user.directoryRevision),
    has_more: hasMore,
  };
}

/**
 * Deletes up to `batch` mailbox events older than `before` (retention, ADR 0040), oldest first; returns how many
 * went. Ordered by `created_at`, as `mailbox_events_created_idx` is, so each batch reads the index from its start
 * instead of sorting every expired row by id. A hole this leaves in an agent's range is what readEvents answers
 * with RESYNC_REQUIRED.
 */
export async function sweepMailboxEvents(tx: Tx, before: Date, batch = 5000): Promise<number> {
  const result = await tx.execute(sql`
    delete from ${mailboxEvents} where ${mailboxEvents.id} in (
      select e.id from ${mailboxEvents} e where e.created_at < ${before} order by e.created_at limit ${batch})`);
  return result.rowCount ?? 0;
}
