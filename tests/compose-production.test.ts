import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Rendering needs Compose, but never a Docker daemon or real credentials.
const hasCompose = spawnSync('docker', ['compose', 'version']).status === 0;

describe.skipIf(!hasCompose)('production Compose configuration (requires Docker Compose)', () => {
  const image = 'ghcr.io/example/agent-drop/server:9.9.9';

  function render(password?: string, agentdropImage: string | null = image) {
    const root = mkdtempSync(join(tmpdir(), 'agentdrop-compose-test-'));
    try {
      for (const file of ['compose.yaml', 'compose.production.yaml'])
        copyFileSync(resolve(file), join(root, file));
      writeFileSync(join(root, '.env.production'), password ? `POSTGRES_PASSWORD=${password}\n` : '');
      const env = { ...process.env };
      delete env.POSTGRES_PASSWORD;
      delete env.AGENTDROP_IMAGE;
      if (agentdropImage) env.AGENTDROP_IMAGE = agentdropImage;
      return spawnSync(
        'docker',
        [
          'compose',
          '--env-file',
          '.env.production',
          '-f',
          'compose.yaml',
          '-f',
          'compose.production.yaml',
          'config',
          '--format',
          'json',
        ],
        { cwd: root, env, encoding: 'utf8' },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('does not publish PostgreSQL and uses the explicitly supplied production password', () => {
    const result = render('fixture-only-database-password');
    expect(result.status, result.stderr).toBe(0);
    const postgres = JSON.parse(result.stdout).services.postgres;
    expect(postgres.ports ?? []).toEqual([]);
    expect(postgres.environment.POSTGRES_PASSWORD).toBe('fixture-only-database-password');
  });

  it('runs the image named in AGENTDROP_IMAGE and has no stale default', () => {
    const result = render('fixture-only-database-password');
    expect(result.status, result.stderr).toBe(0);
    const services = JSON.parse(result.stdout).services;
    for (const name of ['migrate', 'api', 'worker']) expect(services[name].image).toBe(image);

    const missing = render('fixture-only-database-password', null);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('AGENTDROP_IMAGE');
  });

  it('refuses to render without a production database password', () => {
    const result = render();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('POSTGRES_PASSWORD');
  });
});

describe.skipIf(!hasCompose)('local Compose configuration (requires Docker Compose)', () => {
  function render(authSecret?: string) {
    const root = mkdtempSync(join(tmpdir(), 'agentdrop-compose-local-test-'));
    try {
      copyFileSync(resolve('compose.local.yaml'), join(root, 'compose.local.yaml'));
      const env = { ...process.env };
      delete env.AUTH_SECRET;
      if (authSecret) env.AUTH_SECRET = authSecret;
      return spawnSync('docker', ['compose', '-f', 'compose.local.yaml', 'config', '--format', 'json'], {
        cwd: root,
        env,
        encoding: 'utf8',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('refuses to start without AUTH_SECRET instead of using a shared default', () => {
    const result = render();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('AUTH_SECRET');
  });

  it('passes the supplied AUTH_SECRET to the API', () => {
    const result = render('fixture-only-auth-secret-0123456789abcdef');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).services.api.environment.AUTH_SECRET).toBe(
      'fixture-only-auth-secret-0123456789abcdef',
    );
  });
});
