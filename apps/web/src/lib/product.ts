/*
 * Facts about the product itself that public pages (the product page, the footer) state in more than one place.
 * One constant each, so a change such as a new licence touches this file only. Keep LICENSE_NAME equal to the
 * licence in the repository's LICENSE file.
 */

/** SPDX name of the licence in LICENSE. */
export const LICENSE_NAME = 'Apache-2.0';

/** The project's source repository: its public identity (docs/PUBLIC_REPOSITORY.md). */
export const REPOSITORY_URL = 'https://github.com/Interwork-ai/agentdrop';

/**
 * Whether REPOSITORY_URL is open to visitors. While it is private, every link into it would be a 404, so the public
 * pages leave those links (and the `git clone` command) out. Set to true when the repository is published.
 */
export const REPOSITORY_PUBLIC = true;

/** A file or folder of the repository's default branch on GitHub, e.g. `repoLink('docs/DEPLOY.md')`. */
export function repoLink(path: string): string {
  const clean = path.replace(/^\/+/, '');
  return `${REPOSITORY_URL}/${clean.endsWith('/') ? 'tree' : 'blob'}/main/${clean.replace(/\/$/, '')}`;
}

/** The clients `agentdrop setup` connects, in the order the product names them. */
export const CLIENTS = ['Codex CLI', 'Claude Code', 'opencode', 'Cursor', 'oh-my-pi', 'WorkBuddy'] as const;
