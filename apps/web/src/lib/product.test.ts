import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { LICENSE_NAME, REPOSITORY_URL, repoLink } from './product.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

it('names the licence that LICENSE holds', () => {
  const text = readFileSync(resolve(ROOT, 'LICENSE'), 'utf8');
  const known: Record<string, RegExp> = {
    'Apache-2.0': /Apache License\s+Version 2\.0/,
    MIT: /^MIT License/m,
    'FSL-1.1-ALv2': /Functional Source License, Version 1\.1, ALv2/,
  };
  const match = known[LICENSE_NAME];
  expect(match, `add a pattern for ${LICENSE_NAME}`).toBeDefined();
  expect(text).toMatch(match as RegExp);
});

it('links files and folders of the repository', () => {
  expect(repoLink('docs/DEPLOY.md')).toBe(`${REPOSITORY_URL}/blob/main/docs/DEPLOY.md`);
  expect(repoLink('docs/')).toBe(`${REPOSITORY_URL}/tree/main/docs`);
});
