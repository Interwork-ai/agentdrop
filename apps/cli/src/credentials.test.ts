import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { loadCredential } from './credentials.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it('bounds keychain reads when used by a Stop hook', () => {
  vi.mocked(execFileSync).mockReturnValue('fixture-value\n');
  expect(loadCredential({ store: 'keychain', account: 'test-only' }, { timeoutMs: 1000 })).toBe(
    'fixture-value',
  );
  expect(execFileSync).toHaveBeenCalledWith(
    'security',
    expect.any(Array),
    expect.objectContaining({ timeout: 1000 }),
  );
});
it('keychain timeout fails quietly without exposing command errors', () => {
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('private keychain diagnostic');
  });
  expect(loadCredential({ store: 'keychain', account: 'test-only' }, { timeoutMs: 1000 })).toBeNull();
});
