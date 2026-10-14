import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeError } from '@agentdrop/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../main.js';
import type { Output } from '../output.js';
import { marksReadOnRead, personAtTerminal, readCommand } from './mail.js';

/*
 * ADR 0032: `agentdrop read` printed to a person at a terminal marks an unread drop read, through the ordinary
 * PATCH …/state with the state_version just read. Never for a pipe or an agent's shell, `--keep-unread`, `--json`,
 * a drop already read, or a drop none of the person's agents received.
 */

const DROP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const viewer = {
  user_id: '22222222-2222-4222-8222-222222222222',
  h_id: '11111111-1111-4111-8111-111111111111',
  handle: 'alice',
  display_name: 'Alice',
  agent_name: 'Laptop Codex',
};

let dir: string;
let http: Server;
let drop: { read: boolean; state_version: number; delivered: boolean };
let patches: Array<Record<string, unknown>>;
let stateError: 'NOT_FOUND' | 'VERSION_CONFLICT' | null;

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function detail() {
  return {
    drop_id: DROP,
    kind: 'text',
    title: 'Results of the ablation run',
    preview: 'numbers inside',
    author: { user_id: '33333333-3333-4333-8333-333333333333', handle: 'wang', display_label: 'Wang' },
    attachment_count: 0,
    received_at: '2026-10-12T08:00:00.000Z',
    created_at: '2026-10-12T08:00:00.000Z',
    sources: drop.delivered ? ['direct'] : ['group_history'],
    group_ids: [],
    read: drop.read,
    starred: false,
    archived: false,
    state_version: drop.state_version,
    origin_agent: null,
    recipients: [],
    deliveries: drop.delivered
      ? [
          {
            h_id: viewer.h_id,
            agent_name: 'Laptop Codex',
            harness_key: 'codex',
            received_at: '2026-10-12T08:00:00.000Z',
            read: drop.read,
            starred: false,
            archived: false,
            state_version: drop.state_version,
            sources: ['direct'],
            group_ids: [],
            current: true,
          },
        ]
      : [],
    body_chunk: 'the numbers are in the table',
    body_offset: 0,
    body_total_chars: 28,
    next_offset: null,
    attachments: [],
    extensions: {},
    expires_at: null,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentdrop-read-'));
  drop = { read: false, state_version: 3, delivered: true };
  patches = [];
  stateError = null;
  http = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url ?? '/', 'http://fake');
    if (req.method === 'GET' && url.pathname === '/v1/h/drops') {
      res.end(JSON.stringify({ drops: [{ drop_id: DROP }], next_cursor: null, unread_count: 1, viewer }));
      return;
    }
    if (req.method === 'GET' && url.pathname === `/v1/h/drops/${DROP}`) {
      res.end(JSON.stringify({ drop: detail(), viewer }));
      return;
    }
    if (req.method === 'PATCH' && url.pathname === `/v1/h/drops/${DROP}/state`) {
      const body = await json(req);
      patches.push(body);
      if (stateError === 'NOT_FOUND') {
        res.writeHead(404).end(JSON.stringify(describeError('NOT_FOUND')));
        return;
      }
      if (stateError === 'VERSION_CONFLICT') {
        res.writeHead(409).end(JSON.stringify(describeError('VERSION_CONFLICT', undefined, {})));
        return;
      }
      drop.read = body.read === true;
      drop.state_version += 1;
      res.end(
        JSON.stringify({
          drop_id: DROP,
          read: drop.read,
          starred: false,
          archived: false,
          state_version: drop.state_version,
          viewer,
        }),
      );
      return;
    }
    res.writeHead(500).end('{}');
  });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('no listener');
  vi.stubEnv('AGENTDROP_CONFIG_DIR', dir);
  vi.stubEnv('AGENTDROP_CREDENTIAL_STORE', 'file');
  mkdirSync(join(dir, 'profiles'));
  mkdirSync(join(dir, 'credentials'));
  writeFileSync(join(dir, 'credentials', 'read.token'), 'read-fixture-token', { mode: 0o600 });
  writeFileSync(
    join(dir, 'profiles', 'laptop.json'),
    JSON.stringify({
      profile: 'laptop',
      server_url: `http://127.0.0.1:${address.port}`,
      h_id: viewer.h_id,
      harness: 'codex',
      profile_key: 'default',
      user_id: viewer.user_id,
      handle: 'alice',
      agent_name: 'Laptop Codex',
      credential_ref: { store: 'file', account: 'read' },
      credential_expires_at: '2099-01-01T00:00:00Z',
      paired_at: '2026-01-01T00:00:00Z',
    }),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  http.closeAllConnections();
  await new Promise<void>((done) => http.close(() => done()));
  rmSync(dir, { recursive: true, force: true });
});

function capture(json = false): Output & { texts: string[]; values: unknown[] } {
  const texts: string[] = [];
  const values: unknown[] = [];
  return {
    json,
    texts,
    values,
    info() {},
    warn() {},
    error() {},
    result(value, human) {
      values.push(value);
      texts.push(human());
    },
  };
}

