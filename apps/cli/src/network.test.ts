import { describe, expect, it } from 'vitest';
import {
  ancestorProxies,
  createRoutedFetch,
  LOCAL_PROXY_PORTS,
  type NetworkDeps,
  type NetworkRoute,
  normalizeProxy,
  proxyFromEnv,
  redactProxy,
} from './network.js';

const SERVER = 'https://drop.example.com';
const PROXY = 'http://127.0.0.1:3128';

function refused(): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });
}

/** A fake world: `reachable` lists the routes ('direct' or a proxy URL) that get through to the server. */
function world(opts: {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  proc?: Record<string, string>;
  shell?: Record<string, string> | null;
  reachable: Set<string>;
  saved?: NetworkRoute | null;
}) {
  const calls: string[] = [];
  const probes: string[] = [];
  let saved: NetworkRoute | null = opts.saved ?? null;
  let shellRuns = 0;
  let clock = 1_000_000;
  const via = (key: string): typeof fetch =>
    (async () => {
      calls.push(key);
      if (!opts.reachable.has(key)) throw refused();
      return new Response('{"status":"ok","version":"x"}', { status: 200 });
    }) as unknown as typeof fetch;
  const deps: NetworkDeps = {
    env: opts.env ?? {},
    platform: opts.platform ?? 'linux',
    pid: 100,
    readProcFile: (path) => opts.proc?.[path] ?? null,
    loginShellEnv: async () => {
      shellRuns++;
      return opts.shell ?? null;
    },
    probe: async (_origin, proxy) => {
      probes.push(proxy ?? 'direct');
      return opts.reachable.has(proxy ?? 'direct');
    },
    direct: via('direct'),
    viaProxy: (proxy) => via(proxy),
    loadSaved: () => saved,
    save: (_origin, route) => {
      saved = route;
    },
    now: () => clock,
  };
  return {
    deps,
    calls,
    probes,
    saved: () => saved,
    shellRuns: () => shellRuns,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('network route discovery', () => {
  it('goes direct without probing when no proxy is in sight', async () => {
    const w = world({ reachable: new Set(['direct']) });
    const r = createRoutedFetch(SERVER, w.deps);
    await r.fetch(`${SERVER}/v1/h/identity`);
    expect(w.calls).toEqual(['direct']);
    expect(w.probes).toEqual([]);
    expect(w.saved()).toBeNull();
    expect(r.current()).toMatchObject({ proxy: null, basis: 'assumed' });
  });

  it("finds the harness's proxy when the bridge was started without one (Codex strips HTTPS_PROXY)", async () => {
    const w = world({
      proc: {
        '/proc/100/stat': '100 (node) S 90 100 100',
        '/proc/90/stat': '90 (codex) S 80 90 90',
        '/proc/90/environ': `HOME=/home/u\0HTTPS_PROXY=${PROXY}\0`,
      },
      reachable: new Set([PROXY]),
    });
    const r = createRoutedFetch(SERVER, w.deps);
    const report = await r.prepare();
    expect(report).toMatchObject({
      proxy: PROXY,
      source: 'parent-process',
      basis: 'probed',
      unreachable: false,
    });
    await r.fetch(`${SERVER}/v1/h/requests`);
    expect(w.calls).toEqual([PROXY]);
    expect(w.saved()).toEqual({ proxy: PROXY, source: 'parent-process' });
  });

  it('prefers the proxy in its own environment, and saves it for processes that lack it', async () => {
    const w = world({ env: { https_proxy: '127.0.0.1:3128' }, reachable: new Set([PROXY, 'direct']) });
    const r = createRoutedFetch(SERVER, w.deps);
    await r.fetch(`${SERVER}/v1/h/identity`);
    expect(w.calls).toEqual([PROXY]);
    expect(w.saved()).toEqual({ proxy: PROXY, source: 'environment' });
  });

  it('falls back to direct when its own proxy is broken', async () => {
    const w = world({ env: { HTTPS_PROXY: 'http://dead:3128' }, reachable: new Set(['direct']) });
    const r = createRoutedFetch(SERVER, w.deps);
    await r.fetch(`${SERVER}/v1/h/identity`);
    expect(w.calls).toEqual(['direct']);
    expect(w.saved()).toEqual({ proxy: null, source: 'direct' });
  });

  it('uses a saved route without probing', async () => {
    const w = world({ reachable: new Set([PROXY]), saved: { proxy: PROXY, source: 'environment' } });
    const r = createRoutedFetch(SERVER, w.deps);
    await r.fetch(`${SERVER}/v1/h/identity`);
    expect(w.probes).toEqual([]);
    expect(w.calls).toEqual([PROXY]);
  });

  it('after a direct failure, reads the login shell and retries the request through what it found', async () => {
    const w = world({
      platform: 'darwin',
      shell: { HTTPS_PROXY: PROXY },
      reachable: new Set([PROXY]),
    });
    const r = createRoutedFetch(SERVER, w.deps);
    const res = await r.fetch(`${SERVER}/v1/h/requests`);
    expect(res.ok).toBe(true);
    expect(w.calls).toEqual(['direct', PROXY]);
    expect(w.shellRuns()).toBe(1);
    expect(w.saved()).toEqual({ proxy: PROXY, source: 'login-shell' });
  });

  it('tries common local proxy ports last, for an https server only', async () => {
    const port = `http://127.0.0.1:${LOCAL_PROXY_PORTS[1]}`;
    const w = world({ reachable: new Set([port]) });
    const r = createRoutedFetch(SERVER, w.deps);
    await r.fetch(`${SERVER}/v1/h/identity`);
    expect(w.saved()).toEqual({ proxy: port, source: 'local-port' });

    const plain = world({ reachable: new Set([port]) });
    const rp = createRoutedFetch('http://drop.example.com:3300', plain.deps);
    await expect(rp.fetch('http://drop.example.com:3300/v1/h/identity')).rejects.toThrow('fetch failed');
    expect(plain.probes.some((p) => p.startsWith('http://127.0.0.1'))).toBe(false);
  });

  it('retries a POST only when the first attempt never left the machine', async () => {
    const w = world({
      saved: { proxy: 'http://gone:8080', source: 'environment' },
      reachable: new Set(['direct']),
    });
    const r = createRoutedFetch(SERVER, w.deps);
    await r.fetch(`${SERVER}/v1/h/drops`, { method: 'POST', body: '{}' });
    expect(w.calls).toEqual(['http://gone:8080', 'direct']);

    const reset = world({ saved: { proxy: null, source: 'direct' }, reachable: new Set([PROXY]) });
    reset.deps.direct = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }) as unknown as typeof fetch;
    reset.deps.env = { HTTPS_PROXY: PROXY };
    const rr = createRoutedFetch(SERVER, reset.deps);
    await expect(rr.fetch(`${SERVER}/v1/h/drops`, { method: 'POST', body: '{}' })).rejects.toThrow(
      'fetch failed',
    );
    // the route was still corrected for the next request
    expect(rr.current()).toMatchObject({ proxy: PROXY });
  });

  it('does not probe again within the cooldown after a resolution', async () => {
    const w = world({ reachable: new Set() });
    const r = createRoutedFetch(SERVER, w.deps);
    await expect(r.fetch(`${SERVER}/a`)).rejects.toThrow();
    const probed = w.probes.length;
    await expect(r.fetch(`${SERVER}/b`)).rejects.toThrow();
    expect(w.probes.length).toBe(probed);
    expect(r.current()).toMatchObject({ unreachable: true });
    w.advance(31_000);
    await expect(r.fetch(`${SERVER}/c`)).rejects.toThrow();
    expect(w.probes.length).toBeGreaterThan(probed);
  });

  it('never proxies a private server, and honours an explicit AGENTDROP_PROXY', async () => {
    const lan = world({ env: { HTTPS_PROXY: PROXY }, reachable: new Set(['direct']) });
    await createRoutedFetch('https://10.1.2.3:3300', lan.deps).fetch('https://10.1.2.3:3300/x');
    expect(lan.calls).toEqual(['direct']);
    expect(lan.probes).toEqual([]);

    const forced = world({
      env: { AGENTDROP_PROXY: 'http://corp:8080' },
      reachable: new Set(['http://corp:8080']),
    });
    await createRoutedFetch(SERVER, forced.deps).fetch(`${SERVER}/x`);
    expect(forced.calls).toEqual(['http://corp:8080']);
    expect(forced.probes).toEqual([]);
  });

  it('skips ancestor and shell discovery when AGENTDROP_PROXY_DISCOVERY=off', async () => {
    const w = world({
      env: { AGENTDROP_PROXY_DISCOVERY: 'off' },
      proc: { '/proc/100/stat': '100 (node) S 90', '/proc/90/environ': `HTTPS_PROXY=${PROXY}` },
      shell: { HTTPS_PROXY: PROXY },
      reachable: new Set([PROXY]),
    });
    await expect(createRoutedFetch(SERVER, w.deps).fetch(`${SERVER}/x`)).rejects.toThrow();
    expect(w.shellRuns()).toBe(0);
    expect(w.calls).toEqual(['direct']);
  });
});

