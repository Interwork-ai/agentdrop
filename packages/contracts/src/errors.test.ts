import { expect, it } from 'vitest';
import { ERROR_CODES } from './errors.js';

it('writes next_action for the calling agent: human-only steps are things to tell the user', () => {
  for (const [code, def] of Object.entries(ERROR_CODES)) {
    // A model cannot open a dashboard or a browser or type in the user's terminal; it can only relay that step.
    for (const sentence of def.next_action.split(/(?<=[.;])\s+/)) {
      if (/dashboard|browser|`agentdrop /.test(sentence))
        expect(sentence, code).toMatch(/tell the user|give the user|ask the user/i);
    }
  }
});
