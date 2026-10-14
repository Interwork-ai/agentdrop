import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeError } from '@agentdrop/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../main.js';
import type { Output } from '../output.js';
import { DERIVED_TITLE_MAX, deriveSendTitle, sendCommand } from './send.js';

/*
 * `agentdrop send` against a fake server: the directory (GET /v1/h/directory) resolves who it goes to, files go
 * through upload_file's policy and POST /v1/h/attachments, the message is one POST /v1/h/drops.
 */

const viewer = {
  user_id: '22222222-2222-4222-8222-222222222222',
  h_id: '11111111-1111-4111-8111-111111111111',
  handle: 'alice',
  display_name: 'Alice',
  public_email: null,
  agent_name: 'Laptop Codex',
  directory_revision: 0,
  mailbox_revision: 0,
  pending: { unread: 0, contact_requests: 0, group_invitations: 0, approvals: 0 },
};

function person(handle: string, label: string, user_id: string) {
  return {
    kind: 'person',
    user_id,
    handle,
    display_label: label,
    display_name: label,
    remark: null,
    public_email: null,
    default_target: { type: 'user', user_id },
    default_target_label: label,
    default_endpoint: null,
    preference_applied: false,
    preference_problem: null,
    alternatives: [],
    contact_status: 'accepted',
  };
}
const WANG = person('wang', 'Wang', '33333333-3333-4333-8333-333333333333');
const WANGF = person('wangf', 'Wang', '44444444-4444-4444-8444-444444444444');
const MIA = person('mia', 'Mia', '55555555-5555-4555-8555-555555555555');
const LAB = {
  kind: 'group',
  group_id: '66666666-6666-4666-8666-666666666666',
  slug: 'lab',
  display_name: 'Lab',
  my_nickname: null,
  member_count: 3,
  current_h_receives: true,
  target: { type: 'group', group_id: '66666666-6666-4666-8666-666666666666' },
};
const INBOX_DROP = 'abcdef12-1111-4111-8111-111111111111';

