import { LIMITS } from '@agentdrop/contracts';
import { describe, expect, it } from 'vitest';
import { replyHref, replyRecipient, replyTitle, TITLE_MAX_CHARS } from './reply.js';

const author = { user_id: 'u', handle: 'wang', display_label: 'Wang', public_name: null, public_email: null };
const core = { group_id: 'g', display_name: 'Core team', slug: 'core' };

describe('replyTitle', () => {
  it('uses the server title cap', () => expect(TITLE_MAX_CHARS).toBe(LIMITS.TITLE_MAX_CHARS));
  it('prefixes once and stays within the title cap', () => {
    expect(replyTitle('Budget')).toBe('Re: Budget');
    expect(replyTitle('Re: Budget')).toBe('Re: Budget');
    expect(replyTitle('RE: Budget')).toBe('RE: Budget');
    expect(replyTitle('x'.repeat(LIMITS.TITLE_MAX_CHARS))).toHaveLength(LIMITS.TITLE_MAX_CHARS);
    // 155 code units of "x", then an emoji straddling the cut: dropped whole
    expect(replyTitle(`${'x'.repeat(155)}😀`)).toBe(`Re: ${'x'.repeat(155)}`);
  });
});

describe('replyRecipient', () => {
  it('answers in the group when the drop came only through it', () => {
    expect(replyRecipient({ sources: ['group'], group_labels: [core], author })).toBe('#core');
  });
  it('answers the author when it was also sent directly, or the group is unknown', () => {
    expect(replyRecipient({ sources: ['direct', 'group'], group_labels: [core], author })).toBe('@wang');
    expect(replyRecipient({ sources: ['direct'], author })).toBe('@wang');
    expect(replyRecipient({ sources: ['group'], group_labels: [], author })).toBe('@wang');
  });
  it('builds the composer link', () => {
    expect(replyHref({ drop_id: 'd1', sources: ['group'], group_labels: [core], author })).toBe(
      '/app/compose?to=%23core&reply=d1',
    );
  });
});
