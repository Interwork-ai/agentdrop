import { execFileSync, spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AgentDropError } from '@agentdrop/client';
import { isSensitivePath } from '@agentdrop/security';
import { isRecord } from '../harnesses/shared.js';
import { detectHarnesses, type Harness, harness as harnessAdapter, harnessChoices } from '../harnesses.js';
import { readLanguage } from '../locale.js';
import { type Output, terminalText } from '../output.js';
import { configDir, dataDir, stateDir } from '../paths.js';
import { readProfile, writeProfile } from '../store.js';
import { allowDirCommand } from './allowdir.js';
import { connectCommand } from './connect.js';
import { doctorCommand } from './doctor.js';
import { endpointAddCommand } from './endpoint.js';
import { loginCommand, normalizeServerInput, validateServerUrl } from './login.js';
import { clientFor } from './mail.js';
import { skillInstallCommand } from './skill.js';

export interface SetupOptions {
  server: string;
  harnesses?: Harness[];
  allowDir?: string;
  noBrowser?: boolean;
  /** Edit client config files directly instead of `codex mcp add` / `claude mcp add`. */
  noCli?: boolean;
  /**
   * Let agents upload from the current folder: true allows it without asking, false never asks, undefined asks in
   * an interactive terminal (default yes) and does nothing otherwise.
   */
  allowCurrentDir?: boolean;
  /** The folder setup runs in (tests); defaults to `process.cwd()`. */
  cwd?: string;
  /** Asks the person one question; null when nobody can answer (not a terminal). Defaults to `askTerminal`. */
  ask?: (question: string) => Promise<string | null>;
  which?: (bin: string) => string | null;
  openUrl?: (url: string) => void;
}

/**
 * One command for a new machine: login → pair every installed harness (browser opens automatically) →
 * register the MCP bridge + Stop hook → install the companion skill → doctor. Re-running is safe: already
 * paired profiles are kept and re-paired only if their credential is missing.
 */
export async function setupCommand(out: Output, opts: SetupOptions): Promise<void> {
  const which = opts.which ?? whichBin;
  const t = translator();
  const base = validateServerUrl(normalizeServerInput(opts.server), true);
  const allowHttp = base.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(base);
  out.info(`AgentDrop setup → ${base}`);
  await loginCommand(out, { server: base, allowHttp, fromSetup: true });

  const detected = detectHarnesses(which);
  const harnesses = opts.harnesses ?? detected;
  if (harnesses.length === 0) {
    throw new Error(
      t(
        `no supported client found on this computer; install one, or name it with --harness ${harnessChoices('|')}`,
        `这台电脑上没有找到支持的客户端；先装一个，或者用 --harness ${harnessChoices('|')} 指定`,
      ),
    );
  }
  out.info(
    t(
      `clients: ${harnesses.map(labelOf).join(', ')}${opts.harnesses ? '' : ' (found on this computer)'}`,
      `客户端：${harnesses.map(labelOf).join('、')}${opts.harnesses ? '' : '（在这台电脑上找到的）'}`,
    ),
  );

  const host = hostname().replace(/\.local$/, '');
  const connected: Harness[] = [];
  const notSetUp: Harness[] = [];
  for (const harness of harnesses) {
    try {
      await setupHarness(out, opts, base, host, harness);
      connected.push(harness);
    } catch (err) {
      // One harness the server or this machine cannot take must not leave the others without skill and checks.
      notSetUp.push(harness);
      out.error(harnessFailure(harness, err));
    }
  }
  if (connected.length) await offerCurrentFolder(out, opts, connected);
  if (connected.length) await skillInstallCommand(out, { only: connected });

  const checks = await doctorCommand(out, {});
  const failed = checks.filter((c) => c.status === 'fail');
  out.info('');
  if (failed.length === 0 && notSetUp.length === 0) {
    for (const line of setupDone(base, connected)) out.info(line);
    const feishu = await feishuSuggestion(which, connected);
    if (feishu) out.info(feishu);
  } else {
    out.info(setupSummary(connected, notSetUp, failed.length));
  }
  if (failed.length || notSetUp.length) process.exitCode = 1;
}

/** Fixed words in the person's language (English unless `agentdrop settings --language zh`). */
type Tr = (en: string, zh: string) => string;
function translator(): Tr {
  const zh = readLanguage() === 'zh';
  return (en, zhText) => (zh ? zhText : en);
}

