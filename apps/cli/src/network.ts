import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyProxyBypass, isPrivateHost, matchedByNoProxyCidr } from '@agentdrop/client';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { configDir } from './paths.js';
import { writePrivateFile } from './store.js';

/**
 * How this process reaches the AgentDrop server: directly or through an HTTP proxy, found without asking.
 *
 * Harnesses start the MCP bridge with a reduced environment — Codex passes only HOME, PATH, SHELL and a few more —
 * so `HTTPS_PROXY` set in the user's terminal never reaches it. The hooks, started by the same harness with the full
 * environment, then work while every tool call fails with `fetch failed`. Node's `fetch` also ignores the proxy
 * variables unless `NODE_USE_ENV_PROXY=1`, so even a process that has them may go direct.
 *
 * So the route is decided by trying, not by trusting the environment. Candidates, in order:
 *   1. `AGENTDROP_PROXY=<url>`: the only candidate, the user said so;
 *   2. the proxy in this process's own environment, then a direct connection;
 *   3. a proxy in an ancestor process's environment (Linux `/proc`: the harness itself kept it);
 *   4. only when all of those fail: the login shell's environment, then common local proxy ports.
 * Each candidate is probed with `GET /health/live`; the first that answers wins and is saved per server in
 * `network.json`, so later processes (a bridge started with a stripped environment, or a hook) use it without
 * probing. A saved route that stops working is re-resolved once and the request retried when that is safe.
 *
 * A process with no proxy anywhere in sight goes direct with no probe at all, exactly as before.
 */

export type RouteSource =
  | 'direct'
  | 'override'
  | 'environment'
  | 'parent-process'
  | 'login-shell'
  | 'local-port';

export interface NetworkRoute {
  /** Proxy URL, or null for a direct connection. May carry credentials: show it only through `redactProxy`. */
  proxy: string | null;
  source: RouteSource;
}

interface Candidate extends NetworkRoute {}

/** What a caller can observe: the route in use and how it was chosen. */
export interface RouteReport extends NetworkRoute {
  /** `saved` = taken from network.json, `probed` = just tested, `assumed` = no alternative, so not tested. */
  basis: 'saved' | 'probed' | 'assumed';
  /** True when every candidate failed its probe; the route is then only the best guess. */
  unreachable: boolean;
}

export interface NetworkDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  pid: number;
  /** Reads `/proc/<pid>/…`; null when unreadable. */
  readProcFile: (path: string) => string | null;
  loginShellEnv: () => Promise<Record<string, string> | null>;
  probe: (origin: string, proxy: string | null, timeoutMs: number) => Promise<boolean>;
  direct: typeof fetch;
  viaProxy: (proxy: string) => typeof fetch;
  loadSaved: (origin: string) => NetworkRoute | null;
  save: (origin: string, route: NetworkRoute) => void;
  now: () => number;
}

const PROBE_TIMEOUT_MS = 3500;
/** A failed resolution is not repeated within this window: a dead network must not turn into a probe storm. */
const RESOLVE_COOLDOWN_MS = 30_000;
/** Clash, Clash Verge, v2rayN, ShadowsocksX-NG, Privoxy, Squid. Tried last, and only for an https server. */
export const LOCAL_PROXY_PORTS = [7890, 7897, 10809, 1087, 8118, 3128];
/** Connection failures that mean the request never reached the server, so any method may be retried. */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_PRX_TLS',
]);

/** `http://user:pass@host:port` → `http://***@host:port`; for logs and doctor output. */
export function redactProxy(proxy: string): string {
  try {
    const u = new URL(proxy);
    const auth = u.username || u.password ? '***@' : '';
    return `${u.protocol}//${auth}${u.host}`;
  } catch {
    return '(invalid proxy URL)';
  }
}

