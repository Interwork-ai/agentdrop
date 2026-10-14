import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

/*
 * Whether a completion hook runs where a person can see its notice. A notice is announced once per account
 * (ADR 0007), so a turn that ends in a script, CI job or batch run would use up the announcement and the person at
 * their terminal would never see it. Only a run that is clearly unattended is skipped; anything unclear is treated
 * as attended, which is how every run was treated before.
 *
 * Signals, checked against the hosts:
 * - Claude Code sets CLAUDE_CODE_SESSION_ATTENDED=1 in interactive sessions and 0 in `claude -p` runs; older
 *   versions only distinguish CLAUDE_CODE_ENTRYPOINT (`cli` interactive, `sdk-*` for print mode and the SDKs).
 * - Codex gives a hook no environment or input field that marks `codex exec` (openai/codex rust-v0.159.3: hook
 *   processes replay Codex's own start-up environment, and Stop input has no session source). Its exec runs do fire
 *   trusted Stop hooks, so the hook looks for the `codex` process among its ancestors and reads its subcommand.
 * - AGENTDROP_UNATTENDED=1 (or 0) lets a script or CI job say so explicitly, for any host.
 */

export type ProcessLookup = (pid: number) => { ppid: number; args: string } | null;

/** One `ps` per ancestor; a few milliseconds each, well inside the hook budget. */
const psLookup: ProcessLookup = (pid) => {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = /^(\d+)\s+(.*)$/s.exec(out);
    return match ? { ppid: Number(match[1]), args: match[2] ?? '' } : null;
  } catch {
    return null;
  }
};

/** Codex options that take a value before the subcommand (`codex -c key=value exec …`). */
const CODEX_VALUE_FLAGS = new Set([
  '-c',
  '--config',
  '-m',
  '--model',
  '-p',
  '--profile',
  '-C',
  '--cd',
  '-s',
  '--sandbox',
  '-a',
  '--ask-for-approval',
  '-i',
  '--image',
  '--enable',
  '--disable',
  '--add-dir',
  '--local-provider',
]);

/**
 * Whether a command line is a non-interactive `codex exec` (alias `e`). `ps` joins arguments with spaces, so a
 * prompt with spaces splits into words; only the first positional argument counts, which is the subcommand for
 * `codex exec …` and the start of the prompt for an interactive `codex "…"`.
 */
export function isCodexExec(args: string): boolean {
  const words = args.trim().split(/\s+/);
  const exe = basename(words[0] ?? '');
  if (exe !== 'codex' && !/^codex-[\w.-]+$/.test(exe)) return false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i] ?? '';
    if (word.startsWith('-')) {
      if (CODEX_VALUE_FLAGS.has(word)) i++;
      continue;
    }
    return word === 'exec' || word === 'e';
  }
  return false;
}

export function unattendedHookRun(
  env: NodeJS.ProcessEnv = process.env,
  lookup: ProcessLookup = psLookup,
  startPid: number = process.ppid,
): boolean {
  if (env.AGENTDROP_UNATTENDED === '1') return true;
  if (env.AGENTDROP_UNATTENDED === '0') return false;
  if (env.CLAUDE_CODE_SESSION_ATTENDED === '0') return true;
  if (env.CLAUDE_CODE_SESSION_ATTENDED === '1') return false;
  if (env.CLAUDECODE === '1') return (env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk');
  // Codex runs the hook as `$SHELL -lc <command>`: the codex process is a few ancestors up.
  let pid = startPid;
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    const p = lookup(pid);
    if (!p) return false;
    const exe = basename(p.args.trim().split(/\s+/)[0] ?? '');
    if (exe === 'codex' || /^codex-[\w.-]+$/.test(exe)) return isCodexExec(p.args);
    pid = p.ppid;
  }
  return false;
}
