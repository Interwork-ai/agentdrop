import { describe, expect, it } from 'vitest';
import { buildProgram } from '../main.js';

function groupCommand() {
  const group = buildProgram().commands.find((c) => c.name() === 'group');
  if (!group) throw new Error('the group command group is missing');
  return group;
}

describe('agentdrop group', () => {
  it('registers the subcommands users need to run a group from the terminal', () => {
    expect(
      groupCommand()
        .commands.map((c) => c.name())
        .sort(),
    ).toEqual(['create', 'invite', 'leave', 'list', 'requests']);
  });

  it('declares --profile on every leaf, which is what triggers the settings sync hook', () => {
    for (const sub of groupCommand().commands) {
      const flags = sub.options.map((o) => o.long);
      expect(flags, `${sub.name()} must take --profile`).toContain('--profile');
      expect(sub.options.find((o) => o.long === '--profile')?.required).toBe(true);
    }
  });

  it('accepts several handles at once for create and invite', () => {
    const create = groupCommand().commands.find((c) => c.name() === 'create');
    expect(create?.options.find((o) => o.long === '--invite')?.flags).toContain('<handles...>');
    const invite = groupCommand().commands.find((c) => c.name() === 'invite');
    // <group> then a variadic handle list
    expect(invite?.registeredArguments.map((a) => a.variadic)).toEqual([false, true]);
  });

  /*
   * Approving a join request admits somebody to every other member's mailbox. That is not a self-scoped action,
   * so it lives on a browser session only; the CLI may report the queue but must never offer to decide it.
   */
  it('offers no way to approve or reject a join request', () => {
    const names = groupCommand().commands.map((c) => c.name());
    expect(names).not.toContain('approve');
    expect(names).not.toContain('reject');
    expect(names).not.toContain('decide');
    expect(
      groupCommand()
        .commands.find((c) => c.name() === 'requests')
        ?.description(),
    ).toContain('dashboard');
  });
});
