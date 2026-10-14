import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ApiClient } from '@agentdrop/client';
import { type BridgeLogger, createBridgeServer, StdioServerTransport } from '@agentdrop/mcp';
import { planBridgeAutorun, startBridgeAutorun } from '../autorun.js';
import { clientLabel, createStaleBridgeNotice } from '../bridge-version.js';
import { readEffectiveHookSettings, synchronizeClientSettings } from '../client-preferences.js';
import { loadCredential } from '../credentials.js';
import { createFileTools } from '../files.js';
import { harnessChoices } from '../harnesses.js';
import { describeRoute, networkRoute } from '../network.js';
import { CLI_VERSION } from '../output.js';
import { logsDir } from '../paths.js';
import { readDevice, readProfile, writeProfile } from '../store.js';
import { installedCliVersion, startUpdateMaintenance } from '../updates.js';
import { validateServerUrl } from './login.js';

/**
 * `agentdrop mcp --profile NAME`: the stdio bridge. stdout carries protocol frames only; every diagnostic goes to
 * stderr and a log file. The profile fixes the H; the model cannot switch it through tool arguments.
 */
export async function mcpCommand(opts: { profile: string; toolset?: 'core' | 'standard' }): Promise<void> {
  const logger = createFileLogger(opts.profile);
  const profile = readProfile(opts.profile);
  if (!profile) {
    logger.error(
      `profile "${opts.profile}" not found; run: agentdrop endpoint add --harness <${harnessChoices('|')}|other> --profile ${opts.profile}`,
    );
    process.exit(2);
  }
  const credential = loadCredential(profile.credential_ref);
  if (!credential) {
    logger.error(
      `credential for profile "${opts.profile}" missing from ${profile.credential_ref.store}; re-pair with agentdrop endpoint add`,
    );
    process.exit(2);
  }
  let serverUrl: string;
  try {
    serverUrl = validateServerUrl(profile.server_url, readDevice()?.allow_http === true);
  } catch (err) {
    logger.error(
      `profile "${opts.profile}" has an unsafe server URL: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(2);
  }
  // Harnesses start this process with a reduced environment (Codex drops HTTPS_PROXY), so find the route before the
  // first call instead of failing every tool with "fetch failed". Bounded: startup must stay within the harness's limit.
  const network = networkRoute(serverUrl);
  const route = await network.prepare(6000);
  if (route)
    logger[route.unreachable ? 'warn' : 'info'](
      route.unreachable ? 'server unreachable directly and through every proxy found' : 'network route',
      { route: describeRoute(route) },
    );
  const client = new ApiClient({
    baseUrl: serverUrl,
    fetch: network.fetch,
    credential,
    userAgent: `agentdrop-bridge/${CLI_VERSION}`,
  });
  const toolset = opts.toolset ?? profile.toolset;
  // Best-effort, bounded refresh of the live agent name for the initialize instructions. Never blocks startup
  // for long and never fails it: names may also change later, so every tool result carries the live viewer.
  let agentName = profile.agent_name;
  try {
    const id = await client.request<{ viewer: { agent_name: string; handle: string } }>(
      'GET',
      '/v1/h/identity',
      {
        timeoutMs: 3000,
      },
    );
    agentName = id.viewer.agent_name;
    if (agentName !== profile.agent_name || id.viewer.handle !== profile.handle) {
      // re-read right before writing and merge only the two name fields (other settings may have changed meanwhile)
      const latest = readProfile(opts.profile) ?? profile;
      writeProfile({ ...latest, agent_name: agentName, handle: id.viewer.handle });
    }
  } catch (err) {
    logger.warn('identity refresh skipped (server unreachable?); using cached names', {
      error: String(err instanceof Error ? err.message : err),
    });
  }
  let connectionId: string | null = null;
  let lastTool: string | null = null;
  const fileTools = createFileTools({ client, profile: { ...profile, toolset }, logger });
  let autorun: ReturnType<typeof planBridgeAutorun> = null;
  try {
    autorun = planBridgeAutorun(opts.profile);
  } catch {
    autorun = null; // Hidden autorun must never stop the bridge from starting.
  }

  const server = createBridgeServer({
    client,
    toolset,
    bridgeVersion: CLI_VERSION,
    identity: {
      agentName,
      handle: profile.handle,
      hId: profile.h_id,
      profile: profile.profile,
    },
    ...(fileTools ? { files: fileTools } : {}),
    onToolCall: (name) => {
      lastTool = name;
    },
    connectionIdProvider: () => connectionId,
    logger,
    channel: autorun?.kind === 'claude',
    // The CLI may update itself on disk while this bridge keeps running the old version: tell the model once.
    notice: createStaleBridgeNotice({
      running: CLI_VERSION,
      installed: installedCliVersion,
      client: clientLabel(profile.harness),
      onFound: (installed) => logger.info('a newer CLI is installed', { installed, running: CLI_VERSION }),
    }),
  });

  // Register the connection after initialize so client_info is known; never block the protocol on the network.
  let openPromise: Promise<void> | null = null;
  server.server.oninitialized = () => {
    const info = server.server.getClientVersion();
    const caps = server.server.getClientCapabilities() ?? {};
    openPromise = client
      .connectionOpen({
        client_name: info?.name ?? null,
        client_version: info?.version ?? null,
        capabilities: caps as Record<string, unknown>,
        bridge_version: CLI_VERSION,
        toolset,
      })
      .then((res) => {
        connectionId = res.connection_id;
        logger.info('connection registered', {
          connection_id: res.connection_id,
          client: info?.name ?? 'unknown',
        });
        startHeartbeat(res.heartbeat_interval_s);
      })
      .catch((err) =>
        logger.warn('connection registration failed (tools still work)', {
          error: String(err instanceof Error ? err.message : err),
        }),
      );
  };

  let heartbeat: NodeJS.Timeout | null = null;
  const startHeartbeat = (intervalS: number) => {
    const tick = () => {
      if (!connectionId) return;
      client
        .connectionHeartbeat(connectionId, lastTool)
        .catch((err) =>
          logger.warn('heartbeat failed', { error: String(err instanceof Error ? err.message : err) }),
        );
      lastTool = null;
      // Uses the same device preferences and updater for every stdio harness, including those without Stop hooks.
      void synchronizeClientSettings(opts.profile).then(() => {
        if (shuttingDown) return;
        try {
          startUpdateMaintenance(readEffectiveHookSettings(opts.profile).updates, opts.profile);
        } catch {
          /* Optional maintenance never interrupts MCP traffic. */
        }
      });
      heartbeat = setTimeout(tick, (intervalS + Math.random() * 5) * 1000);
      heartbeat.unref();
    };
    heartbeat = setTimeout(tick, (intervalS + Math.random() * 5) * 1000);
    heartbeat.unref();
  };

  let stopAutorun: (() => void) | null = null;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (heartbeat) clearTimeout(heartbeat);
    stopAutorun?.();
    // a registration may still be in flight when the client disconnects right after initialize
    if (openPromise) await Promise.race([openPromise, new Promise((r) => setTimeout(r, 2000))]);
    if (connectionId) await client.connectionClose(connectionId).catch(() => undefined);
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.stdin.once('end', () => void shutdown());

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('bridge started', { profile: profile.profile, toolset, server: serverUrl });
  if (autorun) {
    stopAutorun = startBridgeAutorun(opts.profile, autorun, {
      notify: (content) =>
        server.server.notification({
          method: 'notifications/claude/channel',
          params: { content, meta: { kind: 'autorun' } },
        }),
      log: (level, msg, meta) => logger[level](msg, meta),
    });
    logger.info('autorun enabled', { kind: autorun.kind });
  }
}

function createFileLogger(profile: string): BridgeLogger {
  let file: string | null = null;
  try {
    mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
    file = join(logsDir(), `bridge-${profile}.log`);
  } catch {
    file = null;
  }
  const write = (level: string, msg: string, meta?: Record<string, unknown>) => {
    const line = `${JSON.stringify({ t: new Date().toISOString(), level, msg, ...(meta ?? {}) })}\n`;
    process.stderr.write(line);
    if (file) {
      try {
        appendFileSync(file, line, { mode: 0o600 });
      } catch {
        /* ignore */
      }
    }
  };
  return {
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  };
}
