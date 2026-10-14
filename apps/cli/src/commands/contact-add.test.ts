import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeError } from '@agentdrop/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../main.js';
import type { Output } from '../output.js';
import { contactAddCommand } from './contact.js';

/*
 * `agentdrop contact add` against a fake server: one POST /v1/h/contacts/request per handle, the same call as the
 * contact_request tool. The fake answers by handle: wang → invited, mia → accepted (she had asked), nobody →
 * NOT_FOUND, blocked → BLOCKED, alice (myself) → VALIDATION_FAILED.
 */

let dir: string;
let http: Server;
let requests: string[];

const ids: Record<string, string> = {
  wang: '33333333-3333-4333-8333-333333333333',
  mia: '55555555-5555-4555-8555-555555555555',
};

async function readJson(req: IncomingMessage): Promise<{ handle: string }> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function fail(res: import('node:http').ServerResponse, status: number, code: string) {
  // the real error envelope, as the server sends it
  res.writeHead(status).end(JSON.stringify(describeError(code as never)));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentdrop-contact-add-'));
  requests = [];
  http = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/v1/h/contacts/request') {
      const { handle } = await readJson(req);
      requests.push(handle);
      if (handle === 'wang')
        return res.end(
          JSON.stringify({ user_id: ids.wang, handle: 'wang', display_name: 'Wang', status: 'invited' }),
        );
      if (handle === 'mia')
        return res.end(
          JSON.stringify({ user_id: ids.mia, handle: 'mia', display_name: 'Mia', status: 'accepted' }),
        );
      if (handle === 'blocked') return fail(res, 422, 'BLOCKED');
      if (handle === 'alice') return fail(res, 422, 'VALIDATION_FAILED');
      return fail(res, 404, 'NOT_FOUND');
    }
    res.writeHead(500).end('{}');
  });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('no listener');
  vi.stubEnv('AGENTDROP_CONFIG_DIR', join(dir, 'config'));
  vi.stubEnv('AGENTDROP_DATA_DIR', join(dir, 'data'));
  vi.stubEnv('AGENTDROP_STATE_DIR', join(dir, 'state'));
  vi.stubEnv('AGENTDROP_CREDENTIAL_STORE', 'file');
  mkdirSync(join(dir, 'config', 'profiles'), { recursive: true });
  mkdirSync(join(dir, 'config', 'credentials'));
  writeFileSync(join(dir, 'config', 'credentials', 'add.token'), 'add-fixture-token', { mode: 0o600 });
  writeFileSync(
    join(dir, 'config', 'profiles', 'laptop.json'),
    JSON.stringify({
      profile: 'laptop',
      server_url: `http://127.0.0.1:${address.port}`,
      h_id: '11111111-1111-4111-8111-111111111111',
      harness: 'codex',
      profile_key: 'default',
      user_id: '22222222-2222-4222-8222-222222222222',
      handle: 'alice',
      agent_name: 'Laptop Codex',
      credential_ref: { store: 'file', account: 'add' },
      credential_expires_at: '2099-01-01T00:00:00Z',
      paired_at: '2026-01-01T00:00:00Z',
      allowed_dirs: [],
    }),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
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

describe('agentdrop contact add', () => {
  it('sends a request per handle, once each, and says what happened to each', async () => {
    const out = capture();
    await contactAddCommand(out, { profile: 'laptop', handles: ['@wang', 'mia,@wang', 'nobody'] });
    expect(requests).toEqual(['wang', 'mia', 'nobody']);
    const text = out.texts[0] ?? '';
    expect(text).toContain('Sent a contact request to Wang @wang');
    expect(text).toContain('in their agent, the dashboard or agentdrop accept');
    expect(text).toContain('Mia @mia is a contact');
    expect(text).toContain('@nobody: not sent. No such handle');
    expect(text).toContain('invite link');
    // one person reached: the command succeeded
    expect(process.exitCode).toBeUndefined();
  });

  it('cannot add yourself, and a blocked request reads like an unknown handle', async () => {
    const out = capture();
    await contactAddCommand(out, { profile: 'laptop', handles: ['@alice', '@blocked'] });
    const text = out.texts[0] ?? '';
    expect(text).toContain('@alice: you cannot add yourself.');
    expect(text).toContain('@blocked: not sent. No such handle, or a request to them is not possible');
    // nothing was sent: a script sees the failure
    expect(process.exitCode).toBe(1);
  });

  it('speaks Chinese when the person chose it', async () => {
    writeFileSync(join(dir, 'config', 'locale.json'), JSON.stringify({ language: 'zh' }));
    const out = capture();
    await contactAddCommand(out, { profile: 'laptop', handles: ['@wang', '@nobody'] });
    const text = out.texts[0] ?? '';
    expect(text).toContain('已向 Wang @wang 发出联系人申请');
    expect(text).toContain('@nobody：没有发出');
  });

  it('needs at least one handle', async () => {
    await expect(contactAddCommand(capture(), { profile: 'laptop', handles: ['@', ' '] })).rejects.toThrow(
      /agentdrop contact add @wang/,
    );
    expect(requests).toEqual([]);
  });

  it('is a command, with --profile optional like contact remove', async () => {
    const add = buildProgram()
      .commands.find((c) => c.name() === 'contact')
      ?.commands.find((c) => c.name() === 'add');
    expect(add?.description()).toContain('contact request');
    await buildProgram().parseAsync(['contact', 'add', '@wang', '--profile', 'laptop'], { from: 'user' });
    expect(requests).toEqual(['wang']);
  });
});
