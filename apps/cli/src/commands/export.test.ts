import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeLanguage } from '../locale.js';
import {
  parseExportDate,
  parseExportRange,
  readVerifiedExport,
  resolveExportOutPath,
  withOutput,
} from './export.js';

let dir: string;
const savedConfigDir = process.env.AGENTDROP_CONFIG_DIR;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentdrop-export-test-'));
  // the person's language lives in the config directory: a private one per test, English unless a test says zh
  process.env.AGENTDROP_CONFIG_DIR = join(dir, 'config');
});
afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.AGENTDROP_CONFIG_DIR;
  else process.env.AGENTDROP_CONFIG_DIR = savedConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

function ndjson(lines: object[]): ReadableStream {
  const body = lines.map((l) => `${JSON.stringify(l)}\n`).join('');
  return new Response(body).body as ReadableStream;
}

function sample(count: number) {
  const records = Array.from({ length: count }, (_, i) => ({
    record: 'drop' as const,
    drop_id: `00000000-0000-4000-8000-00000000000${i}`,
    created_at: '2026-06-10T12:00:00.000Z',
    direction: 'out' as const,
    author: {
      user_id: '11111111-1111-4111-8111-111111111111',
      handle: 'alice',
      display_label: 'Alice',
      public_name: null,
    },
    title: `t${i}`,
    preview: `p${i}`,
    body_chars: 2,
    sources: ['direct' as const],
    group_ids: [],
    attachments: [],
  }));
  const digest = createHash('sha256');
  for (const r of records) digest.update(`${JSON.stringify(r)}\n`);
  const header = {
    record: 'header' as const,
    format_version: 1 as const,
    generated_at: '2026-06-10T12:00:00.000Z',
    scope: 'peer' as const,
    peer_user_id: '11111111-1111-4111-8111-111111111111',
    peer_handle: 'wang',
    group_id: null,
    group_slug: null,
    since: '2026-06-01T00:00:00.000Z',
    until: '2026-07-01T00:00:00.000Z',
    count,
    include_body: false,
    include_group_history: false,
    endpoint_scope: 'account' as const,
    notes: {
      ordered_by: 'drop.created_at,drop.id' as const,
      range: '[since, until)' as const,
      excludes_revoked: true as const,
      excludes_expired: true as const,
      excludes_group_traffic: true,
    },
  };
  const trailer = { record: 'trailer' as const, count, sha256: digest.digest('hex') };
  return { header, records, trailer };
}

/** A sink that only counts, so these tests exercise the verification rather than a format. */
function countingSink() {
  const seen: string[] = [];
  return {
    seen,
    sink: {
      header: async () => {},
      drop: async (_r: unknown, line: string) => {
        seen.push(line);
      },
      trailer: async () => {},
      verified: async () => {},
    },
  };
}

describe('agentdrop export: dates', () => {
  it('reads a bare day as UTC midnight so a range means the same thing in every timezone', () => {
    expect(parseExportDate('2026-09-01', '--since')).toBe('2026-09-01T00:00:00.000Z');
  });

  it('keeps an explicit timestamp', () => {
    expect(parseExportDate('2026-09-01T08:30:00Z', '--since')).toBe('2026-09-01T08:30:00.000Z');
  });

  it('refuses nonsense and an inverted range instead of exporting something unintended', () => {
    expect(() => parseExportDate('not-a-date', '--since')).toThrow();
    expect(() => parseExportRange('2026-09-10', '2026-09-01')).toThrow();
  });
});

describe('agentdrop export: --out is a path an agent could choose', () => {
  it('refuses sensitive targets', () => {
    // The CLI is reachable from a shell, so an agent can pass this; download_file never lets a caller name a path.
    for (const bad of [join(dir, '.ssh', 'authorized_keys'), join(dir, '.env')])
      expect(() => resolveExportOutPath(bad), bad).toThrow();
  });

  it('resolves before judging, so .. cannot walk into a refused location', () => {
    expect(() => resolveExportOutPath(join(dir, 'sub', '..', '.ssh', 'id_rsa'))).toThrow();
  });

  it('allows an ordinary path', () => {
    expect(resolveExportOutPath(join(dir, 'export.jsonl'))).toContain('export.jsonl');
  });
});

describe('agentdrop export: a partial download must never become a file', () => {
  it('accepts a stream whose trailer matches', async () => {
    const { header, records, trailer } = sample(3);
    const { sink, seen } = countingSink();
    const result = await readVerifiedExport(ndjson([header, ...records, trailer]), sink);
    expect(seen).toHaveLength(3);
    expect(result.trailer.count).toBe(3);
  });

  it('rejects a stream that stops before the trailer', async () => {
    const { header, records } = sample(3);
    const { sink } = countingSink();
    await expect(readVerifiedExport(ndjson([header, ...records]), sink)).rejects.toThrow();
  });

  it('rejects a trailer whose count or digest disagrees with what arrived', async () => {
    const { header, records, trailer } = sample(3);
    const { sink } = countingSink();
    await expect(
      readVerifiedExport(ndjson([header, ...records, { ...trailer, count: 2 }]), sink),
    ).rejects.toThrow();
    await expect(
      readVerifiedExport(ndjson([header, ...records, { ...trailer, sha256: 'f'.repeat(64) }]), sink),
    ).rejects.toThrow();
  });

  it('accepts drops the server left out mid-stream only when the trailer accounts for them', async () => {
    const { header, records, trailer } = sample(3);
    const { sink } = countingSink();
    const planned = { ...header, count: 4 };
    const result = await readVerifiedExport(ndjson([planned, ...records, { ...trailer, omitted: 1 }]), sink);
    expect(result.count).toBe(3);
    await expect(readVerifiedExport(ndjson([planned, ...records, trailer]), sink)).rejects.toThrow();
  });

  it('writes no file at all when the run fails, and leaves no temp directory behind', async () => {
    const target = join(dir, 'audit.jsonl');
    await expect(
      withOutput(target, async () => {
        throw new Error('stream died halfway');
      }),
    ).rejects.toThrow('stream died halfway');
    expect(existsSync(target)).toBe(false);
    // A leftover .part directory would be the next run's confusing failure.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('publishes atomically on success and refuses to overwrite an existing file', async () => {
    const target = join(dir, 'audit.jsonl');
    await withOutput(target, async (write) => {
      await write('one\n');
      await write('two\n');
    });
    expect(readFileSync(target, 'utf8')).toBe('one\ntwo\n');
    expect(readdirSync(dir)).toEqual(['audit.jsonl']);

    writeFileSync(join(dir, 'taken.jsonl'), 'do not clobber');
    await expect(withOutput(join(dir, 'taken.jsonl'), async (write) => write('x\n'))).rejects.toThrow();
    expect(readFileSync(join(dir, 'taken.jsonl'), 'utf8')).toBe('do not clobber');
  });
});

describe('agentdrop export: the person reads it in their language', () => {
  it('says what is wrong in English by default and in Chinese after choosing it', async () => {
    expect(() => parseExportRange('2026-09-10', '2026-09-01')).toThrow('--until must be later than --since');
    const { header, records } = sample(2);
    const { sink } = countingSink();
    await expect(readVerifiedExport(ndjson([header, ...records]), sink)).rejects.toThrow(
      'The export has no trailer',
    );
    writeLanguage('zh');
    expect(() => parseExportRange('2026-09-10', '2026-09-01')).toThrow('--until 必须晚于 --since');
    await expect(readVerifiedExport(ndjson([header, ...records]), countingSink().sink)).rejects.toThrow(
      '导出没有 trailer',
    );
  });
});
