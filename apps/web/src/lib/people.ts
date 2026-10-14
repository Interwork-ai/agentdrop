import type { Translate } from './lang.js';

/**
 * The built-in assistant (packages/domain system-assistant.ts): a reserved handle no person can register. Its
 * stored name is one neutral spelling ("AgentDrop Assistant"); the dashboard shows it in the reader's language.
 */
export const ASSISTANT_HANDLE = 'agentdrop';

export function isAssistant(p: { handle?: string | null; is_system?: boolean | null }): boolean {
  return p.is_system === true || p.handle?.replace(/^@/, '') === ASSISTANT_HANDLE;
}

export const assistantName = (t: Translate): string => t('AgentDrop Assistant', 'AgentDrop 助手');

/** The name to show for a person: the assistant's in the reader's language, anyone else's as the server gives it. */
export function personName(
  p: { handle?: string | null; is_system?: boolean | null },
  name: string,
  t: Translate,
): string {
  return isAssistant(p) ? assistantName(t) : name;
}
