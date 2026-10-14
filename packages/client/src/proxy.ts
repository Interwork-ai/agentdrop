/**
 * Proxy bypass for the AgentDrop server.
 *
 * Node's environment proxy support (`NODE_USE_ENV_PROXY`, undici's `EnvHttpProxyAgent`) matches `NO_PROXY`
 * entries by exact host, domain suffix or `.suffix` only. **A CIDR such as `172.16.0.0/12` never matches**, so
 * the obvious way to exclude a private AgentDrop server silently does nothing and every request is sent through
 * the proxy — which then fails or hangs, because the proxy cannot reach a private address.
 *
 * Two facts make this fixable here, both verified on Node 22.22 with `NODE_USE_ENV_PROXY=1`:
 *   - a CIDR entry in `NO_PROXY` is ignored, while an exact host is honoured;
 *   - the agent reads the environment on the first request, not at startup, so appending the exact host from
 *     process code still takes effect.
 *
 * So when the server is somewhere a proxy has no business going (loopback, RFC1918, link-local, a bare
 * hostname), or when the user already wrote a CIDR that covers it, we add the exact host to `NO_PROXY`.
 * `AGENTDROP_PROXY` overrides: `never` always bypasses, `always` never bypasses, `auto` (default) decides.
 */

export type ProxyMode = 'auto' | 'always' | 'never';
export type ProxyDecision = 'bypassed' | 'proxied' | 'no-proxy-configured' | 'invalid-url';

type Env = Record<string, string | undefined>;

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : null;
}

function ipv4ToInt(octets: number[]): number {
  return ((octets[0] ?? 0) << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
}

/** Addresses a forward proxy cannot usefully reach: loopback, RFC1918, CGNAT, link-local, unique-local. */
export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  const octets = ipv4Octets(host);
  if (octets) {
    const [a = 0, b = 0] = octets;
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (host.includes(':')) {
    // IPv6 literal: ::1, fc00::/7 (unique local), fe80::/10 (link local)
    if (host === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
    return false;
  }
  // A name with no dot cannot be a public DNS name; it is a LAN or container hostname.
  return !host.includes('.');
}

/** Does any CIDR entry in NO_PROXY cover this host? Node ignores these, so we resolve them ourselves. */
export function matchedByNoProxyCidr(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const octets = ipv4Octets(host.trim());
  if (!octets) return false;
  const target = ipv4ToInt(octets);
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim();
    if (!entry.includes('/')) continue;
    const [net, bitsRaw] = entry.split('/');
    const netOctets = net ? ipv4Octets(net) : null;
    const bits = Number(bitsRaw);
    if (!netOctets || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    if ((ipv4ToInt(netOctets) & mask) === (target & mask)) return true;
  }
  return false;
}

function alreadyListed(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  return noProxy
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
    .some((e) => e === host || e === '*');
}

/**
 * Decide once, before the first request, whether this base URL should skip the environment proxy, and record it
 * in `NO_PROXY`/`no_proxy` in the form Node actually honours. Returns what it decided, for diagnostics.
 */
export function applyProxyBypass(baseUrl: string, env: Env = process.env): ProxyDecision {
  let host: string;
  let port: string;
  try {
    const url = new URL(baseUrl);
    host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    port = url.port;
  } catch {
    return 'invalid-url';
  }
  if (!PROXY_VARS.some((v) => (env[v] ?? '').trim() !== '')) return 'no-proxy-configured';

  const mode = (env.AGENTDROP_PROXY ?? 'auto').trim().toLowerCase() as ProxyMode;
  if (mode === 'always') return 'proxied';
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  if (alreadyListed(host, noProxy)) return 'bypassed';
  const bypass = mode === 'never' || isPrivateHost(host) || matchedByNoProxyCidr(host, noProxy);
  if (!bypass) return 'proxied';

  // Both spellings: undici reads whichever the platform set, and they can disagree.
  const additions = port ? [host, `${host}:${port}`] : [host];
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const current = (env[key] ?? '').trim();
    const have = new Set(
      current
        .split(/[,\s]+/)
        .map((e) => e.trim())
        .filter(Boolean),
    );
    for (const a of additions) have.add(a);
    env[key] = [...have].join(',');
  }
  return 'bypassed';
}
