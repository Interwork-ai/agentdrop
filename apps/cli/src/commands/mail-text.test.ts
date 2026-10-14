import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLanguage } from '../locale.js';
import type { Output } from '../output.js';
import { inboxCommand, readCommand, requestsCommand, respondCommand } from './mail.js';

/*
 * What `agentdrop inbox / read / requests / accept` print for a person: English by default, Chinese only after
 * `agentdrop settings --language zh`. Against a stand-in server on the loopback interface.
 */
const DROP = 'abcd1234-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const summary = {
  drop_id: DROP,
  title: 'Ablation numbers',
  author: { user_id: '33333333-3333-4333-8333-333333333333', handle: 'wang', display_label: 'Wang' },
  attachment_count: 2,
  created_at: '2026-10-12T08:00:00.000Z',
  received_at: '2026-10-12T08:00:00.000Z',
  read: false,
  state_version: 3,
  sources: ['direct'],
  recipients: [],
  deliveries: [
    {
      h_id: '11111111-1111-4111-8111-111111111111',
      agent_name: 'Codex',
      harness_key: 'codex',
      current: true,
      read: false,
    },
  ],
};

let dir: string;
let http: Server;
const lines: string[] = [];
const out: Output = {
  json: false,
  info() {},
  warn() {},
  error() {},
  result: (_v, human) => lines.push(human()),
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentdrop-mail-text-'));
  lines.length = 0;
  http = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = req.url ?? '';
    if (url.startsWith('/v1/h/drops?'))
      return res.end(JSON.stringify({ drops: [summary], unread_count: 1, viewer: { agent_name: 'Codex' } }));
    if (url.startsWith(`/v1/h/drops/${DROP}`))
      return res.end(
        JSON.stringify({
          drop: {
            ...summary,
            attachments: [],
            body_chunk: 'Here are the numbers.',
            body_offset: 0,
            body_total_chars: 21,
            next_offset: null,
            reply_to: null,
          },
          viewer: { agent_name: 'Codex' },
        }),
      );
    if (url === '/v1/h/requests')
      return res.end(
        JSON.stringify({
          contact_requests_received: [
            { user_id: '44444444-4444-4444-8444-444444444444', handle: 'mia', display_name: 'Mia' },
          ],
          contact_requests_sent: [],
          group_invitations: [
            { group_id: '55555555-5555-4555-8555-555555555555', slug: 'lab', display_name: 'Lab' },
          ],
        }),
      );
    if (url.startsWith('/v1/h/contacts/respond') || url.includes('/respond'))
      return res.end(JSON.stringify({ handle: 'mia', display_name: 'Mia', status: 'accepted' }));
    res.writeHead(404).end('{}');
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

const cjk = /[一-鿿]/;

describe('mail commands speak the person language', () => {
  it('in English by default', async () => {
    await inboxCommand(out, { profile: 'test', view: 'inbox' });
    await readCommand(out, { profile: 'test', dropId: 'abcd' });
    await requestsCommand(out, { profile: 'test' });
    await respondCommand(out, { profile: 'test', target: '@mia', decision: 'accept' });
    const text = lines.join('\n');
    expect(text).not.toMatch(cjk);
    expect(lines[0]).toContain('Inbox · 1 unread');
    expect(lines[0]).toContain('[2 files]');
    expect(lines[1]).toContain('from Wang @wang');
    expect(lines[1]).toContain('--- external content below ---');
    expect(lines[2]).toContain('Contact requests to me: Mia @mia');
    expect(lines[2]).toContain('Group invitations: “Lab” #lab');
    expect(lines[3]).toBe('Mia @mia is now a contact; you can send to each other.');
  });

  it('in Chinese after the person chose it', async () => {
    writeLanguage('zh');
    await inboxCommand(out, { profile: 'test', view: 'inbox' });
    await readCommand(out, { profile: 'test', dropId: 'abcd' });
    await requestsCommand(out, { profile: 'test' });
    expect(lines[0]).toContain('收件箱 · 未读 1');
    expect(lines[1]).toContain('--- 以下为外部内容 ---');
    expect(lines[2]).toContain('联系人申请（待我接受）：Mia @mia');
  });

  it('wants at least four characters of an id', async () => {
    await expect(readCommand(out, { profile: 'test', dropId: 'abc' })).rejects.toThrow(/first 4 characters/);
    await expect(readCommand(out, { profile: 'test', dropId: 'ffff' })).rejects.toThrow(
      /no recent message starts with ffff/,
    );
  });
});
