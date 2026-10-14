import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AgentDropError, type ApiClient } from '@agentdrop/client';
import type {
  DownloadFileInput,
  DownloadFileResult,
  UploadFileInput,
  UploadFileResult,
} from '@agentdrop/contracts';
import type { BridgeLogger, FileToolHandlers } from '@agentdrop/mcp';
import { openAllowedFile, reviewHints, safeFilename } from '@agentdrop/security';
import { downloadsDir } from './paths.js';
import type { ProfileFile } from './store.js';

/**
 * Local file tools. upload_file: allowlist + sensitive-file rules + fd-level checks, then a streaming upload.
 * download_file: authorized through the drop, written under the controlled downloads directory with a sanitized
 * name, never overwriting, never executing or extracting. `agentdrop space` uses the same two functions.
 */
export function createFileTools(opts: {
  client: ApiClient;
  profile: ProfileFile;
  logger: BridgeLogger;
}): FileToolHandlers | undefined {
  if (opts.profile.toolset !== 'standard') return undefined;
  const { client, profile, logger } = opts;
  let limitsCache: { max_file_bytes: number } | null = null;
  const limits = async () => {
    if (limitsCache) return limitsCache;
    const id = await client.identity();
    limitsCache = id.limits;
    return limitsCache;
  };

  return {
    async uploadFile(input: UploadFileInput): Promise<UploadFileResult> {
      const lim = await limits();
      let uploaded: UploadFileResult;
      try {
        uploaded = await uploadLocalFile(client, {
          path: input.path,
          allowedDirs: profile.allowed_dirs,
          maxBytes: lim.max_file_bytes,
          ...(input.display_name ? { displayName: input.display_name } : {}),
        });
      } catch (err) {
        throw withAllowCommand(err, profile.profile);
      }
      logger.info('uploaded attachment', {
        attachment_id: uploaded.attachment_id,
        bytes: uploaded.byte_size,
      });
      return uploaded;
    },

    async downloadFile(input: DownloadFileInput): Promise<DownloadFileResult> {
      try {
        const { max_file_bytes: maxBytes } = await limits();
        const saved = await downloadAttachment(client, input, {
          dir: join(downloadsDir(), input.drop_id),
          maxBytes,
          existing: 'suffix',
        });
        return {
          attachment_id: input.attachment_id,
          saved_path: saved.saved_path,
          byte_size: saved.byte_size,
          sha256: saved.sha256,
          sha256_verified: true,
        };
      } catch (err) {
        logger.warn('download failed', { attachment_id: input.attachment_id, outcome: 'failed' });
        // A code the server named (FILE_REMOVED, NOT_FOUND, …) reaches the model with its next_action; anything
        // local is reported without its message, which may hold a path.
        if (err instanceof AgentDropError) throw err;
        throw new AgentDropError('UPSTREAM_UNAVAILABLE', 'download failed; no unverified file was saved');
      }
    },
  };
}

/**
 * A refused path the person can fix by allowing its folder gets the exact command for this profile, so the model
 * can tell the user what to run in a terminal. Sensitive files cannot be allowed and get nothing; the folder
 * itself is never named here (the model knows the path it asked for).
 */
export function withAllowCommand(err: unknown, profileName: string): unknown {
  if (!(err instanceof AgentDropError) || err.code !== 'PATH_NOT_ALLOWED') return err;
  if (!/outside the allowed|no allowed directories/.test(err.message)) return err;
  return new AgentDropError('PATH_NOT_ALLOWED', err.message, {
    ...err.details,
    allow_command: `agentdrop allow-dir add <folder> --profile ${profileName}`,
  });
}

/**
 * upload_file's path policy (allowlist, sensitive-file rules, fd-level checks), then a streaming upload. Shared by
 * the MCP tool and `agentdrop space put`, so a person's terminal and an agent obey the same rules.
 */
export async function uploadLocalFile(
  client: ApiClient,
  opts: { path: string; allowedDirs: string[]; maxBytes: number; displayName?: string },
): Promise<UploadFileResult> {
  const check = openAllowedFile(opts.path, opts.allowedDirs, opts.maxBytes);
  try {
    const hints = reviewHints(check.fd, check.size, check.baseName);
    const displayName = safeFilename(opts.displayName ?? check.baseName);
    const binary = hints.some((h) => h.startsWith('binary'));
    const stream = createReadStream('', { fd: check.fd, autoClose: false });
    const res = await client.requestRaw('POST', '/v1/h/attachments', {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(check.size),
        'x-agentdrop-filename': encodeURIComponent(displayName),
        'x-agentdrop-review-hints': JSON.stringify(hints),
        'x-agentdrop-binary': binary ? '1' : '0',
      },
      rawBody: Readable.toWeb(stream) as unknown as ReadableStream,
      timeoutMs: 10 * 60 * 1000,
      duplex: 'half',
    });
    const body = (await res.json()) as UploadFileResult & { status: string };
    return {
      attachment_id: body.attachment_id,
      safe_name: body.safe_name,
      content_type: body.content_type,
      byte_size: body.byte_size,
      sha256: body.sha256,
      review_hints: hints,
    };
  } finally {
    closeSync(check.fd);
  }
}