/** A usable HTTP(S) proxy URL, or null. `host:port` gets `http://`; SOCKS and other schemes are not supported. */
export function normalizeProxy(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return withScheme.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** The proxy an environment asks for, for a server with this scheme (curl's precedence). */
export function proxyFromEnv(
  env: Record<string, string | undefined>,
  scheme: 'http:' | 'https:',
): string | null {
  const keys =
    scheme === 'https:'
      ? ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
      : ['http_proxy', 'HTTP_PROXY', 'ALL_PROXY', 'all_proxy'];
  for (const k of keys) {
    const p = normalizeProxy(env[k]);
    if (p) return p;
  }
  return null;
}

function noProxyCovers(host: string, env: Record<string, string | undefined>): boolean {
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  if (!noProxy) return false;
  if (matchedByNoProxyCidr(host, noProxy)) return true;
  return noProxy
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .some((e) => {
      if (e === '*') return true;
      const bare = e.replace(/^\*?\./, '').replace(/:\d+$/, '');
      return host === bare || host.endsWith(`.${bare}`);
    });
}

/** Parses `/proc/<pid>/environ` (NUL-separated) or `env` output (newline-separated). */
export function parseEnvBlock(text: string, separator: '\0' | '\n'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of text.split(separator)) {
    const i = entry.indexOf('=');
    if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return out;
}

/** Proxies found in ancestor processes' environments, nearest first (Linux only; elsewhere empty). */
export function ancestorProxies(deps: NetworkDeps, scheme: 'http:' | 'https:', maxDepth = 8): string[] {
  if (deps.platform !== 'linux') return [];
  const found: string[] = [];
  let pid = deps.pid;
  for (let depth = 0; depth < maxDepth; depth++) {
    const stat = deps.readProcFile(`/proc/${pid}/stat`);
    // "pid (comm) state ppid …": comm may contain spaces and parentheses, so read after the last ')'.
    const ppid = stat ? Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) : Number.NaN;
    if (!Number.isInteger(ppid) || ppid <= 1) break;
    const environ = deps.readProcFile(`/proc/${ppid}/environ`);
    if (environ) {
      const p = proxyFromEnv(parseEnvBlock(environ, '\0'), scheme);
      if (p && !found.includes(p)) found.push(p);
    }
    pid = ppid;
  }
  return found;
}

export interface RoutedFetch {
  fetch: typeof fetch;
  /** Resolve the route now (at most `capMs`) instead of on the first request. Never rejects. */
  prepare: (capMs?: number) => Promise<RouteReport | null>;
  /** The route decided so far, or null before the first resolution. */
  current: () => RouteReport | null;
}

export function createRoutedFetch(serverUrl: string, deps: NetworkDeps): RoutedFetch {
  let origin: string;
  let host: string;
  let scheme: 'http:' | 'https:';
  try {
    const u = new URL(serverUrl);
    origin = u.origin;
    host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    scheme = u.protocol === 'http:' ? 'http:' : 'https:';
  } catch {
    const passthrough: typeof fetch = (input, init) => deps.direct(input, init);
    return { fetch: passthrough, prepare: async () => null, current: () => null };
  }

  const mode = (deps.env.AGENTDROP_PROXY ?? 'auto').trim();
  const override = /:\/\//.test(mode) ? normalizeProxy(mode) : null;
  const modeWord = override ? 'override' : mode.toLowerCase();
  const discovery = (deps.env.AGENTDROP_PROXY_DISCOVERY ?? 'on').trim().toLowerCase() !== 'off';
  const ownProxy = proxyFromEnv(deps.env, scheme);
  // Private or NO_PROXY-covered servers never go through a proxy (see @agentdrop/client proxy.ts).
  const directOnly =
    modeWord === 'never' ||
    (modeWord !== 'always' && !override && (isPrivateHost(host) || noProxyCovers(host, deps.env)));
  if (directOnly) applyProxyBypass(serverUrl, deps.env);

  const agents = new Map<string, typeof fetch>();
  const fetchFor = (route: NetworkRoute): typeof fetch => {
    if (!route.proxy) return deps.direct;
    let f = agents.get(route.proxy);
    if (!f) {
      f = deps.viaProxy(route.proxy);
      agents.set(route.proxy, f);
    }
    return f;
  };

  let report: RouteReport | null = null;
  let resolving: Promise<RouteReport> | null = null;
  let lastFreshResolve = Number.NEGATIVE_INFINITY;

  /** Probes candidates concurrently; the first in order whose probe succeeds wins. */
  const firstWorking = async (candidates: Candidate[]): Promise<Candidate | null> => {
    const probes = candidates.map((c) => deps.probe(origin, c.proxy, PROBE_TIMEOUT_MS).catch(() => false));
    for (let i = 0; i < candidates.length; i++) if (await probes[i]) return candidates[i] ?? null;
    return null;
  };

  const dedupe = (list: Candidate[], seen: Set<string>): Candidate[] =>
    list.filter((c) => {
      const key = c.proxy ?? 'direct';
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const resolve = async (fresh: boolean): Promise<RouteReport> => {
    if (override) return { proxy: override, source: 'override', basis: 'assumed', unreachable: false };
    if (directOnly) return { proxy: null, source: 'direct', basis: 'assumed', unreachable: false };
    if (modeWord === 'always')
      return ownProxy
        ? { proxy: ownProxy, source: 'environment', basis: 'assumed', unreachable: false }
        : { proxy: null, source: 'direct', basis: 'assumed', unreachable: false };
    if (!fresh) {
      const saved = deps.loadSaved(origin);
      if (saved) return { ...saved, basis: 'saved', unreachable: false };
    }
    const seen = new Set<string>();
    const direct: Candidate = { proxy: null, source: 'direct' };
    const first = dedupe(
      [
        ...(ownProxy ? [{ proxy: ownProxy, source: 'environment' as const }] : []),
        direct,
        ...(discovery
          ? ancestorProxies(deps, scheme).map((p) => ({ proxy: p, source: 'parent-process' as const }))
          : []),
      ],
      seen,
    );
    // Nothing but a direct connection to choose from, and nothing has failed yet: behave as before, no probe.
    if (!fresh && first.length === 1) return { ...direct, basis: 'assumed', unreachable: false };
    lastFreshResolve = deps.now();
    let chosen = await firstWorking(first);
    if (!chosen && discovery) {
      const shellEnv = await deps.loginShellEnv().catch(() => null);
      const shellProxy = shellEnv ? proxyFromEnv(shellEnv, scheme) : null;
      const second = dedupe(
        [
          ...(shellProxy ? [{ proxy: shellProxy, source: 'login-shell' as const }] : []),
          // An unknown local listener sees only a CONNECT for an https server; never offer it cleartext.
          ...(scheme === 'https:'
            ? LOCAL_PROXY_PORTS.map((port) => ({
                proxy: `http://127.0.0.1:${port}`,
                source: 'local-port' as const,
              }))
            : []),
        ],
        seen,
      );
      chosen = await firstWorking(second);
    }
    if (chosen) {
      try {
        deps.save(origin, { proxy: chosen.proxy, source: chosen.source });
      } catch {
        /* an unwritable config dir costs a probe next time, nothing more */
      }
      return { ...chosen, basis: 'probed', unreachable: false };
    }
    const fallback: Candidate = ownProxy ? { proxy: ownProxy, source: 'environment' } : direct;
    return { ...fallback, basis: 'probed', unreachable: true };
  };

  const ensure = (fresh: boolean): Promise<RouteReport> => {
    if (resolving) return resolving;
    resolving = resolve(fresh)
      .then((r) => {
        report = r;
        return r;
      })
      .finally(() => {
        resolving = null;
      });
    return resolving;
  };

  const routed: typeof fetch = async (input, init) => {
    const route = report ?? (await ensure(false));
    const signal = init?.signal ?? undefined;
    try {
      return await fetchFor(route)(input, init);
    } catch (err) {
      if (signal?.aborted || override || directOnly || modeWord === 'always') throw err;
      if (deps.now() - lastFreshResolve < RESOLVE_COOLDOWN_MS) throw err;
      const next = await ensure(true);
      const changed = next.proxy !== route.proxy;
      if (!changed || next.unreachable || signal?.aborted || !retrySafe(init, err)) throw err;
      return fetchFor(next)(input, init);
    }
  };

  return {
    fetch: routed,
    prepare: async (capMs = 8000) => {
      const timer = new Promise<null>((r) => setTimeout(() => r(null), capMs).unref());
      return Promise.race([ensure(false).catch(() => null), timer]);
    },
    current: () => report,
  };
}

function errorCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Replaying needs a body we still have, and either a read or proof the first attempt never left this machine. */
function retrySafe(init: RequestInit | undefined, err: unknown): boolean {
  const body = init?.body;
  const replayable =
    body === undefined || body === null || typeof body === 'string' || body instanceof Uint8Array;
  if (!replayable) return false;
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return true;
  const code = errorCode(err);
  return code !== undefined && NOT_SENT_CODES.has(code);
}

// ---------------------------------------------------------------------------------------------------------------
// Real dependencies

const savedRouteSchema = z.object({
  proxy: z.string().nullable(),
  source: z.enum(['direct', 'override', 'environment', 'parent-process', 'login-shell', 'local-port']),
  checked_at: z.string(),
});
const networkFileSchema = z.object({ routes: z.record(z.string(), savedRouteSchema).default({}) });

export function networkPath(): string {
  return join(configDir(), 'network.json');
}

function readNetworkFile(): z.infer<typeof networkFileSchema> {
  try {
    if (!existsSync(networkPath())) return { routes: {} };
    return networkFileSchema.parse(JSON.parse(readFileSync(networkPath(), 'utf8')));
  } catch {
    return { routes: {} };
  }
}

/** Forget the saved route for a server, so the next process probes again (`agentdrop doctor` does this). */
export function forgetSavedRoute(serverUrl: string): void {
  try {
    const origin = new URL(serverUrl).origin;
    const file = readNetworkFile();
    if (!file.routes[origin]) return;
    delete file.routes[origin];
    writePrivateFile(networkPath(), `${JSON.stringify(file, null, 2)}\n`);
  } catch {
    /* best effort */
  }
}

async function loginShellEnv(
  env: Record<string, string | undefined>,
): Promise<Record<string, string> | null> {
  if (process.platform === 'win32') return null;
  const shell = env.SHELL || '/bin/sh';
  const name = shell.split('/').pop() ?? '';
  // -i reads ~/.bashrc / ~/.zshrc, where proxy exports usually live; plain sh has no reliable -i without a tty.
  const args = ['bash', 'zsh', 'fish', 'ksh'].includes(name) ? ['-l', '-i', '-c'] : ['-l', '-c'];
  const begin = '__AGENTDROP_ENV_BEGIN__';
  const end = '__AGENTDROP_ENV_END__';
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: Record<string, string> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, [...args, `printf '\\n${begin}\\n'; env; printf '\\n${end}\\n'`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...env, TERM: 'dumb' },
        detached: false,
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(null);
    }, 5000);
    timer.unref();
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < 1_000_000) out += d.toString('utf8');
    });
    child.on('error', () => done(null));
    child.on('close', () => {
      const a = out.indexOf(begin);
      const b = out.indexOf(end, a + begin.length);
      done(a < 0 || b < 0 ? null : parseEnvBlock(out.slice(a + begin.length, b), '\n'));
    });
  });
}

