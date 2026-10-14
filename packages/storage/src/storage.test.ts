import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsStorage, StorageLimitError, sha256OfStream } from './index.js';

describe('FsStorage', () => {
  let dir: string;
  let fs: FsStorage;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-storage-'));
    fs = new FsStorage(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('streams, hashes and promotes objects; keys are random and unguessable from names', async () => {
    const data = Buffer.from('hello agentdrop '.repeat(1000));
    const key = fs.newKey('staging');
    expect(key).toMatch(/^staging\/\d{8}\/[a-f0-9]{32}$/);
    const res = await fs.put(key, Readable.from([data]), 1_000_000);
    expect(res.bytes).toBe(data.length);
    expect(res.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    const final = fs.newKey('attachments');
    await fs.promote(key, final);
    expect(await fs.exists(key)).toBe(false);
    expect(await fs.exists(final)).toBe(true);
    expect(await sha256OfStream(await fs.get(final))).toBe(res.sha256);
    await fs.delete(final);
    expect(await fs.exists(final)).toBe(false);
  });

  it('aborts past the byte limit and leaves no partial file behind', async () => {
    const key = fs.newKey('staging');
    const big = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]);
    await expect(fs.put(key, big, 1000)).rejects.toBeInstanceOf(StorageLimitError);
    expect(await fs.exists(key)).toBe(false);
  });

  it('rejects and removes the partial file when the source is aborted mid-stream', async () => {
    const key = fs.newKey('staging');
    // aborts once the upload is reading it, never before: an error with nobody listening yet is an uncaught
    // exception that fails the whole test run on a slow machine
    let reads = 0;
    const aborted = new Readable({
      read() {
        reads += 1;
        if (reads === 1) this.push(Buffer.alloc(100));
        else setImmediate(() => this.destroy(new Error('aborted')));
      },
    });
    await expect(fs.put(key, aborted, 1000)).rejects.toThrow(/aborted/);
    expect(await fs.exists(key)).toBe(false);
    expect(await fs.exists(`${key}.part`)).toBe(false);
  });

  it('rejects malformed keys (no path traversal through keys)', async () => {
    await expect(fs.get('../../etc/passwd')).rejects.toThrow(/invalid storage key/);
    await expect(fs.get('staging/20260101/../x')).rejects.toThrow(/invalid storage key/);
  });
});
