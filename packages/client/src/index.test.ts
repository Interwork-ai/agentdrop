import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './index.js';

/** Headers arrive immediately; the server never finishes the body. Like fetch, abort errors the stream. */
function stalledBody(status: number): typeof fetch {
  return async (_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('Aborted', 'AbortError'));
        });
      },
    });
    return new Response(body, { status });
  };
}

afterEach(() => vi.useRealTimers());

describe('API request deadlines', () => {
  it.each([200, 400, 503])('bounds the entire JSON response for HTTP %i', async (status) => {
    vi.useFakeTimers();
    const client = new ApiClient({
      baseUrl: 'https://example.test',
      fetch: stalledBody(status),
      timeoutMs: 30,
    });
    const assertion = expect(client.healthLive()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'request timed out',
    });
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 503])('bounds raw error response parsing for HTTP %i', async (status) => {
    vi.useFakeTimers();
    const client = new ApiClient({
      baseUrl: 'https://example.test',
      fetch: stalledBody(status),
      timeoutMs: 30,
    });
    const assertion = expect(client.requestRaw('GET', '/attachment')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'request timed out',
    });
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the deadline active while a successful raw body is consumed', async () => {
    vi.useFakeTimers();
    const client = new ApiClient({
      baseUrl: 'https://example.test',
      fetch: stalledBody(200),
      timeoutMs: 30,
    });
    const response = await client.requestRaw('GET', '/attachment');
    const assertion = expect(response.text()).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
  });

  it.each([200, 204, 401])('cleans up after a complete HTTP %i response', async (status) => {
    vi.useFakeTimers();
    const client = new ApiClient({
      baseUrl: 'https://example.test',
      fetch: async () => new Response(status === 204 ? null : '{}', { status }),
      timeoutMs: 30,
    });
    if (status === 401) await expect(client.healthLive()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    else await client.healthLive();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('my space (ADR 0030)', () => {
  function recording() {
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url) });
      return new Response(
        JSON.stringify({ drop_id: '11111111-1111-4111-8111-111111111111', deleted: true, freed_bytes: 42 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    return { calls, client: new ApiClient({ baseUrl: 'https://example.test', fetch: fetchImpl }) };
  }

  it('deletes one item through DELETE /v1/h/space/{drop_id}', async () => {
    const { calls, client } = recording();
    const res = await client.deleteSpaceItem('11111111-1111-4111-8111-111111111111');
    expect(res).toEqual({ drop_id: '11111111-1111-4111-8111-111111111111', deleted: true, freed_bytes: 42 });
    expect(calls).toEqual([
      { method: 'DELETE', url: 'https://example.test/v1/h/space/11111111-1111-4111-8111-111111111111' },
    ]);
  });

  it('passes view=space through to the list route unchanged', async () => {
    const { calls, client } = recording();
    await client.listDrops({ view: 'space', limit: 5 } as Parameters<ApiClient['listDrops']>[0]);
    expect(new URL(calls[0]?.url ?? '').searchParams.get('view')).toBe('space');
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/v1/h/drops');
  });
});

/* A person told "network error" cannot fix anything: callers need the reason's code word, never its message. */
describe('transport failure details', () => {
  it('keeps the system error code of a failed connection', async () => {
    const client = new ApiClient({
      baseUrl: 'https://drop.example.com',
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) });
      },
    });
    await expect(client.healthLive()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      details: { cause_code: 'ENOTFOUND' },
    });
  });

  it('reports the status of a response it cannot name (a redirect to https)', async () => {
    const client = new ApiClient({
      baseUrl: 'http://drop.example.com',
      fetch: async () =>
        new Response(null, { status: 301, headers: { location: 'https://drop.example.com/' } }),
    });
    await expect(client.healthLive()).rejects.toMatchObject({ code: 'INTERNAL', details: { status: 301 } });
  });
});
