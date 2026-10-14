import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDropError } from '@agentdrop/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeLanguage } from '../locale.js';
import type { Output } from '../output.js';
import { readDevice } from '../store.js';
import { loginCommand, normalizeServerInput, serverProblem } from './login.js';

/* What a person types as the server, and what they are told when it does not answer as AgentDrop. No network. */
describe('login: the server address', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-login-'));
    process.env.AGENTDROP_CONFIG_DIR = join(dir, 'config');
    process.env.AGENTDROP_STATE_DIR = join(dir, 'state');
    process.env.AGENTDROP_DATA_DIR = join(dir, 'data');
  });
  afterEach(() => {
    delete process.env.AGENTDROP_CONFIG_DIR;
    delete process.env.AGENTDROP_STATE_DIR;
    delete process.env.AGENTDROP_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds a missing https:// (http:// for localhost or with --allow-http)', () => {
    expect(normalizeServerInput('drop.example.com')).toBe('https://drop.example.com');
    expect(normalizeServerInput('  drop.example.com/  ')).toBe('https://drop.example.com');
    expect(normalizeServerInput('localhost:3300')).toBe('http://localhost:3300');
    expect(normalizeServerInput('drop.example.com', true)).toBe('http://drop.example.com');
  });

  it('keeps only the server of a pasted dashboard link', () => {
    expect(normalizeServerInput('http://x:3300/app/agents')).toBe('http://x:3300');
    expect(normalizeServerInput('https://drop.example.com/pair?code=ABCD')).toBe('https://drop.example.com');
    expect(normalizeServerInput('https://drop.example.com/invite/abc#top')).toBe('https://drop.example.com');
    expect(normalizeServerInput('drop.example.com/app/inbox')).toBe('https://drop.example.com');
    // a server under a path of its own is left alone
    expect(normalizeServerInput('https://example.com/agentdrop')).toBe('https://example.com/agentdrop');
  });

  const failure = (cause_code: string) =>
    new AgentDropError('NETWORK_ERROR', 'network error', { cause_code });

  it('names the problem in words the person can act on', () => {
    const base = 'https://drop.example.com';
    expect(serverProblem(failure('ENOTFOUND'), base)).toBe(
      "Can't find drop.example.com. Check the spelling of the address.",
    );
    expect(serverProblem(failure('ECONNREFUSED'), base)).toMatch(/refused the connection/);
    expect(serverProblem(failure('ERR_SSL_WRONG_VERSION_NUMBER'), base)).toMatch(
      /does not speak https.*use http:\/\/drop\.example\.com/,
    );
    expect(serverProblem(failure('UND_ERR_CONNECT_TIMEOUT'), base)).toMatch(/AGENTDROP_PROXY=/);
    expect(serverProblem(failure('TIMEOUT'), base)).toMatch(/AGENTDROP_PROXY=/);
    // plain http to a server that redirects to https
    expect(
      serverProblem(
        new AgentDropError('INTERNAL', 'unexpected response 301', { status: 301 }),
        'http://drop.example.com',
      ),
    ).toMatch(/only accepts https.*https:\/\/drop\.example\.com/);
    expect(serverProblem(new AgentDropError('NETWORK_ERROR', 'malformed response body'), base)).toMatch(
      /not an AgentDrop server/,
    );
    expect(serverProblem(new AgentDropError('NOT_FOUND'), base)).toMatch(/not an AgentDrop server/);
    for (const text of [serverProblem(failure('ENOTFOUND'), base), serverProblem(failure('X'), base)]) {
      expect(text).not.toMatch(/network error|NETWORK_ERROR|fetch failed/);
    }
  });

  it('says it in Chinese when the person chose Chinese', () => {
    writeLanguage('zh');
    expect(serverProblem(failure('ENOTFOUND'), 'https://drop.example.com')).toBe(
      '找不到 drop.example.com。请检查地址有没有写错。',
    );
  });

  const quiet = (lines: string[]): Output => ({
    json: false,
    info() {},
    warn() {},
    error() {},
    result: (_v, human) => lines.push(human()),
  });

  it('refuses an address that answers but is not an AgentDrop server, and records nothing', async () => {
    const page: typeof fetch = async () =>
      new Response('<html>hello</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(loginCommand(quiet([]), { server: 'drop.example.com', fetch: page })).rejects.toThrow(
      /not an AgentDrop server/,
    );
    const otherJson: typeof fetch = async () => Response.json({ ok: true });
    await expect(loginCommand(quiet([]), { server: 'drop.example.com', fetch: otherJson })).rejects.toThrow(
      /not an AgentDrop server/,
    );
    expect(readDevice()?.server_url).toBeUndefined();
  });

  it('turns an unreachable host into a sentence, not "network error"', async () => {
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
    };
    await expect(loginCommand(quiet([]), { server: 'drop.example.com', fetch: down })).rejects.toThrow(
      'drop.example.com refused the connection',
    );
  });

  it('records the server from a pasted dashboard link; no next step or ids inside setup', async () => {
    const seen: string[] = [];
    const live: typeof fetch = async (url) => {
      seen.push(String(url));
      return Response.json({ status: 'ok', version: '0.5.14' });
    };
    const lines: string[] = [];
    await loginCommand(quiet(lines), {
      server: 'https://drop.example.com/app/agents',
      fetch: live,
      fromSetup: true,
    });
    expect(seen).toEqual(['https://drop.example.com/health/live']);
    expect(readDevice()?.server_url).toBe('https://drop.example.com');
    const text = lines.join('\n');
    expect(text).not.toMatch(/next:/);
    expect(text).not.toContain(readDevice()?.installation_id ?? '-');
    // on its own, login says what comes next
    const alone: string[] = [];
    await loginCommand(quiet(alone), { server: 'https://drop.example.com', fetch: live });
    expect(alone.join('\n')).toMatch(/next: +agentdrop setup/);
  });
});
