import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const skill = readFileSync(new URL('../skill/agentdrop/SKILL.md', import.meta.url), 'utf8');

describe('AgentDrop skill routing boundary', () => {
  it('puts a negative scope gate before every operational workflow', () => {
    const gate = skill.indexOf('## Scope gate');
    const send = skill.indexOf('## Send a handoff');
    expect(gate).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(gate);
    expect(skill).toContain('The bare words `drop` or `drops` are **not** AgentDrop triggers.');
    expect(skill).toContain('Never call `list_drops`');
    expect(skill).toContain('`directory_lookup`');
  });

  it.each(['package', 'dependency', 'repository', 'database `DROP`', 'dropdown UI', 'class', 'type'])(
    'names %s as a non-AgentDrop context',
    (context) => {
      expect(skill.toLowerCase()).toContain(context.toLowerCase());
    },
  );

  it('requires an explicit product or mailbox intent', () => {
    expect(skill).toContain('the user explicitly says `AgentDrop`');
    expect(skill).toContain('to a person, handle, named Agent, or AgentDrop group');
    expect(skill).toContain('work received through the AgentDrop mailbox');
  });
});
