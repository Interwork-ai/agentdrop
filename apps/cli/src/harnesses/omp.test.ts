import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectCommand, disconnectCommand } from '../commands/connect.js';
import { synchronizeInstalledHooks } from '../hook-lifecycle.js';
import {
  installOmpExtension,
  omp as ompAdapter,
  ompExtensionSource,
  ompMcpPath,
  removeOmpExtension,
} from './omp.js';
import { silent, writeTestProfile } from './test-fixture.js';

vi.mock('../skill-lifecycle.js', () => ({ isPackagedCli: () => true }));

describe('omp: connect edits only its own entries', () => {
  let dir: string;
  let agent: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-omp-'));
    agent = join(dir, 'omp-agent');
    vi.stubEnv('AGENTDROP_CONFIG_DIR', join(dir, 'config'));
    vi.stubEnv('AGENTDROP_STATE_DIR', join(dir, 'state'));
    vi.stubEnv('PI_CODING_AGENT_DIR', agent);
    writeTestProfile('omp', 'omp');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('follows PI_CODING_AGENT_DIR for MCP servers, the extension and the skill', () => {
    expect(ompMcpPath()).toBe(join(agent, 'mcp.json'));
    expect(ompAdapter.hookRepair.path()).toBe(join(agent, 'extensions', 'agentdrop.js'));
    expect(ompAdapter.skillsRoot()).toBe(join(agent, 'skills'));
  });

  it('finds the agent dir the way omp does: an empty PI_CODING_AGENT_DIR is unset, PI_CONFIG_DIR names the root', () => {
    vi.stubEnv('HOME', join(dir, 'home'));
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    vi.stubEnv('PI_CONFIG_DIR', '');
    expect(ompMcpPath()).toBe(join(dir, 'home', '.omp', 'agent', 'mcp.json'));
    vi.stubEnv('PI_CONFIG_DIR', '.omp-work');
    expect(ompAdapter.configRoot()).toBe(join(dir, 'home', '.omp-work', 'agent'));
    expect(ompAdapter.hookRepair.path()).toBe(
      join(dir, 'home', '.omp-work', 'agent', 'extensions', 'agentdrop.js'),
    );
    // PI_CODING_AGENT_DIR still wins over PI_CONFIG_DIR, resolved like omp's path.resolve
    vi.stubEnv('PI_CODING_AGENT_DIR', 'relative-agent');
    expect(ompAdapter.skillsRoot()).toBe(join(process.cwd(), 'relative-agent', 'skills'));
  });

  it('keeps other MCP servers and keys, writes one extension, and disconnect removes only ours', async () => {
    mkdirSync(join(agent, 'extensions'), { recursive: true });
    const mcp = join(agent, 'mcp.json');
    writeFileSync(
      mcp,
      JSON.stringify({
        $schema: 'x',
        mcpServers: { other: { command: 'npx', args: ['other'] } },
        disabledServers: [],
      }),
    );
    const theirs = join(agent, 'extensions', 'theirs.ts');
    writeFileSync(theirs, 'export default function (pi) {}\n');
    const options = { harness: 'omp' as const, executable: '/path with "quotes"/agentdrop', noCli: true };
    await connectCommand(silent, { ...options, profile: 'omp' });

    const config = JSON.parse(readFileSync(mcp, 'utf8'));
    expect(config.$schema).toBe('x');
    expect(config.disabledServers).toEqual([]);
    expect(config.mcpServers.other).toEqual({ command: 'npx', args: ['other'] });
    expect(config.mcpServers.agentdrop).toEqual({
      type: 'stdio',
      command: '/path with "quotes"/agentdrop',
      args: ['mcp', '--profile', 'omp'],
    });
    const extension = join(agent, 'extensions', 'agentdrop.js');
    expect(readFileSync(extension, 'utf8')).toBe(ompExtensionSource('/path with "quotes"/agentdrop', 'omp'));
    expect(readFileSync(extension, 'utf8')).toContain(
      'const executable = "/path with \\"quotes\\"/agentdrop";',
    );

    await connectCommand(silent, { ...options, profile: 'omp' }); // idempotent
    expect(Object.keys(JSON.parse(readFileSync(mcp, 'utf8')).mcpServers)).toEqual(['other', 'agentdrop']);

    await disconnectCommand(silent, options);
    expect(JSON.parse(readFileSync(mcp, 'utf8')).mcpServers).toEqual({
      other: { command: 'npx', args: ['other'] },
    });
    expect(existsSync(extension)).toBe(false);
    expect(readFileSync(theirs, 'utf8')).toBe('export default function (pi) {}\n');
  });

  it('refuses to replace or remove an unmanaged agentdrop.js', async () => {
    const extension = join(agent, 'extensions', 'agentdrop.js');
    mkdirSync(join(agent, 'extensions'), { recursive: true });
    writeFileSync(extension, 'mine');
    await expect(
      connectCommand(silent, { harness: 'omp', profile: 'omp', executable: '/opt/agentdrop', noCli: true }),
    ).rejects.toThrow(/unmanaged/);
    expect(readFileSync(extension, 'utf8')).toBe('mine');
    await disconnectCommand(silent, { harness: 'omp', noCli: true });
    expect(readFileSync(extension, 'utf8')).toBe('mine');
  });

  it('repairs an extension an older CLI wrote, keeping its executable and profile, then settles', async () => {
    const exe = join(dir, 'agentdrop');
    writeFileSync(exe, '');
    await connectCommand(silent, { harness: 'omp', profile: 'omp', executable: exe, noCli: true });
    const extension = join(agent, 'extensions', 'agentdrop.js');
    const current = readFileSync(extension, 'utf8');
    writeFileSync(extension, current.replace('const BUDGET_MS = 10000;', 'const BUDGET_MS = 5000;'));
    expect(ompAdapter.hookRepair.plan(extension, new Set(['omp'])).status).toBe('stale');
    // only this sandbox: the other harnesses' files are pointed at nothing
    const paths = {
      codex: join(dir, 'none-codex.json'),
      'claude-code': join(dir, 'none-claude.json'),
      cursor: join(dir, 'none-cursor.json'),
      omp: extension,
    };
    expect(synchronizeInstalledHooks(paths).repaired).toEqual([
      { profile: 'omp', harness: 'omp', path: extension },
    ]);
    expect(readFileSync(extension, 'utf8')).toBe(current);
    expect(synchronizeInstalledHooks(paths).repaired).toEqual([]);
    // a profile that no longer exists is left for connect
    expect(ompAdapter.hookRepair.plan(extension, new Set(['other'])).status).toBe('orphaned');
    expect(ompAdapter.hookRepair.plan(join(dir, 'none.js'), new Set(['omp'])).status).toBe('absent');
  });

  it('a repair planned before a disconnect does not bring the extension back', () => {
    const extension = join(dir, 'extensions', 'agentdrop.js');
    installOmpExtension(extension, join(dir, 'gone', 'agentdrop'), 'omp');
    const plan = ompAdapter.hookRepair.plan(extension, new Set(['omp']));
    expect(plan.status).toBe('stale');
    // another process disconnects omp in between
    removeOmpExtension(extension);
    expect(ompAdapter.hookRepair.apply(extension, plan)).toBe(false);
    expect(existsSync(extension)).toBe(false);
  });
});

