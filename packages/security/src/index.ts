import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { AgentDropError } from '@agentdrop/contracts';

/* ------------------------------------------------------------------ path policy */

/** Files that must never leave a machine through an agent, regardless of the allowlist. */
const SENSITIVE_DIRS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.gcloud',
  '.azure',
  '.kube',
  '.docker',
  '.agentdrop',
  'agentdrop',
];
const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'known_hosts',
  'authorized_keys',
  'device.json',
  'auth.json',
  'token',
  'tokens.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
]);
const SENSITIVE_PATTERNS = [
  /^\.env\./i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i,
  /^id_[a-z0-9]+$/i,
  /\.token$/i,
];

export interface PathCheck {
  realPath: string;
  fd: number;
  size: number;
  baseName: string;
}

export function isSensitivePath(realPath: string): boolean {
  const parts = realPath.split(sep).filter(Boolean);
  const base = basename(realPath);
  if (SENSITIVE_BASENAMES.has(base.toLowerCase())) return true;
  if (SENSITIVE_PATTERNS.some((p) => p.test(base))) return true;
  return parts.slice(0, -1).some((seg) => SENSITIVE_DIRS.includes(seg.toLowerCase()));
}

/**
 * Validates a user-supplied path against the explicit allowlist, then opens the *real* file without following a
 * final symlink and re-checks type and size on the descriptor (no directory uploads, no swap after check).
 * Returns an open fd; the caller must close it.
 */
export function openAllowedFile(
  rawPath: string,
  allowedDirs: readonly string[],
  maxBytes: number,
): PathCheck {
  if (allowedDirs.length === 0)
    throw new AgentDropError('PATH_NOT_ALLOWED', 'no allowed directories configured for this profile');
  if (!rawPath || rawPath.includes('\0')) throw new AgentDropError('PATH_NOT_ALLOWED', 'invalid path');
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(rawPath);
  let realPath: string;
  try {
    realPath = realpathSync.native(absolute);
  } catch {
    throw new AgentDropError('PATH_NOT_ALLOWED', 'file does not exist or is not readable');
  }
  const roots = allowedDirs
    .map((d) => {
      try {
        return realpathSync.native(d);
      } catch {
        return null;
      }
    })
    .filter((d): d is string => d !== null);
  if (
    !roots.some((root) => realPath === root || realPath.startsWith(root.endsWith(sep) ? root : root + sep))
  ) {
    throw new AgentDropError('PATH_NOT_ALLOWED', 'path is outside the allowed directories');
  }
  if (isSensitivePath(realPath))
    throw new AgentDropError('PATH_NOT_ALLOWED', 'path matches a sensitive-file rule');
  let fd: number;
  try {
    // A FIFO must reach the descriptor type check without waiting for a writer.
    fd = openSync(realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new AgentDropError('PATH_NOT_ALLOWED', 'file could not be opened');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new AgentDropError('PATH_NOT_ALLOWED', 'only regular files can be uploaded');
    // check → open → re-check: the descriptor must still be the file at a path inside the allowlist. This narrows
    // (not eliminates) the window in which an ancestor directory is swapped for a symlink; see docs/STATUS.md.
    let again: string;
    try {
      again = realpathSync.native(absolute);
    } catch {
      throw new AgentDropError('PATH_NOT_ALLOWED', 'file changed during validation');
    }
    const st2 = statSync(again);
    if (
      again !== realPath ||
      st2.dev !== st.dev ||
      st2.ino !== st.ino ||
      !roots.some((root) => again === root || again.startsWith(root.endsWith(sep) ? root : root + sep))
    ) {
      throw new AgentDropError('PATH_NOT_ALLOWED', 'file changed during validation');
    }
    if (st.size > maxBytes)
      throw new AgentDropError('FILE_TOO_LARGE', undefined, { size: st.size, limit: maxBytes });
    return { realPath, fd, size: st.size, baseName: basename(realPath) };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/* ------------------------------------------------------------------ content risk hints */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'contains a private key block'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'contains what looks like an AWS access key id'],
  [/\bghp_[A-Za-z0-9]{30,}\b/, 'contains what looks like a GitHub token'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, 'contains what looks like an API secret key'],
  [/\badh_[A-Za-z0-9_-]{30,}\b/, 'contains what looks like an AgentDrop credential'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'contains what looks like a Slack token'],
  [/password\s*[=:]\s*\S{6,}/i, 'contains a password assignment'],
];

const ARCHIVE_EXT = new Set(['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.xz', '.bz2', '.dmg', '.iso']);
const EXEC_EXT = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.app',
  '.bat',
  '.cmd',
  '.ps1',
  '.sh',
  '.scr',
  '.msi',
  '.jar',
  '.com',
]);

