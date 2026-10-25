import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingSummary } from './commands/pending.js';
import {
  notificationForHook,
  notificationText,
  pendingContextText,
  statusLineText,
} from './hook-notifications.js';
import type { NotificationSettings } from './hook-settings.js';
import { deleteProfile, writeProfile } from './store.js';

const H1 = '11111111-1111-4111-8111-111111111111';
const H2 = '22222222-2222-4222-8222-222222222222';
const OTHER_USER = '33333333-3333-4333-8333-333333333333';
const TWO_HOURS = 2 * 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const settings: NotificationSettings = { enabled: true, interval_ms: TWO_HOURS, detail: 'counts' };
const waiting: PendingSummary = {
  unread: 2,
  unread_drops: [
    {
      drop_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Review results',
      author: { handle: 'alice', display_label: 'Alice' },
      attachment_count: 1,
    },
  ],
  contact_requests: [{ handle: 'alice', display_name: 'Alice' }],
  group_invitations: [],
  approvals: 1,
  agent_name: 'Private agent name',
};
const empty: PendingSummary = {
  unread: 0,
  unread_drops: [],
  contact_requests: [],
  group_invitations: [],
  approvals: 0,
  agent_name: 'Private agent name',
};

describe('Stop notification state', () => {
  let directory: string;
  let now: number;
  let fetchPending: ReturnType<typeof vi.fn<(p: string) => Promise<PendingSummary | null>>>;
  function profile(name = 'one', hId = H1, server = 'https://drop.example.test', userId = H2) {
    writeProfile({
      profile: name,
      server_url: server,
      h_id: hId,
      harness: 'codex',
      profile_key: name,
      user_id: userId,
      handle: 'owner',
      agent_name: 'secret name',
      credential_ref: { store: 'file', account: 'secret credential' },
      credential_expires_at: '2099-01-01T00:00:00Z',
      paired_at: 'now',
      allowed_dirs: [],
      toolset: 'standard',
    });
  }
  function check(name = 'one', options = settings, extraNotice?: string) {
    return notificationForHook(name, options, {
      fetchPending,
      now: () => now,
      ...(extraNotice ? { extraNotice } : {}),
    });
  }
  function stateFiles() {
    return readdirSync(join(directory, 'state', 'hook-notifications')).filter((f) => f.endsWith('.json'));
  }
  function statePath() {
    return join(directory, 'state', 'hook-notifications', stateFiles()[0] ?? 'missing');
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'agentdrop-hook-'));
    vi.stubEnv('AGENTDROP_CONFIG_DIR', join(directory, 'config'));
    vi.stubEnv('AGENTDROP_STATE_DIR', join(directory, 'state'));
    now = Date.now();
    // New mail keeps arriving: every fetch after the first adds one more unread drop, so interval, lock and
    // clock tests still have something new to announce. Tests about repetition pin a fixed summary instead.
    let calls = 0;
    fetchPending = vi.fn(async () => {
      calls++;
      if (calls === 1) return waiting;
      const later = Array.from({ length: calls - 1 }, (_, i) => ({
        drop_id: `${`${i + 1}`.repeat(8)}-0000-4000-8000-000000000000`,
        title: `Later ${i + 1}`,
        author: { handle: 'bob', display_label: 'Bob' },
        attachment_count: 0,
      }));
      return {
        ...waiting,
        unread: waiting.unread + later.length,
        unread_drops: [...waiting.unread_drops, ...later],
      };
    });
    profile();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('announces each item once, never repeats it after the interval, and names no commands', async () => {
    fetchPending.mockResolvedValue(waiting);
    const first = await check();
    expect(first).toContain('AgentDrop: new');
    // The first announcement counts the whole backlog, including rows the hook did not fetch.
    expect(first).toContain('New messages: 2');
    expect(first).toContain('Direct messages:\n- @alice · "Review results" · 1 attachment');
    // People get no ids: they ask for a message by its title or sender.
    expect(first).not.toContain('aaaaaaaa');
    expect(first).toContain('- 1 more new message not listed; ask your agent to catch you up');
    expect(first).toContain('Contact requests: 1\n- @alice');
    expect(first).toContain('Pending approvals: 1');
    // This string reaches a person in a chat harness: no terminal commands, no model instructions.
    expect(first).not.toMatch(/agentdrop |--profile|下一步|给模型|安全提示|list_drops/);
    now += TWO_HOURS - 1;
    expect(await check()).toBeNull();
    expect(fetchPending).toHaveBeenCalledTimes(1);
    now++;
    // Still pending, already announced: the person is not told again.
    expect(await check()).toBeNull();
    expect(fetchPending).toHaveBeenCalledTimes(2);
    // Only what is new is announced; approvals are announced when the count grows.
    fetchPending.mockResolvedValue({
      ...waiting,
      unread: 3,
      unread_drops: [
        ...waiting.unread_drops,
        {
          drop_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          title: 'Next',
          author: { handle: 'bob', display_label: 'Bob' },
          attachment_count: 0,
        },
      ],
      approvals: 2,
    });
    now += TWO_HOURS;
    const next = await check();
    expect(next).toContain('New messages: 1\nDirect messages:\n- @bob · "Next"');
    expect(next).not.toContain('aaaaaaaa');
    expect(next).not.toContain('Contact requests');
    expect(next).toContain('Pending approvals: 2');
    // A request that was resolved and later sent again is new again.
    fetchPending.mockResolvedValue({ ...waiting, contact_requests: [] });
    now += TWO_HOURS;
    expect(await check()).toBeNull();
    fetchPending.mockResolvedValue(waiting);
    now += TWO_HOURS;
    expect(await check()).toBe('AgentDrop: new\nContact requests: 1\n- @alice');
    // Nothing but hashes is persisted.
    expect(readFileSync(statePath(), 'utf8')).not.toMatch(/alice|bob|aaaaaaaa|bbbbbbbb/);
  });
  it('writes the notice in Chinese when the user chose zh, with the same items', async () => {
    fetchPending.mockResolvedValue(waiting);
    const zh = await notificationForHook('one', settings, { fetchPending, now: () => now, language: 'zh' });
    expect(zh).toBe(
      [
        'AgentDrop 新通知',
        '新消息：2 条',
        '私信：',
        '- @alice ·「Review results」 · 1 个附件',
        '- 另有 1 条新消息未列出，可以让 Agent 帮你过一遍',
        '联系人申请：1 个',
        '- @alice',
        '待人工审批：1 条（只能由用户在终端或网页确认）',
      ].join('\n'),
    );
  });
  it('interval zero checks each time and still announces only what is new', async () => {
    await check('one', { ...settings, interval_ms: 0 });
    expect(await check('one', { ...settings, interval_ms: 0 })).toBe(
      'AgentDrop: new\nNew messages: 1\nDirect messages:\n- @bob · "Later 1"',
    );
    expect(fetchPending).toHaveBeenCalledTimes(2);
  });
  it('an empty successful check consumes the full configured interval', async () => {
    fetchPending.mockResolvedValueOnce(empty);
    expect(await check()).toBeNull();
    now += TWO_HOURS - 1;
    expect(await check()).toBeNull();
    expect(fetchPending).toHaveBeenCalledTimes(1);
    now++;
    expect(await check()).not.toBeNull();
  });
  it('uses the shorter configured interval for empty checks', async () => {
    fetchPending.mockResolvedValue(empty);
    await check('one', { ...settings, interval_ms: 1000 });
    now += 1000;
    await check('one', { ...settings, interval_ms: 1000 });
    expect(fetchPending).toHaveBeenCalledTimes(2);
  });
  it.each([null, new Error('secret transport failure')])(
    'retries failure after five minutes even with interval zero (%s)',
    async (failure) => {
      if (failure) fetchPending.mockRejectedValueOnce(failure);
      else fetchPending.mockResolvedValueOnce(null);
      expect(await check('one', { ...settings, interval_ms: 0 })).toBeNull();
      now += FIVE_MINUTES - 1;
      expect(await check('one', { ...settings, interval_ms: 0 })).toBeNull();
      expect(fetchPending).toHaveBeenCalledTimes(1);
      now++;
      expect(await check('one', { ...settings, interval_ms: 0 })).not.toBeNull();
    },
  );
  it('serializes concurrent invocations before fetching', async () => {
    let finish: ((s: PendingSummary) => void) | undefined;
    fetchPending.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = check();
    expect(await check()).toBeNull();
    finish?.(waiting);
    expect(await first).not.toBeNull();
    expect(fetchPending).toHaveBeenCalledTimes(1);
  });
  it('shares persisted state across profiles for one H and fresh module instances', async () => {
    await check();
    profile('alias');
    vi.resetModules();
    const fresh = await import('./hook-notifications.js');
    expect(await fresh.notificationForHook('alias', settings, { fetchPending, now: () => now })).toBeNull();
    expect(fetchPending).toHaveBeenCalledTimes(1);
    expect(stateFiles()).toHaveLength(1);
  });
  it('shares state across H of one account but isolates other accounts, servers and re-pairing', async () => {
    await check();
    // All agents of an account are one reader (ADR 0007): another H of the same user sees the notice as shown.
    profile('two', H2);
    expect(await check('two')).toBeNull();
    expect(fetchPending).toHaveBeenCalledTimes(1);
    expect(stateFiles()).toHaveLength(1);
    profile('stranger', H1, 'https://drop.example.test', OTHER_USER);
    expect(await check('stranger')).not.toBeNull();
    profile('remote', H1, 'https://other.example.test');
    expect(await check('remote')).not.toBeNull();
    // Re-pairing the same profile name to another account starts from a fresh record.
    profile('one', H2, 'https://drop.example.test', '44444444-4444-4444-8444-444444444444');
    expect(await check()).not.toBeNull();
    expect(stateFiles()).toHaveLength(4);
  });
  it('isolates configuration roots', async () => {
    await check();
    vi.stubEnv('AGENTDROP_CONFIG_DIR', join(directory, 'other-config'));
    profile();
    expect(await check()).not.toBeNull();
    expect(stateFiles()).toHaveLength(2);
  });
  it('disable and missing or removed profiles stay quiet without fetching', async () => {
    const updateOnly = await check('one', { ...settings, enabled: false }, 'Update available');
    expect(updateOnly).toBe('Update available');
    expect(await check('missing')).toBeNull();
    deleteProfile('one');
    expect(await check()).toBeNull();
    expect(fetchPending).not.toHaveBeenCalled();
  });
  it('counts omit optional display names; names are structured, sanitized and truncated', async () => {
    const named = {
      ...waiting,
      contact_requests: [
        { handle: 'a', display_name: 'A\n\u0000\u202e\u2028\u2029' },
        { handle: 'b', display_name: 'B'.repeat(100) },
      ],
      group_invitations: [
        { slug: 'first', display_name: 'Third' },
        { slug: 'second', display_name: 'Fourth' },
      ],
    };
    fetchPending.mockResolvedValue(named);
    const counts = await check();
    expect(counts).not.toContain('Alice');
    expect(counts).not.toContain('Private');
    // `counts` means "no optional display name of a person", not "no list": the stable identifier is always shown.
    expect(counts).toContain('- @a\n- @b');
    // a group is always named
    expect(counts).toContain('- “Third” #first\n- “Fourth” #second');
    const names = notificationText(named, 'names');
    expect(names).toContain('- A @a');
    expect(names).toContain('B'.repeat(32));
    expect(names).not.toContain('B'.repeat(33));
    expect(names).toContain('Third');
    expect(names).toContain('- “Fourth” #second');
    expect(names?.replace(/\n/g, '')).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    const persisted = readFileSync(statePath(), 'utf8');
    expect(persisted).not.toMatch(/Alice|Third|Fourth|secret|Private/);
    // Numbers, plus `shown`, which holds only 16-hex-digit hashes and the approval count.
    const { shown, ...rest } = JSON.parse(persisted);
    expect(Object.values(rest).every((v) => typeof v === 'number')).toBe(true);
    for (const list of [shown.drops, shown.contacts, shown.invitations, shown.join_requests])
      expect(list.every((v: string) => /^[0-9a-f]{16}$/.test(v))).toBe(true);
  });
  it('lists group join requests and keeps an older server without that field countable', async () => {
    fetchPending.mockResolvedValue({
      ...empty,
      group_join_requests: [
        {
          slug: 'paper',
          display_name: '论文讨论组',
          invitee_handle: 'zhao',
          invitee_display_name: 'Zhao',
          invited_by_handle: 'wang',
          decide_url: 'https://drop.example.test/groups/paper/requests',
        },
      ],
    });
    const message = await check();
    expect(message).toContain('Join requests: 1 (only you can decide, in the dashboard)');
    expect(message).toContain('- #paper ← @zhao (invited by @wang)');
    // The decision link stays in the interactive command; the hook notice stays compact.
    expect(message).not.toContain('https://');
    // No CLI command decides these, so they must not invent a next step either.
    expect(message).not.toContain('下一步：');
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).count).toBe(1);
    now += TWO_HOURS;
    // `empty` carries no group_join_requests key at all: exactly what a server older than the field returns.
    fetchPending.mockResolvedValue(empty);
    expect(await check()).toBeNull();
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).count).toBe(0);
  });
  it('caps one notice at 1200 characters on a line boundary for every host', async () => {
    fetchPending.mockResolvedValue({
      ...waiting,
      unread: 9,
      unread_drops: Array.from({ length: 7 }, (_, i) => ({
        drop_id: `${i}`.repeat(8),
        title: '标'.repeat(200),
        author: { handle: 'h'.repeat(40), display_label: 'd'.repeat(40) },
        attachment_count: 3,
      })),
      contact_requests: Array.from({ length: 7 }, (_, i) => ({
        handle: `contact-${i}`,
        display_name: 'n'.repeat(40),
      })),
      group_invitations: Array.from({ length: 7 }, (_, i) => ({
        slug: `group-${i}`,
        display_name: 'g'.repeat(40),
      })),
    });
    const message = await check('one', { ...settings, detail: 'names' });
    expect(message?.length).toBeLessThanOrEqual(1200);
    expect(message?.endsWith('\n- … (truncated)')).toBe(true);
    // Only whole lines survive, so no item and no multi-byte character is cut in half.
    expect(message?.split('\n').filter((line) => line.includes('"标标'))).toHaveLength(5);
    expect(message?.split('\n').every((line) => line.length > 0)).toBe(true);
  });
  it('merges an update notice and applies the same overall output limit', async () => {
    const message = await check('one', settings, 'Update available');
    expect(message).toContain('New messages: 2');
    expect(message).toContain('\nUpdate available');
    expect(message?.length).toBeLessThanOrEqual(1200);
    expect(await check('one', settings, 'Another update')).toBe('Another update');
    expect(await check('one', settings, 'Another update')).not.toContain('给模型');
    expect(fetchPending).toHaveBeenCalledTimes(1);
    expect(readFileSync(statePath(), 'utf8')).not.toContain('Update');
  });
  it('extra notice bypasses empty-query cooldown without another fetch', async () => {
    fetchPending.mockResolvedValue(empty);
    expect(await check()).toBeNull();
    expect(await check('one', settings, 'Update available')).toContain('Update available');
    expect(fetchPending).toHaveBeenCalledTimes(1);
    expect(await check('one', settings, 'Update available')).toContain('Update available');
    expect(fetchPending).toHaveBeenCalledTimes(1);
  });
  it('clock rollback silently resets the notification timestamp before another interval', async () => {
    await check();
    now -= TWO_HOURS;
    expect(await check()).toBeNull();
    expect(await check()).toBeNull();
    expect(fetchPending).toHaveBeenCalledTimes(1);
    now += TWO_HOURS;
    expect(await check()).not.toBeNull();
  });
  it('malformed state and inaccessible state directory fail quietly', async () => {
    await check();
    writeFileSync(statePath(), 'not json');
    now += TWO_HOURS;
    expect(await check()).toBeNull();
    const blocked = join(directory, 'file-not-directory');
    writeFileSync(blocked, 'file');
    vi.stubEnv('AGENTDROP_STATE_DIR', blocked);
    expect(await check()).toBeNull();
    expect(fetchPending).toHaveBeenCalledTimes(1);
  });
  it('never steals an expired lock from a live process', async () => {
    await check();
    const lock = `${statePath()}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    const old = new Date(Date.now() - TWO_HOURS);
    utimesSync(lock, old, old);
    now += TWO_HOURS;
    expect(await check()).toBeNull();
    expect(fetchPending).toHaveBeenCalledTimes(1);
  });
  it('recovers an expired lock from an exited process and checks again', async () => {
    await check();
    const lock = `${statePath()}.lock`;
    const child = spawnSync(process.execPath, ['-e', '']);
    expect(child.status).toBe(0);
    writeFileSync(lock, JSON.stringify({ pid: child.pid }));
    const old = new Date(Date.now() - TWO_HOURS);
    utimesSync(lock, old, old);
    now += TWO_HOURS;
    expect(await check()).not.toBeNull();
    expect(readdirSync(join(directory, 'state', 'hook-notifications'))).toEqual(stateFiles());
  });
  it.each(['not json', '{"count":"wrong"}', 'null'])(
    'repairs damaged state conservatively: %s',
    async (content) => {
      await check();
      writeFileSync(statePath(), content);
      now += TWO_HOURS;
      expect(await check()).toBeNull();
      expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toEqual({
        count: 0,
        last_notified_at: now,
        last_checked_at: now,
      });
      expect(await check()).toBeNull();
      expect(fetchPending).toHaveBeenCalledTimes(1);
      now += TWO_HOURS;
      expect(await check()).not.toBeNull();
    },
  );
  it.each(['empty', 'malformed-owner', 'dead-owner'])('recovers stale directory lock: %s', async (kind) => {
    await check();
    const lock = `${statePath()}.lock`;
    mkdirSync(lock);
    if (kind === 'malformed-owner') writeFileSync(join(lock, 'owner-aaaa.json'), 'broken');
    if (kind === 'dead-owner') {
      const child = spawnSync(process.execPath, ['-e', '']);
      writeFileSync(join(lock, 'owner-aaaa.json'), JSON.stringify({ token: 'aaaa', pid: child.pid }));
    }
    const old = new Date(Date.now() - TWO_HOURS);
    utimesSync(lock, old, old);
    now += TWO_HOURS;
    expect(await check()).not.toBeNull();
    expect(fetchPending).toHaveBeenCalledTimes(2);
  });
  it('ignores orphaned legacy recovery markers and recovers damaged legacy locks', async () => {
    await check();
    const lock = `${statePath()}.lock`;
    writeFileSync(lock, 'broken');
    writeFileSync(`${lock}.recovery`, '');
    const old = new Date(Date.now() - TWO_HOURS);
    utimesSync(lock, old, old);
    now += TWO_HOURS;
    expect(await check()).not.toBeNull();
  });
  it('never steals a directory lock from a live owner even when aged', async () => {
    await check();
    const lock = `${statePath()}.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner-aaaa.json'), JSON.stringify({ token: 'aaaa', pid: process.pid }));
    const old = new Date(Date.now() - TWO_HOURS);
    utimesSync(lock, old, old);
    now += TWO_HOURS;
    expect(await check()).toBeNull();
    expect(fetchPending).toHaveBeenCalledTimes(1);
  });
});

