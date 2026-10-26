import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alreadyFresh,
  type Change,
  COALESCE_MS,
  changeOf,
  coalesce,
  ECHO_MS,
  EVERYTHING,
  FIRST_RETRY_MS,
  followStream,
  mergeChanges,
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

const sentList = ['mailbox', 'h1', 'list', 'sent', '', false, null];
const groupTimeline = ['mailbox', 'h1', 'list', 'inbox', '', false, 'g1'];
const openDrop = ['mailbox', 'h1', 'drop', 'd1', 0];
const groupDetail = ['group', 'g1', 'h1'];
const groupFiles = ['group', 'g1', 'files'];

describe('refreshOf', () => {
  it('refetches the selected agent’s mailbox views when a delivery or its state changes', () => {
    for (const type of [
      'delivery.created',
      'delivery.state',
      'grant.revoked',
      'drop.revoked',
      'attachment.removed',
    ]) {
      const change = changeOf([delivery(type)]);
      for (const key of [inbox, sentList, groupTimeline, ['mailbox', 'h1', 'unread'], openDrop])
        expect(refreshOf('h1', change, key)).toBe('refetch');
      for (const key of [['contacts'], ['groups', 'h1'], ['directory', 'h1', ''], ['me']])
        expect(refreshOf('h1', change, key)).toBeNull();
    }
  });

  it('refetches a group’s details and files only when deliveries arrive or go, or files are removed', () => {
    for (const type of ['delivery.created', 'grant.revoked', 'drop.revoked', 'attachment.removed'])
      for (const key of [groupDetail, groupFiles])
        expect(refreshOf('h1', changeOf([delivery(type)]), key)).toBe('refetch');
    // read state and receipts change nothing a group's details or files show
    for (const type of ['delivery.state', 'sent.changed'])
      for (const key of [groupDetail, groupFiles])
        expect(refreshOf('h1', changeOf([delivery(type)]), key)).toBeNull();
  });

  it('refetches only the views that show the person’s own drops when a sent drop or its receipts change', () => {
    const change = changeOf([delivery('sent.changed')]);
    for (const key of [sentList, groupTimeline, openDrop, ['mailbox', 'h1', 'getting-started-sent']])
      expect(refreshOf('h1', change, key)).toBe('refetch');
    for (const key of [
      inbox,
      ['mailbox', 'h1', 'unread'],
      ['mailbox', 'h1', 'space'],
      groupDetail,
      ['contacts'],
    ])
      expect(refreshOf('h1', change, key)).toBeNull();
    expect(refreshOf('h1', change, ['mailbox', 'h1', 'list', 'sent', 'invoice', false, null])).toBe('mark');
  });

  it('treats a type it does not know as a mailbox and group change, never as nothing', () => {
    const change = changeOf([delivery('something.new')]);
    expect(refreshOf('h1', change, inbox)).toBe('refetch');
    expect(refreshOf('h1', change, groupDetail)).toBe('refetch');
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
  const asked: string[] = [];
  /** What the status check of the next refused connection answers. */
  const status: { next: number | null } = { next: 200 };
  let visible = true;
  const host: StreamHost = {
    connect: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    status: (url) => {
      asked.push(url);
      return Promise.resolve(status.next);
    },
    visible: () => visible,
    refresh: (change) => refreshes.push(change),
  };
  const stream = followStream('h1', host);
  return {
    stream,
    sources,
    refreshes,
    asked,
    status,
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

  it('opens a fresh stream after a pause when the connection is refused or the cursor went stale', async () => {
    const h = harness();
    h.current().frame([]);
    // e.g. the cursor EventSource resumed with is no longer valid: the check without it answers 200
    h.current().refuse();
    expect(h.current().closed).toBe(true);
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS - 1);
    expect(h.asked).toEqual(['/v1/me/endpoints/h1/events']);
    expect(h.sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sources).toHaveLength(2);
    h.current().frame([]);
    h.current().emit('resync', '{"code":"RESYNC_REQUIRED"}');
    expect(h.current().closed).toBe(true);
    vi.advanceTimersByTime(FIRST_RETRY_MS);
    expect(h.sources).toHaveLength(3);
    h.stream.stop();
  });

  it('keeps retrying, ever more slowly, after a server error or no answer at all', async () => {
    const h = harness();
    h.status.next = 502;
    h.current().refuse();
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
    expect(h.sources).toHaveLength(2);
    h.status.next = null;
    h.current().refuse();
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS * 2);
    expect(h.sources).toHaveLength(3);
    h.stream.stop();
  });

  for (const status of [401, 403, 404])
    it(`stops trying after a ${status}, leaving the views to their background refetch, until the person returns`, async () => {
      const h = harness();
      h.current().frame([]);
      h.status.next = status;
      h.current().refuse();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(h.sources).toHaveLength(1);
      expect(h.asked).toHaveLength(1);
      // hiding and showing the tab is the person coming back: one more attempt
      h.setVisible(false);
      h.setVisible(true);
      expect(h.sources).toHaveLength(2);
      h.stream.stop();
    });

  it('ignores the answer of a status check that a stop or a hidden tab overtook', async () => {
    const h = harness();
    h.status.next = 404;
    h.current().refuse();
    h.setVisible(false);
    h.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sources).toHaveLength(2);
    expect(h.current().closed).toBe(false);
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

describe('changeOf and mergeChanges', () => {
  it('marks a batch of nothing but the person’s own state, and keeps that only while every merged batch is', () => {
    expect(changeOf([delivery('delivery.state')]).stateOnly).toBe(true);
    expect(changeOf([delivery('delivery.state'), delivery('sent.changed')]).stateOnly).toBe(false);
    expect(changeOf([]).stateOnly).toBe(false);
    const merged = mergeChanges(changeOf([delivery('delivery.state')]), changeOf([delivery('sent.changed')]));
    expect(merged).toEqual({ mailbox: true, sent: true, groups: false, directory: false, stateOnly: false });
  });
});

describe('coalesce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('merges the batches of one window into one refetch, stamped with when the last arrived', () => {
    const applied: Array<[Change, number]> = [];
    let clock = 1_000;
    const batches = coalesce(
      (change, since) => applied.push([change, since]),
      COALESCE_MS,
      () => clock,
    );
    batches.push(changeOf([delivery('delivery.state')]));
    clock = 1_100;
    batches.push(changeOf([delivery('sent.changed')]));
    batches.push(changeOf([directory]));
    vi.advanceTimersByTime(COALESCE_MS - 1);
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(applied).toEqual([
      // a fetch started between the first and the last batch may have missed the last: it is not fresh enough
      [{ mailbox: true, sent: true, groups: false, directory: true, stateOnly: false }, 1_100],
    ]);
    // the next batch opens a new window
    clock = 2_000;
    batches.push(changeOf([delivery()]));
    vi.advanceTimersByTime(COALESCE_MS);
    expect(applied).toHaveLength(2);
    expect(applied[1]?.[1]).toBe(2_000);
  });

  it('ignores a batch that changed nothing, and applies nothing once stopped', () => {
    const applied: Change[] = [];
    const batches = coalesce((change) => applied.push(change));
    batches.push(changeOf([]));
    vi.advanceTimersByTime(COALESCE_MS);
    expect(applied).toEqual([]);
    batches.push(changeOf([delivery()]));
    batches.stop();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(applied).toEqual([]);
  });
});

describe('alreadyFresh', () => {
  const news = changeOf([delivery()]);
  const ownState = changeOf([delivery('delivery.state')]);

  it('skips a query whose fetch started after the change arrived, and refetches one never fetched or fetched before', () => {
    expect(alreadyFresh(5_000, 5_000, news, Number.NEGATIVE_INFINITY)).toBe(true);
    expect(alreadyFresh(4_999, 5_000, news, Number.NEGATIVE_INFINITY)).toBe(false);
    expect(alreadyFresh(undefined, 5_000, news, Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it('takes the person’s own state change right after a mutation of this tab as its echo', () => {
    // the mutation succeeded at 4_000 and its refetch started at 4_010; the event arrived at 4_050
    expect(alreadyFresh(4_010, 4_050, ownState, 4_000)).toBe(true);
    // a fetch from before the mutation does not show it
    expect(alreadyFresh(3_990, 4_050, ownState, 4_000)).toBe(false);
    // too long after the mutation, or anything besides the person's state, is news
    expect(alreadyFresh(4_010, 4_000 + ECHO_MS + 1, ownState, 4_000)).toBe(false);
    expect(alreadyFresh(4_010, 4_050, news, 4_000)).toBe(false);
  });
});