function proxiedFetch(proxy: string): typeof fetch {
  const dispatcher = new ProxyAgent({
    uri: proxy,
    proxyTls: { timeout: 10_000 },
    connect: { timeout: 10_000 },
  });
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
}

async function probe(origin: string, proxy: string | null, timeoutMs: number): Promise<boolean> {
  const url = `${origin}/health/live`;
  const init = { method: 'GET', redirect: 'manual' as const, signal: AbortSignal.timeout(timeoutMs) };
  if (!proxy) {
    const res = await globalThis.fetch(url, init);
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  }
  const dispatcher = new ProxyAgent({
    uri: proxy,
    connect: { timeout: timeoutMs },
    proxyTls: { timeout: timeoutMs },
  });
  try {
    const res = await undiciFetch(url, { ...init, dispatcher });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } finally {
    void dispatcher.close().catch(() => undefined);
  }
}

export function realNetworkDeps(env: Record<string, string | undefined> = process.env): NetworkDeps {
  return {
    env,
    platform: process.platform,
    pid: process.pid,
    readProcFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    loginShellEnv: () => loginShellEnv(env),
    probe,
    // looked up per call so tests that replace globalThis.fetch still see every request
    direct: (input, init) => globalThis.fetch(input, init),
    viaProxy: proxiedFetch,
    loadSaved: (origin) => {
      const r = readNetworkFile().routes[origin];
      return r ? { proxy: r.proxy, source: r.source } : null;
    },
    save: (origin, route) => {
      const file = readNetworkFile();
      const prev = file.routes[origin];
      if (prev && prev.proxy === route.proxy && prev.source === route.source) return;
      file.routes[origin] = { ...route, checked_at: new Date().toISOString() };
      writePrivateFile(networkPath(), `${JSON.stringify(file, null, 2)}\n`);
    },
    now: () => Date.now(),
  };
}

