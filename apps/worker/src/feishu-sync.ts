import { type Database, feishuAccounts, feishuCards } from '@agentdrop/db';
import { type FeishuAppConfig, feishuNoticeCard, personDropState, updateFeishuCard } from '@agentdrop/domain';
import { and, eq, gt, lt } from 'drizzle-orm';
import { dropNoticeItem } from './feishu-items.js';
import { resolveDropNotificationAudience } from './push.js';

/** Feishu lets the app change a card for 14 days after sending it. */
const CARD_LIFETIME_MS = 14 * 86_400_000;

/**
 * Cards follow the person's state (ADR 0039): a card still showing a drop as unread whose drop the person has read
 * elsewhere (dashboard, agent, terminal) is redrawn as read, and a star changed elsewhere is shown too. Runs every
 * minute in the worker; returns how many cards it changed. Cards older than Feishu's 14 days are forgotten.
 */
export async function syncFeishuCards(
  db: Database,
  app: FeishuAppConfig,
  options: { dashboard: string | null; fetch: typeof fetch; limit?: number; now?: Date },
): Promise<number> {
  const now = options.now ?? new Date();
  const oldest = new Date(now.getTime() - CARD_LIFETIME_MS);
  await db.drizzle.delete(feishuCards).where(lt(feishuCards.createdAt, oldest));
  const rows = await db.drizzle
    .select({ card: feishuCards, language: feishuAccounts.language })
    .from(feishuCards)
    .innerJoin(feishuAccounts, eq(feishuAccounts.userId, feishuCards.userId))
    .where(
      and(
        eq(feishuAccounts.appId, app.appId),
        eq(feishuCards.shownRead, false),
        gt(feishuCards.createdAt, oldest),
      ),
    )
    .orderBy(feishuCards.createdAt)
    .limit(options.limit ?? 200);
  const dashboard = options.dashboard?.replace(/\/$/, '') ?? null;
  let changed = 0;
  for (const { card, language } of rows) {
    const state = await personDropState(db.drizzle, card.userId, card.dropId);
    if (!state || (state.read === card.shownRead && state.starred === card.shownStarred)) continue;
    const audience = await resolveDropNotificationAudience(db.drizzle, card.dropId);
    const recipient = audience?.recipients.find((r) => r.userId === card.userId);
    const link = dashboard
      ? `${dashboard}/app/inbox/${encodeURIComponent(card.dropId)}?h=${encodeURIComponent(card.hId)}`
      : null;
    const redrawn = feishuNoticeCard(
      dropNoticeItem(audience, recipient, link),
      language === 'zh' ? 'zh' : 'en',
      {
        dropId: card.dropId,
        read: state.read,
        starred: state.starred,
      },
    );
    const result = await updateFeishuCard(app, card.messageId, redrawn, options.fetch);
    // a card Feishu no longer lets us change (too old, deleted) is forgotten rather than retried every minute
    if (!result.ok && result.code !== 230031 && result.code !== 230011) continue;
    await db.drizzle
      .update(feishuCards)
      .set(result.ok ? { shownRead: state.read, shownStarred: state.starred } : { shownRead: true })
      .where(and(eq(feishuCards.userId, card.userId), eq(feishuCards.dropId, card.dropId)));
    if (result.ok) changed += 1;
  }
  return changed;
}
