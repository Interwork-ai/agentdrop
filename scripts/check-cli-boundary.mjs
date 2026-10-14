// Checks the actual bundled dependency graph, not just direct package.json dependencies.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const meta = JSON.parse(readFileSync(resolve(root, 'apps/cli/bundle/metafile.json'), 'utf8'));
const forbidden =
  /(?:^|\/)(?:apps\/(?:api|web|worker)|packages\/(?:db|domain|storage))(?:\/|$)|(?:@aws-sdk|drizzle-orm|fastify|better-auth)(?:\/|@)/;
const violations = Object.keys(meta.inputs).filter((path) => forbidden.test(path.replaceAll('\\', '/')));
if (violations.length) {
  console.error('[cli-boundary] server-only modules leaked into the CLI bundle:', violations);
  process.exit(1);
}
console.log(
  `[cli-boundary] ${Object.keys(meta.inputs).length} inputs checked; no server, database or S3 code`,
);

// Experimental features must be compiled out of the installable package (apps/cli/src/experimental.ts). Run the
// bundle with the source-mode switch on: a correctly built package still does not know the hidden command.
if (process.env.AGENTDROP_BUILD_EXPERIMENTAL !== '1') {
  const { spawnSync } = await import('node:child_process');
  const probe = spawnSync(
    process.execPath,
    [resolve(root, 'apps/cli/bundle/agentdrop.mjs'), 'autorun', 'status'],
    {
      env: { ...process.env, AGENTDROP_EXPERIMENTAL: '1' },
      encoding: 'utf8',
    },
  );
  if (!probe.stderr.includes("unknown command 'autorun'")) {
    console.error('[cli-boundary] experimental features are reachable in the package bundle');
    process.exit(1);
  }
  console.log('[cli-boundary] experimental features are compiled out');
}