const perOrigin = new Map<string, RoutedFetch>();

/** The routed fetch for a server, shared by every client in this process. */
export function networkRoute(serverUrl: string): RoutedFetch {
  let key: string;
  try {
    key = new URL(serverUrl).origin;
  } catch {
    key = serverUrl;
  }
  let r = perOrigin.get(key);
  if (!r) {
    r = createRoutedFetch(serverUrl, realNetworkDeps());
    perOrigin.set(key, r);
  }
  return r;
}

/** Shorthand for `new ApiClient({ baseUrl, fetch: networkFetch(baseUrl) })`. */
export function networkFetch(serverUrl: string): typeof fetch {
  return networkRoute(serverUrl).fetch;
}

/** For `doctor` and tests: drop per-process state so the next call resolves again. */
export function resetNetworkRoutes(): void {
  perOrigin.clear();
}

export function describeRoute(r: RouteReport): string {
  const via = r.proxy ? `proxy ${redactProxy(r.proxy)}` : 'direct';
  const from: Record<RouteSource, string> = {
    direct: '',
    override: ' (AGENTDROP_PROXY)',
    environment: ' (from this environment)',
    'parent-process': " (from the harness's environment)",
    'login-shell': ' (from the login shell)',
    'local-port': ' (local proxy port)',
  };
  const basis = r.basis === 'saved' ? ', saved' : r.basis === 'probed' ? ', tested' : '';
  return `${via}${from[r.source]}${basis}`;
}
