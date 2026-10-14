import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

const CLI_MAIN = resolve(import.meta.dirname, 'main.ts');
const TSX = resolve(import.meta.dirname, '../../../node_modules/.bin/tsx');
const PACKAGED_CLI = process.env.AGENTDROP_TEST_CLI_BIN;
const CORE_TOOLS = ['directory_lookup', 'list_drops', 'read_drop', 'send_drop', 'set_drop_state'];
const STANDARD_TOOLS = [
  ...CORE_TOOLS,
  'upload_file',
  'download_file',
  'pending_requests',
  'contact_request',
  'contact_respond',
  'group_create',
  'group_invite',
  'group_respond',
  'group_leave',
];

describe('MCP stdio startup without a database', () => {
  it.each([
    { harness: 'codex', profileToolset: 'core', override: 'standard' },
    { harness: 'claude-code', profileToolset: 'standard', override: 'core' },
    { harness: 'cursor', profileToolset: 'core', override: 'standard' },
    { harness: 'opencode', profileToolset: 'standard', override: 'core' },
  ] as const)(
    '$harness uses $override when the saved profile is $profileToolset',
    async ({ harness, profileToolset, override }) => {
      const dir = mkdtempSync(join(tmpdir(), 'agentdrop-mcp-smoke-'));
      const token = `test-only-${randomUUID()}`;
      const viewer = {
        user_id: randomUUID(),
        h_id: randomUUID(),
        handle: 'smoke-user',
        display_name: 'Smoke User',
        agent_name: 'Smoke Agent',
        directory_revision: 0,
        mailbox_revision: 0,
        pending: { unread: 0, contact_requests: 0, group_invitations: 0, approvals: 0 },
      };
      const registrations: Array<{ toolset: string }> = [];
      const http = createServer(async (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401).end('{}');
          return;
        }
        if (req.url === '/v1/h/identity') {
          res.end(JSON.stringify({ viewer }));
        } else if (req.url === '/v1/h/connections') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          registrations.push(JSON.parse(Buffer.concat(chunks).toString()));
          res.end(JSON.stringify({ connection_id: randomUUID(), heartbeat_interval_s: 60, viewer }));
        } else if (req.url === '/v1/h/connections/close' || req.url === '/v1/h/connections/heartbeat') {
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404).end('{}');
        }
      });
      const client = new Client({ name: 'agentdrop-smoke', version: '1.0.0' });
      let stderr = '';
      try {
        await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('mock HTTP listener has no port');
        mkdirSync(join(dir, 'profiles'), { mode: 0o700 });
        mkdirSync(join(dir, 'credentials'), { mode: 0o700 });
        writeFileSync(join(dir, 'credentials', 'smoke.token'), token, { mode: 0o600 });
        const profilePath = join(dir, 'profiles', 'smoke.json');
        writeFileSync(
          profilePath,
          JSON.stringify({
            profile: 'smoke',
            server_url: `http://127.0.0.1:${address.port}`,
            h_id: viewer.h_id,
            user_id: viewer.user_id,
            harness,
            profile_key: 'smoke',
            handle: viewer.handle,
            agent_name: viewer.agent_name,
            credential_ref: { store: 'file', account: 'smoke' },
            credential_expires_at: new Date(Date.now() + 60_000).toISOString(),
            paired_at: new Date().toISOString(),
            allowed_dirs: [],
            toolset: profileToolset,
          }),
          { mode: 0o600 },
        );
        const transport = new StdioClientTransport({
          command: PACKAGED_CLI ? process.execPath : TSX,
          args: [PACKAGED_CLI ?? CLI_MAIN, 'mcp', '--profile', 'smoke', '--toolset', override],
          env: {
            ...process.env,
            AGENTDROP_CONFIG_DIR: dir,
            HOME: join(dir, 'home'),
            CODEX_HOME: join(dir, 'codex-home'),
            CLAUDE_CONFIG_DIR: join(dir, 'claude-home'),
            XDG_CONFIG_HOME: join(dir, 'xdg'),
            AGENTDROP_DATA_DIR: join(dir, 'data'),
            AGENTDROP_STATE_DIR: join(dir, 'state'),
            AGENTDROP_CREDENTIAL_STORE: 'file',
          } as Record<string, string>,
          stderr: 'pipe',
        });
        transport.stderr?.on('data', (chunk) => {
          stderr += String(chunk);
        });
        await client.connect(transport);
        expect(client.getServerVersion()?.name).toBe('agentdrop');
        expect(client.getInstructions()).toContain(viewer.agent_name);
        const result = await client.listTools();
        expect(result.tools.map((tool) => tool.name)).toEqual(
          override === 'core' ? CORE_TOOLS : STANDARD_TOOLS,
        );
        await expect.poll(() => registrations[0]?.toolset).toBe(override);
        expect(JSON.parse(readFileSync(profilePath, 'utf8')).toolset).toBe(profileToolset);
        expect(stderr).not.toContain(token);
      } finally {
        await client.close();
        http.closeAllConnections();
        await new Promise<void>((done) => http.close(() => done()));
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
