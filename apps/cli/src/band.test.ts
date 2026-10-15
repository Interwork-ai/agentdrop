import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ackCommand,
  BandFailure,
  bandData,
  markReadCommand,
  modFailure,
  moreUnread,
  truncate,
} from './commands/band.js';
import { readCommand } from './commands/mail.js';
import { fetchPending } from './commands/pending.js';
import type { Output } from './output.js';

/*
 * The commands the Claude Code mod runs, against a stand-in server: what the band lists, and what "On it", "Mark
 * read" and opening a drop in the pane send. The mod itself is checked in claude-mod.test.ts and by hand in a real
 * session.
 */

const ME = '22222222-2222-4222-8222-222222222222';
const WANG = '33333333-3333-4333-8333-333333333333';
const LAB = '44444444-4444-4444-8444-444444444444';
const H_HERE = '11111111-1111-4111-8111-111111111111';
const H_OTHER = '55555555-5555-4555-8555-555555555555';
const id = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (s: number) =>
  `2026-10-02T08:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`;
const lab = { group_id: LAB, slug: 'lab', display_name: 'Lab' };

type Drop = Record<string, unknown> & { drop_id: string };
const drop = (n: number, title: string, extra: Record<string, unknown> = {}): Drop => ({
  drop_id: id(n),
  title,
  author: {
    user_id: WANG,
    handle: 'wang',
    display_label: 'Wang\u0007',
    public_name: null,
    public_email: null,
  },
  attachment_count: 0,
  created_at: at(n),
  received_at: at(n),
  sources: ['direct'],
  read: false,
  state_version: n,
  deliveries: [],
  ...extra,
});
const inGroup = (extra: Record<string, unknown> = {}) => ({
  sources: ['group'],
  group_labels: [lab],
  ...extra,
});

