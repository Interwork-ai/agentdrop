import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser/lib/esm/main.js';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectCommand, disconnectCommand } from '../commands/connect.js';
import { writeDevice, writeProfile } from '../store.js';
import { connectableHarnesses, type Harness, harness } from './index.js';
import { silent, writeTestProfile } from './test-fixture.js';

describe('harness parity: connect/disconnect give every harness the same capabilities', () => {
  it('codex and claude-code get MCP, Stop, UserPromptSubmit and SessionStart; disconnect removes them all', async () => {
    const { mkdtempSync, existsSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { parse } = await import('smol-toml');
    const dir = mkdtempSync(join(tmpdir(), 'agentdrop-parity-'));
    process.env.AGENTDROP_CONFIG_DIR = join(dir, 'config');
    // connect records the hook events it wrote; keep that out of the real state directory.
    process.env.AGENTDROP_STATE_DIR = join(dir, 'state');
    writeDevice({ installation_id: '11111111-1111-4111-8111-111111111111', label: 'box', created_at: 'now' });
    for (const p of ['codex', 'cc']) {
      writeProfile({
        profile: p,
        server_url: 'https://drop.example.test',
        h_id: '11111111-1111-4111-8111-111111111111',
        harness: p === 'codex' ? 'codex' : 'claude-code',
        profile_key: p,
        user_id: '22222222-2222-4222-8222-222222222222',
        handle: 'alice',
        agent_name: 'A',
        credential_ref: { store: 'file', account: 'x' },
        credential_expires_at: new Date(Date.now() + 86400000).toISOString(),
        paired_at: 'now',
        allowed_dirs: [],
        toolset: 'standard',
      });
    }
    const paths = {
      codexConfigPath: join(dir, 'codex', 'config.toml'),
      codexHooksPath: join(dir, 'codex', 'hooks.json'),
      claudeConfigPath: join(dir, '.claude.json'),
      claudeSettingsPath: join(dir, 'claude', 'settings.json'),
    };
    await connectCommand(silent, {
      harness: 'codex',
      profile: 'codex',
      executable: '/opt/agentdrop',
      noCli: true,
      ...paths,
    });
    await connectCommand(silent, {
      harness: 'claude-code',
      profile: 'cc',
      executable: '/opt/agentdrop',
      noCli: true,
      ...paths,
    });

    const toml = parse(readFileSync(paths.codexConfigPath, 'utf8')) as {
      hooks?: unknown;
      mcp_servers: Record<string, { args: string[] }>;
    };
    // `hooks` must stay whatever Codex owns: we add the Stop hook to hooks.json and touch no switch here
    expect(toml.hooks).toBeUndefined();
    expect(toml.mcp_servers.agentdrop?.args).toEqual(['mcp', '--profile', 'codex']);
    const codexHooks = JSON.parse(readFileSync(paths.codexHooksPath, 'utf8'));
    expect(codexHooks.hooks.Stop[0].hooks[0].command).toBe(
      '/opt/agentdrop pending --profile codex --in-hook',
    );
    expect(codexHooks.hooks.Stop[0].hooks[0].statusMessage).toBeUndefined();
    expect(codexHooks.hooks.UserPromptSubmit[0].hooks[0]).toEqual({
      type: 'command',
      command: '/opt/agentdrop pending --profile codex --in-hook --hook-output prompt-context',
      timeout: 10,
    });
    // the moment a session starts or resumes, the person is there: same hook in both, same output contract
    expect(codexHooks.hooks.SessionStart[0].hooks[0]).toEqual({
      type: 'command',
      command: '/opt/agentdrop pending --profile codex --in-hook --hook-output session-start',
      timeout: 10,
    });
    // Codex has no custom status line: nothing like it is written for Codex
    expect(codexHooks.statusLine).toBeUndefined();
    const claude = JSON.parse(readFileSync(paths.claudeConfigPath, 'utf8'));
    expect(claude.mcpServers.agentdrop.args).toEqual(['mcp', '--profile', 'cc']);
    const claudeHooks = JSON.parse(readFileSync(paths.claudeSettingsPath, 'utf8'));
    expect(claudeHooks.hooks.Stop[0].hooks[0].command).toBe('/opt/agentdrop pending --profile cc --in-hook');
    expect(claudeHooks.hooks.Stop[0].hooks[0].statusMessage).toBeUndefined();
    expect(claudeHooks.hooks.UserPromptSubmit[0].hooks[0]).toEqual({
      type: 'command',
      command: '/opt/agentdrop pending --profile cc --in-hook --hook-output prompt-context',
      timeout: 10,
    });
    expect(claudeHooks.hooks.SessionStart[0].hooks[0]).toEqual({
      type: 'command',
      command: '/opt/agentdrop pending --profile cc --in-hook --hook-output session-start',
      timeout: 10,
    });
    expect(claudeHooks.statusLine).toEqual({
      type: 'command',
      command: '/opt/agentdrop statusline --profile cc',
      refreshInterval: 30,
    });

    await disconnectCommand(silent, { harness: 'codex', noCli: true, ...paths });
    await disconnectCommand(silent, { harness: 'claude-code', noCli: true, ...paths });
    expect(
      (parse(readFileSync(paths.codexConfigPath, 'utf8')) as { mcp_servers?: Record<string, unknown> })
        .mcp_servers?.agentdrop,
    ).toBeUndefined();
    expect(JSON.parse(readFileSync(paths.codexHooksPath, 'utf8')).hooks.Stop).toBeUndefined();
    expect(JSON.parse(readFileSync(paths.codexHooksPath, 'utf8')).hooks.UserPromptSubmit).toBeUndefined();
    expect(JSON.parse(readFileSync(paths.claudeConfigPath, 'utf8')).mcpServers.agentdrop).toBeUndefined();
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, 'utf8')).hooks.Stop).toBeUndefined();
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, 'utf8')).hooks.UserPromptSubmit).toBeUndefined();
    expect(JSON.parse(readFileSync(paths.codexHooksPath, 'utf8')).hooks.SessionStart).toBeUndefined();
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, 'utf8')).hooks.SessionStart).toBeUndefined();
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, 'utf8')).statusLine).toBeUndefined();
    expect(existsSync(paths.codexHooksPath)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

/*
 * Every harness in the registry, connected the way a person connects it: what the host starts, which moments notify
 * whom, and that disconnect takes all of it back. Adding a harness fails here until it has a row in `EXPECTED` and a
 * reader in `READ`, so its parity with the others is a decision written down, not an accident (docs/HARNESSES.md).
 */
interface Installed {
  /** argv of the `agentdrop` MCP server the host starts, or null when there is none. */
  mcp: string[] | null;
  /** Every `agentdrop pending … --in-hook` command the host runs, as executable, profile and hook output. */
  notices: Array<{ exe: string; profile: string; output: string }>;
}

/** What each harness gets. Moments: `prompt-context` (the model's view at each prompt, plus the person's notice),
 * `session-start` (the person's notice), and the end-of-turn preview's encoding. */
const EXPECTED: Record<Harness, { endOfTurn: string; promptContext: boolean; sessionStart: boolean }> = {
  codex: { endOfTurn: 'system-message', promptContext: true, sessionStart: true },
  'claude-code': { endOfTurn: 'system-message', promptContext: true, sessionStart: true },
  cursor: { endOfTurn: 'cursor', promptContext: false, sessionStart: false },
  opencode: { endOfTurn: 'opencode', promptContext: false, sessionStart: false },
  omp: { endOfTurn: 'system-message', promptContext: true, sessionStart: true },
  workbuddy: { endOfTurn: 'system-message', promptContext: true, sessionStart: true },
};

const PENDING =
  /^(?:'([^']+)'|(\S+)) pending --profile (?:'([^']+)'|(\S+)) --in-hook(?: --hook-output (\S+))?$/;
function notice(command: string): Installed['notices'][number] | null {
  const m = PENDING.exec(command);
  if (!m) return null;
  return { exe: m[1] ?? m[2] ?? '', profile: m[3] ?? m[4] ?? '', output: m[5] ?? 'system-message' };
}
const readJson = (path: string): Record<string, unknown> =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
/** Codex `hooks.json`, Claude Code `settings.json`: event → group → handler. */
function commandHooks(path: string): Installed['notices'] {
  const hooks = (readJson(path).hooks ?? {}) as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  return Object.values(hooks).flatMap((groups) =>
    groups.flatMap((g) => g.hooks.map((h) => notice(h.command)).filter((n) => n !== null)),
  );
}
/** A generated plugin or extension embeds the executable and profile as JSON string constants. */
function generatedSource(path: string): Installed['notices'] {
  if (!existsSync(path)) return [];
  const source = readFileSync(path, 'utf8');
  const constant = (name: string) =>
    JSON.parse(new RegExp(`const ${name} = ("[^"]*");`).exec(source)?.[1] ?? '""');
  return [...source.matchAll(/--hook-output[ ,'"]+([a-z-]+)/g)].map((m) => ({
    exe: constant('executable'),
    profile: constant('profile'),
    output: m[1] ?? '',
  }));
}
const entry = (servers: unknown): { command: string; args: string[] } | undefined =>
  (servers as Record<string, { command: string; args: string[] }> | undefined)?.agentdrop;
const argv = (e: { command: string; args: string[] } | undefined) => (e ? [e.command, ...e.args] : null);

const READ: Record<Harness, (home: string) => Installed> = {
  codex: (home) => ({
    mcp: argv(
      entry(
        (parseToml(readFileSync(join(home, 'codex', 'config.toml'), 'utf8')) as { mcp_servers?: unknown })
          .mcp_servers,
      ),
    ),
    notices: commandHooks(join(home, 'codex', 'hooks.json')),
  }),
  'claude-code': (home) => ({
    mcp: argv(entry(readJson(join(home, 'claude', '.claude.json')).mcpServers)),
    notices: commandHooks(join(home, 'claude', 'settings.json')),
  }),
  cursor: (home) => ({
    mcp: argv(entry(readJson(join(home, 'home', '.cursor', 'mcp.json')).mcpServers)),
    notices: (
      ((readJson(join(home, 'home', '.cursor', 'hooks.json')).hooks as { stop?: Array<{ command: string }> })
        ?.stop ?? []) as Array<{ command: string }>
    )
      .map((h) => notice(h.command))
      .filter((n) => n !== null),
  }),
  opencode: (home) => {
    const config = parseJsonc(readFileSync(join(home, 'xdg', 'opencode', 'opencode.json'), 'utf8')) as {
      mcp?: Record<string, { command: string[] }>;
    };
    const command = config.mcp?.agentdrop?.command;
    return {
      mcp: command ?? null,
      notices: generatedSource(join(home, 'xdg', 'opencode', 'plugins', 'agentdrop.js')),
    };
  },
  omp: (home) => ({
    mcp: argv(entry(readJson(join(home, 'omp-agent', 'mcp.json')).mcpServers)),
    notices: generatedSource(join(home, 'omp-agent', 'extensions', 'agentdrop.js')),
  }),
  workbuddy: (home) => ({
    mcp: argv(entry(readJson(join(home, 'workbuddy', 'mcp.json')).mcpServers)),
    notices: commandHooks(join(home, 'workbuddy', 'settings.json')),
  }),
};

describe('harness parity across the registry', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentdrop-registry-parity-'));
    vi.stubEnv('AGENTDROP_CONFIG_DIR', join(home, 'config'));
    vi.stubEnv('AGENTDROP_STATE_DIR', join(home, 'state'));
    vi.stubEnv('AGENTDROP_DATA_DIR', join(home, 'data'));
    // every host's own relocation variable, so nothing reaches the real home directory
    vi.stubEnv('HOME', join(home, 'home'));
    vi.stubEnv('CODEX_HOME', join(home, 'codex'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude'));
    vi.stubEnv('XDG_CONFIG_HOME', join(home, 'xdg'));
    vi.stubEnv('PI_CODING_AGENT_DIR', join(home, 'omp-agent'));
    vi.stubEnv('WORKBUDDY_CONFIG_DIR', join(home, 'workbuddy'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('has an expectation and a reader for every registered harness', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...connectableHarnesses].sort());
    expect(Object.keys(READ).sort()).toEqual([...connectableHarnesses].sort());
  });

  it.each([...connectableHarnesses])(
    '%s: connect registers the shared bridge and its notices; disconnect removes both',
    async (key) => {
      const profile = harness(key).profile;
      writeTestProfile(profile, key);
      const options = { harness: key, executable: '/opt/agentdrop', noCli: true, which: () => null };
      await connectCommand(silent, { ...options, profile });

      const installed = READ[key](home);
      // one bridge for every host: the same executable, subcommand and profile
      expect(installed.mcp).toEqual(['/opt/agentdrop', 'mcp', '--profile', profile]);
      for (const n of installed.notices) expect([n.exe, n.profile]).toEqual(['/opt/agentdrop', profile]);
      const outputs = installed.notices.map((n) => n.output);
      const want = EXPECTED[key];
      expect(outputs).toContain(want.endOfTurn);
      expect(outputs.includes('prompt-context')).toBe(want.promptContext);
      expect(outputs.includes('session-start')).toBe(want.sessionStart);

      await disconnectCommand(silent, options);
      const after = READ[key](home);
      expect(after.mcp).toBeNull();
      expect(after.notices).toEqual([]);
    },
  );
});
