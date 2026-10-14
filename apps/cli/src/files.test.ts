import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AgentDropError, type ApiClient } from '@agentdrop/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileTools, downloadAttachment, FileExistsFailure } from './files.js';
import type { ProfileFile } from './store.js';

const input = {
  drop_id: '11111111-1111-4111-8111-111111111111',
  attachment_id: '22222222-2222-4222-8222-222222222222',
};
const profile = { toolset: 'standard', allowed_dirs: [] } as unknown as ProfileFile;

function response(content: string, sha = createHash('sha256').update(content).digest('hex')) {
  const stream = Readable.from(
    (async function* () {
      for (const chunk of Buffer.from(content)) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        yield Buffer.from([chunk]);
      }
    })(),
  );
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { 'x-agentdrop-sha256': sha, 'content-disposition': "attachment; filename*=UTF-8''result.txt" },
  });
}

describe('file download: verified streams and atomic publication', () => {
  let dir: string;
  let destination: string;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-files-'));
    vi.stubEnv('AGENTDROP_DATA_DIR', dir);
    destination = join(dir, 'downloads', input.drop_id);
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(maxBytes = 1024, getResponse = () => response('result')) {
    const identity = vi.fn(async () => ({ limits: { max_file_bytes: maxBytes } }));
    const requestRaw = vi.fn(async () => getResponse());
    const client = { identity, requestRaw } as unknown as ApiClient;
    const tools = createFileTools({ client, profile, logger });
    if (!tools) throw new Error('missing standard file tools');
    return { ...tools, identity, requestRaw };
  }

  it('downloads the same attachment concurrently into distinct complete files', async () => {
    const tools = setup();
    const results = await Promise.all(Array.from({ length: 12 }, () => tools.downloadFile(input)));
    expect(new Set(results.map((r) => r.saved_path)).size).toBe(12);
    expect(readdirSync(destination)).toHaveLength(12);
    for (const result of results) {
      expect(readFileSync(result.saved_path, 'utf8')).toBe('result');
      expect(result.sha256_verified).toBe(true);
      expect(statSync(result.saved_path).mode & 0o777).toBe(0o600);
    }
  });

  it('preserves existing filenames and appends a suffix', async () => {
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'result.txt'), 'original');
    writeFileSync(join(destination, 'result-1.txt'), 'also original');
    const result = await setup().downloadFile(input);
    expect(result.saved_path).toBe(join(destination, 'result-2.txt'));
    expect(readFileSync(join(destination, 'result.txt'), 'utf8')).toBe('original');
    expect(readFileSync(join(destination, 'result-1.txt'), 'utf8')).toBe('also original');
  });

  it('cleans a failed hash without touching another in-flight download', async () => {
    let count = 0;
    const tools = setup(1024, () =>
      ++count === 1 ? response('bad', '0'.repeat(64)) : response('valid result'),
    );
    const results = await Promise.allSettled([tools.downloadFile(input), tools.downloadFile(input)]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]?.status).toBe('fulfilled');
    expect(readdirSync(destination)).toEqual(['result.txt']);
    expect(readFileSync(join(destination, 'result.txt'), 'utf8')).toBe('valid result');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(dir);
  });

  it('accepts exactly the server byte limit, including multibyte content', async () => {
    const result = await setup(3, () => response('好')).downloadFile(input);
    expect(result.byte_size).toBe(3);
    expect(readFileSync(result.saved_path, 'utf8')).toBe('好');
  });

  it('rejects one byte over the server limit and cleans all partial content', async () => {
    await expect(setup(2, () => response('好')).downloadFile(input)).rejects.toThrow('file size limit');
    expect(readdirSync(destination)).toEqual([]);
  });

  it('fails closed if identity cannot provide limits and does not expose its error', async () => {
    const tools = setup();
    tools.identity.mockRejectedValueOnce(new Error('secret=/private/token'));
    await expect(tools.downloadFile(input)).rejects.toThrow('download failed');
    expect(tools.requestRaw).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])('rejects invalid server limit %s', async (limit) => {
    const tools = setup(limit);
    await expect(tools.downloadFile(input)).rejects.toThrow('limit is unavailable');
    expect(tools.requestRaw).not.toHaveBeenCalled();
  });

  it('sanitizes filesystem failures rather than returning local paths', async () => {
    writeFileSync(join(dir, 'downloads'), 'not a directory');
    const error = await setup()
      .downloadFile(input)
      .catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(dir);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(dir);
  });
});

