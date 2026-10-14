import { describe, expect, it } from 'vitest';
import { isCodexExec, type ProcessLookup, unattendedHookRun } from './hook-attendance.js';

/** A fake process table: pid → [ppid, args]. */
function table(rows: Record<number, [number, string]>): ProcessLookup {
  return (pid) => {
    const row = rows[pid];
    return row ? { ppid: row[0], args: row[1] } : null;
  };
}
const none: ProcessLookup = () => null;

describe('isCodexExec', () => {
  it('recognises exec and its alias, after options that take a value', () => {
    expect(isCodexExec('codex exec --json run the tests')).toBe(true);
    expect(isCodexExec('/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex/codex e fix it')).toBe(
      true,
    );
    expect(isCodexExec('codex -c model="o4" -s workspace-write exec do it')).toBe(true);
    expect(isCodexExec('codex-aarch64-apple-darwin exec resume --last')).toBe(true);
  });
  it('treats an interactive session as attended, even when the prompt says exec', () => {
    expect(isCodexExec('codex')).toBe(false);
    expect(isCodexExec('codex resume --last')).toBe(false);
    // `ps` loses the quotes: `codex "fix the exec bug"` arrives as words; the first one is not a subcommand
    expect(isCodexExec('codex fix the exec bug')).toBe(false);
    expect(isCodexExec('codex app-server')).toBe(false);
    expect(isCodexExec('node /usr/local/bin/exec-runner')).toBe(false);
  });
});

describe('unattendedHookRun', () => {
  it('follows Claude Code: attended 1 or 0, else the sdk entrypoints of older versions', () => {
    expect(unattendedHookRun({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ATTENDED: '1' }, none)).toBe(false);
    expect(unattendedHookRun({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ATTENDED: '0' }, none)).toBe(true);
    expect(unattendedHookRun({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, none)).toBe(true);
    expect(unattendedHookRun({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }, none)).toBe(false);
  });
  it('finds a codex exec among the ancestors (the hook runs under $SHELL -lc)', () => {
    const exec = table({ 40: [30, '/bin/zsh -lc agentdrop pending --in-hook'], 30: [1, 'codex exec go'] });
    const tui = table({ 40: [30, '/bin/zsh -lc agentdrop pending --in-hook'], 30: [1, 'codex'] });
    expect(unattendedHookRun({}, exec, 40)).toBe(true);
    expect(unattendedHookRun({}, tui, 40)).toBe(false);
  });
  it('is attended when nothing says otherwise, and AGENTDROP_UNATTENDED decides first', () => {
    const vitest = table({ 40: [30, 'node vitest'], 30: [1, 'pnpm test'] });
    expect(unattendedHookRun({}, vitest, 40)).toBe(false);
    expect(unattendedHookRun({}, none, 40)).toBe(false);
    expect(unattendedHookRun({ AGENTDROP_UNATTENDED: '1', CLAUDE_CODE_SESSION_ATTENDED: '1' }, none)).toBe(
      true,
    );
    const exec = table({ 40: [1, 'codex exec go'] });
    expect(unattendedHookRun({ AGENTDROP_UNATTENDED: '0' }, exec, 40)).toBe(false);
  });
});
