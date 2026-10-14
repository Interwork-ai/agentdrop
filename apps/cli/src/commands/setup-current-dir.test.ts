import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLanguage } from '../locale.js';
import type { Output } from '../output.js';
import { readProfile, writeProfile } from '../store.js';
import { setupCommand, uploadFolderProblem } from './setup.js';

/*
 * After pairing, an interactive `agentdrop setup` offers the folder it runs in for uploads (default yes); scripts
 * are never asked, and --allow-current-dir / --no-allow-current-dir decide without asking. Home, the root, system,
 * hidden and key folders are never offered, nor a folder already allowed.
 */

vi.mock('./login.js', () => ({
  loginCommand: vi.fn(),
  validateServerUrl: (s: string) => s,
  normalizeServerInput: (s: string) => s,
}));
vi.mock('./connect.js', () => ({ connectCommand: vi.fn() }));
vi.mock('./endpoint.js', () => ({ endpointAddCommand: vi.fn() }));
vi.mock('./skill.js', () => ({ skillInstallCommand: vi.fn() }));
vi.mock('./doctor.js', () => ({ doctorCommand: vi.fn().mockResolvedValue([]) }));
vi.mock('./mail.js', () => ({ clientFor: () => ({ client: { identity: vi.fn() } }) }));

let root: string;
let home: string;
let project: string;
let info: string[];
let warnings: string[];
let asked: string[];
let out: Output;

function paired(profile: 'codex' | 'cc', allowed: string[] = []) {
  writeProfile({
    profile,
    harness: profile === 'cc' ? 'claude-code' : 'codex',
    server_url: 'https://example.test',
    h_id: '11111111-1111-4111-8111-111111111111',
    profile_key: profile,
    user_id: '22222222-2222-4222-8222-222222222222',
    handle: 'alice',
    agent_name: profile,
    credential_ref: { store: 'file', account: profile },
    credential_expires_at: new Date(Date.now() + 86400000).toISOString(),
    paired_at: 'now',
    allowed_dirs: allowed,
    toolset: 'standard',
  });
}

function answering(answer: string | null) {
  return async (question: string) => {
    asked.push(question);
    return answer;
  };
}