describe('file download: what the server says and existing files', () => {
  let dir: string;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-files-'));
    vi.stubEnv('AGENTDROP_DATA_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes FILE_REMOVED through to the model instead of reporting an outage', async () => {
    const client = {
      identity: async () => ({ limits: { max_file_bytes: 1024 } }),
      requestRaw: async () => {
        throw new AgentDropError('FILE_REMOVED');
      },
    } as unknown as ApiClient;
    const tools = createFileTools({ client, profile, logger });
    await expect(tools?.downloadFile(input)).rejects.toMatchObject({ code: 'FILE_REMOVED' });
  });

  it('refuses or replaces an existing name when asked to, never touching it otherwise', async () => {
    const client = { requestRaw: async () => response('fresh') } as unknown as ApiClient;
    const target = join(dir, 'pulled');
    mkdirSync(target);
    writeFileSync(join(target, 'result.txt'), 'mine');
    await expect(
      downloadAttachment(client, input, { dir: target, maxBytes: 1024, existing: 'refuse' }),
    ).rejects.toBeInstanceOf(FileExistsFailure);
    expect(readFileSync(join(target, 'result.txt'), 'utf8')).toBe('mine');
    expect(readdirSync(target)).toEqual(['result.txt']);
    const replaced = await downloadAttachment(client, input, {
      dir: target,
      maxBytes: 1024,
      existing: 'replace',
    });
    expect(replaced.saved_path).toBe(join(target, 'result.txt'));
    expect(readFileSync(join(target, 'result.txt'), 'utf8')).toBe('fresh');
    expect(readdirSync(target)).toEqual(['result.txt']);
  });
});

/* A refused upload the person can fix: the model is handed the exact command to tell them, never a workaround. */
describe('file upload: a folder that is not allowed yet', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-upload-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const tools = (allowed: string[]) => {
    const client = {
      identity: vi.fn(async () => ({ limits: { max_file_bytes: 1024 } })),
      requestRaw: vi.fn(),
    } as unknown as ApiClient;
    const p = { profile: 'codex', toolset: 'standard', allowed_dirs: allowed } as unknown as ProfileFile;
    const t = createFileTools({
      client,
      profile: p,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    if (!t) throw new Error('missing standard file tools');
    return t;
  };

  it('names the allow-dir command for this profile when the folder is outside or none is allowed', async () => {
    const file = join(dir, 'results.csv');
    writeFileSync(file, 'a,b\n');
    for (const allowed of [[], [join(dir, 'elsewhere')]]) {
      mkdirSync(join(dir, 'elsewhere'), { recursive: true });
      const err = await tools(allowed)
        .uploadFile({ path: file })
        .catch((e) => e);
      expect(err).toBeInstanceOf(AgentDropError);
      expect(err.code).toBe('PATH_NOT_ALLOWED');
      expect(err.details.allow_command).toBe('agentdrop allow-dir add <folder> --profile codex');
      expect(err.toApiError().next_action).toMatch(/tell the user to run `agentdrop allow-dir add <folder>`/);
    }
  });

  it('offers no command for a sensitive file, which cannot be allowed', async () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'SECRET=x\n');
    const err = await tools([dir])
      .uploadFile({ path: file })
      .catch((e) => e);
    expect(err.code).toBe('PATH_NOT_ALLOWED');
    expect(err.details?.allow_command).toBeUndefined();
  });
});
