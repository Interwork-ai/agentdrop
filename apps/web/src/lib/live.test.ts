import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Change,
  changeOf,
  EVERYTHING,
  FIRST_RETRY_MS,
  followStream,
  refreshOf,
  SILENCE_MS,
  type StreamHost,
  type StreamSource,
} from './live.js';

const delivery = (type = 'delivery.created') => ({ type, drop_id: 'd1' });
const directory = { type: 'directory.changed', drop_id: null };
const search = ['mailbox', 'h1', 'list', 'inbox', 'invoice', false, null];
const inbox = ['mailbox', 'h1', 'list', 'inbox', '', false, null];
const composerSearch = ['directory', 'h1', 'an'];

describe('refreshOf', () => {
  it('refetches the selected agent’s mailbox views and group details when a delivery changes', () => {
    for (const type of [
      'delivery.created',
      'delivery.state',
      'grant.revoked',
      'drop.revoked',
      'attachment.removed',
    ]) {
      const change = changeOf([delivery(type)]);
      for (const key of [
        inbox,
        ['mailbox', 'h1', 'list', 'sent', '', false, null],
        ['mailbox', 'h1', 'unread'],
        ['mailbox', 'h1', 'drop', 'd1', 0],
        ['group', 'g1', 'h1'],
      ])
        expect(refreshOf('h1', change, key)).toBe('refetch');
      for (const key of [['contacts'], ['groups', 'h1'], ['directory', 'h1', ''], ['me']])
        expect(refreshOf('h1', change, key)).toBeNull();
    }
  });

  it('never refetches a search from the stream, only marks it stale (each search decrypts up to 2000 messages)', () => {
    expect(refreshOf('h1', changeOf([delivery('delivery.state')]), search)).toBe('mark');
    expect(refreshOf('h1', EVERYTHING, search)).toBe('mark');
  });

  it('refetches relationships, groups, the account and every mailbox list (their pending counts) on a directory change', () => {
    const change = changeOf([directory]);
    for (const key of [
      ['contacts'],
      ['groups', 'h1'],
      ['group', 'g1', 'h1'],
      ['group-join-requests', ['g1']],
      ['me'],
      inbox,
    ])
      expect(refreshOf('h1', change, key)).toBe('refetch');
  });

  it('only marks the directory stale, so the composer’s open recipient list never reorders under the highlight', () => {
    expect(refreshOf('h1', changeOf([directory]), composerSearch)).toBe('mark');
  });

  it('leaves views no event covers alone, and another agent’s cached mailbox', () => {
    for (const key of [['connections'], ['approvals', 'pending'], ['mailbox', 'h2', 'unread']])
      expect(refreshOf('h1', EVERYTHING, key)).toBeNull();
    expect(refreshOf('h1', changeOf([]), inbox)).toBeNull();
  });
});

/** A stand-in EventSource: the test plays the server's frames and the browser's errors. */
class FakeSource implements StreamSource {
  readyState = 0;
  closed = false;
  private readonly handlers = new Map<string, Array<(event: { data?: unknown }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data?: unknown): void {
    if (type === 'events' || type === 'ping') this.readyState = 1;
    for (const listener of this.handlers.get(type) ?? []) listener({ data });
  }
  frame(events: Array<{ type: string; drop_id: string | null }>): void {
    this.emit('events', JSON.stringify({ events, cursor: 'c', has_more: false }));
  }
  /** A dropped connection EventSource retries itself (resuming through Last-Event-ID). */
  drop(): void {
    this.readyState = 0;
    this.emit('error');
  }
  /** An error answer (401, 404, 410, 502…): EventSource gives up. */
  refuse(): void {
    this.readyState = 2;
    this.emit('error');
  }
}

function harness() {
  const sources: FakeSource[] = [];
  const refreshes: Change[] = [];
  let visible = true;
  const host: StreamHost = {
    connect: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    visible: () => visible,
    refresh: (change) => refreshes.push(change),
  };
  const stream = followStream('h1', host);
  return {
    stream,
    sources,
    refreshes,
    current: () => sources[sources.length - 1] as FakeSource,
    setVisible: (next: boolean) => {
      visible = next;
      stream.visibility(next);
    },
  };
}

describe('followStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refetches everything when a fresh stream’s first frame arrives, then what each batch changes', () => {
    const h = harness();
    expect(h.current().url).toBe('/v1/me/endpoints/h1/events');
    expect(h.refreshes).toEqual([]);
    h.current().frame([]);
    expect(h.refreshes).toEqual([EVERYTHING]);
    h.current().frame([delivery()]);
    h.current().frame([]);
    expect(h.refreshes).toEqual([EVERYTHING, changeOf([delivery()])]);
    h.stream.stop();
  });

  it('closes in a hidden tab and refetches everything again when it returns (no cursor)', () => {
    const h = harness();
    h.current().frame([]);
    h.setVisible(false);
    expect(h.current().closed).toBe(true);
    h.setVisible(true);
    expect(h.sources).toHaveLength(2);
    h.current().frame([]);
    expect(h.refreshes).toEqual([EVERYTHING, EVERYTHING]);
    h.stream.stop();
  });

  it('refetches nothing extra when EventSource resumes a dropped stream itself (the server ends streams regularly)', () => {
    const h = harness();
    h.current().frame([]);
    h.current().drop();
    // the same EventSource reconnects with Last-Event-ID; its first frame carries only what was missed
    h.current().frame([]);
    h.current().frame([delivery()]);
    expect(h.sources).toHaveLength(1);
    expect(h.refreshes).toEqual([EVERYTHING, changeOf([delivery()])]);
    h.stream.stop();
  });

  it('opens a fresh stream after a pause when the connection is refused or the cursor went stale', () => {
    const h = harness();
    h.current().frame([]);
    h.current().refuse();
    expect(h.current().closed).toBe(true);
    vi.advanceTimersByTime(FIRST_RETRY_MS - 1);
    expect(h.sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.sources).toHaveLength(2);
    h.current().frame([]);
    h.current().emit('resync', '{"code":"RESYNC_REQUIRED"}');
    expect(h.current().closed).toBe(true);
    vi.advanceTimersByTime(FIRST_RETRY_MS);
    expect(h.sources).toHaveLength(3);
    h.stream.stop();
  });

  it('restarts a stream silent for a minute; a ping keeps it alive, and one whose frames never come is given up', () => {
    const h = harness();
    h.current().frame([]);
    vi.advanceTimersByTime(SILENCE_MS - 10_000);
    h.current().emit('ping', '{}');
    vi.advanceTimersByTime(SILENCE_MS - 10_000);
    expect(h.current().closed).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(h.current().closed).toBe(true);
    vi.advanceTimersByTime(FIRST_RETRY_MS * 2);
    // the next one never gets a frame through (a proxy that buffers the body)
    expect(h.sources).toHaveLength(2);
    vi.advanceTimersByTime(SILENCE_MS);
    expect(h.sources[1]?.closed).toBe(true);
    h.stream.stop();
  });

  it('ignores a frame it cannot read', () => {
    const h = harness();
    h.current().frame([]);
    h.current().emit('events', 'not json');
    expect(h.refreshes).toEqual([EVERYTHING]);
    h.stream.stop();
  });
});
