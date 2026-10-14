// Bundles the CLI (with all workspace packages) into a single file so `npm install -g` needs no monorepo.

import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { packageDirsOf, renderNotices } from '../../scripts/lib/third-party-notices.mjs';

rmSync('bundle', { recursive: true, force: true });
mkdirSync('bundle/skill', { recursive: true });
const result = await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'bundle/agentdrop.mjs',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  sourcemap: false,
  minify: false,
  legalComments: 'inline',
  metafile: true,
  logLevel: 'warning',
  // Experimental features are compiled out of the installable package (see src/experimental.ts).
  define: { __AGENTDROP_EXPERIMENTAL__: process.env.AGENTDROP_BUILD_EXPERIMENTAL === '1' ? 'true' : 'false' },
});
writeFileSync('bundle/metafile.json', JSON.stringify(result.metafile, null, 2));
// Licence texts of every npm package with code in the bundle (MIT, ISC, BSD… require them to ship with it).
const bundled = Object.values(result.metafile.outputs).flatMap((o) =>
  Object.entries(o.inputs)
    .filter(([, input]) => input.bytesInOutput > 0)
    .map(([file]) => file),
);
const noticeDirs = packageDirsOf(bundled);
writeFileSync('bundle/THIRD_PARTY_NOTICES', renderNotices(noticeDirs, { product: 'The AgentDrop CLI' }));
cpSync('skill/agentdrop', 'bundle/skill/agentdrop', { recursive: true });
// The Claude Code mod, without the type declarations Claude Code writes beside a mod during development
cpSync('claude-mod/agentdrop', 'bundle/claude-mod/agentdrop', {
  recursive: true,
  // either path separator: the package is also built on Windows
  filter: (src) =>
    !/[\\/]\.claude-plugin[\\/]types([\\/]|$)/.test(src) && !/(^|[\\/])tsconfig\.json$/.test(src),
});
console.log(
  `[bundle] bundle/agentdrop.mjs + bundle/skill/ + bundle/claude-mod/ + THIRD_PARTY_NOTICES (${noticeDirs.length} packages; experimental ${process.env.AGENTDROP_BUILD_EXPERIMENTAL === '1' ? 'ON' : 'off'})`,
);
