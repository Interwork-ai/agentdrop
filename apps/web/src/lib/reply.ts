import type { DropSummary } from './api.js';

/** Mirrors `LIMITS.TITLE_MAX_CHARS` (a test checks it); the web bundle keeps @agentdrop/contracts type-only. */
export const TITLE_MAX_CHARS = 160;

/**
 * The title of a reply: "Re: <original>", in one neutral spelling for every reader (a title is shared data,
 * docs/PRODUCT_PRINCIPLES.md #8), never prefixed twice, and within the title cap.
 */
export function replyTitle(original: string): string {
  const title = /^re:\s/i.test(original) ? original : `Re: ${original}`;
  // the server counts UTF-16 units; never leave half of a surrogate pair at the cut
  const cut = title.slice(0, TITLE_MAX_CHARS);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Whom a reply goes to, as a composer `?to=` value: the group when the drop reached me only through a group (as
 * every surface classifies it: a direct copy wins), otherwise its author as a person. Names the person by @handle
 * and the group by #slug, which the composer resolves through the directory.
 */
export function replyRecipient(d: Pick<DropSummary, 'sources' | 'group_labels' | 'author'>): string {
  const viaGroupOnly = d.sources.includes('group') && !d.sources.includes('direct');
  const slug = viaGroupOnly ? d.group_labels?.[0]?.slug : undefined;
  return slug ? `#${slug}` : `@${d.author.handle}`;
}

/** The composer URL for replying to a drop. */
export function replyHref(d: Pick<DropSummary, 'drop_id' | 'sources' | 'group_labels' | 'author'>): string {
  return `/app/compose?to=${encodeURIComponent(replyRecipient(d))}&reply=${encodeURIComponent(d.drop_id)}`;
}
