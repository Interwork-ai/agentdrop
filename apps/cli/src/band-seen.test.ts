import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeNoticeState, type NoticeState } from '@agentdrop/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BandData, withSeenAt } from './commands/band.js';
import type { PendingSummary } from './commands/pending.js';
import { writeTestProfile } from './harnesses/test-fixture.js';
import { announceSeen } from './hook-notifications.js';
import { dropSeenKey, readSeenLog, recordSeenLocally } from './seen-log.js';
import { readProfile } from './store.js';

// ADR 0025: a session's band lists what was not seen inside an agent before that session started.

const rowsUrl = pathToFileURL(resolve(import.meta.dirname, '../claude-mod/agentdrop/hooks/rows.js')).href;
type Rows = {
  buildRows: (
    data: unknown,
    dismissed: Set<string>,
    surface?: string,
    since?: number,
  ) => { rows: Array<{ kind: string; id: string; text: string; drops?: string[] }> };
};
const ID = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const GROUP = 'a0000000-0000-4000-8000-000000000001';
const T0 = 1_800_000_000_000;

function drop(n: number, seenAt: number | null | undefined) {
  return {
    drop_id: ID(n),
    title: `Drop ${n}`,
    from: { handle: `wang${n}`, label: 'Wang' },
    group: null,
    mentioned: false,
    reply_to_title: null,
    reply_to_mine: null,
    attachments: 0,
    created_at: `2026-10-08T08:00:0${n}Z`,
    received_at: `2026-10-08T08:00:0${n}Z`,
    ...(seenAt === undefined ? {} : { seen_at: seenAt }),
  };
}
const groupDrop = (n: number, from: string, seenAt: number | null) => ({
  drop_id: ID(n),
  state_version: 1,
  title: `Group ${n}`,
  from,
  at: `2026-10-08T09:00:0${n}Z`,
  seen_at: seenAt,
});
const band = (drops: unknown[], groups: unknown[] = []) => ({
  enabled: true,
  language: 'en',
  drops,
  groups,
  requests: {},
  more: 0,
  at: 0,
});

describe('which rows a session lists', () => {
  it('lists what is unseen or first seen in this session, not what an earlier session showed', async () => {
    const { buildRows } = (await import(rowsUrl)) as Rows;
    const data = band([
      drop(1, null), // not seen in an agent yet
      drop(2, T0 + 2_000), // seen by this session's own start, just after it began
      drop(3, T0 - 5_000), // seen by this session's start hook a moment before the mod saw the start
      drop(4, T0 - 60_000), // shown by an earlier session
      drop(5, 0), // seen on another machine, or before this machine kept a log
    ]);
    const ids = buildRows(data, new Set(), 'band', T0).rows.map((r) => r.id);
    expect(ids.sort()).toEqual([ID(1), ID(2), ID(3)]);
    // the pane the person opens still lists everything unread
    expect(buildRows(data, new Set(), 'pane', T0).rows).toHaveLength(5);
  });

  it('lists everything when the data says nothing about seen (an older CLI or server)', async () => {
    const { buildRows } = (await import(rowsUrl)) as Rows;
    const data = band([drop(1, undefined), drop(2, undefined)]);
    expect(buildRows(data, new Set(), 'band', T0).rows).toHaveLength(2);
    expect(buildRows(band([drop(1, 0)]), new Set(), 'band', undefined).rows).toHaveLength(1);
  });

  it("a group row counts, names and marks only this session's new drops, and goes when none is left", async () => {
    const { buildRows } = (await import(rowsUrl)) as Rows;
    const data = band(
      [],
      [
        {
          group_id: GROUP,
          slug: 'team',
          name: 'Team',
          count: 3,
          from: ['Li', 'Mia', 'Zhou'],
          up_to: '2026-10-08T09:00:03Z',
          drops: [
            groupDrop(3, 'Zhou', T0 - 60_000),
            groupDrop(2, 'Mia', null),
            groupDrop(1, 'Li', T0 + 1_000),
          ],
        },
      ],
    );
    const [row] = buildRows(data, new Set(), 'band', T0).rows;
    expect(row?.text).toBe('“Team” #team · 2 new messages (Mia, Li)');
    expect(row?.drops).toEqual([`${ID(2)}:1`, `${ID(1)}:1`]);
    // a later session: only the drop nobody has seen yet is left in the row
    const later = buildRows(data, new Set(), 'band', T0 + 10 * 60_000).rows;
    expect(later.map((r) => r.text)).toEqual(['“Team” #team · 1 new message (Mia)']);
    // once that one was seen too (by an earlier session), the row goes
    const allSeen = band(
      [],
      [{ ...(data.groups as Array<Record<string, unknown>>)[0], drops: [groupDrop(2, 'Mia', T0)] }],
    );
    expect(buildRows(allSeen, new Set(), 'band', T0 + 10 * 60_000).rows).toHaveLength(0);
    // the pane keeps the whole group
    expect(buildRows(data, new Set(), 'pane', T0 + 10 * 60_000).rows[0]?.text).toContain('3 new messages');
  });
});

