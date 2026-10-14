import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeError, type ErrorCode } from '@agentdrop/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../main.js';
import type { Output } from '../output.js';
import { deriveTitle, spaceGetCommand, spaceListCommand, spacePutCommand, spaceRmCommand } from './space.js';

/*
 * `agentdrop space` against a fake server: the routes are the ones ADR 0030 names (list = GET /v1/h/drops?view=space,
 * put = upload then send to {type:'self'}, delete = DELETE /v1/h/space/:id, get = the attachment download route).
 */

interface FakeFile {
  attachment_id: string;
  safe_name: string;
  content: Buffer;
  removed?: boolean;
  /** The listing does not know yet; the download route answers FILE_REMOVED. */
  goneOnServer?: boolean;
}
interface FakeItem {
  drop_id: string;
  title: string;
  body: string;
  created_at: string;
  origin_agent: { h_id: string; agent_name: string; harness_key: string } | null;
  files: FakeFile[];
}

const viewer = {
  user_id: '22222222-2222-4222-8222-222222222222',
  h_id: '11111111-1111-4111-8111-111111111111',
  handle: 'alice',
  display_name: 'Alice',
  agent_name: 'Laptop Codex',
  directory_revision: 0,
  mailbox_revision: 0,
  pending: { unread: 0, contact_requests: 0, group_invitations: 0, approvals: 0 },
};
const laptop = { h_id: viewer.h_id, agent_name: 'Laptop Codex', harness_key: 'codex' };

let dir: string;
let uploadsDir: string;
let http: Server;
let items: FakeItem[];
let staged: Map<string, FakeFile>;
let sends: Array<Record<string, unknown>>;
let deletes: string[];
let reads: string[];
let uploadError: ErrorCode | null;

function summary(item: FakeItem) {
  return {
    drop_id: item.drop_id,
    kind: item.files.length ? 'file' : 'text',
    title: item.title,
    preview: item.body.slice(0, 160),
    author: { user_id: viewer.user_id, handle: 'alice', display_label: 'Alice', public_name: null },
    attachment_count: item.files.length,
    received_at: item.created_at,
    created_at: item.created_at,
    sources: ['direct'],
    group_ids: [],
    read: true,
    starred: false,
    archived: false,
    state_version: 1,
    origin_agent: item.origin_agent,
    deliveries: [],
    recipients: [],
  };
}

function meta(f: FakeFile) {
  return {
    attachment_id: f.attachment_id,
    safe_name: f.safe_name,
    content_type: 'application/octet-stream',
    byte_size: f.removed ? 0 : f.content.length,
    sha256: f.removed ? '0'.repeat(64) : createHash('sha256').update(f.content).digest('hex'),
    ...(f.removed ? { removed: true } : {}),
  };
}