/** Heuristic review hints for humans. Explicitly NOT a guarantee that a file is safe or secret-free. */
export function reviewHints(fd: number, size: number, baseName: string): string[] {
  const sample = Buffer.alloc(Math.min(size, 64 * 1024));
  const read = size > 0 ? readSync(fd, sample, 0, sample.length, 0) : 0;
  return reviewHintsFromBytes(sample.subarray(0, read), size, baseName);
}

/** Same heuristics over an in-memory sample (the API runs this on the bytes it actually received). */
/**
 * Recognizes a real image from its leading bytes. The file name is never trusted: `photo.png` that is actually a
 * zip is not an image, and a genuine PNG called `notes.txt` is. SVG is deliberately absent — it is XML that can
 * carry script, so it stays on the ordinary path (and `safeDownloadContentType` neutralizes it on download).
 */
export function detectImageType(head: Buffer): string | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, k) => head[i + k] === b);
  const ascii = (i: number, s: string) => head.subarray(i, i + s.length).toString('latin1') === s;
  if (head.length < 12) return null;
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'BM')) return 'image/bmp';
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return 'image/tiff';
  if (ascii(4, 'ftyp')) {
    const brand = head.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'heif' || brand === 'mif1') return 'image/heic';
  }
  return null;
}

/**
 * Reasons a human should look at an attachment before it is delivered. Empty means it can go straight out.
 *
 * Images are exempt from the binary and size rules on purpose. The binary rule exists because arbitrary bytes
 * cannot be scanned for secrets — but a human approver cannot see data hidden inside a photo either, so the
 * prompt bought no safety and made every screenshot need a click. Format is verified from the magic bytes, so
 * renaming a keystore to `.png` does not buy the exemption. Executable and archive names still flag, as does a
 * secret pattern in anything textual.
 */
export function reviewHintsFromBytes(head: Buffer, size: number, baseName: string): string[] {
  const hints: string[] = [];
  const ext = extname(baseName).toLowerCase();
  const image = detectImageType(head) !== null;
  const binary = head.includes(0);
  if (binary) {
    if (!image) hints.push('binary content: cannot be scanned for secrets, review manually');
  } else {
    const text = head.toString('utf8');
    for (const [re, msg] of SECRET_PATTERNS) if (re.test(text)) hints.push(msg);
  }
  if (ARCHIVE_EXT.has(ext)) hints.push('archive: contents are not inspected');
  if (EXEC_EXT.has(ext)) hints.push('executable: recipients must never run it automatically');
  if (!image && size > 10 * 1024 * 1024) hints.push('large file');
  return hints;
}

/* ------------------------------------------------------------------ names for downloads */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/**
 * Invisible format characters (\p{Cf}): bidi embeddings/overrides/isolates (U+202A–U+202E, U+2066–U+2069), marks
 * (U+200E/U+200F), BOM, soft hyphen, tag characters. They let "invoice\u202Efdp.exe" display as "invoiceexe.pdf".
 * ZWNJ/ZWJ stay because real scripts and emoji sequences need them and they cannot reorder text.
 */
const FORMAT_CHARS = /(?![\u200c\u200d])\p{Cf}/gu;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Sanitizes a display name into a single safe path component; never trusts separators, dots or controls. */
export function safeFilename(raw: string, fallback = 'attachment'): string {
  let name = raw
    .normalize('NFC')
    .replace(/[\\/]/g, '_')
    .replace(CONTROL_CHARS, '')
    .replace(FORMAT_CHARS, '')
    .trim();
  name = name.replace(/^\.+/, '').replace(/\s+/g, ' ');
  if (name.length > 120) {
    const ext = extname(name).slice(0, 16);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  if (!name || name === '.' || name === '..' || WINDOWS_RESERVED.test(name)) name = fallback;
  return name;
}

export function contentTypeFor(baseName: string, binary: boolean): string {
  const ext = extname(baseName).toLowerCase();
  const table: Record<string, string> = {
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.json': 'application/json',
    '.csv': 'text/csv; charset=utf-8',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.avif': 'image/avif',
    '.heic': 'image/heic',
    '.py': 'text/x-python; charset=utf-8',
    '.ts': 'text/plain; charset=utf-8',
    '.js': 'text/plain; charset=utf-8',
    '.yaml': 'text/plain; charset=utf-8',
    '.yml': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.zip': 'application/zip',
  };
  return table[ext] ?? (binary ? 'application/octet-stream' : 'text/plain; charset=utf-8');
}

/** Content types that a browser could render actively are downgraded for downloads. */
export function safeDownloadContentType(stored: string): string {
  const lower = stored.toLowerCase();
  if (
    lower.startsWith('text/html') ||
    lower.includes('svg') ||
    lower.includes('javascript') ||
    lower.includes('xml')
  ) {
    return 'application/octet-stream';
  }
  return stored;
}