function labelOf(harness: Harness): string {
  return harnessAdapter(harness).label;
}

/**
 * The end of a setup that worked, in three lines: what is set up and for whom, how to try it, how to add people.
 * The test sentence is in the person's language, since they will type it to their agent.
 */
export function setupDone(base: string, connected: Harness[]): string[] {
  const t = translator();
  const names = connected.map(labelOf);
  const handle = connected.map((h) => readProfile(harnessAdapter(h).profile)?.handle).find(Boolean);
  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  })();
  const who = handle ? t(` as @${handle} on ${host}`, `，账号 @${handle}，服务器 ${host}`) : '';
  return [
    t(`Done: ${names.join(', ')} set up${who}.`, `完成：已设置 ${names.join('、')}${who}。`),
    t(
      `Try it: restart ${names.join(' / ')}, then ask your agent "send a test message to @agentdrop"; the built-in assistant answers with a receipt.`,
      `试一下：重启 ${names.join(' / ')}，然后对 Agent 说「发一条测试消息给 @agentdrop」，内置助手会回一条回执。`,
    ),
    t(
      `Add people: open ${base}/app/contacts, create an invite link and send it to a colleague.`,
      `加人：打开 ${base}/app/contacts，生成邀请链接发给同事。`,
    ),
  ];
}

/** Pairs (unless already paired), connects and allows the directory for one harness; throws on any failure. */
async function setupHarness(
  out: Output,
  opts: SetupOptions,
  base: string,
  host: string,
  harness: Harness,
): Promise<void> {
  const t = translator();
  const profile = harnessAdapter(harness).profile;
  const existing = readProfile(profile);
  if (existing && existing.harness !== harness)
    throw new Error(
      t(
        `Profile ${profile} already belongs to ${existing.harness}; pair a separate profile with endpoint add, then connect it explicitly.`,
        `配置 ${profile} 已属于 ${existing.harness}；请用 endpoint add 另配一个配置，再单独 connect。`,
      ),
    );
  if (
    existing &&
    existing.server_url === base &&
    new Date(existing.credential_expires_at).getTime() > Date.now()
  ) {
    out.info(
      t(
        `${labelOf(harness)}: already paired as "${existing.agent_name}"; keeping it`,
        `${labelOf(harness)}：已经配对为「${existing.agent_name}」，保留`,
      ),
    );
  } else {
    const label = `${host} ${harnessAdapter(harness).label}`;
    out.info(
      opts.noBrowser
        ? t(
            `pairing ${labelOf(harness)} as "${label}": open the link below in a browser and confirm the code there`,
            `正在配对 ${labelOf(harness)}（「${label}」）：在浏览器里打开下面的链接，确认验证码`,
          )
        : t(
            `pairing ${labelOf(harness)} as "${label}": a browser window will open; confirm the code there`,
            `正在配对 ${labelOf(harness)}（「${label}」）：浏览器会打开，在那里确认验证码`,
          ),
    );
    await endpointAddCommand(out, {
      harness,
      profile,
      label,
      server: base,
      fromSetup: true,
      ...(opts.noBrowser ? {} : { onCode: (url) => (opts.openUrl ?? openInBrowser)(url) }),
    });
  }
  await connectCommand(out, { harness, profile, ...(opts.noCli ? { noCli: true } : {}) });
  if (opts.allowDir) await allowDirCommand(out, { profile, action: 'add', dir: opts.allowDir });
}

/**
 * Why one harness was not set up, for the person, in their language. A server older than this CLI rejects a
 * harness key it does not know yet (`omp` before 0.5.9) as a validation failure on `harness_key`, before any code
 * is shown or a browser opens; that is said as what it means: this client needs a newer server. Pairing is tried
 * rather than gated on the server's version, because a server built from source between releases still reports
 * the last released version.
 */
export function harnessFailure(harness: Harness, err: unknown): string {
  const label = harnessAdapter(harness).label;
  const zh = readLanguage() === 'zh';
  if (harnessKeyRejected(err))
    return zh
      ? `${label}：这台 AgentDrop 服务器版本较旧，还不支持这个客户端，需要先更新服务器。其他客户端照常设置。`
      : `${label}: this AgentDrop server is older and does not support this client yet; the server needs an update. The other clients are set up as usual.`;
  const reason = failureReason(err, zh);
  return zh
    ? `${label}：没有设置成功（${reason}）。其他客户端照常设置。`
    : `${label}: not set up (${reason}). The other clients are set up as usual.`;
}