describe('two Claude Code sessions, one after the other', () => {
  type Node = { type: string; props: Record<string, unknown> };
  const ui = {
    Box: (props: Record<string, unknown>) => ({ type: 'Box', props }),
    Text: (props: Record<string, unknown>) => ({ type: 'Text', props }),
    Button: (props: Record<string, unknown>) => ({ type: 'Button', props }),
  };
  const texts = (node: unknown): string[] => {
    const n = node as Node | null;
    if (!n || typeof n !== 'object' || !n.props) return [];
    const kids = (n.props.children as unknown[] | undefined) ?? [];
    return kids.flatMap((k) => (typeof k === 'string' ? [k] : texts(k)));
  };
  const tick = () => new Promise((done) => setTimeout(done, 0));

  async function session(n: number, startedAt: number, data: unknown) {
    const mod = (await import(
      `${pathToFileURL(resolve(import.meta.dirname, '../claude-mod/agentdrop/hooks/register.js')).href}?seen=${n}`
    )) as { register: (on: (event: string, ...rest: unknown[]) => void) => void };
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    mod.register((event, ...rest) => {
      const fn = rest.at(-1) as (...args: unknown[]) => Promise<unknown>;
      const filter = rest.length > 1 ? (rest[0] as Record<string, string>) : {};
      handlers.set(`${event}:${filter.component ?? filter.command ?? ''}`, fn);
    });
    const store = new Map<string, unknown>();
    const $ = {
      plugin: { root: '/plugin' },
      env: { get: async () => undefined },
      fs: {
        read: async (path: string) =>
          path === '/plugin/config.json'
            ? JSON.stringify({ config: '/cfg/claude-mod.json' })
            : JSON.stringify({ argv: ['/bin/agentdrop'], profile: 'cc' }),
      },
      store: {
        get: async (key: string) => store.get(key),
        set: async (key: string, value: unknown) => store.set(key, value),
        delete: async (key: string) => store.delete(key),
        keys: async () => [...store.keys()],
      },
      clock: { now: async () => startedAt, after: () => ({ cancel() {} }), every: () => ({ cancel() {} }) },
      command: { register: async () => {} },
      process: { run: async () => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: '' }) },
      ui: { invalidate: () => {}, open: async () => ({}), resolve: () => ui, toast: () => {} },
      prompt: { submit: async () => {} },
    };
    await handlers.get('session.start:')?.($, {}, () => {});
    await handlers.get('command.run:agentdrop')?.($, {});
    for (let i = 0; i < 20; i++) await tick();
    return texts(
      await handlers.get('ui.render:AbovePrompt')?.(
        $,
        { props: { hasSurvey: false, bodyColumns: 120, isWorking: false, maxRows: 20 } },
        () => null,
      ),
    ).join('\n');
  }

  it('the second session does not list again what the first one showed; a new drop shows in both', async () => {
    // the first session started at T0; its start hook recorded drop 1 as seen two seconds later
    const first = await session(1, T0, band([drop(1, T0 + 2_000), drop(2, null)]));
    expect(first).toContain('Drop 1');
    expect(first).toContain('Drop 2');
    // a minute later another session starts: drop 1 was seen before it, drop 2 still is not
    const second = await session(2, T0 + 60_000, band([drop(1, T0 + 2_000), drop(2, null)]));
    expect(second).not.toContain('Drop 1');
    expect(second).toContain('Drop 2');
  });
});

describe('the band data and the local seen log', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-band-seen-'));
    vi.stubEnv('AGENTDROP_CONFIG_DIR', join(dir, 'config'));
    vi.stubEnv('AGENTDROP_STATE_DIR', join(dir, 'state'));
    writeTestProfile('cc', 'claude-code');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks each drop with when it was first seen, and never prints the record itself', () => {
    const data = {
      ...band([drop(1, undefined), drop(2, undefined), drop(3, undefined)]),
      groups: [
        {
          group_id: GROUP,
          slug: 'team',
          name: 'Team',
          count: 1,
          from: ['Li'],
          up_to: 'x',
          drops: [{ drop_id: ID(4), state_version: 1, title: 'G', from: 'Li', at: 'x' }],
        },
      ],
      seen: [dropSeenKey(ID(1)), dropSeenKey(ID(2)), dropSeenKey(ID(4))],
    } as unknown as BandData;
    const out = withSeenAt(data, { [dropSeenKey(ID(1))]: T0 });
    expect(out.drops.map((d) => d.seen_at)).toEqual([T0, 0, null]);
    expect(out.groups[0]?.drops[0]?.seen_at).toBe(0);
    expect(JSON.stringify(out)).not.toContain(dropSeenKey(ID(2)));
    // a server without a seen record: nothing is marked, so the band lists everything as before
    expect(withSeenAt({ ...data, seen: null }, {}).drops[0]).not.toHaveProperty('seen_at');
  });

  it('a claim records the drops it saw for the first time, with the earliest time kept', async () => {
    const pending = (ids: number[]) =>
      ({
        unread: ids.length,
        unread_drops: ids.map((n) => ({
          drop_id: ID(n),
          title: `Drop ${n}`,
          author: { handle: 'wang', display_label: 'Wang' },
        })),
        contact_requests: [],
        group_invitations: [],
        approvals: 0,
        agent_name: 'A',
      }) as unknown as PendingSummary;
    // drop 1 was already in the account's seen record (shown on another machine): it is not logged here
    let seen: NoticeState | null = {
      drops: [dropSeenKey(ID(1))],
      contacts: [],
      invitations: [],
      join_requests: [],
      approvals: 0,
    };
    const deps = {
      session: 's1',
      claimSeen: async (current: NoticeState) => {
        const previous = seen;
        seen = mergeNoticeState(previous, current);
        return previous;
      },
    };
    const settings = { enabled: true, interval_ms: 0, detail: 'counts' as const };
    await announceSeen('cc', pending([1, 2]), settings, deps);
    const profile = readProfile('cc');
    if (!profile) throw new Error('no profile');
    const log = readSeenLog(profile);
    expect(Object.keys(log)).toEqual([dropSeenKey(ID(2))]);
    const first = log[dropSeenKey(ID(2))];
    recordSeenLocally(profile, [dropSeenKey(ID(2))], (first ?? 0) + 99_999);
    expect(readSeenLog(profile)[dropSeenKey(ID(2))]).toBe(first);
  });
});