describe('network helpers', () => {
  it('normalizes proxies and rejects schemes it cannot use', () => {
    expect(normalizeProxy('127.0.0.1:3128')).toBe(PROXY);
    expect(normalizeProxy('http://127.0.0.1:3128/')).toBe(PROXY);
    expect(normalizeProxy('socks5://127.0.0.1:1080')).toBeNull();
    expect(normalizeProxy('')).toBeNull();
    expect(proxyFromEnv({ ALL_PROXY: 'socks5://x:1', all_proxy: 'http://y:2' }, 'https:')).toBe('http://y:2');
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://s:1', http_proxy: 'http://p:2' }, 'http:')).toBe('http://p:2');
  });

  it('hides proxy credentials', () => {
    expect(redactProxy('http://user:secret@proxy.example:3128')).toBe('http://***@proxy.example:3128');
    expect(redactProxy(PROXY)).toBe(PROXY);
  });

  it('walks ancestors through process names with spaces and parentheses', () => {
    const w = world({
      proc: {
        '/proc/100/stat': '100 (a b) c) S 90 1 1',
        '/proc/90/stat': '90 (zsh) S 1 1 1',
        '/proc/90/environ': `https_proxy=${PROXY}\0`,
      },
      reachable: new Set(),
    });
    expect(ancestorProxies(w.deps, 'https:')).toEqual([PROXY]);
    expect(ancestorProxies({ ...w.deps, platform: 'darwin' }, 'https:')).toEqual([]);
  });
});
