import { describe, expect, it } from 'vitest';
import { dropPayloadV1Schema } from './drop.js';
import { hasNoControlChars } from './limits.js';
import { displayNameSchema, remarkSchema } from './names.js';

// Written as escapes on purpose: the characters under test would reorder this file's own text in an editor.
describe('hasNoControlChars', () => {
  it('rejects control characters and bidi embeddings, overrides and isolates', () => {
    expect(hasNoControlChars('plain name')).toBe(true);
    expect(hasNoControlChars('a\u0007b')).toBe(false);
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])
      expect(hasNoControlChars(`invoice${String.fromCodePoint(cp)}fdp.exe`), cp.toString(16)).toBe(false);
  });

  it('keeps what real names need: joiners in emoji, CJK, accents, right-to-left scripts', () => {
    expect(hasNoControlChars('\u{1F469}\u200D\u{1F4BB} 王同学 Zoë')).toBe(true);
    expect(hasNoControlChars('עברית and العربية')).toBe(true);
    expect(hasNoControlChars('\u200Dx\u200C')).toBe(true);
  });

  it('applies to names, remarks and titles', () => {
    expect(displayNameSchema.safeParse('Alice\u202Eecila').success).toBe(false);
    expect(displayNameSchema.safeParse('\u{1F468}\u200D\u{1F469}\u200D\u{1F467} family').success).toBe(true);
    expect(remarkSchema.safeParse('boss\u2066').success).toBe(false);
    const payload = (title: string) =>
      dropPayloadV1Schema.safeParse({
        payload_version: 1,
        kind: 'text',
        title,
        body: 'x',
        attachment_ids: [],
        extensions: {},
      }).success;
    expect(payload('report \u2067final\u2069')).toBe(false);
    expect(payload('report final')).toBe(true);
  });
});