/** `suffix` appends -1, -2, …; `refuse` fails with FileExistsFailure; `replace` swaps the file in atomically. */
export type ExistingFilePolicy = 'suffix' | 'refuse' | 'replace';

/** The target name is taken; nothing was written. */
export class FileExistsFailure extends Error {
  constructor(readonly fileName: string) {
    super('a file with that name already exists; nothing was written');
  }
}

/**
 * Downloads one attachment, authorized through its drop, into `dir` with a sanitized name: streamed into a private
 * temporary directory, size-capped, sha256-verified, then published in one step. Never executes or extracts.
 * Errors the server named (FILE_REMOVED, NOT_FOUND, …) pass through as they are; anything local becomes a
 * path-free UPSTREAM_UNAVAILABLE, except FileExistsFailure.
 */
export async function downloadAttachment(
  client: ApiClient,
  input: DownloadFileInput,
  opts: { dir: string; maxBytes: number; existing: ExistingFilePolicy; name?: string },
): Promise<{ saved_path: string; byte_size: number; sha256: string }> {
  let tempDir: string | undefined;
  try {
    const { maxBytes } = opts;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new DownloadFailure('server download limit is unavailable');
    }
    const res = await client.requestRaw(
      'GET',
      `/v1/h/drops/${encodeURIComponent(input.drop_id)}/attachments/${encodeURIComponent(input.attachment_id)}`,
      { timeoutMs: 10 * 60 * 1000 },
    );
    if (!res.body) throw new DownloadFailure('empty download body');
    const expectedSha = res.headers.get('x-agentdrop-sha256') ?? '';
    const disposition = res.headers.get('content-disposition') ?? '';
    const m = /filename\*=UTF-8''([^;]+)/.exec(disposition);
    const name = safeFilename(opts.name ?? (m?.[1] ? decodeURIComponent(m[1]) : input.attachment_id));
    const dir = opts.dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A private, uniquely allocated directory belongs to this download only.
    tempDir = mkdtempSync(join(dir, '.download-'));
    const tmp = join(tempDir, 'content.part');
    const metered = downloadMeter(maxBytes);
    await pipeline(
      Readable.fromWeb(res.body as never),
      metered.stream,
      createWriteStream(tmp, { flags: 'wx', mode: 0o600 }),
    );
    const { bytes, sha256 } = metered.result();
    if (expectedSha.length !== 64 || expectedSha !== sha256) {
      throw new DownloadFailure('downloaded bytes do not match the expected sha256; nothing was saved');
    }
    const target = publishDownload(tmp, dir, name, opts.existing);
    return { saved_path: target, byte_size: bytes, sha256 };
  } catch (err) {
    if (err instanceof AgentDropError || err instanceof FileExistsFailure) throw err;
    throw new AgentDropError(
      'UPSTREAM_UNAVAILABLE',
      err instanceof DownloadFailure ? err.message : 'download failed; no unverified file was saved',
    );
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* a leftover private temporary directory holds no published content */
      }
    }
  }
}

/** Never overwrites unless asked to: appends -1, -2, … before the extension, or refuses. */
function publishDownload(tmp: string, dir: string, name: string, existing: ExistingFilePolicy): string {
  if (existing === 'replace') {
    const target = join(dir, name);
    // rename swaps the name in one step and replaces a symlink itself, never the file it points to
    renameSync(tmp, target);
    return target;
  }
  if (existing === 'refuse') {
    const target = join(dir, name);
    try {
      linkSync(tmp, target);
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new FileExistsFailure(name);
      throw err;
    }
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 0; i < 10_000; i++) {
    const candidate = join(dir, i === 0 ? name : `${stem}-${i}${ext}`);
    try {
      // Hard-link creation is atomic and fails if another process already owns the name.
      linkSync(tmp, candidate);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new DownloadFailure('could not allocate a download filename');
}

class DownloadFailure extends Error {}

/** Client-local stream verification; no server storage implementations enter the CLI bundle. */
function downloadMeter(maxBytes: number) {
  let bytes = 0;
  const hash = createHash('sha256');
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (chunk.length > maxBytes - bytes) {
        callback(new DownloadFailure('download exceeds the server file size limit; nothing was saved'));
        return;
      }
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { stream, result: () => ({ bytes, sha256: hash.digest('hex') }) };
}
