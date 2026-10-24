import { type QueryClient, useQueryClient } from '@tanstack/react-query';
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
  /** Deliveries and their state: mailbox lists, counts and drops, group timelines and files. */
  mailbox: boolean;
  /** Contacts, groups, invitations, join requests and names, and with them the pending counts every list carries. */
  directory: boolean;
}

/** A stream opened without a cursor carries no backlog: whatever happened before it is only in a refetch. */
export const EVERYTHING: Change = { mailbox: true, directory: true };

export function changeOf(events: LiveEvent[]): Change {
  return {
    mailbox: events.some((e) => e.type !== 'directory.changed'),
    directory: events.some((e) => e.type === 'directory.changed'),
  };
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
  const any = change.mailbox || change.directory;
  switch (queryKey[0]) {
    case 'mailbox': {
      // a directory change moves the pending counts (requests, invitations, join requests) of every list
      if (queryKey[1] !== hId || !any) return null;
      const search = queryKey[2] === 'list' && typeof queryKey[4] === 'string' && queryKey[4] !== '';
      return search ? 'mark' : 'refetch';
    }
    case 'group':
      return any ? 'refetch' : null;
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

function refresh(qc: QueryClient, hId: string, change: Change): void {
  void qc.invalidateQueries({ predicate: (q) => refreshOf(hId, change, q.queryKey) === 'refetch' });
  void qc.invalidateQueries({
    predicate: (q) => refreshOf(hId, change, q.queryKey) === 'mark',
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
 * Follows the event stream of one agent's person while the tab is visible.
 *
 * - A stream opened without a cursor (first open, after a restart, on returning to the tab) refetches everything it
 *   covers when its first frame arrives: from then on events cover every change.
 * - A dropped connection, including the server ending a stream (at most every 15 minutes, and whenever the session
 *   no longer passes), is resumed by EventSource itself through `Last-Event-ID`: nothing is missed or refetched.
 * - A refused connection (CLOSED), a `resync` and a stream silent for SILENCE_MS get a fresh stream after a pause.
 */
export function followStream(
  hId: string,
  host: StreamHost,
): { visibility(visible: boolean): void; stop(): void } {
  let source: StreamSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let delay = FIRST_RETRY_MS;

  const close = () => {
    source?.close();
    source = null;
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };
  const restart = () => {
    close();
    retry = setTimeout(() => {
      retry = null;
      open();
    }, delay);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  };
  const open = () => {
    if (source || retry || !host.visible()) return;
    const es = host.connect(`/v1/me/endpoints/${encodeURIComponent(hId)}/events`);
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
    // the cursor went stale (retention, a changed read scope): a fresh stream refetches everything
    es.addEventListener('resync', () => {
      if (source === es) restart();
    });
    es.addEventListener('error', () => {
      if (source === es && es.readyState === CLOSED) restart();
    });
  };

  open();
  return {
    visibility: (visible) => (visible ? open() : close()),
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
    const stream = followStream(hId, {
      connect: (url) => new EventSource(url),
      visible: () => document.visibilityState === 'visible',
      refresh: (change) => refresh(qc, hId, change),
    });
    const onVisibility = () => stream.visibility(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stream.stop();
    };
  }, [hId, qc]);
}
