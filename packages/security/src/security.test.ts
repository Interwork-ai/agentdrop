import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectImageType,
  isSensitivePath,
  openAllowedFile,
  reviewHints,
  reviewHintsFromBytes,
  safeDownloadContentType,
  safeFilename,
} from './index.js';

describe('path policy', () => {
  let root: string;
  let allowed: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentdrop-sec-'));
    allowed = join(root, 'project');
    outside = join(root, 'private');
    mkdirSync(allowed);
    mkdirSync(outside);
    mkdirSync(join(outside, '.ssh'));
    writeFileSync(join(allowed, 'notes.md'), '# notes\nhello');
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    writeFileSync(join(outside, '.ssh', 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----');
    writeFileSync(join(allowed, '.env'), 'DB=1');
    writeFileSync(join(allowed, 'server.pem'), 'x');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts a regular file inside an allowed directory and returns an open descriptor', () => {
    const c = openAllowedFile(join(allowed, 'notes.md'), [allowed], 1_000_000);
    expect(c.size).toBe(13);
    expect(c.baseName).toBe('notes.md');
    closeSync(c.fd);
  });

  it('rejects traversal, symlink escapes, directories, sensitive names and oversize files', () => {
    expect(() => openAllowedFile(join(allowed, '..', 'private', 'secret.txt'), [allowed], 1e6)).toThrow(
      /outside/,
    );
    symlinkSync(join(outside, 'secret.txt'), join(allowed, 'link.txt'));
    expect(() => openAllowedFile(join(allowed, 'link.txt'), [allowed], 1e6)).toThrow(/outside/);
    symlinkSync(outside, join(allowed, 'dirlink'));
    expect(() => openAllowedFile(join(allowed, 'dirlink', 'secret.txt'), [allowed], 1e6)).toThrow(/outside/);
    expect(() => openAllowedFile(allowed, [allowed], 1e6)).toThrow(/regular files/);
    expect(() => openAllowedFile(join(allowed, '.env'), [allowed], 1e6)).toThrow(/sensitive/);
    expect(() => openAllowedFile(join(allowed, 'server.pem'), [allowed], 1e6)).toThrow(/sensitive/);
    expect(() => openAllowedFile(join(outside, '.ssh', 'id_rsa'), [outside], 1e6)).toThrow(/sensitive/);
    expect(() => openAllowedFile(join(allowed, 'notes.md'), [allowed], 5)).toThrow(
      /FILE_TOO_LARGE|exceeds|limit/,
    );
    expect(() => openAllowedFile(join(allowed, 'notes.md'), [], 1e6)).toThrow(/no allowed directories/);
    expect(() => openAllowedFile(join(allowed, 'missing.md'), [allowed], 1e6)).toThrow(/does not exist/);
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without blocking the calling process', () => {
    const fifo = join(allowed, 'pipe');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const source = new URL('./index.ts', import.meta.url).href;
    const code = [
      `import { openAllowedFile } from ${JSON.stringify(source)};`,
      'try { openAllowedFile(' +
        JSON.stringify(fifo) +
        ', [' +
        JSON.stringify(allowed) +
        '], 1024); process.exit(2); }',
      'catch (error) { if (error.code !== "PATH_NOT_ALLOWED") throw error; console.log("rejected"); }',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe('rejected');
  });

  it('flags sensitive paths by directory or name', () => {
    expect(isSensitivePath('/home/u/.aws/credentials')).toBe(true);
    expect(isSensitivePath('/home/u/.config/agentdrop/device.json')).toBe(true);
    expect(isSensitivePath('/home/u/proj/README.md')).toBe(false);
    expect(isSensitivePath('/home/u/proj/.env.production')).toBe(true);
  });

  it('review hints detect secrets and binaries without claiming safety', () => {
    writeFileSync(join(allowed, 'leak.txt'), 'token AKIAABCDEFGHIJKLMNOP and password=hunter22');
    writeFileSync(join(allowed, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    const a = openAllowedFile(join(allowed, 'leak.txt'), [allowed], 1e6);
    expect(reviewHints(a.fd, a.size, a.baseName)).toEqual(
      expect.arrayContaining([expect.stringMatching(/AWS access key/), expect.stringMatching(/password/)]),
    );
    closeSync(a.fd);
    const b = openAllowedFile(join(allowed, 'bin.dat'), [allowed], 1e6);
    expect(reviewHints(b.fd, b.size, b.baseName)[0]).toMatch(/binary/);
    closeSync(b.fd);
  });
});

describe('names and content types', () => {
  it('sanitizes filenames', () => {
    expect(safeFilename('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFilename('  报告 v2.pdf ')).toBe('报告 v2.pdf');
    expect(safeFilename('con')).toBe('attachment');
    expect(safeFilename('a\u0000b.txt')).toBe('ab.txt');
    expect(safeFilename(`${'x'.repeat(300)}.tar.gz`).length).toBeLessThanOrEqual(120);
  });
  it('strips bidi and other invisible format characters that disguise extensions', () => {
    expect(safeFilename('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    const bidi = [
      '\u200E',
      '\u200F',
      '\u202A',
      '\u202B',
      '\u202C',
      '\u202D',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
    ];
    expect(safeFilename(`a${bidi.join('')}b.txt`)).toBe('ab.txt');
    expect(safeFilename('\uFEFFreport\u00AD.pdf\u0085')).toBe('report.pdf');
    // joiners are part of real scripts and emoji sequences, not reordering controls
    expect(safeFilename('\u{1F468}\u200D\u{1F4BB}.png')).toBe('\u{1F468}\u200D\u{1F4BB}.png');
  });
  it('downgrades active content types for downloads', () => {
    expect(safeDownloadContentType('text/html')).toBe('application/octet-stream');
    expect(safeDownloadContentType('image/svg+xml')).toBe('application/octet-stream');
    expect(safeDownloadContentType('application/pdf')).toBe('application/pdf');
  });
});

describe('image attachments do not ask a human for nothing', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 0), // real image bytes contain zeros, which is what used to force a review
  ]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0)]);
  const webp = Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.alloc(4, 0),
    Buffer.from('WEBP', 'latin1'),
    Buffer.alloc(64, 0),
  ]);

  it('recognizes real images from their bytes, not from the file name', () => {
    expect(detectImageType(png)).toBe('image/png');
    expect(detectImageType(jpeg)).toBe('image/jpeg');
    expect(detectImageType(webp)).toBe('image/webp');
    expect(detectImageType(Buffer.from('PK\u0003\u0004 not an image at all'))).toBeNull();
    // SVG stays off the list: it is script-capable XML, not a safe raster image
    expect(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });

  it('sends a photo straight out, whatever its size', () => {
    expect(reviewHintsFromBytes(png, 4096, 'screenshot.png')).toEqual([]);
    expect(reviewHintsFromBytes(jpeg, 25 * 1024 * 1024, 'DSC_0001.jpg')).toEqual([]);
  });

  it('still stops everything an image is not', () => {
    const binary = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x03]), Buffer.alloc(32, 0)]);
    expect(reviewHintsFromBytes(binary, 10, 'keystore.png')).toContain(
      'binary content: cannot be scanned for secrets, review manually',
    );
    expect(reviewHintsFromBytes(png, 10, 'payload.exe')).toContain(
      'executable: recipients must never run it automatically',
    );
    expect(reviewHintsFromBytes(png, 10, 'bundle.zip')).toContain('archive: contents are not inspected');
    expect(reviewHintsFromBytes(Buffer.from('AKIAIOSFODNN7EXAMPLE'), 10, 'creds.txt')).toContain(
      'contains what looks like an AWS access key id',
    );
  });
});
