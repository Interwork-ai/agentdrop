import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clientLabel,
  createStaleBridgeNotice,
  newerRelease,
  STALE_CHECK_MS,
  staleBridgeLine,
} from './bridge-version.js';
import { createUpdateManager } from './updates.js';

describe('a bridge older than the installed CLI', () => {
  it('tells the model once, naming both versions and the client, then never again', () => {
    let now = 1_000_000;
    const installed = vi.fn(() => '0.6.0');
    const notice = createStaleBridgeNotice({
      running: '0.5.15',
      installed,
      client: 'Claude Code',
      now: () => now,
    });
    expect(notice()).toBe(
      'AgentDrop 0.6.0 is installed but this session still runs 0.5.15; tell the user to restart Claude Code when convenient.',
    );
    for (let i = 0; i < 3; i++) {
      now += STALE_CHECK_MS * 2;
      expect(notice()).toBeNull();
    }
    // once told, the disk is not read again
    expect(installed).toHaveBeenCalledTimes(1);
  });

  it('says nothing for the same or an older version, and looks at the disk at most every few minutes', () => {
    let now = 1_000_000;
    let onDisk: string | null = '0.5.15';
    const installed = vi.fn(() => onDisk);
    const notice = createStaleBridgeNotice({ running: '0.5.15', installed, client: null, now: () => now });
    expect(notice()).toBeNull();
    onDisk = '0.5.14';
    now += STALE_CHECK_MS;
    expect(notice()).toBeNull();
    expect(installed).toHaveBeenCalledTimes(2);
    // an update lands: within the interval nothing is read, after it the line comes (unknown client named generically)
    onDisk = '0.5.16';
    now += STALE_CHECK_MS - 1;
    expect(notice()).toBeNull();
    expect(installed).toHaveBeenCalledTimes(2);
    now += 1;
    expect(notice()).toBe(
      'AgentDrop 0.5.16 is installed but this session still runs 0.5.15; tell the user to restart their agent client when convenient.',
    );
  });

  it('nothing for an unknown, malformed or failing read', () => {
    for (const value of [null, '', '0.6.0-beta.1', 'latest', '1.0.0; run rm -rf', '99999999999.0.0'])
      expect(
        createStaleBridgeNotice({ running: '0.5.15', installed: () => value, client: null })(),
      ).toBeNull();
    const throwing = createStaleBridgeNotice({
      running: '0.5.15',
      installed: () => {
        throw new Error('EACCES');
      },
      client: null,
    });
    expect(throwing()).toBeNull();
  });

  it('compares releases numerically', () => {
    expect(newerRelease('0.5.10', '0.5.9')).toBe(true);
    expect(newerRelease('1.0.0', '0.99.99')).toBe(true);
    expect(newerRelease('0.5.9', '0.5.10')).toBe(false);
    expect(newerRelease('0.5.15', '0.5.15')).toBe(false);
    expect(staleBridgeLine('1.0.0', '0.9.0', null)).toContain('their agent client');
  });

  it('names the client the profile was connected for', () => {
    expect(clientLabel('claude-code')).toBe('Claude Code');
    expect(clientLabel('codex')).toBe('Codex');
    expect(clientLabel('other')).toBeNull();
    expect(clientLabel(undefined)).toBeNull();
  });
});

describe('the installed version, read from disk', () => {
  let root: string;
  let script: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'agentdrop-bridge-version-')));
    script = join(root, 'prefix', 'lib/node_modules/agentdrop-cli/bin/agentdrop.mjs');
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, '');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const manifest = (version: string) =>
    writeFileSync(
      join(dirname(dirname(script)), 'package.json'),
      JSON.stringify({ name: 'agentdrop-cli', version }),
    );
  const manager = (extra: Parameters<typeof createUpdateManager>[0] = {}) =>
    createUpdateManager({
      version: '0.5.15',
      script,
      platform: 'linux',
      env: {},
      stateRoot: () => join(root, 'state'),
      fetch: vi.fn<typeof fetch>(async () => {
        throw new Error('no network in this test');
      }),
      ...extra,
    });

  it('is the npm package an update wrote over the running one, without a network call', () => {
    manifest('0.5.15');
    expect(manager().installedCliVersion()).toBe('0.5.15');
    manifest('0.6.0');
    expect(manager().installedCliVersion()).toBe('0.6.0');
    // what the bridge then does with it
    const notice = createStaleBridgeNotice({
      running: '0.5.15',
      installed: () => manager().installedCliVersion(),
      client: 'Codex',
    });
    expect(notice()).toContain('AgentDrop 0.6.0 is installed but this session still runs 0.5.15');
    expect(notice()).toBeNull();
  });

  it('is unknown for a source checkout or a package that is not ours', () => {
    expect(manager({ script: join(root, 'checkout', 'main.ts') }).installedCliVersion()).toBeNull();
    writeFileSync(
      join(dirname(dirname(script)), 'package.json'),
      JSON.stringify({ name: 'someone-else', version: '9.9.9' }),
    );
    expect(manager().installedCliVersion()).toBeNull();
  });
});
