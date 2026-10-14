import { existsSync, statSync } from 'node:fs';
import { AgentDropError, ApiClient } from '@agentdrop/client';
import { claudeModRemovedIn } from '../claude-mod.js';
import { loadCredential, preferredStore } from '../credentials.js';
import { harness as harnessAdapter, isConnectableHarness } from '../harnesses.js';
import {
  describeRoute,
  forgetSavedRoute,
  networkFetch,
  networkRoute,
  resetNetworkRoutes,
} from '../network.js';
import { CLI_VERSION, type Output } from '../output.js';
import { configDir, devicePath, downloadsDir, logsDir, profilesDir } from '../paths.js';
import { listProfiles, readDevice, readProfile } from '../store.js';

/**
 * Hooks are written by `connect`, so an upgrade that changes them reaches an existing install only when the
 * startup repair runs — this makes the state visible either way, instead of the user noticing months later that
 * a hook silently never fired. It reads the file through the same plan the repair uses, so the two never disagree.
 */
export function hookCheck(profile: string, harness: string, profiles: ReadonlySet<string>): Check {
  const name = `profile ${profile}: completion hooks`;
  try {
    const repair = isConnectableHarness(harness) ? harnessAdapter(harness).hookRepair : undefined;
    if (!repair)
      return { name, status: 'skip', detail: `${harness} uses a managed plugin instead of config hooks` };
    const path = repair.path();
    const plan = repair.plan(path, profiles);
    const connect = `run agentdrop connect ${harness} --profile ${profile}`;
    // A file that does not parse is not a missing hook, and connect cannot edit it either: say which file it is.
    if (plan.status === 'unreadable')
      return { name, status: 'warn', detail: `cannot read ${path}; fix that file, then ${connect}` };
    if (plan.status === 'absent') return { name, status: 'warn', detail: `not installed; ${connect}` };
    // One hook set per harness file: another profile owning it is a choice, not a fault.
    if (plan.profile && plan.profile !== profile)
      return { name, status: 'skip', detail: `hooks in ${path} use profile ${plan.profile}` };
    if (plan.status === 'orphaned')
      return { name, status: 'warn', detail: `AgentDrop hook in ${path} cannot be repaired; ${connect}` };
    if (plan.status === 'stale')
      return { name, status: 'warn', detail: `out of date in ${path}; any agentdrop command repairs it` };
    return { name, status: 'ok', detail: repair.describe(plan) };
  } catch (err) {
    return { name, status: 'warn', detail: err instanceof Error ? err.message : String(err) };
  }
}

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
}

/**
 * The person removed the AgentDrop mod in Claude Code itself (its plugin list): the CLI stopped trying to update it
 * there, so say how to bring it back. One line per Claude Code config directory it was removed from.
 */
export function claudeModChecks(): Check[] {
  return claudeModRemovedIn().map((dir) => ({
    name: 'Claude Code mod',
    status: 'warn',
    detail: `removed in Claude Code${dir ? ` (config directory ${dir})` : ''}; \`agentdrop connect claude-code\`${dir ? ` with CLAUDE_CONFIG_DIR=${dir}` : ''} puts it back`,
  }));
}

