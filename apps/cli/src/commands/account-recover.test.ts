import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeError } from '@agentdrop/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../main.js';
import type { Output } from '../output.js';
import { accountRecoverCommand } from './account.js';

/*
 * `agentdrop account recover` against a fake server (ADR 0036): only a person at a terminal who types their own
 * handle gets the one-time link; anything else stops before the server is asked.
 */

let dir: string;
let http: Server;
let requests: string[];
let suspended = false;

function fail(res: import('node:http').ServerResponse, status: number, code: string) {
  // the real error envelope, as the server sends it
  res.writeHead(status).end(JSON.stringify(describeError(code as never)));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentdrop-account-recover-'));
  requests = [];
  suspended = false;
  http = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/v1/h/account/recovery-link') {
      requests.push(req.headers.authorization ?? '');
      if (suspended) return fail(res, 403, 'ACCOUNT_SUSPENDED');
      return res.end(
        JSON.stringify({
          url: 'http://drop.test/reset-password?token=t0k3n',
          expires_at: '2099-01-01T00:00:00Z',
        }),
      );
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
  writeFileSync(join(dir, 'config', 'credentials', 'rec.token'), 'rec-fixture-token', { mode: 0o600 });
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
      credential_ref: { store: 'file', account: 'rec' },
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

describe('agentdrop account recover', () => {
  it('gives the link to a person at a terminal who types their own handle', async () => {
    const out = capture();
    const questions: string[] = [];
    await accountRecoverCommand(
      out,
      { profile: 'laptop' },
      {
        terminal: true,
        ask: async (q) => {
          questions.push(q);
          return ' @Alice ';
        },
      },
    );
    expect(questions[0]).toContain('@alice');
    expect(questions[0]).toContain('Type your handle to continue');
    expect(requests).toEqual(['Bearer rec-fixture-token']);
    const text = out.texts[0] ?? '';
    expect(text).toContain('http://drop.test/reset-password?token=t0k3n');
    expect(text).toContain('within 1 hour');
    expect(text).toContain('your agents keep working');
  });

  it('refuses outside a terminal, and an agent shell, without asking the server', async () => {
    await expect(
      accountRecoverCommand(capture(), { profile: 'laptop' }, { terminal: false, ask: async () => 'alice' }),
    ).rejects.toThrow(/only runs when you type it yourself in a terminal/);
    // the default check: Claude Code's shell tool sets CLAUDECODE
    vi.stubEnv('CLAUDECODE', '1');
    await expect(
      accountRecoverCommand(capture(), { profile: 'laptop' }, { ask: async () => 'alice' }),
    ).rejects.toThrow(/an agent cannot run it for you/);
    expect(requests).toEqual([]);
  });

  it('stops when the typed handle is not the account, or nothing is typed', async () => {
    for (const typed of ['bob', '', null]) {
      await expect(
        accountRecoverCommand(capture(), { profile: 'laptop' }, { terminal: true, ask: async () => typed }),
      ).rejects.toThrow(/not your handle; nothing was changed/);
    }
    expect(requests).toEqual([]);
  });

  it('speaks Chinese when chosen, and passes a refusal from the server through', async () => {
    writeFileSync(join(dir, 'config', 'locale.json'), JSON.stringify({ language: 'zh' }));
    const out = capture();
    await accountRecoverCommand(out, { profile: 'laptop' }, { terminal: true, ask: async () => 'alice' });
    expect(out.texts[0]).toContain('在浏览器里打开这个链接设置新密码');
    suspended = true;
    await expect(
      accountRecoverCommand(capture(), { profile: 'laptop' }, { terminal: true, ask: async () => 'alice' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
  });

  it('is a command; run by a script it refuses', async () => {
    const recover = buildProgram()
      .commands.find((c) => c.name() === 'account')
      ?.commands.find((c) => c.name() === 'recover');
    expect(recover?.description()).toContain('reset link');
    // vitest has no terminal on stdin: the real check refuses
    await expect(
      buildProgram().parseAsync(['account', 'recover', '--profile', 'laptop'], { from: 'user' }),
    ).rejects.toThrow(/type it yourself in a terminal/);
    expect(requests).toEqual([]);
  });
});
