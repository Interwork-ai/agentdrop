/** Mirrors LIMITS.TITLE_MAX_CHARS in @agentdrop/contracts (the web bundle imports it type-only). */
const TITLE_MAX_CHARS = 160;
/** Derived titles stop shorter than typed ones (docs/PRODUCT_PRINCIPLES.md §7). */
const DERIVED_TITLE_CHARS = 80;

/** Cuts by characters (not UTF-16 units) and marks the cut. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * The title of a My space item, which nobody has to type (docs/PRODUCT_PRINCIPLES.md §6): the first file's name
 * ("+N" for the rest), else the note's first line; empty when there is neither.
 */
export function spaceTitle(files: Array<{ safe_name: string }>, note: string): string {
  const first = files[0];
  if (first) {
    const more = files.length - 1;
    const suffix = more > 0 ? ` +${more}` : '';
    return clip(first.safe_name, DERIVED_TITLE_CHARS - suffix.length) + suffix;
  }
  const line = note
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return line ? clip(line, Math.min(DERIVED_TITLE_CHARS, TITLE_MAX_CHARS)) : '';
}
