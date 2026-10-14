// Assembles the standalone npm package (name: agentdrop) from the bundle and produces a tarball in pack/out.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
rmSync('pack/out', { recursive: true, force: true });
mkdirSync('pack/out/bin', { recursive: true });
const manifest = JSON.parse(readFileSync('pkg/package.json', 'utf8'));
manifest.version = version;
writeFileSync('pack/out/package.json', `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  'pack/out/bin/agentdrop.mjs',
  `#!/usr/bin/env node\n${readFileSync('bundle/agentdrop.mjs', 'utf8')}`,
);
cpSync('bundle/skill', 'pack/out/skill', { recursive: true });
cpSync('bundle/claude-mod', 'pack/out/claude-mod', { recursive: true });
cpSync('README.md', 'pack/out/README.md');
cpSync('../../LICENSE', 'pack/out/LICENSE'); // Apache-2.0 requires shipping the license text
cpSync('bundle/THIRD_PARTY_NOTICES', 'pack/out/THIRD_PARTY_NOTICES'); // licences of the bundled npm packages
const out = execFileSync('npm', ['pack', '--silent', '--pack-destination', '..'], {
  cwd: 'pack/out',
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
cpSync(`pack/${out}`, 'pack/agentdrop.tgz'); // stable name served by the API at /install/agentdrop.tgz
console.log(`[pack] pack/${out} (also pack/agentdrop.tgz)`);
