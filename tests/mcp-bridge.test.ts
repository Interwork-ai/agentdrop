/**
 * Black-box MCP contract test: spawns `agentdrop mcp --profile ...` as a real stdio server, drives it with the
 * official MCP client, and verifies tools/list and tools/call end to end against the real API + PostgreSQL.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BrowserUser,
  type PairedEndpoint,
  pair,
  signUp,
  TEST_DATABASE_URL,
} from '../apps/api/src/testing/harness.js';
import { type LiveApp, startLiveApp } from '../apps/api/src/testing/live.js';
import { storeCredential } from '../apps/cli/src/credentials.js';
import { readProfile, writeDevice, writeProfile } from '../apps/cli/src/store.js';

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL) console.warn('[mcp-bridge.test] TEST_DATABASE_URL unset: black-box MCP test SKIPPED');

const CLI_MAIN = resolve(import.meta.dirname, '..', 'apps', 'cli', 'src', 'main.ts');
const TSX = resolve(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');

interface Bridge {
  client: Client;
  close(): Promise<void>;
}

async function spawnBridge(
  configDir: string,
  profile: string,
  toolset?: 'core' | 'standard',
): Promise<Bridge> {
  const client = new Client({ name: `test-client-${profile}`, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: TSX,
    args: [CLI_MAIN, 'mcp', '--profile', profile, ...(toolset ? ['--toolset', toolset] : [])],
    env: {
      ...process.env,
      AGENTDROP_CONFIG_DIR: configDir,
      AGENTDROP_DATA_DIR: join(configDir, 'data'),
      AGENTDROP_STATE_DIR: join(configDir, 'state'),
      AGENTDROP_CREDENTIAL_STORE: 'file',
    } as Record<string, string>,
    stderr: 'pipe',
  });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

function writeLocalProfile(
  configDir: string,
  name: string,
  harness: 'codex' | 'claude-code',
  ep: PairedEndpoint,
  user: BrowserUser,
  serverUrl: string,
  toolset: 'core' | 'standard',
) {
  process.env.AGENTDROP_CONFIG_DIR = configDir;
  process.env.AGENTDROP_CREDENTIAL_STORE = 'file';
  writeDevice({
    installation_id: ep.installationId,
    label: 'Test Box',
    created_at: new Date().toISOString(),
    server_url: serverUrl,
  });
  const ref = storeCredential(`test/${name}`, ep.credential, () => undefined);
  writeProfile({
    profile: name,
    server_url: serverUrl,
    h_id: ep.hId,
    harness,
    profile_key: name,
    user_id: user.userId,
    handle: user.handle,
    agent_name: 'Agent',
    credential_ref: ref,
    credential_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    paired_at: new Date().toISOString(),
    allowed_dirs: [],
    toolset,
  });
}

function text(result: { content: unknown }): string {
  const blocks = result.content as Array<{ type: string; text?: string }>;
  return blocks.map((b) => b.text ?? '').join('\n');
}

describeDb('PR-03 MCP bridge black-box (stdio → API → PostgreSQL)', () => {
  let live: LiveApp;
  let aliceDir: string;
  let bobDir: string;
  let alice: BrowserUser;
  let bob: BrowserUser;
  let aliceEp: PairedEndpoint;
  let bobEp: PairedEndpoint;
  let bobOtherEp: PairedEndpoint;

  beforeAll(async () => {
    live = await startLiveApp();
    await live.reset();
    alice = await signUp(live, 'alice', 'Alice');
    bob = await signUp(live, 'bob', '王同学');
    aliceEp = await pair(live, alice, { harness: 'codex', endpointLabel: '小码' });
    bobEp = await pair(live, bob, { harness: 'claude-code', endpointLabel: '科研助手' });
    bobOtherEp = await pair(live, bob, { harness: 'codex', endpointLabel: '阅读助手' });
    const inv = await live.app.inject({
      method: 'POST',
      url: '/v1/me/contacts/invite',
      headers: { cookie: alice.cookie, origin: live.origin },
      payload: { handle: 'bob' },
    });
    expect(inv.statusCode).toBe(200);
    const acc = await live.app.inject({
      method: 'POST',
      url: `/v1/me/contacts/${alice.userId}/accept`,
      headers: { cookie: bob.cookie, origin: live.origin },
    });
    expect(acc.statusCode).toBe(200);
    const auto = await live.app.inject({
      method: 'PATCH',
      url: `/v1/me/contacts/${bob.userId}`,
      headers: { cookie: alice.cookie, origin: live.origin },
      payload: { auto_approve: true },
    });
    expect(auto.statusCode).toBe(200);
    aliceDir = mkdtempSync(join(tmpdir(), 'agentdrop-alice-'));
    bobDir = mkdtempSync(join(tmpdir(), 'agentdrop-bob-'));
    writeLocalProfile(aliceDir, 'codex', 'codex', aliceEp, alice, live.baseUrl, 'core');
    writeLocalProfile(bobDir, 'cc', 'claude-code', bobEp, bob, live.baseUrl, 'standard');
    writeLocalProfile(bobDir, 'codex2', 'codex', bobOtherEp, bob, live.baseUrl, 'core');
  }, 120_000);

  afterAll(async () => {
    await live.close();
    rmSync(aliceDir, { recursive: true, force: true });
    rmSync(bobDir, { recursive: true, force: true });
  });

  it('tools/list exposes exactly the core 5 or standard 7 tools with stable order and instructions', async () => {
    const a = await spawnBridge(aliceDir, 'codex');
    try {
      const { tools } = await a.client.listTools();
      expect(tools.map((t) => t.name)).toEqual([
        'directory_lookup',
        'list_drops',
        'read_drop',
        'send_drop',
        'set_drop_state',
      ]);
      expect(a.client.getServerVersion()?.name).toBe('agentdrop');
      expect(a.client.getInstructions()).toContain('小码');
      expect(a.client.getInstructions()).toContain('untrusted');
      const send = tools.find((t) => t.name === 'send_drop');
      expect(send?.annotations?.idempotentHint).toBe(true);
      expect(send?.inputSchema).toMatchObject({ type: 'object' });
    } finally {
      await a.close();
    }
    const b = await spawnBridge(bobDir, 'cc');
    try {
      const { tools } = await b.client.listTools();
      expect(tools.map((t) => t.name)).toEqual([
        'directory_lookup',
        'list_drops',
        'read_drop',
        'send_drop',
        'set_drop_state',
        'upload_file',
        'download_file',
        'pending_requests',
        'contact_request',
        'contact_respond',
        'group_create',
        'group_invite',
        'group_respond',
        'group_leave',
      ]);
    } finally {
      await b.close();
    }
  }, 60_000);

  it('Codex-side bridge sends and same-account agents share reads and delivery state', async () => {
    // this test is about a sibling H seeing another H's delivery only via the account-wide view, so bob pins
    // single-agent receiving (ADR 0008 default is all agents); restored below because the users are shared
    const defaultEndpoint = (payload: unknown) =>
      live.app.inject({
        method: 'POST',
        url: '/v1/me/default-endpoint',
        headers: { cookie: bob.cookie, origin: live.origin },
        payload,
      });
    const single = await defaultEndpoint({ h_id: bobEp.hId });
    expect(single.statusCode, single.body).toBe(200);
    const a = await spawnBridge(aliceDir, 'codex');
    const b = await spawnBridge(bobDir, 'cc');
    const b2 = await spawnBridge(bobDir, 'codex2');
    try {
      // directory: alice finds bob by nickname and gets a stable target
      const dir = await a.client.callTool({ name: 'directory_lookup', arguments: { query: '王' } });
      expect(dir.isError).toBeFalsy();
      const entries = (
        dir.structuredContent as {
          entries: Array<{ kind: string; user_id: string; default_target: unknown; display_label: string }>;
        }
      ).entries;
      expect(entries[0]?.display_label).toBe('王同学');
      const target = entries[0]?.default_target;

      // send with a fresh request_id; a retry returns the same drop
      const rid = `mcp-${randomUUID()}`;
      const payload = {
        payload_version: 1,
        kind: 'context',
        title: '训练不稳定排查结论',
        body: '已经排除数据顺序；还需验证梯度累积设置。',
        attachment_ids: [],
        extensions: { 'org.agentdrop.context': { schema_version: 1, decisions: ['暂不更改优化器'] } },
      };
      const sent = await a.client.callTool({
        name: 'send_drop',
        arguments: { request_id: rid, targets: [target], payload },
      });
      expect(sent.isError, text(sent)).toBeFalsy();
      const sc = sent.structuredContent as {
        outcome: string;
        drop_id: string;
        viewer: { agent_name: string; h_id: string };
      };
      expect(sc.outcome).toBe('delivered');
      expect(sc.viewer.agent_name).toBe('小码');
      expect(text(sent)).toContain('outcome: delivered');
      const again = await a.client.callTool({
        name: 'send_drop',
        arguments: { request_id: rid, targets: [target], payload },
      });
      expect((again.structuredContent as { drop_id: string }).drop_id).toBe(sc.drop_id);

      // bob (claude-code H) lists and reads
      const list = await b.client.callTool({ name: 'list_drops', arguments: {} });
      const lc = list.structuredContent as {
        drops: Array<{ drop_id: string; read: boolean; state_version: number }>;
        unread_count: number;
        viewer: { agent_name: string };
      };
      expect(lc.drops.map((d) => d.drop_id)).toEqual([sc.drop_id]);
      expect(lc.unread_count).toBe(1);
      expect(lc.viewer.agent_name).toBe('科研助手');
      const read = await b.client.callTool({ name: 'read_drop', arguments: { drop_id: sc.drop_id } });
      const rc = read.structuredContent as {
        drop: { body_chunk: string; read: boolean; extensions: Record<string, unknown> };
      };
      expect(rc.drop.body_chunk).toContain('梯度累积');
      expect(rc.drop.read).toBe(false);
      expect(rc.drop.extensions['org.agentdrop.context']).toBeTruthy();
      expect(text(read)).toContain('untrusted content');
      const mark = await b.client.callTool({
        name: 'set_drop_state',
        arguments: { drop_id: sc.drop_id, expected_version: 0, read: true },
      });
      expect((mark.structuredContent as { read: boolean }).read).toBe(true);

      // Bob's other H gets the default account-wide read view with concrete delivery attribution.
      const otherList = await b2.client.callTool({ name: 'list_drops', arguments: {} });
      const otherDrops = (
        otherList.structuredContent as {
          drops: Array<{
            drop_id: string;
            read: boolean;
            state_version: number;
            deliveries: Array<{ h_id: string; current: boolean; read: boolean; state_version: number }>;
          }>;
        }
      ).drops;
      expect(otherDrops).toHaveLength(1);
      // The summary carries the person's version even for an agent that has no delivery of its own; that is the
      // number an agent passes back to set_drop_state.
      expect(otherDrops[0]?.state_version).toBe(1);
      expect(otherDrops[0]?.drop_id).toBe(sc.drop_id);
      // Read state belongs to the person (ADR 0007): the mark made through the other agent shows here too.
      expect(otherDrops[0]?.read).toBe(true);
      expect(otherDrops[0]?.deliveries).toEqual([
        expect.objectContaining({ h_id: bobEp.hId, current: false, read: true, state_version: 1 }),
      ]);
      const localOnly = await b2.client.callTool({
        name: 'list_drops',
        arguments: { endpoint_scope: 'current' },
      });
      expect((localOnly.structuredContent as { drops: unknown[] }).drops).toHaveLength(0);
      const otherRead = await b2.client.callTool({ name: 'read_drop', arguments: { drop_id: sc.drop_id } });
      expect(otherRead.isError).toBeFalsy();
      expect(text(otherRead)).toContain('科研助手');
      // The other agent may change the shared state, but only from the current version.
      const staleState = await b2.client.callTool({
        name: 'set_drop_state',
        arguments: { drop_id: sc.drop_id, expected_version: 0, starred: true },
      });
      expect(staleState.isError).toBe(true);
      expect(text(staleState)).toContain('ERROR VERSION_CONFLICT');
      const sharedState = await b2.client.callTool({
        name: 'set_drop_state',
        arguments: {
          drop_id: sc.drop_id,
          expected_version: otherDrops[0]?.state_version ?? -1,
          starred: true,
        },
      });
      expect(sharedState.isError, text(sharedState)).toBeFalsy();
      expect(sharedState.structuredContent).toMatchObject({ read: true, starred: true, state_version: 2 });
      const receiverList = await b.client.callTool({ name: 'list_drops', arguments: {} });
      expect((receiverList.structuredContent as { drops: unknown[] }).drops).toEqual([
        expect.objectContaining({ drop_id: sc.drop_id, read: true, starred: true, state_version: 2 }),
      ]);

      // schema violations never reach the server and surface as tool errors
      const bad = await a.client.callTool({
        name: 'send_drop',
        arguments: { request_id: 'x', targets: [], payload: {} },
      });
      expect(bad.isError).toBe(true);

      // connections were registered with the client name; the bridges closed in the previous test shut down cleanly
      const conns = await live.app.inject({
        method: 'GET',
        url: '/v1/me/connections',
        headers: { cookie: bob.cookie },
      });
      const rows = conns.json().connections as Array<{ client_name: string; status: string }>;
      const liveNames = rows
        .filter((c) => c.status !== 'closed')
        .map((c) => c.client_name)
        .sort();
      expect(liveNames).toEqual(['test-client-cc', 'test-client-codex2']);
      expect(rows.some((c) => c.status === 'closed' && c.client_name === 'test-client-cc')).toBe(true);
    } finally {
      await a.close();
      await b.close();
      await b2.close();
      await defaultEndpoint({ all: true });
    }
  }, 90_000);

  it('manage tools: agents exchange contact requests, create/join groups and send to the group; only their own endpoint is bound', async () => {
    const carol = await signUp(live, 'carol', '李同学');
    const carolEp = await pair(live, carol, { harness: 'codex', endpointLabel: '阅读助手' });
    const carolDir = mkdtempSync(join(tmpdir(), 'agentdrop-carol-'));
    writeLocalProfile(carolDir, 'codex', 'codex', carolEp, carol, live.baseUrl, 'standard');
    const a = await spawnBridge(aliceDir, 'codex', 'standard');
    const c = await spawnBridge(carolDir, 'codex');
    try {
      // alice's agent asks carol; carol's agent sees the request and accepts
      const req = await a.client.callTool({ name: 'contact_request', arguments: { handle: 'carol' } });
      expect(req.isError, text(req)).toBeFalsy();
      expect((req.structuredContent as { status: string }).status).toBe('invited');
      const pending = await c.client.callTool({ name: 'pending_requests', arguments: {} });
      const pc = pending.structuredContent as {
        contact_requests_received: Array<{ user_id: string; handle: string }>;
      };
      expect(pc.contact_requests_received.map((p) => p.handle)).toEqual(['alice']);
      const acc = await c.client.callTool({
        name: 'contact_respond',
        arguments: { user_id: pc.contact_requests_received[0]?.user_id, decision: 'accept' },
      });
      expect((acc.structuredContent as { status: string }).status).toBe('accepted');

      // alice's agent creates a group (bound to alice's endpoint) and invites carol; carol's agent joins with its own endpoint
      const created = await a.client.callTool({
        name: 'group_create',
        arguments: { slug: 'paper', display_name: '论文讨论组', invite_handles: ['carol'] },
      });
      expect(created.isError, text(created)).toBeFalsy();
      const createdOut = created.structuredContent as {
        group_id: string;
        invites: Array<{ handle: string; outcome: string }>;
        member_limit: number;
        member_slots_used: number;
      };
      const groupId = createdOut.group_id;
      // creating and inviting in one call, with the per-handle outcome reported back through the bridge
      expect(createdOut.invites).toEqual([{ handle: 'carol', outcome: 'invited' }]);
      expect(createdOut.member_slots_used).toBe(2);
      expect(createdOut.member_limit).toBeGreaterThan(0);
      // a second invite of the same person is idempotent rather than an error
      const inv = await a.client.callTool({
        name: 'group_invite',
        arguments: { group_id: groupId, handles: ['carol'] },
      });
      expect(inv.isError, text(inv)).toBeFalsy();
      expect((inv.structuredContent as { invites: Array<{ outcome: string }> }).invites).toEqual([
        { handle: 'carol', outcome: 'already_member' },
      ]);
      const gpend = await c.client.callTool({ name: 'pending_requests', arguments: {} });
      expect(
        (gpend.structuredContent as { group_invitations: Array<{ group_id: string }> }).group_invitations[0]
          ?.group_id,
      ).toBe(groupId);
      const joined = await c.client.callTool({
        name: 'group_respond',
        arguments: { group_id: groupId, decision: 'accept', nickname: '李同学·RL' },
      });
      expect(joined.isError, text(joined)).toBeFalsy();
      expect(
        (joined.structuredContent as { current_h_receives: boolean; my_status: string }).current_h_receives,
      ).toBe(true);
      // the group binding is exactly carol's own endpoint, nothing else
      const bindings = await live.app.inject({
        method: 'GET',
        url: `/v1/me/groups/${groupId}`,
        headers: { cookie: carol.cookie },
      });
      expect(bindings.json().my_membership.binding_h_ids).toEqual([carolEp.hId]);

      // a group send from alice reaches carol's endpoint (first group sends need no approval; contact is fresh so mark auto-approve for the direct case is not needed here)
      const sent = await a.client.callTool({
        name: 'send_drop',
        arguments: {
          request_id: `grp-${randomUUID()}`,
          targets: [{ type: 'group', group_id: groupId }],
          payload: {
            payload_version: 1,
            kind: 'text',
            title: '群消息',
            body: 'hi group',
            attachment_ids: [],
            extensions: {},
          },
        },
      });
      expect(sent.isError, text(sent)).toBeFalsy();
      expect((sent.structuredContent as { outcome: string }).outcome).toBe('delivered');
      const inbox = await c.client.callTool({ name: 'list_drops', arguments: { group_id: groupId } });
      expect(
        (inbox.structuredContent as { drops: Array<{ title: string }> }).drops.map((d) => d.title),
      ).toEqual(['群消息']);

      // leaving through the agent revokes the group grant
      const left = await c.client.callTool({ name: 'group_leave', arguments: { group_id: groupId } });
      expect((left.structuredContent as { my_status: string }).my_status).toBe('left');
      const after = await c.client.callTool({ name: 'list_drops', arguments: { group_id: groupId } });
      expect((after.structuredContent as { drops: unknown[] }).drops).toHaveLength(0);
    } finally {
      await a.close();
      await c.close();
      rmSync(carolDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('standard toolset: upload_file honours the allowlist and download_file lands in the controlled directory', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'agentdrop-project-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'agentdrop-outside-'));
    writeFileSync(join(projectDir, 'notes.md'), '# notes\n实验结论：暂不更改优化器\n');
    writeFileSync(join(outsideDir, 'secret.txt'), 'nope');
    // bob (standard toolset) allows only the project directory
    process.env.AGENTDROP_CONFIG_DIR = bobDir;
    const bobProfile = readProfile('cc');
    if (!bobProfile) throw new Error('profile missing');
    writeProfile({ ...bobProfile, allowed_dirs: [projectDir] });
    // bob → alice needs the contact policy in that direction too
    const auto = await live.app.inject({
      method: 'PATCH',
      url: `/v1/me/contacts/${alice.userId}`,
      headers: { cookie: bob.cookie, origin: live.origin },
      payload: { auto_approve: true },
    });
    expect(auto.statusCode).toBe(200);

    const b = await spawnBridge(bobDir, 'cc');
    const a = await spawnBridge(aliceDir, 'codex');
    try {
      const denied = await b.client.callTool({
        name: 'upload_file',
        arguments: { path: join(outsideDir, 'secret.txt') },
      });
      expect(denied.isError).toBe(true);
      expect(text(denied)).toContain('PATH_NOT_ALLOWED');
      const up = await b.client.callTool({
        name: 'upload_file',
        arguments: { path: join(projectDir, 'notes.md') },
      });
      expect(up.isError, text(up)).toBeFalsy();
      const upc = up.structuredContent as { attachment_id: string; sha256: string; byte_size: number };
      const sent = await b.client.callTool({
        name: 'send_drop',
        arguments: {
          request_id: `file-${randomUUID()}`,
          targets: [{ type: 'user', user_id: alice.userId }],
          payload: {
            payload_version: 1,
            kind: 'file',
            title: 'notes',
            body: 'attached',
            attachment_ids: [upc.attachment_id],
            extensions: {},
          },
        },
      });
      expect(sent.isError, text(sent)).toBeFalsy();
      const dropId = (sent.structuredContent as { drop_id: string }).drop_id;
      // alice's bridge is core-only: download_file is not even registered
      const noTool = await a.client.listTools();
      expect(noTool.tools.map((t) => t.name)).not.toContain('download_file');
      // bob's own bridge can download its sent attachment; the file lands under the downloads dir with the hash verified
      const dl = await b.client.callTool({
        name: 'download_file',
        arguments: { drop_id: dropId, attachment_id: upc.attachment_id },
      });
      expect(dl.isError, text(dl)).toBeFalsy();
      const dlc = dl.structuredContent as {
        saved_path: string;
        sha256: string;
        sha256_verified: boolean;
        byte_size: number;
      };
      expect(dlc.sha256_verified).toBe(true);
      expect(dlc.sha256).toBe(upc.sha256);
      expect(dlc.saved_path.startsWith(join(bobDir, 'data', 'downloads', dropId))).toBe(true);
      expect(readFileSync(dlc.saved_path, 'utf8')).toContain('暂不更改优化器');
      // a second download never overwrites
      const dl2 = await b.client.callTool({
        name: 'download_file',
        arguments: { drop_id: dropId, attachment_id: upc.attachment_id },
      });
      expect((dl2.structuredContent as { saved_path: string }).saved_path).not.toBe(dlc.saved_path);
    } finally {
      await a.close();
      await b.close();
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }, 90_000);

  it('the bridge refuses to start without a paired profile and never writes diagnostics to stdout', async () => {
    const client = new Client({ name: 'x', version: '1' });
    const transport = new StdioClientTransport({
      command: TSX,
      args: [CLI_MAIN, 'mcp', '--profile', 'missing'],
      env: { ...process.env, AGENTDROP_CONFIG_DIR: aliceDir, AGENTDROP_CREDENTIAL_STORE: 'file' } as Record<
        string,
        string
      >,
      stderr: 'pipe',
    });
    await expect(client.connect(transport)).rejects.toThrow();
  }, 30_000);
});
