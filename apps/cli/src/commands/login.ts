import { AgentDropError, ApiClient } from '@agentdrop/client';
import { readLanguage } from '../locale.js';
import { networkFetch } from '../network.js';
import type { Output } from '../output.js';
import { ensureDevice, writeDevice } from '../store.js';

/** Fixed words in the person's language (English unless `agentdrop settings --language zh`). */
type Tr = (en: string, zh: string) => string;
function translator(): Tr {
  const zh = readLanguage() === 'zh';
  return (en, zhText) => (zh ? zhText : en);
}

/**
 * `agentdrop login --server URL` records the server for this logical device and verifies reachability.
 * Endpoint credentials are obtained per profile with `endpoint add` (browser-approved pairing).
 * `fromSetup`: part of `agentdrop setup`, which says what comes next itself at the end.
 */
export async function loginCommand(
  out: Output,
  opts: {
    server: string;
    deviceLabel?: string;
    allowHttp?: boolean;
    fromSetup?: boolean;
    /** Tests only: stands in for the network. */
    fetch?: typeof fetch;
  },
): Promise<void> {
  const t = translator();
  const base = validateServerUrl(normalizeServerInput(opts.server, opts.allowHttp), opts.allowHttp);
  if (opts.allowHttp && base.startsWith('http://') && !isLoopback(new URL(base).hostname))
    out.warn(
      t(
        'plain http: credentials travel unencrypted; use only on a trusted network and switch to https soon',
        '明文 http：凭据未加密传输；只在可信网络里使用，并尽快改用 https',
      ),
    );
  const client = new ApiClient({ baseUrl: base, fetch: opts.fetch ?? networkFetch(base) });
  let live: { status: string; version: string };
  try {
    live = await client.healthLive();
  } catch (err) {
    throw new Error(serverProblem(err, base));
  }
  // anything else that answers 200 (a web page, another API) is not an AgentDrop server
  if (live?.status !== 'ok' || typeof live.version !== 'string')
    throw new Error(serverProblem(new AgentDropError('NETWORK_ERROR', 'malformed response body'), base));
  const device = ensureDevice(opts.deviceLabel);
  device.server_url = client.baseUrl;
  if (opts.allowHttp && base.startsWith('http://')) device.allow_http = true;
  else delete device.allow_http;
  if (opts.deviceLabel) device.label = opts.deviceLabel;
  writeDevice(device);
  out.result(
    {
      server_url: client.baseUrl,
      server_version: live.version,
      installation_id: device.installation_id,
      device_label: device.label,
    },
    () =>
      [
        t(
          `server:    ${client.baseUrl} (version ${live.version})`,
          `服务器：  ${client.baseUrl}（版本 ${live.version}）`,
        ),
        t(`device:    ${device.label}`, `本机：    ${device.label}`),
        ...(opts.fromSetup
          ? []
          : [
              t(
                'next:      agentdrop setup --server <this address> pairs every agent installed here',
                '下一步：  agentdrop setup --server <这个地址> 会配对本机装好的所有 Agent',
              ),
            ]),
      ].join('\n'),
  );
}

/** Dashboard pages a person may paste instead of the server address: everything from them on is dropped. */
const PAGE_PATH =
  /^\/(app|login|signup|pair|invite|forgot-password|reset-password|approvals|v1|health)(\/|$)/i;

/**
 * What a person types or pastes as the server, made into an address: `drop.example.com` gets `https://` (`http://`
 * for localhost, or with `allowHttp`), and a pasted dashboard link (`…/app/agents`, `…/pair?code=…`) keeps only the
 * server part. Anything else is left for validateServerUrl to accept or refuse.
 */