let dir: string;
let work: string;
let http: Server;
interface SentBody {
  request_id: string;
  targets: unknown[];
  payload: { title: string; body: string; kind: string; attachment_ids: string[]; reply_to?: string };
}
let sends: SentBody[];
let lookups: string[];
let uploads: string[];
let outcome: 'delivered' | 'needs_approval' | 'not_sent';
let dropFirstSends: number;
let sendError: string | null;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentdrop-send-'));
  work = join(dir, 'work');
  mkdirSync(work);
  sends = [];
  lookups = [];
  uploads = [];
  outcome = 'delivered';
  dropFirstSends = 0;
  sendError = null;
  const drops = new Map<string, string>();
  http = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/v1/h/identity') {
      res.end(
        JSON.stringify({
          viewer,
          limits: {
            max_file_bytes: 1024 * 1024,
            max_drop_file_bytes: 2 * 1024 * 1024,
            quota_bytes: 1024 ** 3,
          },
        }),
      );
      return;
    }
    if (req.method === 'GET' && path === '/v1/h/directory') {
      const q = (url.searchParams.get('query') ?? '').toLowerCase();
      const kind = url.searchParams.get('kind');
      lookups.push(`${kind ?? 'any'}:${q}`);
      const all = [WANG, WANGF, MIA, LAB].filter(
        (e) =>
          ((!kind || e.kind === kind) && ('handle' in e ? e.handle : e.slug).includes(q)) ||
          e.display_name.toLowerCase().includes(q),
      );
      res.end(
        JSON.stringify({ entries: all, next_cursor: null, directory_revision: 1, ambiguous: false, viewer }),
      );
      return;
    }
    if (req.method === 'GET' && path === '/v1/h/drops') {
      res.end(
        JSON.stringify({ drops: [{ drop_id: INBOX_DROP }], next_cursor: null, unread_count: 0, viewer }),
      );
      return;
    }
    if (req.method === 'POST' && path === '/v1/h/attachments') {
      await readBody(req);
      const name = decodeURIComponent(String(req.headers['x-agentdrop-filename']));
      uploads.push(name);
      res.end(
        JSON.stringify({
          attachment_id: randomUUID(),
          safe_name: name,
          content_type: 'application/octet-stream',
          byte_size: Number(req.headers['content-length']),
          sha256: '0'.repeat(64),
          status: 'ready',
        }),
      );
      return;
    }
    if (req.method === 'POST' && path === '/v1/h/drops') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      sends.push(body);
      if (dropFirstSends > 0) {
        dropFirstSends -= 1;
        req.socket.destroy();
        return;
      }
      if (sendError) {
        res.writeHead(422).end(JSON.stringify(describeError(sendError as never)));
        return;
      }
      const drop_id = drops.get(body.request_id) ?? randomUUID();
      drops.set(body.request_id, drop_id);
      res.end(
        JSON.stringify({
          outcome,
          request_id: body.request_id,
          drop_id: outcome === 'delivered' ? drop_id : null,
          recipients: [],
          approval_url: outcome === 'needs_approval' ? 'https://drop.example.com/app/approvals/x' : null,
          retryable: false,
          error: outcome === 'not_sent' ? 'rejected by user' : null,
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
  vi.stubEnv('AGENTDROP_CONFIG_DIR', join(dir, 'config'));
  vi.stubEnv('AGENTDROP_DATA_DIR', join(dir, 'data'));
  vi.stubEnv('AGENTDROP_CREDENTIAL_STORE', 'file');
  mkdirSync(join(dir, 'config', 'profiles'), { recursive: true });
  mkdirSync(join(dir, 'config', 'credentials'));
  writeFileSync(join(dir, 'config', 'credentials', 'send.token'), 'send-fixture-token', { mode: 0o600 });
  writeFileSync(
    join(dir, 'config', 'profiles', 'laptop.json'),
    JSON.stringify({
      profile: 'laptop',
      server_url: `http://127.0.0.1:${address.port}`,
      h_id: viewer.h_id,
      harness: 'codex',
      profile_key: 'default',
      user_id: viewer.user_id,
      handle: 'alice',
      agent_name: 'Laptop Codex',
      credential_ref: { store: 'file', account: 'send' },
      credential_expires_at: '2099-01-01T00:00:00Z',
      paired_at: '2026-01-01T00:00:00Z',
      allowed_dirs: [work],
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

const noStdin = () => null;
function chinese() {
  writeFileSync(join(dir, 'config', 'locale.json'), JSON.stringify({ language: 'zh' }));
}

describe('agentdrop send: who it goes to', () => {
  it('sends to @handle through the person target and says who it reached', async () => {
    const out = capture();
    await sendCommand(out, {
      profile: 'laptop',
      to: '@wang',
      body: 'The ablation run finished.',
      stdin: noStdin,
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]?.targets).toEqual([{ type: 'user', user_id: WANG.user_id }]);
    expect(sends[0]?.payload).toMatchObject({ title: 'The ablation run finished.', kind: 'text' });
    expect(sends[0]?.request_id).toMatch(/^cli-send-/);
    expect(out.texts[0]).toBe('Sent to Wang @wang: The ablation run finished.\n  text: 26 characters');
  });

  it('sends to #group by its exact slug', async () => {
    const out = capture();
    await sendCommand(out, { profile: 'laptop', to: '#lab', body: 'standup notes', stdin: noStdin });
    expect(sends[0]?.targets).toEqual([LAB.target]);
    expect(out.texts[0]).toContain('Sent to “Lab” #lab: standup notes');
  });

  it('sends to me as my own space', async () => {
    const out = capture();
    await sendCommand(out, { profile: 'laptop', to: 'me', body: 'for the workstation', stdin: noStdin });
    expect(sends[0]?.targets).toEqual([{ type: 'self' }]);
    expect(lookups).toEqual([]);
    expect(out.texts[0]).toContain('Put in your space: for the workstation');
  });

  it('treats my own @handle as my space', async () => {
    await sendCommand(capture(), { profile: 'laptop', to: '@alice', body: 'note', stdin: noStdin });
    expect(sends[0]?.targets).toEqual([{ type: 'self' }]);
  });

  it('takes a plain name only when exactly one entry is called that', async () => {
    await sendCommand(capture(), { profile: 'laptop', to: 'Mia', body: 'hi', stdin: noStdin });
    expect(sends[0]?.targets).toEqual([MIA.default_target]);
  });

  it('asks for the @handle when a name fits several people, and sends nothing', async () => {
    await expect(
      sendCommand(capture(), { profile: 'laptop', to: 'Wang', body: 'hi', stdin: noStdin }),
    ).rejects.toThrow('"Wang" could be 2 recipients: Wang @wang, Wang @wangf. Give the @handle or #group.');
    expect(sends).toEqual([]);
  });

  it('never guesses a @handle from a longer one', async () => {
    await expect(
      sendCommand(capture(), { profile: 'laptop', to: '@wan', body: 'hi', stdin: noStdin }),
    ).rejects.toThrow(
      /@wan is not one of your contacts or groups yet\. Add them on http:\/\/127\.0\.0\.1:\d+\/app\/contacts/,
    );
    expect(sends).toEqual([]);
  });

  it('says how to join when the group is not one of mine', async () => {
    await expect(
      sendCommand(capture(), { profile: 'laptop', to: '#core', body: 'hi', stdin: noStdin }),
    ).rejects.toThrow('You are not in a group #core. agentdrop group list shows your groups and invitations');
  });

  it('says it in Chinese after agentdrop settings --language zh', async () => {
    chinese();
    await expect(
      sendCommand(capture(), { profile: 'laptop', to: '@bob', body: 'hi', stdin: noStdin }),
    ).rejects.toThrow(/@bob 还不是你的联系人或群。在 http:\/\/127\.0\.0\.1:\d+\/app\/contacts 添加/);
    const out = capture();
    await sendCommand(out, { profile: 'laptop', to: '#lab', body: '周会记录', stdin: noStdin });
    expect(out.texts[0]).toBe('已发给「Lab」#lab：周会记录\n  正文：4 字');
  });
});

describe('agentdrop send: text, title and files', () => {
  it('reads the text from a pipe when no --body is given', async () => {
    await sendCommand(capture(), {
      profile: 'laptop',
      to: '@wang',
      stdin: () => 'Loss went down\nsee the attached table\n\n',
    });
    expect(sends[0]?.payload).toMatchObject({
      title: 'Loss went down',
      body: 'Loss went down\nsee the attached table',
    });
  });

  it('refuses an empty send without a request', async () => {
    await expect(sendCommand(capture(), { profile: 'laptop', to: '@wang', stdin: noStdin })).rejects.toThrow(
      /Nothing to send/,
    );
    expect(sends).toEqual([]);
  });

  it('derives the title from the first line, capped, or from the files', () => {
    const long = 'x'.repeat(200);
    const derived = deriveSendTitle({ body: `\n  ${long}\nmore`, files: [] });
    expect([...derived]).toHaveLength(DERIVED_TITLE_MAX);
    expect(derived.endsWith('…')).toBe(true);
    expect(deriveSendTitle({ body: '', files: ['/a/report.pdf', '/a/data.csv'] })).toBe('report.pdf +1');
    expect(deriveSendTitle({ title: '  Typed\u0007 title ', body: 'body', files: [] })).toBe('Typed title');
    expect([...deriveSendTitle({ title: 'y'.repeat(300), body: '', files: [] })]).toHaveLength(160);
  });

  it('uploads files from an allowed folder and lists them', async () => {
    writeFileSync(join(work, 'table.csv'), 'a,b\n1,2\n');
    const out = capture();
    await sendCommand(out, {
      profile: 'laptop',
      to: '@wang',
      files: [join(work, 'table.csv')],
      stdin: noStdin,
    });
    expect(uploads).toEqual(['table.csv']);
    expect(sends[0]?.payload).toMatchObject({ kind: 'file', title: 'table.csv', body: '' });
    expect(sends[0]?.payload.attachment_ids).toHaveLength(1);
    expect(out.texts[0]).toBe('Sent to Wang @wang: table.csv\n  table.csv  8 B');
  });

  it('refuses a file outside the allowed folders with the exact command for its folder, uploading nothing', async () => {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(work, 'ok.txt'), 'ok');
    writeFileSync(join(elsewhere, 'notes.txt'), 'notes');
    await expect(
      sendCommand(capture(), {
        profile: 'laptop',
        to: '@wang',
        files: [join(work, 'ok.txt'), join(elsewhere, 'notes.txt')],
        stdin: noStdin,
      }),
    ).rejects.toThrow(
      `notes.txt: That file is outside the folders this profile may upload from. Allow its folder, then send again: agentdrop allow-dir add ${realpathSync.native(elsewhere)} --profile laptop`,
    );
    expect(uploads).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('never uploads a key file, even inside an allowed folder', async () => {
    writeFileSync(join(work, 'server.pem'), '-----BEGIN PRIVATE KEY-----');
    await expect(
      sendCommand(capture(), {
        profile: 'laptop',
        to: '@wang',
        files: [join(work, 'server.pem')],
        stdin: noStdin,
      }),
    ).rejects.toThrow('server.pem: That file looks like a key or credential, so it is never uploaded.');
    expect(uploads).toEqual([]);
  });

  it('answers the message given by an id prefix', async () => {
    await sendCommand(capture(), {
      profile: 'laptop',
      to: '@wang',
      body: 'done',
      replyTo: 'abcdef',
      stdin: noStdin,
    });
    expect(sends[0]?.payload.reply_to).toBe(INBOX_DROP);
  });
});

describe('agentdrop send: outcomes', () => {
  it('says what to do when the send waits for approval', async () => {
    outcome = 'needs_approval';
    const out = capture();
    await sendCommand(out, { profile: 'laptop', to: '@wang', body: 'first message', stdin: noStdin });
    expect(out.texts[0]).toContain(
      'Not sent yet: your message to Wang @wang waits for your approval. Open https://drop.example.com/app/approvals/x to check it, or run agentdrop approvals --profile laptop in a terminal.',
    );
  });

  it('prints the raw result with --json', async () => {
    const out = capture(true);
    await sendCommand(out, { profile: 'laptop', to: '@wang', body: 'x', stdin: noStdin });
    expect(out.values[0]).toMatchObject({ outcome: 'delivered', request_id: sends[0]?.request_id });
  });

  it('reports a send the server did not take as a failure', async () => {
    outcome = 'not_sent';
    await expect(
      sendCommand(capture(), { profile: 'laptop', to: '@wang', body: 'x', stdin: noStdin }),
    ).rejects.toThrow('The server did not take this message; nothing was sent.');
  });

  it('retries a dropped connection with the same request_id, so it is delivered once', async () => {
    dropFirstSends = 1;
    const out = capture(true);
    await sendCommand(out, { profile: 'laptop', to: '@wang', body: 'x', stdin: noStdin, retryDelayMs: 1 });
    expect(sends).toHaveLength(2);
    expect(sends[1]?.request_id).toBe(sends[0]?.request_id);
    expect(out.values[0]).toMatchObject({ outcome: 'delivered' });
  });

  it('words a refusal by its code', async () => {
    sendError = 'NOT_A_CONTACT';
    await expect(
      sendCommand(capture(), { profile: 'laptop', to: '@wang', body: 'x', stdin: noStdin }),
    ).rejects.toThrow('This person cannot receive your messages');
  });
});

describe('agentdrop send: registration', () => {
  it('takes the recipient, --title, -m/--body, --file, --reply-to and --profile', () => {
    const send = buildProgram().commands.find((c) => c.name() === 'send');
    expect(send?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--title', '--body', '--file', '--reply-to', '--profile']),
    );
    expect(send?.options.find((o) => o.long === '--body')?.short).toBe('-m');
  });

  it('parses repeated --file and -m from the command line', async () => {
    writeFileSync(join(work, 'a.txt'), 'a');
    writeFileSync(join(work, 'b.txt'), 'b');
    await buildProgram().parseAsync(
      [
        'send',
        '@wang',
        '-m',
        'two files',
        '--file',
        join(work, 'a.txt'),
        '--file',
        join(work, 'b.txt'),
        '--profile',
        'laptop',
      ],
      { from: 'user' },
    );
    expect(uploads).toEqual(['a.txt', 'b.txt']);
    expect(sends[0]?.payload.title).toBe('two files');
  });
});
