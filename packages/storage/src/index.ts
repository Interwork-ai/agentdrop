import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { finished, type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class StorageLimitError extends Error {
  constructor(readonly limit: number) {
    super(`upload exceeds ${limit} bytes`);
    this.name = 'StorageLimitError';
  }
}

export interface PutResult {
  bytes: number;
  sha256: string;
}

/**
 * One contract for the dev filesystem backend and the production private bucket. Keys are server generated
 * (random), never derived from user names or content hashes, so nothing is guessable across users.
 */
export interface StorageProvider {
  readonly kind: 'fs' | 's3';
  newKey(prefix: 'staging' | 'attachments'): string;
  /** Streams `body` into `key`, aborting (and cleaning up) once more than `maxBytes` arrive. */
  put(key: string, body: Readable, maxBytes: number): Promise<PutResult>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Moves a staged object to its final key (same bucket/dir); falls back to copy+delete when needed. */
  promote(fromKey: string, toKey: string): Promise<void>;
  ping(): Promise<void>;
}

export function randomKey(prefix: string): string {
  const now = new Date();
  const day = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  return `${prefix}/${day}/${randomBytes(16).toString('hex')}`;
}

/** Counts bytes and hashes while passing data through; throws StorageLimitError past `maxBytes`. */
export function meter(maxBytes: number) {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        cb(new StorageLimitError(maxBytes));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  return { stream, result: () => ({ bytes, sha256: hash.digest('hex') }) };
}

/* ------------------------------------------------------------------ filesystem (development only) */
export class FsStorage implements StorageProvider {
  readonly kind = 'fs' as const;
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private pathOf(key: string): string {
    if (!/^[a-z]+\/\d{8}\/[a-f0-9]{32}$/.test(key)) throw new Error('invalid storage key');
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return p;
  }
  newKey(prefix: 'staging' | 'attachments'): string {
    return randomKey(prefix);
  }
  async put(key: string, body: Readable, maxBytes: number): Promise<PutResult> {
    const target = this.pathOf(key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.part`;
    const m = meter(maxBytes);
    try {
      await pipeline(body, m.stream, createWriteStream(tmp, { mode: 0o600, flags: 'wx' }));
      await rename(tmp, target);
      return m.result();
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
  async get(key: string): Promise<Readable> {
    const p = this.pathOf(key);
    await access(p);
    return createReadStream(p);
  }
  async delete(key: string): Promise<void> {
    await unlink(this.pathOf(key)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathOf(key));
      return true;
    } catch {
      return false;
    }
  }
  async promote(fromKey: string, toKey: string): Promise<void> {
    const to = this.pathOf(toKey);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await rename(this.pathOf(fromKey), to);
  }
  async ping(): Promise<void> {
    await mkdir(join(this.root, 'staging'), { recursive: true, mode: 0o700 });
  }
}

/* ------------------------------------------------------------------ S3-compatible private bucket (production) */
export interface S3StorageOptions {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
  forcePathStyle?: boolean | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
}

export class S3Storage implements StorageProvider {
  readonly kind = 's3' as const;
  private client: import('@aws-sdk/client-s3').S3Client | null = null;
  constructor(private readonly opts: S3StorageOptions) {}

  private async s3() {
    if (this.client) return this.client;
    const { S3Client } = await import('@aws-sdk/client-s3');
    this.client = new S3Client({
      region: this.opts.region,
      ...(this.opts.endpoint ? { endpoint: this.opts.endpoint } : {}),
      ...(this.opts.forcePathStyle !== undefined ? { forcePathStyle: this.opts.forcePathStyle } : {}),
      ...(this.opts.accessKeyId && this.opts.secretAccessKey
        ? { credentials: { accessKeyId: this.opts.accessKeyId, secretAccessKey: this.opts.secretAccessKey } }
        : {}),
    });
    return this.client;
  }
  newKey(prefix: 'staging' | 'attachments'): string {
    return randomKey(prefix);
  }
  async put(key: string, body: Readable, maxBytes: number): Promise<PutResult> {
    const { Upload } = await import('@aws-sdk/lib-storage');
    const client = await this.s3();
    const m = meter(maxBytes);
    const metered = body.pipe(m.stream);
    // A source error or premature close (client abort) must fail the upload, not leave it waiting for more parts.
    finished(body, (err) => {
      if (err) metered.destroy(err);
    });
    const upload = new Upload({
      client,
      params: { Bucket: this.opts.bucket, Key: key, Body: metered, ContentType: 'application/octet-stream' },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    try {
      await upload.done();
    } catch (err) {
      await this.delete(key).catch(() => undefined);
      throw err;
    }
    return m.result();
  }
  async get(key: string): Promise<Readable> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.s3();
    const res = await client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    if (!res.Body) throw new Error('empty object body');
    return res.Body as Readable;
  }
  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.s3();
    await client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }
  async exists(key: string): Promise<boolean> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.s3();
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
  async promote(fromKey: string, toKey: string): Promise<void> {
    const { CopyObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.s3();
    await client.send(
      new CopyObjectCommand({
        Bucket: this.opts.bucket,
        CopySource: `${this.opts.bucket}/${fromKey}`,
        Key: toKey,
      }),
    );
    await this.delete(fromKey);
  }
  async ping(): Promise<void> {
    const { HeadBucketCommand } = await import('@aws-sdk/client-s3');
    const client = await this.s3();
    await client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
  }
}

export function sha256OfStream(stream: Readable): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    stream.on('data', (c: Buffer) => h.update(c));
    stream.on('end', () => res(h.digest('hex')));
    stream.on('error', rej);
  });
}
