import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeNoticeState, type NoticeState } from '@agentdrop/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PendingSummary } from './commands/pending.js';
import { writeTestProfile } from './harnesses/test-fixture.js';
import { announceSeen, notificationForHook } from './hook-notifications.js';

let dir: string;
const empty: PendingSummary = {
  unread: 0,
  unread_drops: [],
  contact_requests: [],
  group_invitations: [],
  approvals: 0,
  agent_name: 'A',
};
const settings = { enabled: true, interval_ms: 0, detail: 'counts' as const };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentdrop-notice-regression-'));
  vi.stubEnv('AGENTDROP_CONFIG_DIR', join(dir, 'config'));
  vi.stubEnv('AGENTDROP_STATE_DIR', join(dir, 'state'));
  writeTestProfile('codex', 'codex');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

it('does not claim a background preview when reading seen state fails temporarily', async () => {
  const claimSeen = vi.fn(async () => null);
  const claim = vi.fn(async () => null);
  await notificationForHook('codex', settings, {
    fetchPending: async () => ({ ...empty, approvals: 1 }),
    mode: 'preview',
    session: 'background',
    shared: {
      seen: async () => {
        throw new Error('temporary network failure');
      },
      claimSeen,
      claim,
    },
  });
  expect(claimSeen).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled();
});

it.each(['contact', 'invitation', 'join', 'approval'] as const)(
  'announces a renewed %s after it cleared in the same session',
  async (kind) => {
    let seen: NoticeState | null = null;
    const deps = {
      session: 'same-session',
      claimSeen: async (current: NoticeState) => {
        const previous = seen;
        seen = mergeNoticeState(previous, current);
        return previous;
      },
    };
    const pending: PendingSummary = {
      ...empty,
      ...(kind === 'contact' ? { contact_requests: [{ handle: 'alice', display_name: 'Alice' }] } : {}),
      ...(kind === 'invitation' ? { group_invitations: [{ slug: 'team', display_name: 'Team' }] } : {}),
      ...(kind === 'join'
        ? {
            group_join_requests: [
              {
                slug: 'team',
                display_name: 'Team',
                invitee_handle: 'alice',
                invitee_display_name: 'Alice',
                invited_by_handle: 'bob',
                decide_url: 'https://example.test',
              },
            ],
          }
        : {}),
      ...(kind === 'approval' ? { approvals: 1 } : {}),
    };
    expect(await announceSeen('codex', pending, settings, deps)).not.toBeNull();
    expect(await announceSeen('codex', empty, settings, deps)).toBeNull();
    expect(await announceSeen('codex', pending, settings, deps)).not.toBeNull();
    expect(await announceSeen('codex', pending, settings, deps)).toBeNull();
  },
);

it('backs off after seen-state failure and retries when the failure cooldown expires', async () => {
  let now = Date.now();
  const fetchPending = vi.fn(async () => ({ ...empty, approvals: 1 }));
  const seen = vi.fn(async () => {
    throw new Error('temporary failure');
  });
  const claim = vi.fn(async () => null);
  const deps = { fetchPending, now: () => now, mode: 'preview' as const, shared: { seen, claim } };
  expect(await notificationForHook('codex', settings, deps)).toBeNull();
  now += 1000;
  expect(await notificationForHook('codex', settings, deps)).toBeNull();
  expect(fetchPending).toHaveBeenCalledTimes(1);
  expect(seen).toHaveBeenCalledTimes(1);
  now += 5 * 60 * 1000;
  expect(await notificationForHook('codex', settings, deps)).toBeNull();
  expect(fetchPending).toHaveBeenCalledTimes(2);
  expect(claim).not.toHaveBeenCalled();
});