describe('model context', () => {
  const many = (n: number, title: string) =>
    Array.from({ length: n }, (_, i) => ({
      drop_id: `${i}`.padStart(8, '0'),
      title,
      author: { handle: `h${i}`, display_label: 'x' },
      attachment_count: 0,
    }));
  it('lists everything fetched that fits and says where the rest is, in bounded length', () => {
    const text =
      pendingContextText({
        ...empty,
        unread: 40,
        unread_drops: many(12, 'short'),
        contact_requests: Array.from({ length: 8 }, (_, i) => ({ handle: `c${i}`, display_name: 'n' })),
      }) ?? '';
    // Not just the newest five: the model sees everything pending that was fetched.
    expect(text.split('\n').filter((l) => l.startsWith('- drop_id='))).toHaveLength(12);
    expect(text).toContain('- 28 more unread, not listed (use list_drops)');
    expect(text.split('\n').filter((l) => /^- @c\d$/.test(l))).toHaveLength(8);
    // Too many to fit: drops beyond the cap are counted in the overflow line, requests stay listed.
    const long =
      pendingContextText({
        ...empty,
        unread: 60,
        unread_drops: many(50, '标'.repeat(200)),
        contact_requests: Array.from({ length: 8 }, (_, i) => ({
          handle: 'c'.repeat(40) + i,
          display_name: 'n',
        })),
        group_invitations: Array.from({ length: 8 }, (_, i) => ({
          slug: 'g'.repeat(40) + i,
          display_name: 'n',
        })),
      }) ?? '';
    expect(long.length).toBeLessThanOrEqual(4000);
    const listed = long.split('\n').filter((l) => l.startsWith('- drop_id=')).length;
    expect(listed).toBeGreaterThan(5);
    expect(listed).toBeLessThan(50);
    expect(long).toContain(`- ${60 - listed} more unread, not listed (use list_drops)`);
    expect(long.split('\n').filter((l) => l.startsWith('- “n” #ggg'))).toHaveLength(8);
    expect(long).toContain('list_drops / read_drop tools');
  });
  it('keeps muted-group drops (the person is not told, the model still sees them)', () => {
    const summary: PendingSummary = {
      ...empty,
      unread: 1,
      unread_drops: [
        {
          ...(many(1, 'Quiet')[0] as PendingSummary['unread_drops'][number]),
          group: { name: 'Noise', slug: 'noise' },
          muted: true,
        },
      ],
    };
    expect(pendingContextText(summary)).toContain('Group “Noise” #noise:\n- drop_id=00000000 @h0 · "Quiet"');
    expect(notificationText(summary, 'counts')).toBeNull();
  });
});