let server: Server;
let dir: string;
let pages: Drop[][] = [];
let unreadCount = 0;
let details: Record<string, Drop> = {};
let sendRefusesMentions = false;
let sendOutcome = 'delivered';
let conflictOnce: string | null = null;
/** A state change of these drops fails with this code (every time). */
let patchFails: Record<string, string> = {};
let patchDelayMs = 0;
let patchInFlight = 0;
let patchMaxInFlight = 0;
let sendConflict = false;
let listDelayMs = 0;
const sent: Array<Record<string, unknown>> = [];
const marked: unknown[] = [];
const patched: Array<{ id: string; body: Record<string, unknown> }> = [];
let listQueries = 0;
const saved: Record<string, string | undefined> = {};
const lastPayload = (): Record<string, unknown> =>
  ((sent.at(-1) ?? {}) as { payload?: Record<string, unknown> }).payload ?? {};

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
function apiError(res: ServerResponse, status: number, code: string, extra: Record<string, unknown> = {}) {
  json(
    res,
    { code, message: `server words for ${code}`, next_action: 'x', retryable: false, ...extra },
    status,
  );
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentdrop-band-'));
  server = createServer(async (req, res) => {
    const url = req.url ?? '';
    if (url === '/v1/h/identity')
      return json(res, { viewer: { agent_name: 'A', pending: { unread: 4, approvals: 1 } } });
    if (url === '/v1/h/requests')
      return json(res, {
        contact_requests_received: [{ handle: 'mia', display_name: 'Mia' }],
        group_invitations: [],
        groups: [{ group_id: LAB, slug: 'lab', display_name: 'Lab' }],
      });
    if (url.startsWith('/v1/h/drops?')) {
      listQueries += 1;
      if (listDelayMs) await new Promise((done) => setTimeout(done, listDelayMs));
      const cursor = new URL(url, 'http://x').searchParams.get('cursor');
      const page = cursor ? Number(cursor) : 0;
      return json(res, {
        drops: pages[page] ?? [],
        unread_count: unreadCount,
        next_cursor: page + 1 < pages.length ? String(page + 1) : null,
        viewer: {},
      });
    }
    if (url === '/v1/h/drops/mark-read' && req.method === 'POST') {
      marked.push(await body(req));
      return json(res, { marked: 2, remaining: 0, unread_count: 2, viewer: {} });
    }
    if (url === '/v1/h/drops' && req.method === 'POST') {
      const b = await body(req);
      const payload = b.payload as { mentions?: string[] };
      if (sendRefusesMentions && payload.mentions?.length)
        return apiError(res, 400, 'VALIDATION_FAILED', { details: { field: 'mentions', handle: 'wang' } });
      if (sendConflict) return apiError(res, 409, 'IDEMPOTENCY_CONFLICT');
      sent.push(b);
      return json(res, { outcome: sendOutcome, drop_id: 'r1', recipients: [] });
    }
    const state = /^\/v1\/h\/drops\/([^/?]+)\/state$/.exec(url);
    if (state && req.method === 'PATCH') {
      const b = await body(req);
      const dropId = state[1] ?? '';
      patchInFlight += 1;
      patchMaxInFlight = Math.max(patchMaxInFlight, patchInFlight);
      if (patchDelayMs) await new Promise((done) => setTimeout(done, patchDelayMs));
      patchInFlight -= 1;
      const failWith = patchFails[dropId];
      if (failWith)
        return apiError(res, failWith === 'NOT_FOUND' ? 404 : failWith === 'FORBIDDEN' ? 403 : 500, failWith);
      if (conflictOnce === dropId) {
        conflictOnce = null;
        return apiError(res, 409, 'VERSION_CONFLICT', { details: { current_version: 99 } });
      }
      patched.push({ id: dropId, body: b });
      return json(res, { drop_id: dropId, read: true, starred: false, archived: false, state_version: 1 });
    }
    const one = /^\/v1\/h\/drops\/([^?/]+)/.exec(url);
    if (one) {
      const found = details[one[1] ?? ''];
      if (!found) return apiError(res, 404, 'NOT_FOUND');
      return json(res, {
        drop: {
          recipients: [],
          attachments: [],
          body_chunk: 'x',
          next_offset: null,
          body_total_chars: 1,
          origin_agent: null,
          ...found,
        },
        viewer: {},
      });
    }
    apiError(res, 404, 'NOT_FOUND');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no listener');
  for (const [key, value] of Object.entries({
    AGENTDROP_CONFIG_DIR: join(dir, 'config'),
    AGENTDROP_STATE_DIR: join(dir, 'state'),
    AGENTDROP_DATA_DIR: join(dir, 'data'),
    AGENTDROP_CREDENTIAL_STORE: 'file',
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  mkdirSync(join(dir, 'config', 'profiles'), { recursive: true });
  mkdirSync(join(dir, 'config', 'credentials'), { recursive: true });
  writeFileSync(join(dir, 'config', 'credentials', 'band.token'), 'band-fixture-token', { mode: 0o600 });
  writeFileSync(join(dir, 'config', 'settings.json'), JSON.stringify({ updates: { mode: 'off' } }));
  for (const name of ['cc', 'cc2'])
    writeFileSync(
      join(dir, 'config', 'profiles', `${name}.json`),
      JSON.stringify({
        profile: name,
        server_url: `http://127.0.0.1:${address.port}`,
        h_id: H_HERE,
        harness: 'claude-code',
        profile_key: name,
        user_id: ME,
        handle: 'me',
        agent_name: 'A',
        credential_ref: { store: 'file', account: 'band' },
        credential_expires_at: '2099-01-01T00:00:00Z',
        paired_at: '2026-01-01T00:00:00Z',
      }),
    );
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // every test starts without a band cache
  rmSync(join(dir, 'state', 'band'), { recursive: true, force: true });
  sendRefusesMentions = false;
  sendOutcome = 'delivered';
  conflictOnce = null;
  patchFails = {};
  patchDelayMs = 0;
  patchMaxInFlight = 0;
  sendConflict = false;
  listDelayMs = 0;
  const inbox = [
    drop(1, 'Direct question'),
    drop(2, 'Calls on you', inGroup({ mentioned_me: true })),
    drop(3, 'Group chatter', inGroup({ received_at: at(30) })),
    drop(4, 'Muted chatter', inGroup({ muted: true })),
  ];
  pages = [inbox];
  unreadCount = 6;
  details = Object.fromEntries(inbox.map((d) => [d.drop_id, d]));
});

function capture(): { out: Output; results: unknown[] } {
  const results: unknown[] = [];
  const out = {
    json: true,
    result: (value: unknown) => results.push(value),
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Output;
  return { out, results };
}

describe('the band commands', () => {
  it('uses the same direct-delivery precedence as prompt and Stop notices', async () => {
    pages = [
      [
        drop(10, 'Delivered both ways', {
          sources: ['direct', 'group'],
          group_labels: [lab],
          mentioned_me: true,
        }),
      ],
    ];
    unreadCount = 1;
    const pending = await fetchPending('cc');
    const band = await bandData('cc', { fresh: true });
    expect(pending?.unread_drops[0]).toMatchObject({ direct: true, group: null });
    expect(band.drops[0]).toMatchObject({ drop_id: id(10), group: null });
    expect(band.groups).toEqual([]);
  });

  it('keeps known group origins when older servers omit labels, without inventing an address', async () => {
    pages = [
      [
        drop(10, 'Group without label', { sources: ['group'] }),
        drop(11, 'Old metadata', { sources: undefined }),
        drop(12, 'Label without sources', { sources: undefined, group_labels: [lab], mentioned_me: true }),
      ],
    ];
    unreadCount = 3;
    const pending = await fetchPending('cc');
    const band = await bandData('cc', { fresh: true });
    expect(pending?.unread_drops.map((d) => d.group)).toEqual([
      { name: '', slug: '' },
      null,
      { name: 'Lab', slug: 'lab' },
    ]);
    expect(band.drops.map((d) => d.group)).toEqual([
      { group_id: '', name: '', slug: '' },
      null,
      { group_id: LAB, name: 'Lab', slug: 'lab' },
    ]);
    expect(band.groups).toEqual([]);
  });

  it('lists drops to answer one by one, the rest by group, muted groups only when called on', async () => {
    const data = await bandData('cc', { fresh: true });
    expect(data.drops.map((d) => d.title)).toEqual(['Direct question', 'Calls on you']);
    expect(data.drops[1]).toMatchObject({ mentioned: true, group: { group_id: LAB, slug: 'lab' } });
    // other people's text is cleaned of control characters before it reaches a terminal row
    expect(data.drops[0]?.from.label).toBe('Wang');
    expect(data.groups).toEqual([
      {
        group_id: LAB,
        slug: 'lab',
        name: 'Lab',
        count: 1,
        from: ['Wang'],
        // received time, as the dashboard sorts, not when it was written
        up_to: at(30),
        // "Mark read" stands for these and nothing else: not the mention listed above
        // the pane lists them to open, cleaned like every other line
        drops: [{ drop_id: id(3), state_version: 3, title: 'Group chatter', from: 'Wang', at: at(30) }],
      },
    ]);
    expect(data.requests).toEqual({ contacts: 1, invitations: 0, join_requests: 0, approvals: 1 });
    // every unread drop was read, the muted one the band skips included: nothing "more" to count
    expect(data.more).toBe(0);
  });

  it("promotes a reply only when it answers the person's own drop; an older server keeps the row", async () => {
    pages = [
      [
        drop(11, 'Re: Plan', inGroup({ reply_to: { drop_id: id(90), title: 'Plan', mine: true } })),
        drop(
          12,
          'Re: Their plan',
          inGroup({ reply_to: { drop_id: id(91), title: 'Their plan', mine: false } }),
        ),
        drop(13, 'Re: Old server', inGroup({ reply_to: { drop_id: id(92), title: 'Old server' } })),
        drop(14, 'Re: Direct', { reply_to: { drop_id: id(93), title: 'Direct', mine: false } }),
      ],
    ];
    unreadCount = 4;
    const data = await bandData('cc', { fresh: true });
    expect(data.drops.map((d) => [d.title, d.reply_to_title, d.reply_to_mine])).toEqual([
      ['Re: Plan', 'Plan', true],
      ['Re: Old server', 'Old server', null],
      // a direct drop answering someone else's: its own row, like any direct drop, no reply wording
      ['Re: Direct', null, null],
    ]);
    // answering someone else in the group is group traffic
    expect(data.groups[0]?.drops).toMatchObject([{ drop_id: id(12), state_version: 12 }]);
  });

  it('reads past a page of group chatter so direct drops and mentions are not hidden', async () => {
    const chatter = Array.from({ length: 50 }, (_, i) => drop(100 + i, `chatter ${i}`, inGroup()));
    pages = [chatter, [drop(5, 'Old direct question')]];
    unreadCount = 51;
    const data = await bandData('cc', { fresh: true });
    expect(data.drops.map((d) => d.title)).toEqual(['Old direct question']);
    expect(data.groups[0]?.count).toBe(50);
    expect(data.more).toBe(0);
  });

  it('shares one query among every session for 15 seconds, one cache per profile', async () => {
    await bandData('cc');
    const before = listQueries;
    await bandData('cc');
    await bandData('cc');
    expect(listQueries).toBe(before);
    // another profile of the same person keeps its own cache
    await bandData('cc2');
    expect(listQueries).toBe(before + 1);
    await bandData('cc', { fresh: true });
    expect(listQueries).toBe(before + 2);
  });

  it('never answers --fresh with data from before the action, even while another session refreshes', async () => {
    const stale = await bandData('cc', { now: Date.now() - 1000 });
    expect(stale.drops).toHaveLength(2);
    // another session holds the lock and is querying right now
    const lock = readdirSync(join(dir, 'state', 'band')).find((f) => f.endsWith('.json'));
    const lockDir = join(dir, 'state', 'band', `${lock}.lock`);
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner-x.json'), JSON.stringify({ pid: process.pid, token: 'x' }));
    // an ordinary poll may show what we have; a refresh after the person acted may not
    expect((await bandData('cc')).drops).toHaveLength(2);
    await expect(bandData('cc', { fresh: true, waitMs: 300 })).rejects.toBeInstanceOf(BandFailure);
    rmSync(lockDir, { recursive: true, force: true });
    const before = listQueries;
    await bandData('cc', { fresh: true });
    expect(listQueries).toBe(before + 1);
  });

  it('"On it" answers where it was asked, once per language, and drops the band cache', async () => {
    await bandData('cc');
    const direct = capture();
    await ackCommand(direct.out, { profile: 'cc', dropId: id(1) });
    expect(sent.at(-1)).toMatchObject({
      request_id: `ack:${id(1)}:en`,
      targets: [{ type: 'user', user_id: WANG }],
      payload: { title: 'Re: Direct question', reply_to: id(1), body: "Got it, I'm on it." },
    });
    expect(lastPayload().mentions).toBeUndefined();
    expect(direct.results[0]).toMatchObject({
      outcome: 'delivered',
      to: 'Wang',
      message: "Replied to Wang: Got it, I'm on it.",
    });
    // the next poll of any session queries again instead of showing the row just answered
    const before = listQueries;
    await bandData('cc');
    expect(listQueries).toBe(before + 1);

    const group = capture();
    await ackCommand(group.out, { profile: 'cc', dropId: id(2) });
    expect(sent.at(-1)).toMatchObject({
      request_id: `ack:${id(2)}:en`,
      targets: [{ type: 'group', group_id: LAB }],
      payload: { reply_to: id(2), mentions: ['wang'] },
    });
    expect(group.results[0]).toMatchObject({ to: '“Lab” #lab' });

    // the person switched to Chinese: another body, so another request id rather than a conflict
    writeFileSync(join(dir, 'config', 'locale.json'), JSON.stringify({ language: 'zh' }));
    try {
      const zh = capture();
      await ackCommand(zh.out, { profile: 'cc', dropId: id(1) });
      expect(sent.at(-1)).toMatchObject({
        request_id: `ack:${id(1)}:zh`,
        payload: { body: '收到，我在处理了。' },
      });
      expect(zh.results[0]).toMatchObject({ message: '已回复 Wang：收到，我在处理了。' });
    } finally {
      rmSync(join(dir, 'config', 'locale.json'), { force: true });
    }
  });

  it('"On it" keeps one "Re:", says what happened, and answers in the group when the author left it', async () => {
    details[id(1)] = drop(1, 'Re: Direct question');
    sendOutcome = 'needs_approval';
    const approval = capture();
    await ackCommand(approval.out, { profile: 'cc', dropId: id(1) });
    expect(lastPayload().title).toBe('Re: Direct question');
    expect(approval.results[0]).toMatchObject({
      outcome: 'needs_approval',
      message: 'Your reply to Wang waits for your approval in the dashboard.',
    });

    sendOutcome = 'delivered';
    sendRefusesMentions = true;
    const left = capture();
    await ackCommand(left.out, { profile: 'cc', dropId: id(2) });
    expect(sent.at(-1)).toMatchObject({
      request_id: `ack:${id(2)}:en:group`,
      targets: [{ type: 'group', group_id: LAB }],
      payload: { reply_to: id(2) },
    });
    expect(lastPayload().mentions).toBeUndefined();
    expect(left.results[0]).toMatchObject({ outcome: 'delivered', to: '“Lab” #lab' });

    // the person's own drop is refused with a code the mod can name
    details[id(7)] = drop(7, 'Mine', { author: { user_id: ME, handle: 'me', display_label: 'Me' } });
    const own = await ackCommand(capture().out, { profile: 'cc', dropId: id(7) }).catch((e) => e);
    expect(modFailure(own)).toEqual({ error: { code: 'OWN_DROP' }, language: 'en' });
  });

  it('"Mark read" on a group row marks exactly its drops, retrying a moved version once', async () => {
    const c = capture();
    conflictOnce = id(3);
    patched.length = 0;
    // no version given: read first; already read by now, so left alone
    details[id(9)] = drop(9, 'Nine', inGroup({ read: true }));
    await markReadCommand(c.out, { profile: 'cc', drops: [`${id(3)}:3`, id(9)] });
    expect(patched).toEqual([{ id: id(3), body: { expected_version: 99, read: true } }]);
    expect(c.results[0]).toEqual({ marked: 1, skipped: 0 });
    details[id(9)] = drop(9, 'Nine', inGroup({ state_version: 4 }));
    patched.length = 0;
    await markReadCommand(capture().out, { profile: 'cc', drops: [id(9)] });
    expect(patched).toEqual([{ id: id(9), body: { expected_version: 4, read: true } }]);
    // nothing went through the whole-group "mark all" route
    expect(marked).toEqual([]);
  });

  it('"Mark read" without --drop still marks one group up to a time', async () => {
    const c = capture();
    await markReadCommand(c.out, { profile: 'cc', group: LAB, upTo: at(3) });
    expect(marked.at(-1)).toEqual({ group_id: LAB, up_to: at(3) });
    expect(c.results[0]).toMatchObject({ marked: 2 });
    marked.length = 0;
  });

  it('"Mark read" takes a group as a person writes it: #slug', async () => {
    const c = capture();
    await markReadCommand(c.out, { profile: 'cc', group: '#lab' });
    expect(marked.at(-1)).toEqual({ group_id: LAB });
    await expect(markReadCommand(c.out, { profile: 'cc', group: '#nope' })).rejects.toThrow(
      'you are not in a group #nope',
    );
    marked.length = 0;
  });

  it('"On it" from a terminal takes an id prefix and a one-line plan', async () => {
    pages = [[drop(1, 'Direct question')]];
    details[id(1)] = drop(1, 'Direct question');
    const c = capture();
    await ackCommand(c.out, {
      profile: 'cc',
      dropId: id(1).slice(0, 8),
      note: 'Will send the numbers\nby Friday ',
    });
    expect(sent.at(-1)).toMatchObject({
      request_id: `ack:${id(1)}:en`,
      payload: { reply_to: id(1), body: "Got it, I'm on it.\n\nWill send the numbers by Friday" },
    });
    await expect(ackCommand(c.out, { profile: 'cc', dropId: 'd0' })).rejects.toThrow(/at least its first 4/);
    pages = [];
  });

  it('opening a drop in the pane marks it read for the person, whichever of their agents received it', async () => {
    details[id(8)] = drop(8, 'To my other agent', {
      read: false,
      state_version: 6,
      deliveries: [
        {
          h_id: H_OTHER,
          agent_name: 'B',
          harness_key: 'codex',
          received_at: at(8),
          read: false,
          starred: false,
          archived: false,
          state_version: 6,
          sources: ['direct'],
          group_ids: [],
          current: false,
        },
      ],
    });
    patched.length = 0;
    await readCommand(capture().out, { profile: 'cc', dropId: id(8), markRead: true });
    expect(patched).toEqual([{ id: id(8), body: { expected_version: 6, read: true } }]);
    // already read: nothing to change
    details[id(8)] = { ...(details[id(8)] as Drop), read: true };
    patched.length = 0;
    await readCommand(capture().out, { profile: 'cc', dropId: id(8), markRead: true });
    expect(patched).toEqual([]);
  });

  it('reports failures to the mod by code only', async () => {
    const missing = await bandData('nobody').catch((e) => e);
    expect(modFailure(missing)).toEqual({ error: { code: 'NOT_PAIRED' }, language: 'en' });
    const gone = await ackCommand(capture().out, { profile: 'cc', dropId: id(77) }).catch((e) => e);
    expect(modFailure(gone)).toEqual({ error: { code: 'NOT_FOUND' }, language: 'en' });
    expect(modFailure(new Error('profile "x" not found; run agentdrop endpoint add'))).toEqual({
      error: { code: 'FAILED' },
      language: 'en',
    });
  });

  it('prints the failure code on stdout with --json, where the mod reads it', async () => {
    const { run } = await import('./main.js');
    const written: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) =>
      written.push(String(chunk)) > 0) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await run(['node', 'agentdrop', '--json', 'ack', id(77), '--profile', 'cc']);
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      process.exitCode = 0;
    }
    // with whether notices are on, so the mod stays quiet about failures when they are off
    expect(JSON.parse(written.join(''))).toEqual({
      error: { code: 'NOT_FOUND' },
      language: 'en',
      enabled: true,
    });
  });
});

describe('the band commands after the review', () => {
  it('counts "N more unread" only beyond what it read, never the muted drops it skipped', async () => {
    // the window ran out: what the server counts beyond it is "more"
    const page = (p: number) =>
      Array.from({ length: 50 }, (_, i) => drop(400 + p * 50 + i, `muted ${i}`, inGroup({ muted: true })));
    pages = [page(0), page(1), page(2), page(3), page(4)];
    unreadCount = 260;
    expect((await bandData('cc', { fresh: true })).more).toBe(60);
    // everything was read: the 50 muted drops are neither rows nor "more"
    pages = [Array.from({ length: 50 }, (_, i) => drop(200 + i, `muted ${i}`, inGroup({ muted: true })))];
    unreadCount = 50;
    const data = await bandData('cc', { fresh: true });
    expect([data.drops.length, data.groups.length, data.more]).toEqual([0, 0, 0]);
  });

  it('sessions starting at once without a cache wait for the one that queries, instead of failing', async () => {
    listDelayMs = 150;
    const before = listQueries;
    const all = await Promise.all(Array.from({ length: 5 }, () => bandData('cc')));
    expect(all.map((d) => d.drops.length)).toEqual([2, 2, 2, 2, 2]);
    expect(listQueries).toBe(before + 1);
    // the wait is bounded: a holder that never finishes ends in BUSY, which the mod does not count as a failure
    const cache = readdirSync(join(dir, 'state', 'band')).find((f) => f.endsWith('.json'));
    const lockDir = join(dir, 'state', 'band', `${cache}.lock`);
    rmSync(join(dir, 'state', 'band'), { recursive: true, force: true });
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner-x.json'), JSON.stringify({ pid: process.pid, token: 'x' }));
    const busy = await bandData('cc', { waitMs: 300 }).catch((e) => e);
    expect(modFailure(busy).error.code).toBe('BUSY');
    rmSync(lockDir, { recursive: true, force: true });
  });

  it('"Mark read" skips a drop that is gone or changed, marks the rest a few at a time, and says how many', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => id(300 + i));
    patchFails = { [id(301)]: 'NOT_FOUND', [id(302)]: 'FORBIDDEN', [id(303)]: 'VERSION_CONFLICT' };
    patchDelayMs = 20;
    patched.length = 0;
    const c = capture();
    await markReadCommand(c.out, { profile: 'cc', drops: ids.map((x) => `${x}:1`) });
    expect(c.results[0]).toEqual({ marked: 17, skipped: 3 });
    expect(patched).toHaveLength(17);
    // concurrent, but bounded
    expect(patchMaxInFlight).toBeGreaterThan(1);
    expect(patchMaxInFlight).toBeLessThanOrEqual(8);
    // nothing could be marked: still a result, the mod says so
    const none = capture();
    await markReadCommand(none.out, { profile: 'cc', drops: [`${id(301)}:1`] });
    expect(none.results[0]).toEqual({ marked: 0, skipped: 1 });
    // anything else is a failure the mod names
    patchFails = { [id(310)]: 'INTERNAL' };
    const failed = await markReadCommand(capture().out, { profile: 'cc', drops: [`${id(310)}:1`] }).catch(
      (e) => e,
    );
    expect(modFailure(failed).error.code).toBe('INTERNAL');
  });

  it('"Mark read" takes full drop ids only, and never --drop with --group', async () => {
    patched.length = 0;
    for (const drops of [['abc'], [`${id(1)}:x`], [`${id(1)}:1:2`], ['../../v1/h/identity']]) {
      const err = await markReadCommand(capture().out, { profile: 'cc', drops }).catch((e) => e);
      expect(modFailure(err).error.code).toBe('VALIDATION_FAILED');
    }
    const both = await markReadCommand(capture().out, { profile: 'cc', drops: [id(1)], group: LAB }).catch(
      (e) => e,
    );
    expect(both).toBeInstanceOf(BandFailure);
    expect(String(both.message)).toMatch(/--group/);
    expect(patched).toEqual([]);
  });

  it('opening a drop in the pane shows it even when marking it read fails', async () => {
    patchFails = { [id(1)]: 'INTERNAL' };
    const c = capture();
    await readCommand(c.out, { profile: 'cc', dropId: id(1), markRead: true });
    expect(c.results[0]).toMatchObject({ drop: { drop_id: id(1) }, mark_read_failed: 'INTERNAL' });
    patchFails = {};
    const ok = capture();
    await readCommand(ok.out, { profile: 'cc', dropId: id(1), markRead: true });
    expect(ok.results[0]).not.toHaveProperty('mark_read_failed');
  });

  it('"On it" again after the content changed (a new handle, a rejoin) says it was already sent', async () => {
    sendConflict = true;
    const c = capture();
    await ackCommand(c.out, { profile: 'cc', dropId: id(2) });
    expect(c.results[0]).toMatchObject({ outcome: 'already_sent', message: 'You already replied to that.' });
    writeFileSync(join(dir, 'config', 'locale.json'), JSON.stringify({ language: 'zh' }));
    try {
      const zh = capture();
      await ackCommand(zh.out, { profile: 'cc', dropId: id(1) });
      expect(zh.results[0]).toMatchObject({ outcome: 'already_sent', message: '已经回复过了。' });
    } finally {
      rmSync(join(dir, 'config', 'locale.json'), { force: true });
    }
  });

  it('keeps one "Re:" however it is written, and cuts titles between characters', async () => {
    details[id(1)] = drop(1, 'Re:Plan');
    await ackCommand(capture().out, { profile: 'cc', dropId: id(1) });
    expect(lastPayload().title).toBe('Re:Plan');
    expect(truncate('ab😀c', 3)).toBe('ab');
    expect(truncate('ab😀c', 4)).toBe('ab😀');
    expect(truncate('abc', 3)).toBe('abc');
    pages = [[drop(1, `${'a'.repeat(79)}😀 tail`)]];
    unreadCount = 1;
    const title = (await bandData('cc', { fresh: true })).drops[0]?.title ?? '';
    expect(title).toBe('a'.repeat(79));
    // no lone surrogate left
    expect(/[\uD800-\uDFFF]/.test(title)).toBe(false);
  });
});

describe('"N more unread"', () => {
  const page = (quiet: number, loud: number) => [
    ...Array.from({ length: quiet }, () => ({ muted: true, mentioned_me: false })),
    ...Array.from({ length: loud }, () => ({ muted: false })),
  ];
  it('counts beyond the window without the quiet drops the band never lists, as the server counts them', () => {
    // 300 unread, 200 read: 60 of those quiet; the server says 140 of all 300 stay quiet
    expect(moreUnread({ drops: page(60, 140), unread: 300, mutedUnread: 140, complete: false })).toBe(20);
    // an older server cannot say: its total is all the band has
    expect(moreUnread({ drops: page(60, 140), unread: 300, mutedUnread: null, complete: false })).toBe(100);
    // everything was read: nothing more
    expect(moreUnread({ drops: page(3, 4), unread: 7, mutedUnread: 3, complete: true })).toBe(0);
  });
});
