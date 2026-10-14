import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Client-only checks intentionally never load .env or connect to PostgreSQL.
const packages = ['contracts', 'client', 'mcp', 'security'];
export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      packages.map((name) => [
        `@agentdrop/${name}`,
        resolve(import.meta.dirname, `packages/${name}/src/index.ts`),
      ]),
    ),
  },
  test: {
    include: [
      'apps/cli/src/**/*.test.ts',
      ...packages.map((name) => `packages/${name}/src/**/*.test.ts`),
      'scripts/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    setupFiles: ['tests/setup/isolate-cli-dirs.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/cli-junit.xml' },
  },
});
