import { platform, release } from 'node:os';
import { AgentDropError, ApiClient } from '@agentdrop/client';
import type { HarnessKey } from '@agentdrop/contracts';
import { deleteCredential, loadCredential, storeCredential } from '../credentials.js';
import { isConnectableHarness } from '../harnesses.js';
import { readLanguage } from '../locale.js';
import { networkFetch } from '../network.js';
import { CLI_VERSION, type Output } from '../output.js';
import { deleteProfile, ensureDevice, listProfiles, readProfile, writeProfile } from '../store.js';
import { validateServerUrl } from './login.js';

export interface EndpointAddOptions {
  harness: HarnessKey;
  profile: string;
  label?: string;
  server?: string;
  timeoutS?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called with the verification URL (setup uses it to open the browser). */
  onCode?: (url: string) => void;
  /** Part of `agentdrop setup`, which connects the client itself and says what comes next at the end. */
  fromSetup?: boolean;
}

/** Fixed words in the person's language (English unless `agentdrop settings --language zh`). */
function translator(): (en: string, zh: string) => string {
  const zh = readLanguage() === 'zh';
  return (en, zhText) => (zh ? zhText : en);
}

/**
 * Pairs one profile with the server: start → show code + URL → poll until a human approves in the browser.
 * The resulting credential is bound to exactly one H and stored in the OS keychain (or a 0600 file).
 */
export async function endpointAddCommand(out: Output, opts: EndpointAddOptions): Promise<void> {
  const t = translator();
  const device = ensureDevice();
  const rawServer = opts.server ?? device.server_url;
  if (!rawServer) throw new Error('no server configured: run `agentdrop login --server https://...` first');
  const serverUrl = validateServerUrl(rawServer, device.allow_http === true);
  const existing = readProfile(opts.profile);
  if (existing && existing.server_url !== serverUrl) {
    throw new Error(
      `profile "${opts.profile}" is already paired with ${existing.server_url}; use another profile name`,
    );
  }
  const client = new ApiClient({
    baseUrl: serverUrl,
    fetch: networkFetch(serverUrl),
    userAgent: `agentdrop-cli/${CLI_VERSION}`,
  });
  const label = opts.label ?? existing?.agent_name ?? `${device.label} ${opts.harness}`;
  const start = await client.pairingStart({
    installation_id: device.installation_id,
    device_label: device.label,
    harness_key: opts.harness,
    profile_key: opts.profile,
    endpoint_label: label,
    bridge_version: CLI_VERSION,
    platform: `${platform()} ${release()}`,
  });
  const minutes = Math.round(start.expires_in / 60);
  out.info('');
  out.info(t(`  Open ${start.verification_url_complete}`, `  打开 ${start.verification_url_complete}`));
  out.info(
    t(
      `  and confirm code  ${start.user_code}  for "${label}".`,
      `  为「${label}」确认验证码  ${start.user_code}`,
    ),
  );
  out.info(
    t(
      `  The code expires in ${minutes} minutes. Waiting for approval...`,
      `  验证码 ${minutes} 分钟内有效。正在等待确认……`,
    ),
  );
  opts.onCode?.(start.verification_url_complete);
  out.info('');

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutS ?? start.expires_in) * 1000;
  let interval = start.interval * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    let poll: Awaited<ReturnType<typeof client.pairingPoll>>;
    try {
      poll = await client.pairingPoll(start.device_code);
    } catch (err) {
      if (err instanceof AgentDropError && err.code === 'RATE_LIMITED') {
        interval += 1000;
        continue;
      }
      if (err instanceof AgentDropError && err.retryable) {
        out.warn(
          t(
            `can't reach the server right now (${err.code}); retrying`,
            `暂时连不上服务器（${err.code}），正在重试`,
          ),
        );
        continue;
      }
      throw err;
    }
    if (poll.status === 'pending') continue;
    if (poll.status === 'denied')
      throw new Error(t('pairing was denied in the browser', '配对在浏览器里被拒绝了'));
    if (poll.status === 'expired')
      throw new Error(
        t('the pairing code expired; run the command again', '验证码已过期；请重新运行这条命令'),
      );

    if (existing) deleteCredential(existing.credential_ref);
    const account = `${new URL(serverUrl).host}/${opts.profile}`;
    const ref = storeCredential(account, poll.credential, out.warn);
    writeProfile({
      profile: opts.profile,
      server_url: serverUrl,
      h_id: poll.h_id,
      harness: opts.harness,
      profile_key: opts.profile,
      user_id: poll.user_id,
      handle: poll.handle,
      agent_name: poll.agent_name,
      credential_ref: ref,
      credential_expires_at: poll.credential_expires_at,
      paired_at: new Date().toISOString(),
      allowed_dirs: existing?.allowed_dirs ?? [],
      toolset: existing?.toolset ?? 'standard',
    });
    out.result(
      {
        profile: opts.profile,
        h_id: poll.h_id,
        agent_name: poll.agent_name,
        handle: poll.handle,
        credential_store: ref.store,
        credential_expires_at: poll.credential_expires_at,
        reused_endpoint: existing?.h_id === poll.h_id,
      },
      () =>
        [
          t(
            `paired:    ${poll.agent_name} as @${poll.handle}`,
            `已配对：  ${poll.agent_name}，账号 @${poll.handle}`,
          ),
          t(`profile:   ${opts.profile} → ${serverUrl}`, `配置：    ${opts.profile} → ${serverUrl}`),
          t(
            `secret:    stored in ${ref.store}; expires ${poll.credential_expires_at.slice(0, 10)}`,
            `密钥：    保存在 ${ref.store}；${poll.credential_expires_at.slice(0, 10)} 到期`,
          ),
          ...(opts.fromSetup
            ? []
            : [
                isConnectableHarness(opts.harness)
                  ? t(
                      `next:      agentdrop connect ${opts.harness} --profile ${opts.profile} && agentdrop skill install --only ${opts.harness}`,
                      `下一步：  agentdrop connect ${opts.harness} --profile ${opts.profile} && agentdrop skill install --only ${opts.harness}`,
                    )
                  : t(
                      `next:      register a stdio MCP server in your client that runs agentdrop mcp --profile ${opts.profile}`,
                      `下一步：  在客户端里登记一个 stdio MCP 服务器，运行 agentdrop mcp --profile ${opts.profile}`,
                    ),
              ]),
        ].join('\n'),
    );
    return;
  }
  throw new Error(t('timed out waiting for approval in the browser', '等待浏览器确认超时'));
}

