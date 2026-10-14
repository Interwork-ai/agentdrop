import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Output } from '../output.js';
import { approveCommand, readCommand } from './mail.js';

const silent: Output = { json: true, info() {}, warn() {}, error() {}, result() {} };
const approval = (approval_id: string) => ({
  approval_id,
  title: 'fixture',
  recipients: [{ label: 'wang', endpoint_count: 1 }],
  reasons: ['first contact'],
  body_preview: '',
});

let dir: string;
let http: Server;
let decided: string[];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentdrop-approve-'));
  decided = [];
  http = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/v1/h/approvals') {
      res.end(
        JSON.stringify({
          approvals: [
            approval('abc11111-1111-4111-8111-111111111111'),
            approval('abc22222-2222-4222-8222-222222222222'),
          ],
        }),
      );
      return;
    }
    if (req.url?.startsWith('/v1/h/drops?')) {
      res.end(JSON.stringify({ drops: [{ drop_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] }));
      return;
    }
    if (req.url?.startsWith('/v1/h/drops/')) {
      res.end(JSON.stringify({ drop: { drop_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', read: true } }));
      return;
    }
    decided.push(req.url ?? '');
    res.writeHead(500).end('{}');
  });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('no listener');
  vi.stubEnv('AGENTDROP_CONFIG_DIR', dir);
  vi.stubEnv('AGENTDROP_CREDENTIAL_STORE', 'file');
  mkdirSync(join(dir, 'profiles'));
  mkdirSync(join(dir, 'credentials'));
  writeFileSync(join(dir, 'credentials', 'mail.token'), 'mail-fixture-token', { mode: 0o600 });
  writeFileSync(
    join(dir, 'profiles', 'test.json'),
    JSON.stringify({
      profile: 'test',
      server_url: `http://127.0.0.1:${address.port}`,
      h_id: '11111111-1111-4111-8111-111111111111',
      harness: 'codex',
      profile_key: 'default',
      user_id: '22222222-2222-4222-8222-222222222222',
      handle: 'test',
      agent_name: 'Test Agent',
      credential_ref: { store: 'file', account: 'mail' },
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

it('refuses an approval id prefix that matches more than one pending approval', async () => {
  await expect(approveCommand(silent, { profile: 'test', id: 'abc', yes: true })).rejects.toThrow(
    /several approvals start with/,
  );
  await expect(approveCommand(silent, { profile: 'test', id: 'zzz', yes: true })).rejects.toThrow(
    /no pending approval/,
  );
  await expect(approveCommand(silent, { profile: 'test', id: '', yes: true })).rejects.toThrow(
    /no pending approval/,
  );
  expect(decided).toEqual([]);
});

it('accepts a unique prefix and goes on to the human confirmation step', async () => {
  // Not a terminal here, so `--yes` is refused — which is only reached once the id resolved to one approval.
  await expect(approveCommand(silent, { profile: 'test', id: 'abc2', yes: true })).rejects.toThrow(
    /interactive terminal/,
  );
  expect(decided).toEqual([]);
});

it('reads a unique prefix even when the same drop appears in both inbox and sent', async () => {
  const result = vi.fn();
  await readCommand({ ...silent, result }, { profile: 'test', dropId: 'aaaaaaaa' });
  expect(result).toHaveBeenCalledWith(
    expect.objectContaining({
      drop: expect.objectContaining({ drop_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    }),
    expect.any(Function),
  );
});
