import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeError } from '@agentdrop/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLanguage } from '../locale.js';
import type { Output } from '../output.js';
import { readProfile } from '../store.js';
import { connectCommand } from './connect.js';
import { doctorCommand } from './doctor.js';
import { setupCommand } from './setup.js';
import { skillInstallCommand } from './skill.js';

/*
 * A newer CLI against a server released before a harness existed: the real pairing code talks to a stand-in for a
 * 0.5.8 server, which validates `harness_key` against its older list and answers the way that server does.
 */
vi.mock('./login.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./login.js')>()),
  loginCommand: vi.fn(),
}));
vi.mock('./connect.js', () => ({ connectCommand: vi.fn() }));
vi.mock('./skill.js', () => ({ skillInstallCommand: vi.fn() }));
vi.mock('./doctor.js', () => ({ doctorCommand: vi.fn().mockResolvedValue([]) }));

const OLD_HARNESS_KEYS = ['codex', 'claude-code', 'other', 'opencode', 'cursor'];

function oldServer(): Promise<{ server: Server; url: string; started: string[] }> {
  const started: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const input = body ? (JSON.parse(body) as Record<string, string>) : {};
      if (req.url === '/v1/pairing/start') {
        if (!OLD_HARNESS_KEYS.includes(input.harness_key ?? ''))
          return send(
            400,
            describeError('VALIDATION_FAILED', 'request validation failed', {
              issues: [{ path: 'harness_key', message: 'Invalid option' }],
            }),
          );
        started.push(input.harness_key ?? '');
        return send(200, {
          device_code: `device-code-${input.harness_key}-0123456789`,
          user_code: 'ABCD-EFGH',
          verification_url: 'http://localhost/pair',
          verification_url_complete: 'http://localhost/pair?code=ABCD-EFGH',
          expires_in: 600,
          interval: 1,
        });
      }
      if (req.url === '/v1/pairing/poll')
        return send(200, {
          status: 'approved',
          h_id: '11111111-1111-4111-8111-111111111111',
          credential: 'test-credential',
          credential_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          user_id: '22222222-2222-4222-8222-222222222222',
          handle: 'alice',
          agent_name: 'Codex',
          server_version: '0.5.8',
        });
      send(404, describeError('NOT_FOUND', 'route not found'));
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, started }),
    ),
  );
}

describe('setup against a server that does not know a harness yet', () => {
  let dir: string;
  let fake: Awaited<ReturnType<typeof oldServer>>;
  let errors: string[];
  let out: Output;
  beforeEach(async () => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'setup-old-server-'));
    vi.stubEnv('AGENTDROP_CONFIG_DIR', join(dir, 'config'));
    vi.stubEnv('AGENTDROP_STATE_DIR', join(dir, 'state'));
    vi.stubEnv('AGENTDROP_DATA_DIR', join(dir, 'data'));
    vi.stubEnv('AGENTDROP_CREDENTIAL_STORE', 'file');
    fake = await oldServer();
    errors = [];
    out = { json: false, info() {}, warn() {}, error: (m) => errors.push(m), result() {} };
  });
  afterEach(async () => {
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    await new Promise((done) => fake.server.close(done));
    rmSync(dir, { recursive: true, force: true });
  });

  it('pairs the others, says the server needs an update for omp, and still installs the skill and runs doctor', async () => {
    await setupCommand(out, { server: fake.url, harnesses: ['omp', 'codex'], noBrowser: true, noCli: true });
    expect(fake.started).toEqual(['codex']);
    expect(readProfile('codex')?.harness).toBe('codex');
    expect(readProfile('omp')).toBeNull();
    expect(connectCommand).toHaveBeenCalledTimes(1);
    expect(connectCommand).toHaveBeenCalledWith(out, { harness: 'codex', profile: 'codex', noCli: true });
    expect(skillInstallCommand).toHaveBeenCalledWith(out, { only: ['codex'] });
    expect(doctorCommand).toHaveBeenCalled();
    expect(errors).toEqual([
      'oh-my-pi (omp): this AgentDrop server is older and does not support this client yet; the server needs an update. The other clients are set up as usual.',
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('says it in Chinese when the person chose Chinese', async () => {
    writeLanguage('zh');
    await setupCommand(out, { server: fake.url, harnesses: ['omp'], noBrowser: true, noCli: true });
    expect(errors).toEqual([
      'oh-my-pi (omp)：这台 AgentDrop 服务器版本较旧，还不支持这个客户端，需要先更新服务器。其他客户端照常设置。',
    ]);
    // nothing connected: no skill install for nobody, but the checks still run
    expect(skillInstallCommand).not.toHaveBeenCalled();
    expect(doctorCommand).toHaveBeenCalled();
  });
});
