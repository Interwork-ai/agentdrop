/**
 * Third-party notices for what we ship bundled: the standalone CLI (esbuild) and the dashboard (Vite). MIT, ISC,
 * BSD and OFL all require their licence text to travel with the code, so the builds collect the npm packages whose
 * modules ended up in the output and write one notices file from their package.json and licence files.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;

/**
 * The package directory a bundled file belongs to, or null for files outside node_modules (our own workspace
 * packages). Accepts bundler ids with a `\0` prefix or a `?query` suffix and either path separator.
 */
export function packageDirOf(file) {
  const path = String(file)
    .replace(/^\0+/, '')
    .replace(/[?#].*$/, '')
    .replaceAll('\\', '/');
  const at = path.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const parts = path.slice(at + '/node_modules/'.length).split('/');
  const name = parts[0]?.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
  if (!name.length || name.some((p) => !p) || name[0] === '.pnpm') return null;
  return `${path.slice(0, at)}/node_modules/${name.join('/')}`;
}

/** Distinct package directories of a set of bundled files (absolute, or relative to `base`). */
export function packageDirsOf(files, base = process.cwd()) {
  const dirs = new Set();
  for (const file of files) {
    const clean = String(file).replace(/^\0+/, '');
    if (!clean.includes('node_modules')) continue;
    const dir = packageDirOf(resolve(base, clean.replace(/[?#].*$/, '')));
    if (dir && existsSync(join(dir, 'package.json'))) dirs.add(dir);
  }
  return [...dirs];
}

function licenceField(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l?.type ?? String(l)).join(' OR ');
  return 'UNKNOWN';
}

function person(p) {
  if (!p) return '';
  if (typeof p === 'string') return p;
  return [p.name, p.email ? `<${p.email}>` : '', p.url ? `(${p.url})` : ''].filter(Boolean).join(' ');
}

function repository(pkg) {
  const r = pkg.repository;
  return typeof r === 'string' ? r : (r?.url ?? '');
}

/** One entry per package (name@version), sorted by name; licence texts read from the package directory. */
export function noticeEntries(dirs) {
  const byKey = new Map();
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const key = `${pkg.name}@${pkg.version}`;
    if (byKey.has(key)) continue;
    const texts = readdirSync(dir)
      .filter((f) => LICENCE_FILE.test(f) && statSync(join(dir, f)).isFile())
      .sort()
      .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8').replace(/\r\n?/g, '\n').trim() }));
    byKey.set(key, {
      name: pkg.name,
      version: pkg.version,
      license: licenceField(pkg),
      author: person(pkg.author),
      repository: repository(pkg),
      texts,
    });
  }
  return [...byKey.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/** The notices file: a header naming the product part, then each package with its licence text. */
export function renderNotices(dirs, { product }) {
  const entries = noticeEntries(dirs);
  const rule = '-'.repeat(78);
  const out = [
    `${product} includes the following third-party software. Each package is listed with its version,`,
    'the licence it declares and the licence and notice files it ships.',
    '',
    ...entries.map((e) => `- ${e.name} ${e.version} (${e.license})`),
    '',
  ];
  for (const e of entries) {
    out.push(rule, `${e.name} ${e.version}`, `License: ${e.license}`);
    if (e.author) out.push(`Author: ${e.author}`);
    if (e.repository) out.push(`Repository: ${e.repository}`);
    out.push('');
    if (e.texts.length === 0)
      out.push(
        `This package ships no licence file. It declares the ${e.license} licence${e.author ? `; author: ${e.author}` : ''}.`,
        '',
      );
    for (const t of e.texts) out.push(`${t.file}:`, '', t.text, '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
