import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/* The companion skill tells agents how a person gets back into a forgotten account (ADR 0036) without doing it. */
const root = join(import.meta.dirname, '..', 'skill', 'agentdrop');
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
const troubleshooting = readFileSync(join(root, 'reference', 'troubleshooting.md'), 'utf8');

describe('skill: a forgotten AgentDrop password', () => {
  const start = skill.indexOf('## A forgotten AgentDrop password');
  const section = skill.slice(start, skill.indexOf('\n## ', start + 1));

  it('has its own section with every way back in, in order', () => {
    expect(start).toBeGreaterThan(0);
    const order = ['agentdrop account recover', 'recovery codes', 'Forgot password', 'administrator'].map(
      (w) => section.indexOf(w),
    );
    for (const i of order) expect(i).toBeGreaterThan(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('never lets the agent run the command, get around the terminal check, or touch codes and links', () => {
    expect(section).toContain('Never run this command yourself');
    expect(section).toMatch(/pseudo-terminal, `script`, `expect`/);
    expect(section).toContain('Never ask the user for their password, recovery codes or a reset link');
    expect(section).toContain('never open a reset link yourself');
  });

  it('is reachable from troubleshooting', () => {
    expect(troubleshooting).toContain('A forgotten AgentDrop password');
    expect(troubleshooting).toContain('Never run the');
  });
});