/*
 * The generated extension, run the way omp runs it: a default export that receives `pi`, handlers called with an
 * event and a context. The CLI is a stand-in script that records its argv, stdin and AGENTDROP_UNATTENDED.
 */
describe('omp: the generated extension', () => {
  let dir: string;
  let log: string;
  type Handler = (event: unknown, ctx: unknown) => unknown;
  /** The extension's handlers, bound to a `pi` whose session has these tools (a subagent's include `yield`). */
  async function load(
    executable: string,
    tools: string[] = ['read', 'bash'],
    asNames = false,
  ): Promise<Record<string, Handler>> {
    const file = join(dir, `agentdrop-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(file, ompExtensionSource(executable, 'omp'));
    const mod = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void };
    const handlers: Record<string, Handler> = {};
    mod.default({
      on: (name: string, handler: Handler) => (handlers[name] = handler),
      // omp 17.0 lists names, later versions tool infos
      getAllTools: () => (asNames ? tools : tools.map((name) => ({ name, description: '' }))),
    });
    return handlers;
  }
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as { args: string; unattended: string; input: Record<string, unknown> },
          )
      : [];
  function context(mode: string, hasUI: boolean, parentSession?: string) {
    const notify = vi.fn();
    return {
      notify,
      ctx: {
        mode,
        hasUI,
        ui: { notify },
        sessionManager: {
          getSessionId: () => 's1',
          getHeader: () => (parentSession ? { parentSession } : {}),
        },
      },
    };
  }
  const history = [
    { role: 'user', content: 'hi', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }], timestamp: 2 },
  ];
  const withPending = (text = 'CTX') => [
    ...history,
    { role: 'custom', customType: 'agentdrop', content: text, display: false, timestamp: expect.any(Number) },
  ];
  let cli: string;
  function writeCli(promptContext: string, promptNotice = 'new for you') {
    writeFileSync(
      cli,
      `#!/usr/bin/env node
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, unattended: process.env.AGENTDROP_UNATTENDED, input: JSON.parse(input) }) + '\\n');
const answer = (value) => {
  // two writes with a pause, split inside a multi-byte character, the way a pipe may deliver it
  const bytes = Buffer.from(JSON.stringify(value));
  const cut = bytes.indexOf(Buffer.from('✓')) + 1 || Math.floor(bytes.length / 2);
  process.stdout.write(bytes.subarray(0, cut));
  setTimeout(() => process.stdout.write(bytes.subarray(cut)), 30);
};
if (args.endsWith('prompt-context')) answer({ systemMessage: ${JSON.stringify(promptNotice)}, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: fs.readFileSync(${JSON.stringify(join(dirname(log), 'context.txt'))}, 'utf8') } });
else if (args.endsWith('session-start')) answer({ systemMessage: 'welcome back' });
else answer({ systemMessage: 'preview' });
`,
    );
    writeFileSync(join(dirname(log), 'context.txt'), promptContext);
    chmodSync(cli, 0o755);
  }
  const setContext = (text: string) => writeFileSync(join(dirname(log), 'context.txt'), text);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-omp-ext-'));
    log = join(dir, 'calls.jsonl');
    cli = join(dir, 'agentdrop');
    writeCli('CTX');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('in the TUI: notices for the person at session start, prompt and turn end; context for the model', async () => {
    const on = await load(cli);
    const { ctx, notify } = context('tui', true);
    await on.session_start?.({ type: 'session_start' }, ctx);
    expect(notify).toHaveBeenLastCalledWith('welcome back', 'info');
    // the system prompt is left alone: no return value
    expect(await on.before_agent_start?.({ prompt: 'hi', systemPrompt: ['base'] }, ctx)).toBeUndefined();
    expect(notify).toHaveBeenLastCalledWith('new for you', 'info');
    // every model call of the turn gets the pending list as its last message; omp never saves it
    expect(await on.context?.({ type: 'context', messages: history }, ctx)).toEqual({
      messages: withPending(),
    });
    expect(await on.context?.({ type: 'context', messages: history }, ctx)).toEqual({
      messages: withPending(),
    });
    // omp may prepare one submission more than once: same answer, no second claim
    expect(await on.before_agent_start?.({ prompt: 'hi', systemPrompt: ['base'] }, ctx)).toBeUndefined();
    await on.agent_end?.({ messages: [], willContinue: true }, ctx);
    expect(await on.context?.({ type: 'context', messages: history }, ctx)).toEqual({
      messages: withPending(),
    });
    await on.agent_end?.({ messages: [] }, ctx);
    expect(notify).toHaveBeenLastCalledWith('preview', 'info');
    // after the turn, nothing is added any more
    expect(await on.context?.({ type: 'context', messages: history }, ctx)).toBeUndefined();
    // a switch inside a running omp is left to the next prompt: omp's own status line would replace the notice
    expect(on.session_switch).toBeUndefined();
    expect(calls().map((c) => [c.args, c.unattended, c.input])).toEqual([
      [
        'pending --profile omp --in-hook --hook-output session-start',
        '0',
        { hook_event_name: 'SessionStart', source: 'startup', session_id: 's1' },
      ],
      [
        'pending --profile omp --in-hook --hook-output prompt-context',
        '0',
        { hook_event_name: 'UserPromptSubmit', session_id: 's1' },
      ],
      [
        'pending --profile omp --in-hook --hook-output system-message',
        '0',
        { hook_event_name: 'Stop', session_id: 's1' },
      ],
    ]);
    // the user's prompt text is never handed to the CLI
    expect(JSON.stringify(calls())).not.toContain('"hi"');
  });

  it('the same words sent again later ("continue") get a fresh list, not the last one', async () => {
    const on = await load(cli);
    const { ctx } = context('tui', true);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await on.before_agent_start?.({ prompt: 'continue', systemPrompt: ['base'] }, ctx);
    expect(await on.context?.({ messages: history }, ctx)).toEqual({ messages: withPending('CTX') });
    await on.agent_end?.({ messages: [] }, ctx);
    setContext('CTX 2');
    clock.mockReturnValue(now + 5000);
    await on.before_agent_start?.({ prompt: 'continue', systemPrompt: ['base'] }, ctx);
    expect(await on.context?.({ messages: history }, ctx)).toEqual({ messages: withPending('CTX 2') });
    expect(calls().filter((c) => c.args.endsWith('prompt-context'))).toHaveLength(2);
    // and when nothing is pending any more, nothing is added
    await on.agent_end?.({ messages: [] }, ctx);
    setContext('');
    clock.mockReturnValue(now + 10000);
    await on.before_agent_start?.({ prompt: 'continue', systemPrompt: ['base'] }, ctx);
    expect(await on.context?.({ messages: history }, ctx)).toBeUndefined();
  });

  it('a quick turn that ended does not lend its list to the same words sent right after', async () => {
    const on = await load(cli);
    const { ctx } = context('tui', true);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await on.before_agent_start?.({ prompt: 'continue', systemPrompt: ['base'] }, ctx);
    await on.agent_end?.({ messages: [] }, ctx);
    setContext('CTX 2');
    // within the re-entry window, but a new submission: the turn before has ended
    clock.mockReturnValue(now + 500);
    await on.before_agent_start?.({ prompt: 'continue', systemPrompt: ['base'] }, ctx);
    expect(await on.context?.({ messages: history }, ctx)).toEqual({ messages: withPending('CTX 2') });
    expect(calls().filter((c) => c.args.endsWith('prompt-context'))).toHaveLength(2);
  });

  it('on Windows runs a .js CLI through Node, which a script cannot be started without', async () => {
    // a .js entry that is not executable by itself, as on Windows
    const script = join(dir, 'agentdrop.js');
    writeFileSync(script, readFileSync(cli, 'utf8').replace(/^#!.*\n/, ''));
    chmodSync(script, 0o644);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const on = await load(script);
      const { ctx, notify } = context('tui', true);
      await on.session_start?.({ type: 'session_start' }, ctx);
      expect(notify).toHaveBeenLastCalledWith('welcome back', 'info');
      expect(calls().map((c) => c.args)).toEqual([
        'pending --profile omp --in-hook --hook-output session-start',
      ]);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('keeps a multi-byte character whole when the answer arrives in pieces', async () => {
    writeCli('CTX ✓', 'AgentDrop：1 条新消息 ✓');
    const on = await load(cli);
    const { ctx, notify } = context('tui', true);
    await on.before_agent_start?.({ prompt: 'hi', systemPrompt: ['base'] }, ctx);
    expect(notify).toHaveBeenLastCalledWith('AgentDrop：1 条新消息 ✓', 'info');
    expect(await on.context?.({ messages: history }, ctx)).toEqual({ messages: withPending('CTX ✓') });
  });

  it('omp -p: the model gets its context, the person nothing, and the CLI is told the run is unattended', async () => {
    const on = await load(cli);
    const { ctx, notify } = context('print', false);
    await on.session_start?.({ type: 'session_start' }, ctx);
    expect(await on.before_agent_start?.({ prompt: 'hi', systemPrompt: ['base'] }, ctx)).toBeUndefined();
    expect(await on.context?.({ messages: history }, ctx)).toEqual({ messages: withPending() });
    await on.agent_end?.({ messages: [] }, ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(calls().map((c) => [c.args, c.unattended])).toEqual([
      ['pending --profile omp --in-hook --hook-output prompt-context', '1'],
    ]);
  });

  it('omp -p --fork: a main session with a parent session still gets its context', async () => {
    const on = await load(cli);
    const { ctx } = context('print', false, '/sessions/original.jsonl');
    await on.before_agent_start?.({ prompt: 'hi', systemPrompt: ['base'] }, ctx);
    expect(await on.context?.({ messages: history }, ctx)).toEqual({ messages: withPending() });
  });

  it('a subagent of a task run gets nothing, with or without a parent session file (omp -p --no-session)', async () => {
    for (const [parent, asNames] of [
      ['/sessions/parent.jsonl', false],
      [undefined, false],
      [undefined, true],
    ] as const) {
      const on = await load(cli, ['read', 'yield'], asNames);
      const { ctx, notify } = context('print', false, parent);
      await on.session_start?.({ type: 'session_start' }, ctx);
      expect(await on.before_agent_start?.({ prompt: 'hi', systemPrompt: ['base'] }, ctx)).toBeUndefined();
      expect(await on.context?.({ messages: history }, ctx)).toBeUndefined();
      await on.agent_end?.({ messages: [] }, ctx);
      expect(notify).not.toHaveBeenCalled();
    }
    expect(calls()).toEqual([]);
  });

  it('a missing or broken CLI is no notice, never an error in omp', async () => {
    const on = await load(join(dir, 'missing'));
    const { ctx, notify } = context('tui', true);
    await expect(on.session_start?.({}, ctx)).resolves.toBeUndefined();
    await expect(
      on.before_agent_start?.({ prompt: 'x', systemPrompt: ['base'] }, ctx),
    ).resolves.toBeUndefined();
    expect(await on.context?.({ messages: history }, ctx)).toBeUndefined();
    await expect(on.agent_end?.({}, ctx)).resolves.toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });
});