/** Diagnoses configuration, credentials, reachability and (later) MCP handshake. Never prints secrets. */
export async function doctorCommand(
  out: Output,
  opts: { profile?: string; mcp?: boolean },
): Promise<Check[]> {
  const checks: Check[] = [];
  const push = (c: Check) => checks.push(c);

  push({ name: 'executable', status: 'ok', detail: process.argv[1] ?? process.execPath });
  push({ name: 'node', status: 'ok', detail: process.version });
  push({ name: 'config dir', status: existsSync(configDir()) ? 'ok' : 'warn', detail: configDir() });
  if (existsSync(configDir())) {
    const mode = statSync(configDir()).mode & 0o777;
    push({ name: 'config dir mode', status: mode === 0o700 ? 'ok' : 'warn', detail: mode.toString(8) });
  }
  push({ name: 'downloads dir', status: 'ok', detail: downloadsDir() });
  push({ name: 'logs dir', status: 'ok', detail: logsDir() });
  push({ name: 'credential store', status: 'ok', detail: preferredStore() });

  const device = readDevice();
  if (!device) {
    push({ name: 'device', status: 'fail', detail: `no ${devicePath()}; run agentdrop login` });
  } else {
    push({ name: 'device', status: 'ok', detail: `${device.label} (${device.installation_id})` });
    push({
      name: 'server',
      status: device.server_url ? 'ok' : 'fail',
      detail: device.server_url ?? 'not set',
    });
    if (device.server_url) {
      // Test the route afresh rather than trusting the saved one; what it finds is saved for the bridge and hooks.
      forgetSavedRoute(device.server_url);
      resetNetworkRoutes();
      const network = networkRoute(device.server_url);
      try {
        const live = await new ApiClient({
          baseUrl: device.server_url,
          fetch: network.fetch,
          timeoutMs: 8000,
        }).healthLive();
        push({ name: 'server reachable', status: 'ok', detail: `version ${live.version}` });
      } catch (err) {
        push({
          name: 'server reachable',
          status: 'fail',
          detail: err instanceof AgentDropError ? err.code : String(err),
        });
      }
      const route = network.current();
      if (route)
        push({
          name: 'network route',
          status: route.unreachable ? 'fail' : 'ok',
          detail: route.unreachable
            ? 'not reachable directly or through any proxy found; set AGENTDROP_PROXY=http://host:port'
            : describeRoute(route),
        });
    }
  }

  const profiles = opts.profile
    ? [readProfile(opts.profile)].filter((p): p is NonNullable<typeof p> => p !== null)
    : listProfiles();
  if (opts.profile && profiles.length === 0)
    push({ name: `profile ${opts.profile}`, status: 'fail', detail: `not found in ${profilesDir()}` });
  const knownProfiles = new Set(listProfiles().map((p) => p.profile));
  for (const p of profiles) {
    const exp = new Date(p.credential_expires_at).getTime();
    const daysLeft = Math.floor((exp - Date.now()) / 86_400_000);
    push({
      name: `profile ${p.profile}: credential expiry`,
      status: daysLeft < 0 ? 'fail' : daysLeft < 14 ? 'warn' : 'ok',
      detail: daysLeft < 0 ? 'expired; re-pair' : `${daysLeft} days left`,
    });
    const cred = loadCredential(p.credential_ref);
    if (!cred) {
      push({
        name: `profile ${p.profile}: credential`,
        status: 'fail',
        detail: `missing from ${p.credential_ref.store}; re-pair`,
      });
      continue;
    }
    try {
      const id = await new ApiClient({
        baseUrl: p.server_url,
        fetch: networkFetch(p.server_url),
        credential: cred,
        timeoutMs: 8000,
      }).identity();
      push({
        name: `profile ${p.profile}: identity`,
        status: 'ok',
        detail: `${id.viewer.agent_name} @${id.viewer.handle} on ${id.device_label} (${id.harness_key}/${id.profile_key})`,
      });
      if (id.notifications)
        push({
          name: `profile ${p.profile}: Feishu notices`,
          status: 'ok',
          detail: id.notifications.feishu ? 'connected' : 'not connected (optional)',
        });
      if (id.viewer.h_id !== p.h_id)
        push({
          name: `profile ${p.profile}: h_id`,
          status: 'fail',
          detail: 'server H differs from local profile',
        });
    } catch (err) {
      push({
        name: `profile ${p.profile}: identity`,
        status: 'fail',
        detail: err instanceof AgentDropError ? `${err.code}: ${err.message}` : String(err),
      });
    }
    push({
      name: `profile ${p.profile}: allowed dirs`,
      status: p.allowed_dirs.length ? 'ok' : 'warn',
      detail: p.allowed_dirs.length
        ? p.allowed_dirs.join(', ')
        : `none: agents cannot send files from this computer until you allow a folder: agentdrop allow-dir add <folder> --profile ${p.profile}`,
    });
    push({ name: `profile ${p.profile}: toolset`, status: 'ok', detail: p.toolset });
    push(hookCheck(p.profile, p.harness, knownProfiles));
  }
  for (const check of claudeModChecks()) push(check);
  if (profiles.length === 0 && !opts.profile)
    push({ name: 'profiles', status: 'warn', detail: 'none paired yet' });

  if (opts.mcp) {
    for (const p of profiles) push(await mcpSelfTest(p.profile));
  }

  out.result({ checks }, () =>
    checks.map((c) => `${c.status.toUpperCase().padEnd(4)} ${c.name.padEnd(36)} ${c.detail}`).join('\n'),
  );
  return checks;
}

/** Spawns this very executable as `agentdrop mcp --profile X` and performs a real initialize + tools/list. */
async function mcpSelfTest(profile: string): Promise<Check> {
  const name = `profile ${profile}: mcp handshake`;
  try {
    const { Client } = await import('@modelcontextprotocol/client');
    const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
    const argv1 = process.argv[1] ?? '';
    const isTs = argv1.endsWith('.ts');
    const command = isTs ? process.execPath : process.execPath;
    const args = isTs
      ? ['--import', 'tsx', argv1, 'mcp', '--profile', profile]
      : [argv1, 'mcp', '--profile', profile];
    const client = new Client({ name: 'agentdrop-doctor', version: CLI_VERSION });
    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env } as Record<string, string>,
      stderr: 'pipe',
    });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('handshake timed out after 15s')), 15_000),
    );
    await Promise.race([client.connect(transport), timeout]);
    const { tools } = await client.listTools();
    await client.close();
    return { name, status: 'ok', detail: `${tools.length} tools: ${tools.map((t) => t.name).join(', ')}` };
  } catch (err) {
    return { name, status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}