export async function endpointListCommand(out: Output, opts: { check?: boolean }): Promise<void> {
  const profiles = listProfiles();
  interface Row {
    profile: string;
    harness: string;
    agent_name: string;
    handle: string;
    h_id: string;
    server_url: string;
    credential_expires_at: string;
    toolset: string;
    status: string;
  }
  const rows: Row[] = [];
  for (const p of profiles) {
    let status: string = 'unchecked';
    let agentName = p.agent_name;
    if (opts.check) {
      const cred = loadCredential(p.credential_ref);
      if (!cred) status = 'credential missing (re-pair)';
      else {
        try {
          const id = await new ApiClient({
            baseUrl: p.server_url,
            fetch: networkFetch(p.server_url),
            credential: cred,
          }).identity();
          status = 'ok';
          agentName = id.viewer.agent_name;
        } catch (err) {
          status = err instanceof AgentDropError ? err.code : 'error';
        }
      }
    }
    rows.push({
      profile: p.profile,
      harness: p.harness,
      agent_name: agentName,
      handle: p.handle,
      h_id: p.h_id,
      server_url: p.server_url,
      credential_expires_at: p.credential_expires_at,
      toolset: p.toolset,
      status,
    });
  }
  out.result({ endpoints: rows }, () =>
    rows.length === 0
      ? 'no profiles; run `agentdrop endpoint add ...`'
      : rows
          .map(
            (r) =>
              `${r.profile.padEnd(12)} ${r.harness.padEnd(12)} ${r.agent_name}  @${r.handle}  ${r.status}  (expires ${r.credential_expires_at.slice(0, 10)})`,
          )
          .join('\n'),
  );
}

export async function endpointRemoveCommand(out: Output, opts: { profile: string }): Promise<void> {
  const p = readProfile(opts.profile);
  if (!p) throw new Error(`profile "${opts.profile}" not found`);
  deleteCredential(p.credential_ref);
  deleteProfile(opts.profile);
  out.result(
    { removed: opts.profile },
    () =>
      `removed local profile ${opts.profile}; the endpoint still exists on the server until revoked in the dashboard`,
  );
}
