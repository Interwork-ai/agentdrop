import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * No test may read or write the real ~/.config/agentdrop (profiles, language, hook settings) of the machine it runs
 * on: every test file starts with its own empty CLI directories. A test that needs a particular directory still sets
 * it with vi.stubEnv, and vi.unstubAllEnvs() returns to these, never to the real ones.
 */
const root = mkdtempSync(join(tmpdir(), 'agentdrop-test-'));
process.env.AGENTDROP_CONFIG_DIR = join(root, 'config');
process.env.AGENTDROP_DATA_DIR = join(root, 'data');
process.env.AGENTDROP_STATE_DIR = join(root, 'state');
// oh-my-pi keeps everything (MCP servers, extensions, skills) in one agent directory; never the real one.
process.env.PI_CODING_AGENT_DIR = join(root, 'omp-agent');
// WorkBuddy's home (MCP servers, hooks, skills); never the real ~/.workbuddy.
process.env.WORKBUDDY_CONFIG_DIR = join(root, 'workbuddy');

/*
 * Nor may a test find its way to the server through the developer's proxy: the CLI discovers proxies from its own
 * environment, ancestor processes and the login shell (apps/cli/src/network.ts). network.test.ts covers discovery
 * with injected dependencies.
 */
for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'])
  delete process.env[key];
process.env.AGENTDROP_PROXY_DISCOVERY = 'off';