/** Why, in the person's language: by the error's code; a server's own message is for programs, never shown here. */
function failureReason(err: unknown, zh: boolean): string {
  const code = err instanceof AgentDropError ? err.code : null;
  const known: Record<string, [string, string]> = {
    NETWORK_ERROR: ["can't reach the server", '连不上服务器'],
    UPSTREAM_UNAVAILABLE: ["can't reach the server", '连不上服务器'],
    RATE_LIMITED: ['too many attempts; try again in a minute', '尝试太频繁，请一分钟后再试'],
    UNAUTHORIZED: ['not signed in to this server', '还没有登录这台服务器'],
    ENDPOINT_REVOKED: ['this agent was removed in the dashboard', '这个 Agent 已在网页上被移除'],
    ACCOUNT_SUSPENDED: ['the account is suspended', '账号已被停用'],
    FORBIDDEN: ['the server refused it', '服务器拒绝了这个请求'],
  };
  const pair = code ? known[code] : undefined;
  if (pair) return zh ? pair[1] : pair[0];
  // our own failures (a config file that cannot be written, a profile clash) say what is wrong; keep them
  if (!(err instanceof AgentDropError)) return err instanceof Error ? err.message : String(err);
  return zh
    ? `错误 ${err.code}，运行 agentdrop doctor 查看`
    : `error ${err.code}; run agentdrop doctor for details`;
}

function harnessKeyRejected(err: unknown): boolean {
  if (!(err instanceof AgentDropError) || err.code !== 'VALIDATION_FAILED') return false;
  const issues = err.details?.issues;
  return Array.isArray(issues) && issues.some((i) => isRecord(i) && i.path === 'harness_key');
}

function setupSummary(connected: Harness[], notSetUp: Harness[], failedChecks: number): string {
  const zh = readLanguage() === 'zh';
  const parts: string[] = [];
  if (connected.length)
    parts.push(
      zh
        ? `已设置 ${connected.join('、')}，重启后生效`
        : `set up ${connected.join(', ')}; restart ${connected.length > 1 ? 'them' : 'it'} to use AgentDrop`,
    );
  if (notSetUp.length)
    parts.push(
      zh ? `未设置 ${notSetUp.join('、')}，原因见上` : `not set up: ${notSetUp.join(', ')}, see above`,
    );
  if (failedChecks)
    parts.push(zh ? `${failedChecks} 项检查未通过，见上` : `${failedChecks} failing check(s), see above`);
  return zh ? `完成：${parts.join('；')}。` : `finished: ${parts.join('; ')}.`;
}

/**
 * People who already use Feishu's lark-cli are the ones most likely to want notices there, and for them connecting
 * takes one sentence to their agent. Suggested once, at the end of setup, only when the account has no Feishu bot
 * yet; never from the hooks, so it does not follow the person around.
 */
export async function feishuSuggestion(
  which: (bin: string) => string | null,
  harnesses: Harness[],
): Promise<string | null> {
  if (!which('lark-cli')) return null;
  const profile = harnesses.map((h) => harnessAdapter(h).profile).find((p) => readProfile(p));
  if (!profile) return null;
  try {
    const id = await clientFor(profile).client.identity();
    if (id.notifications?.feishu !== false) return null;
  } catch {
    return null;
  }
  return readLanguage() === 'zh'
    ? '飞书：检测到 lark-cli。想在飞书里也收到 AgentDrop 提醒，对 Agent 说「把 AgentDrop 通知接到飞书」，大约一分钟。'
    : 'Feishu: lark-cli is installed. To also get AgentDrop notices in Feishu, tell your agent "send AgentDrop notices to Feishu"; it takes about a minute.';
}

/** Folders no agent should upload from as a whole: system trees and the parents of home folders. */
const SYSTEM_DIRS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var',
  '/private',
  '/System',
  '/Library',
  '/Applications',
  '/cores',
];
/** Folders that only hold other people's or other disks' folders: never offered themselves, their children are. */
const CONTAINER_DIRS = ['/Users', '/home', '/Volumes', '/mnt', '/media', '/srv', '/tmp'];

