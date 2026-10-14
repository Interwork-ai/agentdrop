import { expect, it } from 'vitest';
import { isAssistant, personName } from './people.js';

const en = (e: string, _z: string) => e;
const zh = (_e: string, z: string) => z;

it('shows the built-in assistant in the reader language and everyone else as named', () => {
  expect(personName({ handle: 'agentdrop' }, 'AgentDrop Assistant', zh)).toBe('AgentDrop 助手');
  expect(personName({ handle: 'agentdrop' }, 'AgentDrop 助手', en)).toBe('AgentDrop Assistant');
  expect(personName({ handle: 'x', is_system: true }, 'whatever', en)).toBe('AgentDrop Assistant');
  expect(personName({ handle: 'alice' }, 'Alice', zh)).toBe('Alice');
  expect(isAssistant({ handle: '@agentdrop' })).toBe(true);
  expect(isAssistant({ handle: 'agentdrop2' })).toBe(false);
});
