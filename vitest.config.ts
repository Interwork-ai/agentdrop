import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Convenience: pick TEST_DATABASE_URL from a local .env when not set in the environment (CI sets it explicitly).
const envFile = resolve(import.meta.dirname, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^(TEST_DATABASE_URL|DATABASE_URL)=(.+)$/.exec(line.trim());
    if (m?.[1] && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const pkg = (name: string) => resolve(import.meta.dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      '@agentdrop/contracts': pkg('contracts'),
      '@agentdrop/db': pkg('db'),
      '@agentdrop/domain': pkg('domain'),
      '@agentdrop/mcp': pkg('mcp'),
      '@agentdrop/storage': pkg('storage'),
      '@agentdrop/security': pkg('security'),
      '@agentdrop/client': pkg('client'),
      '@agentdrop/adapters': pkg('adapters'),
    },
  },
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/**/src/**/*.test.ts',
      'tests/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    // test-database first: it gives each worker its own database before any test module reads TEST_DATABASE_URL
    setupFiles: [
      'tests/setup/test-database.ts',
      'tests/setup/isolate-cli-dirs.ts',
      'tests/setup/content-encryption.ts',
    ],
    // Most files wait on PostgreSQL, not the CPU, so more workers than cores still pays off: GitHub's 2-core runner
    // would otherwise get a single worker. Each worker has its own database (tests/setup/test-database.ts).
    maxWorkers: Math.max(4, availableParallelism() - 1),
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/junit.xml' },
  },
});
