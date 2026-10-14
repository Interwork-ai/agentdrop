import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packageDirOf, packageDirsOf, renderNotices } from './third-party-notices.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function pkg(root: string, name: string, manifest: object, files: Record<string, string> = {}) {
  const dir = join(root, 'node_modules', '.pnpm', `${name.replace('/', '+')}@1.0.0`, 'node_modules', name);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
  writeFileSync(join(dir, 'lib', 'index.js'), '');
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

describe('third-party notices', () => {
  it('maps bundled files to their package directory, scoped or not, ignoring our own sources', () => {
    expect(packageDirOf('/r/node_modules/.pnpm/react@19.3.0/node_modules/react/cjs/react.js')).toBe(
      '/r/node_modules/.pnpm/react@19.3.0/node_modules/react',
    );
    expect(packageDirOf('\0/r/node_modules/@fontsource/ibm-plex-mono/400.css?used')).toBe(
      '/r/node_modules/@fontsource/ibm-plex-mono',
    );
    expect(packageDirOf('C:\\r\\node_modules\\zod\\index.js')).toBe('C:/r/node_modules/zod');
    expect(packageDirOf('/r/packages/contracts/src/index.ts')).toBeNull();
  });

  it('writes each package once with its licence text, and the declared licence when it ships none', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentdrop-notices-'));
    roots.push(root);
    const a = pkg(root, '@scope/a', { license: 'MIT' }, { LICENSE: 'MIT License\r\n\r\nCopyright (c) A' });
    pkg(root, 'b', { license: { type: 'ISC' }, author: { name: 'B Author', email: 'b@example.com' } });
    const dirs = packageDirsOf(
      [
        join(a, 'lib', 'index.js'),
        join(a, 'package.json'),
        'node_modules/.pnpm/b@1.0.0/node_modules/b/lib/index.js',
      ],
      root,
    );
    expect(dirs).toHaveLength(2);
    const text = renderNotices(dirs, { product: 'Fixture' });
    expect(text).toContain('- @scope/a 1.0.0 (MIT)');
    expect(text).toContain('LICENSE:\n\nMIT License\n\nCopyright (c) A');
    expect(text).toContain('- b 1.0.0 (ISC)');
    expect(text).toContain(
      'This package ships no licence file. It declares the ISC licence; author: B Author <b@example.com>.',
    );
  });
});