function fail(res: ServerResponse, code: ErrorCode, details?: Record<string, unknown>) {
  const body = describeError(code, undefined, details);
  res.writeHead(code === 'FILE_REMOVED' ? 410 : code === 'QUOTA_EXCEEDED' ? 413 : 404);
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function item(
  drop_id: string,
  title: string,
  files: Array<Partial<FakeFile> & { safe_name: string }>,
  minutesAgo: number,
): FakeItem {
  return {
    drop_id,
    title,
    body: '',
    created_at: new Date(Date.UTC(2026, 9, 12, 12, 0) - minutesAgo * 60_000).toISOString(),
    origin_agent: laptop,
    files: files.map((f) => ({
      attachment_id: randomUUID(),
      content: Buffer.from(`content of ${f.safe_name}`),
      ...f,
    })),
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentdrop-space-'));
  uploadsDir = join(dir, 'work');
  mkdirSync(uploadsDir);
  items = [];
  staged = new Map();
  sends = [];
  deletes = [];
  reads = [];
  uploadError = null;
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
    if (req.method === 'POST' && path === '/v1/h/attachments') {
      const content = await readBody(req);
      if (uploadError) return fail(res, uploadError, { used: 1024 ** 3, limit: 1024 ** 3 });
      const file: FakeFile = {
        attachment_id: randomUUID(),
        safe_name: decodeURIComponent(String(req.headers['x-agentdrop-filename'])),
        content,
      };
      staged.set(file.attachment_id, file);
      res.end(JSON.stringify({ ...meta(file), status: 'ready' }));
      return;
    }
    if (req.method === 'POST' && path === '/v1/h/drops') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      sends.push(body);
      const created: FakeItem = {
        drop_id: randomUUID(),
        title: body.payload.title,
        body: body.payload.body,
        created_at: new Date().toISOString(),
        origin_agent: laptop,
        files: (body.payload.attachment_ids as string[]).map((id) => staged.get(id) as FakeFile),
      };
      items.push(created);
      res.end(
        JSON.stringify({
          outcome: 'delivered',
          request_id: body.request_id,
          drop_id: created.drop_id,
          recipients: [],
          approval_url: null,
          retryable: false,
          error: null,
          viewer,
        }),
      );
      return;
    }
    if (req.method === 'GET' && path === '/v1/h/drops') {
      if (url.searchParams.get('view') !== 'space') return fail(res, 'VALIDATION_FAILED');
      const sorted = [...items].sort((a, b) => b.created_at.localeCompare(a.created_at));
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const page = sorted.slice(offset, offset + limit);
      res.end(
        JSON.stringify({
          drops: page.map(summary),
          next_cursor: offset + limit < sorted.length ? String(offset + limit) : null,
          unread_count: 0,
          viewer,
        }),
      );
      return;
    }
    const download = /^\/v1\/h\/drops\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && download) {
      const file = items
        .find((i) => i.drop_id === download[1])
        ?.files.find((f) => f.attachment_id === download[2]);
      if (!file) return fail(res, 'NOT_FOUND');
      if (file.removed || file.goneOnServer) return fail(res, 'FILE_REMOVED');
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('x-agentdrop-sha256', createHash('sha256').update(file.content).digest('hex'));
      res.setHeader(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(file.safe_name)}`,
      );
      res.end(file.content);
      return;
    }
    const read = /^\/v1\/h\/drops\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && read) {
      reads.push(read[1] ?? '');
      const found = items.find((i) => i.drop_id === read[1]);
      if (!found) return fail(res, 'NOT_FOUND');
      res.end(
        JSON.stringify({
          drop: {
            ...summary(found),
            body_chunk: found.body,
            body_offset: 0,
            body_total_chars: found.body.length,
            next_offset: null,
            attachments: found.files.map(meta),
            extensions: {},
            expires_at: null,
          },
          viewer,
        }),
      );
      return;
    }
    const del = /^\/v1\/h\/space\/([^/]+)$/.exec(path);
    if (req.method === 'DELETE' && del) {
      const index = items.findIndex((i) => i.drop_id === del[1]);
      if (index < 0) return fail(res, 'NOT_FOUND');
      const [gone] = items.splice(index, 1);
      deletes.push(del[1] ?? '');
      res.end(
        JSON.stringify({
          drop_id: del[1],
          deleted: true,
          freed_bytes: (gone?.files ?? []).reduce((n, f) => n + f.content.length, 0),
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
  writeFileSync(join(dir, 'config', 'credentials', 'space.token'), 'space-fixture-token', { mode: 0o600 });
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
      credential_ref: { store: 'file', account: 'space' },
      credential_expires_at: '2099-01-01T00:00:00Z',
      paired_at: '2026-01-01T00:00:00Z',
      allowed_dirs: [uploadsDir],
    }),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  http.closeAllConnections();
  await new Promise<void>((done) => http.close(() => done()));
  rmSync(dir, { recursive: true, force: true });
});

function capture(): Output & { texts: string[]; values: unknown[] } {
  const texts: string[] = [];
  const values: unknown[] = [];
  return {
    json: false,
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

function chinese() {
  writeFileSync(join(dir, 'config', 'locale.json'), JSON.stringify({ language: 'zh' }));
}

describe('agentdrop space: registration', () => {
  it('offers put, list, get and rm, each with a required --profile', () => {
    const space = buildProgram().commands.find((c) => c.name() === 'space');
    expect(space?.commands.map((c) => c.name()).sort()).toEqual(['get', 'list', 'put', 'rm']);
    for (const sub of space?.commands ?? [])
      expect(sub.options.find((o) => o.long === '--profile')?.required, sub.name()).toBe(true);
  });
});

describe('agentdrop space put', () => {
  it('uploads every file, sends one drop to the self target and says what went in', async () => {
    writeFileSync(join(uploadsDir, 'report.pdf'), Buffer.alloc(2048, 1));
    writeFileSync(join(uploadsDir, 'data.csv'), 'a,b\n1,2\n');
    const out = capture();
    await spacePutCommand(out, {
      profile: 'laptop',
      files: [join(uploadsDir, 'report.pdf'), join(uploadsDir, 'data.csv')],
      note: 'for the workstation',
    });
    expect(staged.size).toBe(2);
    expect(sends).toHaveLength(1);
    const send = sends[0] as { request_id: string; targets: unknown; payload: Record<string, unknown> };
    expect(send.targets).toEqual([{ type: 'self' }]);
    expect(send.request_id).toMatch(/^space-[0-9a-f-]{36}$/);
    expect(send.payload).toMatchObject({ kind: 'file', title: 'report.pdf +1', body: 'for the workstation' });
    expect(send.payload.attachment_ids).toHaveLength(2);
    expect(out.texts[0]).toContain('Put in your space: report.pdf +1');
    expect(out.texts[0]).toContain('report.pdf  2.0 KB');
    expect(out.texts[0]).toContain('data.csv  8 B');
  });

  it('keeps a note on its own, titled by its first line, with a fresh request id each time', async () => {
    const out = capture();
    await spacePutCommand(out, {
      profile: 'laptop',
      files: [],
      note: '\nssh tunnel port\n7022 on the GPU box',
    });
    await spacePutCommand(out, { profile: 'laptop', files: [], note: 'second' });
    expect(sends[0]?.payload).toMatchObject({ kind: 'text', title: 'ssh tunnel port', attachment_ids: [] });
    expect(sends[0]?.request_id).not.toBe(sends[1]?.request_id);
  });

  it('refuses a file outside the allowed folders before uploading anything', async () => {
    writeFileSync(join(uploadsDir, 'ok.txt'), 'fine');
    const outside = join(dir, 'elsewhere.txt');
    writeFileSync(outside, 'not allowed');
    await expect(
      spacePutCommand(capture(), { profile: 'laptop', files: [join(uploadsDir, 'ok.txt'), outside] }),
    ).rejects.toThrow('agentdrop allow-dir add <folder> --profile laptop');
    expect(staged.size).toBe(0);
    expect(sends).toHaveLength(0);
  });

  it('turns QUOTA_EXCEEDED into a sentence about freeing space in my space', async () => {
    writeFileSync(join(uploadsDir, 'big.bin'), 'x');
    uploadError = 'QUOTA_EXCEEDED';
    await expect(
      spacePutCommand(capture(), { profile: 'laptop', files: [join(uploadsDir, 'big.bin')] }),
    ).rejects.toThrow(/upload space is full\. Free space by deleting items from your space/);
    expect(sends).toHaveLength(0);
  });

  it('asks for something to put in', async () => {
    await expect(spacePutCommand(capture(), { profile: 'laptop', files: [] })).rejects.toThrow(
      'Nothing to put in',
    );
  });
});

describe('agentdrop space list', () => {
  it('lists newest first with an id prefix, files and sizes, when, and which agent put it in', async () => {
    const notes = item('abcd1111-1111-4111-8111-111111111111', 'older notes', [], 60);
    notes.body = 'remember the ablation seeds';
    items.push(notes);
    items.push(
      item('ef012222-2222-4222-8222-222222222222', 'figures.zip', [{ safe_name: 'figures.zip' }], 5),
    );
    const out = capture();
    await spaceListCommand(out, { profile: 'laptop' });
    const text = out.texts[0] ?? '';
    expect(text).toContain('My space · 2 item(s), newest first');
    expect(text.indexOf('ef012222')).toBeLessThan(text.indexOf('abcd1111'));
    expect(text).toContain('figures.zip 22 B');
    expect(text).toContain('remember the ablation seeds');
    expect(text).toContain('from Laptop Codex [codex]');
    // only the item with files needed a read
    expect(reads).toEqual(['ef012222-2222-4222-8222-222222222222']);
  });

  it('speaks Chinese when the person chose it', async () => {
    chinese();
    const out = capture();
    await spaceListCommand(out, { profile: 'laptop' });
    expect(out.texts[0]).toContain('你的空间是空的');
  });
});

describe('agentdrop space get', () => {
  beforeEach(() => {
    items.push(item('abcd1111-1111-4111-8111-111111111111', 'first', [{ safe_name: 'a.txt' }], 60));
    items.push(
      item(
        'abcd2222-2222-4222-8222-222222222222',
        'second',
        [{ safe_name: 'b.txt' }, { safe_name: 'c.txt' }],
        30,
      ),
    );
    items.push(item('ef013333-3333-4333-8333-333333333333', 'latest', [{ safe_name: 'new.txt' }], 1));
  });

  it('downloads every file of the item a prefix names into --to and says where', async () => {
    const to = join(dir, 'pulled');
    const out = capture();
    await spaceGetCommand(out, { profile: 'laptop', id: 'abcd2222', to });
    expect(readFileSync(join(to, 'b.txt'), 'utf8')).toBe('content of b.txt');
    expect(readFileSync(join(to, 'c.txt'), 'utf8')).toBe('content of c.txt');
    expect(out.texts[0]).toContain(`Saved 2 file(s) to ${to}:`);
  });

  it('takes the latest item into the downloads folder by default', async () => {
    const out = capture();
    await spaceGetCommand(out, { profile: 'laptop', latest: true });
    const saved = join(dir, 'data', 'downloads', 'ef013333-3333-4333-8333-333333333333', 'new.txt');
    expect(readFileSync(saved, 'utf8')).toBe('content of new.txt');
    // no id and no --latest also means the latest
    await expect(spaceGetCommand(capture(), { profile: 'laptop' })).rejects.toThrow('new.txt already exists');
  });

  it('refuses to overwrite an existing file unless --force', async () => {
    const to = join(dir, 'pulled');
    mkdirSync(to);
    writeFileSync(join(to, 'a.txt'), 'mine');
    await expect(spaceGetCommand(capture(), { profile: 'laptop', id: 'abcd1111', to })).rejects.toThrow(
      'a.txt already exists there; nothing was overwritten. Add --force to replace it',
    );
    expect(readFileSync(join(to, 'a.txt'), 'utf8')).toBe('mine');
    await spaceGetCommand(capture(), { profile: 'laptop', id: 'abcd1111', to, force: true });
    expect(readFileSync(join(to, 'a.txt'), 'utf8')).toBe('content of a.txt');
  });

  it('refuses an ambiguous or unknown prefix', async () => {
    await expect(spaceGetCommand(capture(), { profile: 'laptop', id: 'abcd' })).rejects.toThrow(
      '2 items start with abcd',
    );
    await expect(spaceGetCommand(capture(), { profile: 'laptop', id: '9999' })).rejects.toThrow(
      'No item in your space starts with 9999',
    );
  });

  it('says plainly when a file was removed, whether the listing or the download says so', async () => {
    items.push(
      item('aaaa4444-4444-4444-8444-444444444444', 'gone', [{ safe_name: 'old.bin', removed: true }], 90),
    );
    items.push(
      item(
        'bbbb5555-5555-4555-8555-555555555555',
        'gone too',
        [{ safe_name: 'x.bin', goneOnServer: true }],
        95,
      ),
    );
    const to = join(dir, 'pulled');
    await expect(spaceGetCommand(capture(), { profile: 'laptop', id: 'aaaa', to })).rejects.toThrow(
      'This file was removed after it was put in',
    );
    await expect(spaceGetCommand(capture(), { profile: 'laptop', id: 'bbbb', to })).rejects.toThrow(
      'can no longer be downloaded',
    );
    expect(existsSync(join(to, 'x.bin'))).toBe(false);
  });

  it('speaks Chinese when the person chose it', async () => {
    chinese();
    const to = join(dir, 'pulled');
    const out = capture();
    await spaceGetCommand(out, { profile: 'laptop', id: 'ef01', to });
    expect(out.texts[0]).toContain(`已保存 1 个文件到 ${to}`);
    await expect(spaceGetCommand(capture(), { profile: 'laptop', id: 'ef01', to })).rejects.toThrow(
      '那里已有 new.txt，没有覆盖',
    );
  });
});

describe('agentdrop space rm', () => {
  it('deletes the item a prefix names and says how much it freed', async () => {
    items.push(
      item(
        'abcd1111-1111-4111-8111-111111111111',
        'figures.zip',
        [{ safe_name: 'figures.zip', content: Buffer.alloc(3 * 1024 * 1024) }],
        5,
      ),
    );
    const out = capture();
    await spaceRmCommand(out, { profile: 'laptop', id: 'abcd1111' });
    expect(deletes).toEqual(['abcd1111-1111-4111-8111-111111111111']);
    expect(out.texts[0]).toBe('Deleted from your space: figures.zip (abcd1111); freed 3.0 MB.');
  });

  it('speaks Chinese when the person chose it, and says when nothing matches', async () => {
    chinese();
    items.push(item('abcd1111-1111-4111-8111-111111111111', 'notes', [], 5));
    const out = capture();
    await spaceRmCommand(out, { profile: 'laptop', id: 'abcd' });
    expect(out.texts[0]).toBe('已从我的空间删除：notes（abcd1111），释放 0 B。');
    await expect(spaceRmCommand(capture(), { profile: 'laptop', id: 'abcd' })).rejects.toThrow(
      '你的空间里没有以 abcd 开头的条目',
    );
  });
});

describe('deriveTitle', () => {
  it('prefers --title, then the first file, then the note, and strips control characters', () => {
    expect(deriveTitle({ title: ' Plan ', files: ['/x/a.txt'], note: 'n' })).toBe('Plan');
    expect(deriveTitle({ files: ['/x/a.txt'], note: 'n' })).toBe('a.txt');
    expect(deriveTitle({ files: [], note: 'line\u0007one\nline two' })).toBe('line one');
    expect([...deriveTitle({ files: [], note: 'x'.repeat(500) })]).toHaveLength(160);
  });
});