async function run(opts: { cwd: string; answer?: string | null; allowCurrentDir?: boolean }) {
  await setupCommand(out, {
    server: 'https://example.test',
    harnesses: ['codex'],
    noBrowser: true,
    cwd: opts.cwd,
    ask: answering(opts.answer === undefined ? '' : opts.answer),
    ...(opts.allowCurrentDir !== undefined ? { allowCurrentDir: opts.allowCurrentDir } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agentdrop-setup-dir-')));
  home = join(root, 'home');
  project = join(home, 'projects', 'ablation');
  mkdirSync(project, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('AGENTDROP_CONFIG_DIR', join(root, 'config'));
  vi.stubEnv('AGENTDROP_STATE_DIR', join(root, 'state'));
  vi.stubEnv('AGENTDROP_DATA_DIR', join(root, 'data'));
  info = [];
  warnings = [];
  asked = [];
  out = {
    json: false,
    info: (m) => info.push(m),
    warn: (m) => warnings.push(m),
    error() {},
    result() {},
  };
  paired('codex');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('setup offers the current folder for uploads', () => {
  it('asks once, default yes, and allows it for the agents it set up', async () => {
    await run({ cwd: project, answer: '' });
    expect(asked).toEqual([`Let your agents upload files from ${project}? [Y/n] `]);
    expect(readProfile('codex')?.allowed_dirs).toEqual([project]);
    expect(info).toContain(
      `Your agents may upload files from ${project} (key and credential files never). Downloads still go to the AgentDrop downloads folder.`,
    );
  });

  it('allows it for every profile it set up', async () => {
    paired('cc');
    await setupCommand(out, {
      server: 'https://example.test',
      harnesses: ['codex', 'claude-code'],
      noBrowser: true,
      cwd: project,
      ask: answering('y'),
    });
    expect(asked).toHaveLength(1);
    expect(readProfile('codex')?.allowed_dirs).toEqual([project]);
    expect(readProfile('cc')?.allowed_dirs).toEqual([project]);
  });

  it('leaves it alone when the person says no', async () => {
    await run({ cwd: project, answer: 'n' });
    expect(readProfile('codex')?.allowed_dirs).toEqual([]);
    expect(info).toContain('Not allowed. Allow a folder any time: agentdrop allow-dir add <folder>');
  });

  it('asks in Chinese after agentdrop settings --language zh', async () => {
    writeLanguage('zh');
    await run({ cwd: project, answer: '否' });
    expect(asked).toEqual([`允许你的 Agent 从 ${project} 上传文件吗？[Y/n] `]);
    expect(readProfile('codex')?.allowed_dirs).toEqual([]);
  });

  it('does nothing when nobody can answer (not a terminal)', async () => {
    await run({ cwd: project, answer: null });
    expect(asked).toHaveLength(1);
    expect(readProfile('codex')?.allowed_dirs).toEqual([]);
    expect(info.join('\n')).not.toContain('upload files from');
  });

  it('never asks for the home folder, the root or a key folder', async () => {
    const ssh = join(home, '.ssh');
    const keys = join(home, 'work', 'credentials');
    mkdirSync(ssh, { recursive: true });
    mkdirSync(keys, { recursive: true });
    for (const cwd of [home, '/', ssh, keys]) await run({ cwd });
    expect(asked).toEqual([]);
    expect(readProfile('codex')?.allowed_dirs).toEqual([]);
  });

  it('does not ask when the folder is already allowed, also through a parent', async () => {
    paired('codex', [join(home, 'projects')]);
    await run({ cwd: project });
    expect(asked).toEqual([]);
    expect(readProfile('codex')?.allowed_dirs).toEqual([join(home, 'projects')]);
  });

  it('--allow-current-dir allows it without asking', async () => {
    await run({ cwd: project, allowCurrentDir: true });
    expect(asked).toEqual([]);
    expect(readProfile('codex')?.allowed_dirs).toEqual([project]);
  });

  it('--allow-current-dir in the home folder warns and allows nothing', async () => {
    await run({ cwd: home, allowCurrentDir: true });
    expect(readProfile('codex')?.allowed_dirs).toEqual([]);
    expect(warnings[0]).toMatch(/is not a project folder/);
  });

  it('--no-allow-current-dir neither asks nor allows', async () => {
    await run({ cwd: project, allowCurrentDir: false });
    expect(asked).toEqual([]);
    expect(readProfile('codex')?.allowed_dirs).toEqual([]);
  });
});

describe('which folders are reasonable project folders', () => {
  it('refuses home, root, above home, system, hidden, key and AgentDrop folders', () => {
    const hidden = join(home, '.config', 'tool');
    // relocated into home, as AGENTDROP_DATA_DIR allows (the temp folder itself is a system tree on macOS)
    const agentdropData = join(home, 'drop-data');
    vi.stubEnv('AGENTDROP_DATA_DIR', agentdropData);
    mkdirSync(hidden, { recursive: true });
    mkdirSync(agentdropData, { recursive: true });
    expect(uploadFolderProblem(project, home)).toBeNull();
    expect(uploadFolderProblem(home, home)).toBe('home');
    expect(uploadFolderProblem('/', home)).toBe('root');
    expect(uploadFolderProblem(root, home)).toBe('above home');
    expect(uploadFolderProblem('/usr', home)).toBe('system');
    expect(uploadFolderProblem('/etc', home)).toBe('system');
    expect(uploadFolderProblem(hidden, home)).toBe('hidden');
    expect(uploadFolderProblem(agentdropData, home)).toBe('agentdrop');
    expect(uploadFolderProblem(join(root, 'missing'), home)).toBe('not readable');
  });

  it('registers both flags on setup without a default, so the person is asked', async () => {
    const { buildProgram } = await import('../main.js');
    const setup = buildProgram().commands.find((c) => c.name() === 'setup');
    const longs = setup?.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--allow-current-dir', '--no-allow-current-dir']));
    setup?.parseOptions([]);
    expect(setup?.opts().allowCurrentDir).toBeUndefined();
  });
});
