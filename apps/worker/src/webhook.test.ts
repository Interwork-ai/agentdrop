import type { LookupAddress } from 'node:dns';
import type { DrizzleDb } from '@agentdrop/db';
import { isPublicUnicastAddress, webhookHostForbidden } from '@agentdrop/domain';
import { describe, expect, it, vi } from 'vitest';
import { notifyUsers, pinnedLookup, postWebhook, WebhookAddressError } from './webhook.js';

describe('webhook address policy', () => {
  it.each([
    ['8.8.8.8', true],
    ['2606:4700:4700::1111', true],
    ['::ffff:8.8.8.8', true],
    ['10.1.2.3', false],
    ['172.16.0.1', false],
    ['192.168.1.1', false],
    ['127.0.0.1', false],
    ['0.0.0.0', false],
    ['100.100.100.200', false],
    ['169.254.169.254', false],
    ['224.0.0.1', false],
    ['::1', false],
    ['::', false],
    ['fd00:ec2::254', false],
    ['fe80::1%eth0', false],
    ['ff02::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:a9fe:a9fe', false],
    ['64:ff9b::10.0.0.1', false],
    ['not-an-ip', false],
  ])('%s public=%s', (address, expected) => {
    expect(isPublicUnicastAddress(address)).toBe(expected);
  });

  it('refuses localhost names and literal non-public hosts when a webhook is saved', () => {
    for (const url of [
      'https://localhost/x',
      'https://api.localhost./x',
      'https://127.1/',
      'https://2130706433/',
      'https://[::1]/',
      'https://[::ffff:10.0.0.1]/',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      expect(webhookHostForbidden(new URL(url)), url).toBe(true);
    }
    expect(webhookHostForbidden(new URL('https://hooks.example/x'))).toBe(false);
    expect(webhookHostForbidden(new URL('https://8.8.8.8/x'))).toBe(false);
  });
});

describe('webhook delivery pins checked addresses', () => {
  const lookupOnce = (
    allowPrivate: boolean,
    addresses: LookupAddress[],
    all: boolean,
  ): Promise<{ err: NodeJS.ErrnoException | null; result: unknown }> =>
    new Promise((resolve) => {
      pinnedLookup(allowPrivate, async () => addresses)('hooks.example', { all }, (err, result) =>
        resolve({ err, result }),
      );
    });

  it('refuses a name when any resolved address is non-public, unless explicitly allowed', async () => {
    const mixed = [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    expect((await lookupOnce(false, mixed, true)).err).toBeInstanceOf(WebhookAddressError);
    expect((await lookupOnce(false, [{ address: '::ffff:127.0.0.1', family: 6 }], false)).err).toBeInstanceOf(
      WebhookAddressError,
    );
    expect(await lookupOnce(true, mixed, true)).toEqual({ err: null, result: mixed });
    expect(await lookupOnce(false, [{ address: '8.8.8.8', family: 4 }], false)).toEqual({
      err: null,
      result: '8.8.8.8',
    });
  });

  it('refuses literal private hosts and non-https URLs before opening a socket', async () => {
    const signal = new AbortController().signal;
    for (const url of [
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://[::ffff:a00:1]/',
      'http://8.8.8.8/',
    ]) {
      await expect(
        postWebhook(url, '{}', {}, signal, { allowPrivateNetwork: false }),
        url,
      ).rejects.toBeInstanceOf(WebhookAddressError);
    }
  });

  it('refuses a public-looking name that resolves to a metadata address', async () => {
    await expect(
      postWebhook('https://hooks.example/x', '{}', {}, new AbortController().signal, {
        allowPrivateNetwork: false,
        resolver: async () => [{ address: '169.254.169.254', family: 4 }],
      }),
    ).rejects.toBeInstanceOf(WebhookAddressError);
  });
});

describe('webhook fan-out progress', () => {
  const users = [
    { id: 'u1', url: 'https://one.example/', handle: 'one' },
    { id: 'u2', url: 'https://two.example/', handle: 'two' },
    { id: 'u3', url: 'https://10.0.0.1/', handle: 'three' },
  ];
  const db = {
    select: () => ({ from: () => ({ where: async () => users }) }),
  } as unknown as DrizzleDb;

  it('a retry only re-sends to the receivers that failed; forbidden targets settle without failing', async () => {
    const keys = new Set<string>();
    const progress = { done: (k: string) => keys.has(k), markDone: async (k: string) => void keys.add(k) };
    let twoUp = false;
    const post = vi.fn(async (url: string) => {
      if (url.startsWith('https://10.')) throw new WebhookAddressError();
      return url.includes('two') && !twoUp ? 503 : 204;
    });
    const forbidden: string[] = [];
    const run = () =>
      notifyUsers(
        db,
        ['u1', 'u2', 'u3'],
        { type: 'drop.delivered' },
        { eventId: 'event-1', signal: new AbortController().signal, progress },
        { allowPrivateNetwork: false, onForbidden: (id) => forbidden.push(id) },
        post as never,
      );
    await expect(run()).rejects.toThrow(/u2: HTTP 503/);
    expect(post.mock.calls.map((c) => c[0])).toEqual(users.map((u) => u.url));
    expect([...keys].sort()).toEqual(['webhook:u1', 'webhook:u3']);
    expect(forbidden).toEqual(['u3']);

    post.mockClear();
    twoUp = true;
    await run();
    expect(post.mock.calls.map((c) => c[0])).toEqual(['https://two.example/']);
    expect(keys.has('webhook:u2')).toBe(true);
  });
});
