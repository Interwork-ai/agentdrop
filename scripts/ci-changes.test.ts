import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { changedFiles, plan } from './ci-changes.mjs';

const none = { verify: false, cli: false, e2e: false, cli_nodes: [22] };
const all = { verify: true, cli: true, e2e: true, cli_nodes: [22, 24] };

describe('ci-changes plan', () => {
  it('runs nothing heavy for prose only', () => {
    expect(plan(['docs/QUALITY.md', 'README.md', 'CHANGELOG.md', 'docs/adr/0031-x.md'])).toEqual(none);
  });

  it('runs the CLI check on the oldest Node only, and verify, for a CLI change', () => {
    expect(plan(['apps/cli/src/commands/mail.ts'])).toEqual({ ...none, verify: true, cli: true });
    // the skill ships in the CLI package: its Markdown is code, not prose
    expect(plan(['apps/cli/skill/agentdrop/SKILL.md'])).toEqual({ ...none, verify: true, cli: true });
  });

  it('runs the browser journeys for the dashboard, the API and what lies under them', () => {
    for (const file of [
      'apps/web/src/pages/inbox.tsx',
      'apps/api/src/routes/groups.ts',
      'packages/domain/src/groups/storage.ts',
      'scripts/e2e/journeys/core.mjs',
    ])
      expect(plan([file]), file).toEqual({ ...none, verify: true, e2e: true });
  });

  it('runs both for a shared contract change', () => {
    expect(plan(['packages/contracts/src/tools.ts'])).toEqual({
      ...none,
      verify: true,
      cli: true,
      e2e: true,
    });
  });

  it('runs verify alone for the worker', () => {
    expect(plan(['apps/worker/src/assistant.ts'])).toEqual({ ...none, verify: true });
  });

  it('runs everything for dependencies, toolchain and workflows', () => {
    for (const file of ['pnpm-lock.yaml', 'apps/api/package.json', '.github/workflows/ci.yml', '.nvmrc'])
      expect(plan([file]), file).toEqual(all);
  });

  it('runs everything when asked or when the changes are unknown, and nothing for a release commit', () => {
    expect(plan(['docs/a.md'], { full: true })).toEqual(all);
    expect(plan(null)).toEqual(all);
    expect(plan(['package.json', 'CHANGELOG.md'], { releaseCommit: true })).toEqual(none);
    expect(plan(null, { releaseCommit: true, full: true })).toEqual(all);
  });

  it('cannot know the changes without a usable base', () => {
    const fail = () => {
      throw new Error('bad revision');
    };
    expect(changedFiles(undefined)).toBeNull();
    expect(changedFiles('0000000000000000000000000000000000000000')).toBeNull();
    expect(changedFiles('abc123', fail)).toBeNull();
    expect(changedFiles('abc123', () => 'docs/a.md\napps/cli/x.ts\n')).toEqual([
      'docs/a.md',
      'apps/cli/x.ts',
    ]);
  });
});