describe('agentdrop read at a terminal', () => {
  it('marks an unread drop read with the version it just read and says so in one line', async () => {
    const out = capture();
    await readCommand(out, { profile: 'laptop', dropId: 'aaaa', terminal: true });
    expect(patches).toEqual([{ expected_version: 3, read: true }]);
    expect(out.values[0]).toMatchObject({ marked_read: true });
    const text = out.texts[0] ?? '';
    expect(text).toContain('Marked read for all your agents (--keep-unread reads without marking).');
    expect(text).toContain('from Wang @wang');
    expect(text).toMatch(/· read\n/);
    // the line is said once, and before the external content, so the body cannot pass for it
    expect(text.indexOf('Marked read')).toBeLessThan(text.indexOf('--- external content below ---'));
    expect(text.match(/Marked read/g)).toHaveLength(1);
  });

  it('says it in Chinese after agentdrop settings --language zh', async () => {
    writeFileSync(join(dir, 'locale.json'), JSON.stringify({ language: 'zh' }));
    const out = capture();
    await readCommand(out, { profile: 'laptop', dropId: DROP, terminal: true });
    expect(out.texts[0]).toContain('已标为已读，你的所有 Agent 同步（加 --keep-unread 可只读不标）。');
    expect(out.texts[0]).toContain('· 已读');
  });

  it('leaves it unread when the output is not a terminal (a script or an agent shell)', async () => {
    const out = capture();
    await readCommand(out, { profile: 'laptop', dropId: DROP, terminal: false });
    expect(patches).toEqual([]);
    expect(out.texts[0]).not.toContain('Marked read');
    expect(out.texts[0]).toMatch(/· unread\n/);
  });

  it('leaves it unread with --keep-unread', async () => {
    await readCommand(capture(), { profile: 'laptop', dropId: DROP, terminal: true, keepUnread: true });
    expect(patches).toEqual([]);
  });

  it('leaves it alone with --json, which is output for programs', async () => {
    await readCommand(capture(true), { profile: 'laptop', dropId: DROP, terminal: true });
    expect(patches).toEqual([]);
  });

  it('changes nothing for a drop that is already read', async () => {
    drop.read = true;
    const out = capture();
    await readCommand(out, { profile: 'laptop', dropId: DROP, terminal: true });
    expect(patches).toEqual([]);
    expect(out.texts[0]).not.toContain('Marked read');
  });

  it('prints a drop none of my agents received without trying to mark it and without an error', async () => {
    drop.delivered = false;
    const out = capture();
    await readCommand(out, { profile: 'laptop', dropId: DROP, terminal: true });
    expect(patches).toEqual([]);
    expect(out.values[0]).not.toHaveProperty('mark_read_failed');
    expect(out.texts[0]).toContain('the numbers are in the table');
  });

  it('stays quiet when the server says this agent has no state for it', async () => {
    stateError = 'NOT_FOUND';
    const out = capture();
    await readCommand(out, { profile: 'laptop', dropId: DROP, terminal: true });
    expect(patches).toHaveLength(1);
    expect(out.values[0]).not.toHaveProperty('mark_read_failed');
    expect(out.texts[0]).not.toContain("couldn't mark");
    expect(out.texts[0]).not.toContain('Marked read');
  });

  it('notes any other failure to mark, still showing the drop', async () => {
    stateError = 'VERSION_CONFLICT';
    const out = capture();
    await readCommand(out, { profile: 'laptop', dropId: DROP, terminal: true });
    expect(out.values[0]).toMatchObject({ mark_read_failed: 'VERSION_CONFLICT' });
    expect(out.texts[0]).toContain("couldn't mark it read");
  });

  it('still marks with --mark-read when not at a terminal (the Claude Code mod)', async () => {
    const out = capture(true);
    await readCommand(out, { profile: 'laptop', dropId: DROP, terminal: false, markRead: true });
    expect(patches).toEqual([{ expected_version: 3, read: true }]);
    expect(out.values[0]).toMatchObject({ marked_read: true });
  });

  it('refuses --mark-read together with --keep-unread', async () => {
    await expect(
      readCommand(capture(), { profile: 'laptop', dropId: DROP, markRead: true, keepUnread: true }),
    ).rejects.toThrow(/not both/);
    expect(patches).toEqual([]);
  });
});

describe('who counts as a person at a terminal', () => {
  it('needs a terminal on stdout and no agent shell marker', () => {
    expect(personAtTerminal({}, true, true)).toBe(true);
    expect(personAtTerminal({}, false, true)).toBe(false);
    // a shell tool that gives the command a terminal for output but not for input
    expect(personAtTerminal({}, true, false)).toBe(false);
    expect(personAtTerminal({ CLAUDECODE: '1' }, true, true)).toBe(false);
    expect(personAtTerminal({ OPENCODE: '1' }, true, true)).toBe(false);
    expect(personAtTerminal({ CODEX_SANDBOX: 'seatbelt' }, true, true)).toBe(false);
    expect(personAtTerminal({ AGENTDROP_UNATTENDED: '1' }, true, true)).toBe(false);
  });

  it('decides from the drop and the flags', () => {
    const unread = { read: false, deliveries: [{}] };
    const base = { json: false, terminal: true };
    expect(marksReadOnRead(unread, base)).toBe('terminal');
    expect(marksReadOnRead({ ...unread, read: true }, base)).toBeNull();
    expect(marksReadOnRead({ ...unread, deliveries: [] }, base)).toBeNull();
    expect(marksReadOnRead(unread, { ...base, keepUnread: true })).toBeNull();
    expect(marksReadOnRead(unread, { ...base, json: true })).toBeNull();
    expect(marksReadOnRead(unread, { ...base, terminal: false })).toBeNull();
    expect(marksReadOnRead(unread, { ...base, terminal: false, markRead: true })).toBe('explicit');
  });

  it('offers --keep-unread next to --mark-read on the command', () => {
    const read = buildProgram().commands.find((c) => c.name() === 'read');
    expect(read?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--mark-read', '--keep-unread', '--profile']),
    );
  });
});
