import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import type { AppContext } from './context.js';
import { installRoutes } from './routes/install.js';

it('server-only deployments still serve the latest npm installer while the bundled tarball is absent', async () => {
  const app = Fastify();
  try {
    await installRoutes(app, { config: { PUBLIC_BASE_URL: 'https://drop.example.test' } } as AppContext);
    const script = await app.inject({ method: 'GET', url: '/install.sh' });
    expect(script.statusCode).toBe(200);
    expect(script.body).toContain('npm install -g "agentdrop-cli@latest"');
    const pkg = await app.inject({ method: 'GET', url: '/install/agentdrop.tgz' });
    expect(pkg.statusCode).toBe(404);
    expect(pkg.json().next_action).toContain('npm install -g agentdrop-cli@latest');
  } finally {
    await app.close();
  }
});

it('bundled deployments serve both their package and installer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdrop-installer-'));
  const app = Fastify();
  try {
    writeFileSync(join(dir, 'agentdrop.tgz'), 'package-fixture');
    await installRoutes(app, {
      config: { PUBLIC_BASE_URL: 'https://drop.example.test', CLI_DIST_DIR: dir },
    } as AppContext);
    const script = await app.inject({ method: 'GET', url: '/install.sh' });
    expect(script.statusCode).toBe(200);
    expect(script.body).toContain('npm install -g "agentdrop-cli@latest"');
    const pkg = await app.inject({ method: 'GET', url: '/install/agentdrop.tgz' });
    expect(pkg.statusCode).toBe(200);
    expect(pkg.body).toBe('package-fixture');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
