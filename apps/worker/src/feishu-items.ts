import type { FeishuItem } from '@agentdrop/domain';
import type { DropNotificationAudience, EligibleRecipient } from './push.js';

/**
 * The notice for one person about one drop, from the drop's notification audience: the group it reached them
 * through, a mention, and the drop it answers with the progress the reply gives, only where they may read it. Used
 * for the first notice and again whenever the app's card is redrawn (ADR 0039). Without a recipient entry (they
 * muted the group since, or the audience no longer lists them) the notice names only the sender and the title.
 */
export function dropNoticeItem(
  audience: DropNotificationAudience | null,
  recipient: EligibleRecipient | undefined,
  link: string | null,
): Extract<FeishuItem, { kind: 'drop' }> {
  return {
    kind: 'drop',
    fromName: audience?.sender.displayName ?? '',
    fromHandle: audience?.sender.handle ?? '',
    group: recipient?.group ?? null,
    mentioned: recipient?.mentioned ?? false,
    replyTo: recipient?.replyTo ?? null,
    progress: recipient?.replyTo ? (audience?.progress ?? null) : null,
    title: audience?.title ?? '',
    link,
  };
}
