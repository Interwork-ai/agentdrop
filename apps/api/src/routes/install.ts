import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

/**
 * Self-service CLI install: the default script follows npm's latest stable release. A bundled tarball remains
 * available as an explicit, server-pinned fallback at /install/agentdrop.tgz.
 */
export async function installRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const dir = ctx.config.CLI_DIST_DIR ? resolve(ctx.config.CLI_DIST_DIR) : null;
  const tarball = dir ? join(dir, 'agentdrop.tgz') : null;
  const available = () => tarball !== null && existsSync(tarball);

  app.get('/install/agentdrop.tgz', async (_req, reply) => {
    if (!tarball || !available())
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'CLI package not bundled on this server',
        next_action: 'Install from npm: npm install -g agentdrop-cli@latest',
        retryable: false,
      });
    reply.header('Content-Type', 'application/gzip');
    reply.header('Content-Length', String(statSync(tarball).size));
    reply.header('Content-Disposition', 'attachment; filename="agentdrop.tgz"');
    reply.header('Cache-Control', 'no-cache');
    return reply.send(createReadStream(tarball));
  });

  app.get('/install.sh', async (_req, reply) => {
    const base = ctx.config.PUBLIC_BASE_URL.replace(/\/+$/, '');
    const script = `#!/bin/sh
# AgentDrop CLI installer for ${base}
set -e
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required (https://nodejs.org). Aborting." >&2; exit 1
fi
MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 22 ]; then echo "Node.js $MAJOR found; 22+ required." >&2; exit 1; fi
echo "Installing the latest stable agentdrop CLI from npm ..."
npm install -g "agentdrop-cli@latest"
echo
echo "Next: agentdrop setup --server ${base}"
echo "      (pairs your Codex / Claude Code, opens the browser for confirmation, installs the skill and hook)"
`;
    reply.header('Content-Type', 'text/x-shellscript; charset=utf-8');
    reply.header('Cache-Control', 'no-cache');
    return reply.send(script);
  });
}