function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Why a folder is not offered for uploads, or null when it is a reasonable project folder: never the home folder,
 * the root or anything above home, a system tree, a hidden folder or Library in home, a folder the sensitive-file
 * rules cover (`.ssh`, `.aws`, …), or AgentDrop's own config, state and data folders.
 */
export function uploadFolderProblem(dir: string, home: string = homedir()): string | null {
  let path: string;
  try {
    path = realpathSync.native(dir);
    if (!statSync(path).isDirectory()) return 'not a folder';
  } catch {
    return 'not readable';
  }
  const homeReal = real(home);
  if (path === sep || /^[A-Za-z]:\\?$/.test(path)) return 'root';
  if (path === homeReal) return 'home';
  if (inside(homeReal, path)) return 'above home';
  if (CONTAINER_DIRS.some((d) => path === d || path === real(d))) return 'container';
  if (!inside(path, homeReal) && SYSTEM_DIRS.some((d) => inside(path, d) || inside(path, real(d))))
    return 'system';
  if (/^[A-Za-z]:\\(Windows|Program Files)/i.test(path)) return 'system';
  if (inside(path, homeReal)) {
    const first = path.slice(homeReal.length).split(sep).filter(Boolean)[0] ?? '';
    if (first.startsWith('.') || first === 'Library' || first === 'AppData') return 'hidden';
  }
  if (isSensitivePath(join(path, 'file')) || isSensitivePath(path)) return 'sensitive';
  if ([configDir(), stateDir(), dataDir()].some((d) => inside(path, real(d)) || inside(real(d), path)))
    return 'agentdrop';
  return null;
}

/**
 * After pairing, offers the folder setup runs in for uploads (ADR 0032 notes why it lives here): people run setup
 * from the project they want to share from, and without an allowed folder every upload is refused. Asked only at
 * an interactive terminal (default yes); `--allow-current-dir` / `--no-allow-current-dir` decide without asking.
 * Applies to every profile set up now that does not already allow it. Downloads are untouched.
 */
async function offerCurrentFolder(out: Output, opts: SetupOptions, connected: Harness[]): Promise<void> {
  if (opts.allowCurrentDir === false) return;
  const t = translator();
  const cwd = real(opts.cwd ?? process.cwd());
  if (uploadFolderProblem(cwd)) {
    if (opts.allowCurrentDir)
      out.warn(
        t(
          `${cwd} is not a project folder (home, system, hidden or key folders are never allowed as a whole); agentdrop allow-dir add <folder> allows another one.`,
          `${cwd} 不是项目文件夹（主目录、系统、隐藏或密钥文件夹不能整体允许）；可用 agentdrop allow-dir add <文件夹> 允许别的文件夹。`,
        ),
      );
    return;
  }
  const profiles = connected
    .map((h) => readProfile(harnessAdapter(h).profile))
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .filter((p) => !p.allowed_dirs.some((d) => inside(cwd, real(d))));
  if (profiles.length === 0) return;
  if (opts.allowCurrentDir === undefined) {
    const answer = await (opts.ask ?? askTerminal)(
      t(`Let your agents upload files from ${cwd}? [Y/n] `, `允许你的 Agent 从 ${cwd} 上传文件吗？[Y/n] `),
    );
    if (answer === null) return;
    if (/^\s*(n|no|否|不)/i.test(answer)) {
      out.info(
        t(
          'Not allowed. Allow a folder any time: agentdrop allow-dir add <folder>',
          '未允许。之后随时可以允许文件夹：agentdrop allow-dir add <文件夹>',
        ),
      );
      return;
    }
  }
  for (const p of profiles) writeProfile({ ...p, allowed_dirs: [...p.allowed_dirs, cwd] });
  out.info(
    t(
      `Your agents may upload files from ${cwd} (key and credential files never). Downloads still go to the AgentDrop downloads folder.`,
      `你的 Agent 可以从 ${cwd} 上传文件（密钥和凭据文件除外）。下载的文件仍放在 AgentDrop 下载文件夹。`,
    ),
  );
}

/** One question at a real terminal; null when stdin or stderr is not one (scripts, CI, an agent's shell tool). */
export async function askTerminal(question: string): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(terminalText(question));
  } finally {
    rl.close();
  }
}

function whichBin(bin: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* headless: the URL was printed already */
  }
}