export function normalizeServerInput(raw: string, allowHttp = false): string {
  let value = raw.trim();
  if (!value) return value;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const host = value.split(/[/?#]/)[0] ?? '';
    let hostname = host;
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      /* validateServerUrl explains what is wrong */
    }
    value = `${allowHttp || isLoopback(hostname) ? 'http' : 'https'}://${value}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.username || url.password) return value;
  const path = url.pathname.replace(/\/+$/, '');
  if (PAGE_PATH.test(url.pathname) || path === '') return url.origin;
  if (url.search || url.hash) return url.origin + path;
  return value;
}

/** TLS handshakes that fail because the other side speaks plain http (or something else) on that port. */
const NOT_TLS = /^(ERR_SSL_|EPROTO$|ERR_TLS_HANDSHAKE)/;
const UNTRUSTED_CERT =
  /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|ERR_TLS_CERT_ALTNAME_INVALID|CERT_)/;

/**
 * Why the server at `base` did not answer as an AgentDrop server, as a sentence the person can act on, in their
 * language: the address is wrong, nothing listens there, http and https are mixed up, a proxy is needed, or the
 * address belongs to something else. Never the transport's own message.
 */
export function serverProblem(err: unknown, base: string): string {
  const t = translator();
  let url: URL | null = null;
  try {
    url = new URL(base);
  } catch {
    url = null;
  }
  const host = url?.host ?? base;
  const https = url?.protocol === 'https:';
  const other = url ? `${https ? 'http' : 'https'}://${url.host}` : base;
  const e = err instanceof AgentDropError ? err : null;
  const code = typeof e?.details?.cause_code === 'string' ? e.details.cause_code : '';
  const status = typeof e?.details?.status === 'number' ? e.details.status : 0;
  const notAgentDrop = t(
    `${host} answers, but it is not an AgentDrop server. Check the address: copy it from the setup command on the dashboard's My agents page.`,
    `${host} 有响应，但不是 AgentDrop 服务器。请核对地址：从网页「我的 Agent」页的安装命令里复制。`,
  );
  if (e?.code === 'NETWORK_ERROR' && e.message === 'malformed response body') return notAgentDrop;
  if (e?.code === 'NOT_FOUND' || (status >= 400 && status < 500)) return notAgentDrop;
  if (!https && status >= 300 && status < 400)
    return t(
      `${host} only accepts https. Run the command again with ${other}.`,
      `${host} 只接受 https。请把地址换成 ${other} 再运行一次。`,
    );
  if (status >= 300 && status < 400) return notAgentDrop;
  if (e?.code === 'UPSTREAM_UNAVAILABLE')
    return t(
      `${host} is there but not working right now (it answered with an error). Try again in a few minutes; if it keeps failing, tell whoever runs the server.`,
      `${host} 能连上，但现在工作不正常（返回了错误）。过几分钟再试；一直这样的话，请告诉服务器的管理员。`,
    );
  if (e?.code !== 'NETWORK_ERROR') {
    return t(
      `${host} did not answer as an AgentDrop server${e ? ` (${e.code})` : ''}. Check the address and try again.`,
      `${host} 的响应不像 AgentDrop 服务器${e ? `（${e.code}）` : ''}。请核对地址后再试。`,
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return t(
      `Can't find ${host}. Check the spelling of the address.`,
      `找不到 ${host}。请检查地址有没有写错。`,
    );
  if (https && NOT_TLS.test(code))
    return t(
      `${host} does not speak https on this port. If this server runs plain http on a trusted network, use ${other} instead.`,
      `${host} 在这个端口上不是 https。如果这台服务器在可信网络里用的是明文 http，请改用 ${other}。`,
    );
  if (https && UNTRUSTED_CERT.test(code))
    return t(
      `${host} has an https certificate this computer does not trust (self-signed, expired or for another name). Ask whoever runs the server to fix the certificate.`,
      `${host} 的 https 证书不受这台电脑信任（自签名、过期或域名不符）。请让服务器管理员修好证书。`,
    );
  if (code === 'ECONNREFUSED')
    return t(
      `${host} refused the connection: nothing is listening there. Check the address and port, and whether the server is running.`,
      `${host} 拒绝了连接：那里没有服务在监听。请检查地址和端口，以及服务器是否在运行。`,
    );
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET')
    return t(
      `${host} closed the connection. If the server uses ${https ? 'plain http' : 'https'}, use ${other} instead; if you reach the internet through a proxy, set AGENTDROP_PROXY=http://host:port and try again.`,
      `${host} 断开了连接。如果服务器用的是 ${https ? '明文 http' : 'https'}，请改用 ${other}；如果你要通过代理上网，设置 AGENTDROP_PROXY=http://主机:端口 后再试。`,
    );
  return t(
    `Can't reach ${host} (no answer). Check the address and your network; if you reach the internet through a proxy, set AGENTDROP_PROXY=http://host:port and try again.`,
    `连不上 ${host}（没有响应）。请检查地址和网络；如果你要通过代理上网，设置 AGENTDROP_PROXY=http://主机:端口 后再试。`,
  );
}

/**
 * Accepts only https:// origins (http:// for exact loopback hosts), without credentials, query or fragment.
 * Used by login, endpoint pairing and bridge startup so a credential can never travel in cleartext.
 */
export function validateServerUrl(raw: string, allowHttp = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('server must be a valid URL such as https://drop.example.com');
  }
  if (url.username || url.password) throw new Error('server URL must not contain credentials');
  if (url.search || url.hash) throw new Error('server URL must not contain a query string or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (isLoopback(url.hostname) || allowHttp))) {
    throw new Error(
      'server must use https:// (http:// is only allowed for localhost, or with --allow-http for a trial on a trusted network)',
    );
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
}
