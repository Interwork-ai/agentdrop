import { describe, expect, it } from 'vitest';
import { applyProxyBypass, isPrivateHost, matchedByNoProxyCidr } from './proxy.js';

type Env = Record<string, string | undefined>;

const proxied = (extra: Env = {}): Env => ({
  HTTPS_PROXY: 'http://proxy.corp:8080',
  HTTP_PROXY: 'http://proxy.corp:8080',
  ...extra,
});

describe('isPrivateHost', () => {
  it('recognises the ranges a forward proxy cannot reach', () => {
    for (const host of [
      'localhost',
      'dev.localhost',
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.20.0.10',
      '172.31.255.255',
      '192.168.1.10',
      '169.254.1.1',
      '100.64.0.1',
      'gpu-box',
      'nas.local',
      'api.internal',
      '::1',
      'fd00::1',
      'fe80::1',
    ])
      expect(isPrivateHost(host), host).toBe(true);
  });

  it('leaves public addresses alone, including the ones adjacent to private ranges', () => {
    for (const host of [
      'drop.example.com',
      '8.8.8.8',
      '172.15.0.1', // hygiene-allow: public-ip just outside a private range
      '172.32.0.1', // hygiene-allow: public-ip just outside a private range
      '192.169.0.1', // hygiene-allow: public-ip just outside a private range
      '100.128.0.1', // hygiene-allow: public-ip just outside a private range
      '11.0.0.1', // hygiene-allow: public-ip just outside a private range
      '2001:4860::1',
    ])
      expect(isPrivateHost(host), host).toBe(false);
  });
});

describe('matchedByNoProxyCidr', () => {
  it('resolves the CIDR entries Node silently ignores', () => {
    expect(matchedByNoProxyCidr('172.20.0.10', '172.16.0.0/12')).toBe(true);
    expect(matchedByNoProxyCidr('10.0.0.1', 'localhost,10.0.0.0/8,.example.com')).toBe(true);
    expect(matchedByNoProxyCidr('8.8.8.8', '172.16.0.0/12')).toBe(false);
    expect(matchedByNoProxyCidr('drop.example.com', '172.16.0.0/12')).toBe(false);
    expect(matchedByNoProxyCidr('1.2.3.4', '0.0.0.0/0')).toBe(true);
  });

  it('ignores malformed entries instead of throwing', () => {
    expect(matchedByNoProxyCidr('10.0.0.1', '10.0.0.0/999,not/a/cidr,/8,')).toBe(false);
  });
});

describe('applyProxyBypass', () => {
  it('does nothing when no proxy is configured', () => {
    const env: Record<string, string | undefined> = {};
    expect(applyProxyBypass('http://172.20.0.10:3300', env)).toBe('no-proxy-configured');
    expect(env.NO_PROXY).toBeUndefined();
  });

  /* The reported failure: Codex inherits NODE_USE_ENV_PROXY=1 and NO_PROXY=172.16.0.0/12, Node ignores the
     CIDR, every hook request goes to a proxy that cannot reach the LAN, and the Stop hook blows its budget. */
  it('bypasses a private server that a CIDR in NO_PROXY was meant to exclude', () => {
    const env = proxied({ NO_PROXY: '172.16.0.0/12' });
    expect(applyProxyBypass('http://172.20.0.10:3300', env)).toBe('bypassed');
    for (const key of ['NO_PROXY', 'no_proxy']) {
      const entries = (env[key] ?? '').split(',');
      expect(entries, key).toContain('172.20.0.10');
      expect(entries, key).toContain('172.20.0.10:3300');
    }
    // the user's original entry survives
    expect(env.NO_PROXY).toContain('172.16.0.0/12');
  });

  it('bypasses a private server even when the user configured nothing', () => {
    const env = proxied();
    expect(applyProxyBypass('http://192.168.1.50:3300', env)).toBe('bypassed');
    expect(env.no_proxy).toContain('192.168.1.50:3300');
  });

  it('keeps using the proxy for a public server, which may be the only way to reach it', () => {
    const env = proxied();
    expect(applyProxyBypass('https://drop.example.com', env)).toBe('proxied');
    expect(env.NO_PROXY).toBeUndefined();
  });

  it('honours the explicit override in both directions', () => {
    const never = proxied({ AGENTDROP_PROXY: 'never' });
    expect(applyProxyBypass('https://drop.example.com', never)).toBe('bypassed');
    expect(never.NO_PROXY).toContain('drop.example.com');

    const always = proxied({ AGENTDROP_PROXY: 'always' });
    expect(applyProxyBypass('http://172.20.0.10:3300', always)).toBe('proxied');
    expect(always.NO_PROXY).toBeUndefined();
  });

  it('is idempotent and does not duplicate entries across repeated clients', () => {
    const env = proxied();
    applyProxyBypass('http://10.0.0.5:3300', env);
    applyProxyBypass('http://10.0.0.5:3300', env);
    const entries = (env.NO_PROXY ?? '').split(',');
    expect(entries.filter((e) => e === '10.0.0.5')).toHaveLength(1);
    expect(entries.filter((e) => e === '10.0.0.5:3300')).toHaveLength(1);
  });

  it('treats an existing exact entry or a wildcard as already handled', () => {
    const exact = proxied({ NO_PROXY: 'drop.example.com' });
    expect(applyProxyBypass('https://drop.example.com', exact)).toBe('bypassed');
    expect(applyProxyBypass('https://drop.example.com', proxied({ NO_PROXY: '*' }))).toBe('bypassed');
  });

  it('reports a malformed base URL instead of throwing', () => {
    expect(applyProxyBypass('not a url', proxied())).toBe('invalid-url');
  });
});