it('records items under the same keys as the server-side channels (Feishu), so neither repeats the other', async () => {
  // Same vectors as noticeKey in packages/domain (apps/api/src/feishu.test.ts); the CLI cannot import the domain.
  const { currentKeys } = await import('./hook-notifications.js');
  const keys = currentKeys({
    unread: 1,
    unread_drops: [
      {
        drop_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        title: 't',
        author: { handle: 'a', display_label: 'A' },
        attachment_count: 0,
      },
    ],
    contact_requests: [{ handle: 'bob', display_name: 'Bob' }],
    group_invitations: [{ slug: 'lab', display_name: 'Lab' }],
    group_join_requests: [
      {
        slug: 'lab',
        display_name: 'Lab',
        invitee_handle: 'carol',
        invitee_display_name: 'C',
        invited_by_handle: 'bob',
        decide_url: 'https://x',
      },
    ],
    approvals: 0,
    agent_name: 'x',
  });
  expect(keys.drops).toEqual(['d9fedea7cb11c14c']);
  expect(keys.contacts).toEqual(['10a032fce09bcc56']);
  expect(keys.invitations).toEqual(['a8d294c9fd72a5de']);
  expect(keys.join_requests).toEqual(['7b4036f0643d39db']);
});

describe('direct and group messages are told apart', () => {
  const drop = (id: string, handle: string, title: string, group: { name: string; slug: string } | null) => ({
    drop_id: `${id.repeat(8)}-0000-4000-8000-000000000000`,
    title,
    author: { handle, display_label: handle.toUpperCase() },
    attachment_count: 0,
    direct: group === null,
    group,
  });
  const mixed: PendingSummary = {
    ...empty,
    unread: 4,
    unread_drops: [
      drop('1', 'bob', 'Lab update', { name: 'Core team', slug: 'core' }),
      drop('2', 'alice', 'For you', null),
      { ...drop('3', 'carol', 'Plan', { name: 'Core team', slug: 'core' }), mentioned_me: true },
      drop('4', 'dave', 'Old', { name: '', slug: '' }),
    ],
  };

  it('lists direct messages first, then one section per group, naming the group and the sender', () => {
    expect(notificationText(mixed, 'counts', 'zh')).toBe(
      [
        'AgentDrop 新通知',
        '新消息：4 条',
        '私信：',
        '- @alice ·「For you」',
        '群 「Core team」#core：',
        '- @carol @了你 ·「Plan」',
        '- @bob ·「Lab update」',
        '群消息：',
        '- @dave ·「Old」',
      ].join('\n'),
    );
    const names = notificationText(mixed, 'names', 'en') ?? '';
    expect(names).toContain('Direct messages:\n- ALICE @alice · "For you"');
    expect(names).toContain(
      'In group “Core team” #core:\n- CAROL @carol mentioned you · "Plan"\n- BOB @bob · "Lab update"',
    );
    expect(names).not.toMatch(/1111|2222|drop_id/);
  });

  it('gives the model the full drop ids under the same sections', () => {
    const text = pendingContextText(mixed) ?? '';
    expect(text).toContain(
      'Direct (sent to the user personally):\n- drop_id=22222222-0000-4000-8000-000000000000 @alice · "For you"',
    );
    expect(text).toContain(
      'Group “Core team” #core:\n- drop_id=33333333-0000-4000-8000-000000000000 @carol (mentions the user) · "Plan"\n- drop_id=11111111-0000-4000-8000-000000000000 @bob',
    );
  });

  it("says when a message answers one of the person's drops, for people and for the model", () => {
    const replies: PendingSummary = {
      ...empty,
      unread: 2,
      unread_drops: [
        { ...drop('5', 'wang', 'Re: Ablation results', null), reply_to_title: 'Ablation results, run 14' },
        // the original is not readable for this person (or gone): no title, so nothing is said about it
        { ...drop('6', 'mia', 'Tokens', { name: 'Design', slug: 'design' }), reply_to_title: null },
      ],
    };
    expect(notificationText(replies, 'counts', 'en')).toContain(
      '- @wang replied to "Ablation results, run 14" · "Re: Ablation results"',
    );
    expect(notificationText(replies, 'counts', 'zh')).toContain(
      '- @wang 回复了「Ablation results, run 14」·「Re: Ablation results」',
    );
    expect(notificationText(replies, 'counts', 'en')).toContain('- @mia · "Tokens"');
    expect(pendingContextText(replies) ?? '').toContain(
      '- drop_id=55555555-0000-4000-8000-000000000000 @wang (replies to "Ablation results, run 14") · "Re: Ablation results"',
    );
  });

  it('names the progress a reply gives: for people in their language, for the model as a field (ADR 0038)', () => {
    const replies: PendingSummary = {
      ...empty,
      unread: 2,
      unread_drops: [
        {
          ...drop('5', 'wang', 'Re: Ablation results', null),
          reply_to_title: 'Ablation results, run 14',
          reply_progress: 'done',
        },
        // a value a newer server may add reads as a plain reply
        { ...drop('6', 'mia', 'Re: Plan', null), reply_to_title: 'Plan', reply_progress: 'paused' },
      ],
    };
    expect(notificationText(replies, 'counts', 'en')).toContain(
      '- @wang finished "Ablation results, run 14" · "Re: Ablation results"',
    );
    expect(notificationText(replies, 'counts', 'zh')).toContain(
      '- @wang 完成了「Ablation results, run 14」·「Re: Ablation results」',
    );
    expect(notificationText(replies, 'counts', 'en')).toContain('- @mia replied to "Plan" · "Re: Plan"');
    expect(pendingContextText(replies) ?? '').toContain(
      '@wang (replies to "Ablation results, run 14"; progress: done) · "Re: Ablation results"',
    );
    expect(pendingContextText(replies) ?? '').toContain('@mia (replies to "Plan") · "Re: Plan"');
  });

  it('fits the status bar in one line: counts, up to three names, muted groups left out', () => {
    const line: PendingSummary = {
      ...empty,
      unread: 4,
      unread_drops: [
        { ...drop('1', 'bob', 'Noise', { name: 'Chat', slug: 'chat' }), muted: true },
        drop('2', 'alice', 'For you', null),
        { ...drop('3', 'carol', 'Plan', { name: 'Core team', slug: 'core' }), mentioned_me: true },
        drop('4', 'dave', 'Notes', null),
      ],
      contact_requests: [{ handle: 'erin', display_name: 'Erin' }],
      approvals: 2,
    };
    expect(statusLineText(line, 'en')).toBe(
      '✉ AgentDrop · 3 new messages (@alice, @dave, #core) · 1 request · 2 approvals waiting',
    );
    expect(statusLineText(line, 'zh')).toBe(
      '✉ AgentDrop · 3 条新消息（@alice、@dave、#core）· 1 个申请 · 2 条待审批',
    );
    expect(statusLineText(empty, 'en')).toBe('');
  });

  it('never buries a direct message or a mention behind group traffic', () => {
    const chatter = Array.from({ length: 8 }, (_, i) =>
      drop(`${i + 1}`, 'bob', `Chatter ${i + 1}`, { name: 'Core team', slug: 'core' }),
    );
    const burst: PendingSummary = {
      ...empty,
      unread: 10,
      unread_drops: [
        ...chatter,
        { ...drop('a', 'carol', 'Need you', { name: 'Lab', slug: 'lab' }), mentioned_me: true },
        drop('b', 'alice', 'Private', null),
      ],
    };
    const text = notificationText(burst, 'counts') ?? '';
    expect(text).toBe(
      [
        'AgentDrop: new',
        'New messages: 10',
        'Direct messages:',
        '- @alice · "Private"',
        'In group “Lab” #lab:',
        '- @carol mentioned you · "Need you"',
        'In group “Core team” #core:',
        '- @bob · "Chatter 1"',
        '- @bob · "Chatter 2"',
        '- @bob · "Chatter 3"',
        '- 5 more new messages not listed; ask your agent to catch you up',
      ].join('\n'),
    );
  });

  it('leaves muted-group drops out of the people notice unless they mention the person', () => {
    const muted: PendingSummary = {
      ...empty,
      unread: 3,
      unread_drops: [
        { ...drop('1', 'bob', 'Chatter', { name: 'Noise', slug: 'noise' }), muted: true },
        { ...drop('2', 'carol', 'Ping', { name: 'Noise', slug: 'noise' }), muted: true, mentioned_me: true },
        drop('3', 'alice', 'Hi', null),
      ],
    };
    expect(notificationText(muted, 'counts', 'zh')).toBe(
      [
        'AgentDrop 新通知',
        '新消息：2 条',
        '私信：',
        '- @alice ·「Hi」',
        '群 「Noise」#noise：',
        '- @carol @了你 ·「Ping」',
      ].join('\n'),
    );
    // Only muted traffic: nothing to tell the person.
    expect(
      notificationText({ ...muted, unread: 1, unread_drops: muted.unread_drops.slice(0, 1) }, 'counts'),
    ).toBeNull();
  });
});

