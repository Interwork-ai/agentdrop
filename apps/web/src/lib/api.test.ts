import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { newRequestId } from './api.js';

const UUID_V4 = /^web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

it('makes a v4 request id in a secure context', () => {
  expect(newRequestId()).toMatch(UUID_V4);
});

// Regression: on a plain-http origin `crypto.randomUUID` does not exist, and calling it blanked the
// composer. `getRandomValues` exists everywhere.
it('still makes distinct v4 request ids where crypto.randomUUID is missing (plain http)', () => {
  vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => webcrypto.getRandomValues(a) });
  expect(typeof crypto.randomUUID).toBe('undefined');
  const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
  expect(ids.size).toBe(200);
  for (const id of ids) expect(id).toMatch(UUID_V4);
});
