import { type Query, type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/*
 * Live updates from the person's event stream (ADR 0040). The stream only says what changed (types and drop ids);
 * the dashboard refetches the affected views through the ordinary routes, under the usual authorization. It only
 * makes the dashboard quicker: every view keeps its background refetch, so a stream that is missing, buffered by a
 * proxy or dead costs nothing but speed.
 *
 * Only a visible tab holds a stream: over plain HTTP/1.1 a browser allows six connections per origin across all its
 * tabs. The decisions below are plain functions, tested without a browser.
 */

export interface LiveEvent {
  type: string;
  drop_id: string | null;
}

/** What a batch of events changed, by the views it touches. */
export interface Change {
  /** Deliveries and their state: mailbox lists, counts and drops, group timelines. */
  mailbox: boolean;
  /** Drops the person sent, new or with moved receipts: the sent view, group timelines and open drops. */
  sent: boolean;
  /** Deliveries arriving or going and files removed: a group's details and files (not read state or receipts). */
  groups: boolean;
  /** Contacts, groups, invitations, join requests and names, and with them the pending counts every list carries. */
  directory: boolean;
  /**
   * Nothing but the person's own read, starred or archived state changed. Only the person changes that (from this
   * tab, another tab, an agent or the CLI), so right after a mutation of this tab it is most likely its echo.
   */
  stateOnly: boolean;
}

/** A stream opened without a cursor carries no backlog: whatever happened before it is only in a refetch. */
export const EVERYTHING: Change = {
  mailbox: true,
  sent: true,
  groups: true,
  directory: true,
  stateOnly: false,
};

/** Types that leave a group's details and files as they were. */
const NOT_GROUP_TYPES: ReadonlySet<string> = new Set(['delivery.state', 'sent.changed', 'directory.changed']);

/** A type this dashboard does not know yet counts as a change to the mailbox and groups, never as nothing. */
export function changeOf(events: LiveEvent[]): Change {
  return {
    mailbox: events.some((e) => e.type !== 'directory.changed' && e.type !== 'sent.changed'),
    sent: events.some((e) => e.type === 'sent.changed'),
    groups: events.some((e) => !NOT_GROUP_TYPES.has(e.type)),
    directory: events.some((e) => e.type === 'directory.changed'),
    stateOnly: events.length > 0 && events.every((e) => e.type === 'delivery.state'),
  };
}

/** Both changes at once, for batches merged before one refetch. */
export function mergeChanges(a: Change, b: Change): Change {
  return {
    mailbox: a.mailbox || b.mailbox,
    sent: a.sent || b.sent,
    groups: a.groups || b.groups,
    directory: a.directory || b.directory,
    stateOnly: a.stateOnly && b.stateOnly,
  };
}

function isEmpty(change: Change): boolean {
  return !change.mailbox && !change.sent && !change.groups && !change.directory;
}

/** Refetch now if it is on screen, only mark it stale (it refetches on its next mount, keystroke or focus), or neither. */
export type Refresh = 'refetch' | 'mark' | null;

/**
 * What a change does to one cached query. Two kinds are only marked stale, never refetched by the stream:
 * - a search (`mailboxKey(hId, 'list', view, searchTerm, …)`), which decrypts up to 2000 messages on the server and
 *   is rate-limited per person;
 * - the directory, whose open recipient list in the composer would reorder under the keyboard highlight.
 */
export function refreshOf(hId: string, change: Change, queryKey: readonly unknown[]): Refresh {
  switch (queryKey[0]) {
    case 'mailbox': {
      if (queryKey[1] !== hId) return null;
      // a directory change moves the pending counts (requests, invitations, join requests) of every list
      const touched = change.mailbox || change.directory || (change.sent && showsSent(queryKey));
      if (!touched) return null;
      const search = queryKey[2] === 'list' && typeof queryKey[4] === 'string' && queryKey[4] !== '';
      return search ? 'mark' : 'refetch';
    }
    case 'group':
      return change.groups || change.directory ? 'refetch' : null;
    case 'contacts':
    case 'groups':
    case 'group-join-requests':
    case 'me':
      return change.directory ? 'refetch' : null;
    case 'directory':
      return change.directory ? 'mark' : null;
    default:
      return null;
  }
}

/**
 * Mailbox views that show the person's own drops and their receipts: the sent view, group timelines (own posts
 * included, ADR 0033), an open drop and the getting-started step that waits for a first send.
 * Keys: `mailboxKey(hId, 'list', view, search, unreadOnly, groupId, …)`, `mailboxKey(hId, 'drop', dropId, …)`.
 */
function showsSent(queryKey: readonly unknown[]): boolean {
  if (queryKey[2] === 'list')
    return queryKey[3] === 'sent' || (typeof queryKey[6] === 'string' && queryKey[6] !== '');
  return queryKey[2] === 'drop' || queryKey[2] === 'getting-started-sent';
}

/** Batches arriving within this window are merged into one refetch. */
export const COALESCE_MS = 400;
/** A batch of nothing but the person's own state this soon after a mutation of this tab is taken as its echo. */
export const ECHO_MS = 2_000;

/**
 * Whether a cached query already shows the changes that last reached the tab at `since`, so refetching it again
 * would only repeat a request. `fetchedFrom` is when its latest fetch started: a fetch started after an event
 * arrived reads a database that already holds it. A batch of only the person's own state right after a mutation of
 * this tab (`ownMutationAt`, taken before the mutation's own refetches start) is the mutation's echo, which the
 * mutation's refetch already covers; were it another agent's change in the same moment, the background refetch
 * shows it within its 10 s.
 */
export function alreadyFresh(
  fetchedFrom: number | undefined,
  since: number,
  change: Change,
  ownMutationAt: number,
): boolean {
  if (fetchedFrom === undefined) return false;
  if (fetchedFrom >= since) return true;
  return change.stateOnly && since - ownMutationAt <= ECHO_MS && fetchedFrom >= ownMutationAt;
}

/**
 * Merges changes that arrive within `windowMs` of the first one and applies them once, at the end of the window,
 * with the time the last of them arrived (a fetch started before that may have missed it). A burst (a mark-all-read,
 * a group fan-out, another agent working through the inbox) costs one refetch per view instead of one per batch.
 */
export function coalesce(
  apply: (change: Change, since: number) => void,
  windowMs = COALESCE_MS,
  now: () => number = Date.now,
): { push(change: Change): void; stop(): void } {
  let pending: Change | null = null;
  let since = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    push(change) {
      if (isEmpty(change)) return;
      since = now();
      if (pending) {
        pending = mergeChanges(pending, change);
        return;
      }
      pending = change;
      timer = setTimeout(() => {
        const merged = pending;
        pending = null;
        timer = null;
        if (merged) apply(merged, since);
      }, windowMs);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

/** When the dashboard's latest mutation succeeded; see `noteOwnMutation`. */
let ownMutationAt = Number.NEGATIVE_INFINITY;

/**
 * Called by the QueryClient's mutation cache when a mutation succeeds, before that mutation's own `onSuccess`
 * starts its refetches (main.tsx), so `alreadyFresh` can tell the echo of this tab's change from news.
 */
export function noteOwnMutation(): void {
  ownMutationAt = Date.now();
}

function refresh(
  qc: QueryClient,
  hId: string,
  change: Change,
  since: number,
  fetchedFrom: WeakMap<Query, number>,
): void {
  const stale = (q: Query) => !alreadyFresh(fetchedFrom.get(q), since, change, ownMutationAt);
  void qc.invalidateQueries({
    predicate: (q) => refreshOf(hId, change, q.queryKey) === 'refetch' && stale(q),
  });
  void qc.invalidateQueries({
    predicate: (q) => refreshOf(hId, change, q.queryKey) === 'mark' && stale(q),
    refetchType: 'none',
  });
}

/** The `events` frame the server wrote; anything malformed counts as a frame that changed nothing. */
export function parseEvents(data: unknown): LiveEvent[] {
  try {
    const raw = JSON.parse(String(data)) as { events?: unknown };
    return Array.isArray(raw.events) ? (raw.events as LiveEvent[]) : [];
  } catch {
    return [];
  }
}

/** The parts of an EventSource the stream uses (tests pass a stand-in). */
export interface StreamSource {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

/** What the stream needs from the browser. */
export interface StreamHost {
  connect(url: string): StreamSource;
  /**
   * The HTTP status of an ordinary request to `url` (no cursor, so it answers at once), or null when none came.
   * EventSource never tells why it refused a connection; this does, once per refusal.
   */
  status(url: string): Promise<number | null>;
  visible(): boolean;
  refresh(change: Change): void;
}

/** `EventSource.CLOSED`: the browser gave up on the connection (an error answer); it will not reconnect by itself. */
const CLOSED = 2;
export const FIRST_RETRY_MS = 5_000;
export const MAX_RETRY_MS = 60_000;
/** The server writes a `ping` whenever it has written nothing for 25 s: a stream silent this long is dead. */
export const SILENCE_MS = 60_000;
/**
 * Answers that retrying will not change: signed out (401), not allowed (403), and no stream for this agent here
 * (404: an agent no longer the person's, a server without the stream, or too many agents for one cursor).
 */
const FINAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/**
 * Follows the event stream of one agent's person while the tab is visible.
 *
 * - A stream opened without a cursor (first open, after a restart, on returning to the tab) refetches everything it
 *   covers when its first frame arrives: from then on events cover every change.
 * - A dropped connection, including the server ending a stream (at most every 15 minutes, and whenever the session
 *   no longer passes), is resumed by EventSource itself through `Last-Event-ID`: nothing is missed or refetched.
 * - A `resync` and a stream silent for SILENCE_MS get a fresh stream (a new cursor) after a pause.
 * - A refused connection (CLOSED) asks once why. Signed out, not allowed or not found: no more attempts, and the
 *   views keep their background refetch; returning to the tab tries once more. Anything else, such as a cursor
 *   refused on reconnecting (stale, foreign or too long) or a server error, gets a fresh stream after a pause.
 */
export function followStream(
  hId: string,
  host: StreamHost,
): { visibility(visible: boolean): void; stop(): void } {
  const url = `/v1/me/endpoints/${encodeURIComponent(hId)}/events`;
  let source: StreamSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let delay = FIRST_RETRY_MS;
  /** Bumped by every stop, hide and new stream, so the answer of an older status check is ignored. */
  let generation = 0;
  let checking = false;
  let gaveUp = false;

  const close = () => {
    generation += 1;
    checking = false;
    source?.close();
    source = null;
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };
  const later = () => {
    retry = setTimeout(() => {
      retry = null;
      open();
    }, delay);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  };
  const restart = () => {
    close();
    later();
  };
  const refused = () => {
    close();
    const asked = generation;
    checking = true;
    void host.status(url).then(
      (status) => {
        if (asked !== generation) return;
        checking = false;
        if (status !== null && FINAL_STATUSES.has(status)) gaveUp = true;
        else later();
      },
      () => {
        if (asked !== generation) return;
        checking = false;
        later();
      },
    );
  };
  const open = () => {
    if (source || retry || checking || gaveUp || !host.visible()) return;
    const es = host.connect(url);
    source = es;
    let fresh = true;
    // armed from the start: a stream whose frames never arrive (a proxy that buffers the body) is given up too
    const heard = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(restart, SILENCE_MS);
    };
    heard();
    es.addEventListener('events', (e) => {
      if (source !== es) return;
      heard();
      delay = FIRST_RETRY_MS;
      if (fresh) {
        fresh = false;
        host.refresh(EVERYTHING);
        return;
      }
      const events = parseEvents(e.data);
      if (events.length) host.refresh(changeOf(events));
    });
    es.addEventListener('ping', () => {
      if (source === es) heard();
    });
    // the cursor went stale (retention, a changed read scope): a fresh stream starts over without it
    es.addEventListener('resync', () => {
      if (source === es) restart();
    });
    es.addEventListener('error', () => {
      if (source === es && es.readyState === CLOSED) refused();
    });
  };

  open();
  return {
    visibility: (visible) => {
      if (!visible) return close();
      // the person came back: one more attempt, even after an answer that stopped them
      gaveUp = false;
      open();
    },
    stop: () => {
      if (retry) clearTimeout(retry);
      retry = null;
      close();
    },
  };
}

/** Holds the event stream of the selected agent's person while the tab is visible. */
export function useLiveEvents(hId: string | null): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!hId || typeof EventSource === 'undefined') return;
    // When each query's latest fetch started, so a refetch the person's own action already caused is not repeated.
    const fetchedFrom = new WeakMap<Query, number>();
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'fetch') fetchedFrom.set(event.query, Date.now());
    });
    const batches = coalesce((change, since) => refresh(qc, hId, change, since, fetchedFrom));
    const stream = followStream(hId, {
      connect: (url) => new EventSource(url),
      status: (url) =>
        fetch(url, { credentials: 'include', headers: { accept: 'application/json' } }).then(
          (res) => {
            void res.body?.cancel();
            return res.status;
          },
          () => null,
        ),
      visible: () => document.visibilityState === 'visible',
      refresh: (change) => batches.push(change),
    });
    const onVisibility = () => stream.visibility(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stream.stop();
      batches.stop();
      unsubscribe();
    };
  }, [hId, qc]);
}