describe('more new messages than the fetch window', () => {
  const drop = (i: number) => ({
    drop_id: `${i}`.padStart(8, '0'),
    title: `M${i}`,
    author: { handle: 'bob', display_label: 'Bob' },
    attachment_count: 0,
  });
  it('says "at least" and that more are not listed when every fetched drop is new', async () => {
    const { onlyNew } = await import('./hook-notifications.js');
    const before: PendingSummary = { ...empty, unread: 1, unread_drops: [drop(0)] };
    const { shown } = onlyNew(before, undefined);
    // 30 more arrive; the hook fetched only the newest 20, all of them new.
    const after: PendingSummary = {
      ...empty,
      unread: 31,
      unread_drops: Array.from({ length: 20 }, (_, i) => drop(i + 1)),
    };
    const { fresh } = onlyNew(after, shown);
    expect(fresh.unread).toBe(20);
    expect(fresh.unread_at_least).toBe(true);
    const en = notificationText(fresh, 'counts') ?? '';
    expect(en).toContain('New messages: at least 20');
    expect(en).toContain('- at least 15 more new messages not listed; ask your agent to catch you up');
    const zh = notificationText(fresh, 'counts', 'zh') ?? '';
    expect(zh).toContain('新消息：至少 20 条');
    expect(zh).toContain('- 另有至少 15 条新消息未列出，可以让 Agent 帮你过一遍');
    // Some fetched rows were already shown: the new ones are exactly what is listed, no "at least".
    const mixed = onlyNew(
      { ...after, unread_drops: [...after.unread_drops.slice(0, 19), drop(0)] },
      shown,
    ).fresh;
    expect(mixed.unread).toBe(19);
    expect(mixed.unread_at_least).toBeUndefined();
    expect(notificationText(mixed, 'counts')).toContain('New messages: 19');
    // Nothing beyond the window: an exact count.
    const exact = onlyNew({ ...after, unread: 20 }, shown).fresh;
    expect(exact.unread_at_least).toBeUndefined();
  });
});
