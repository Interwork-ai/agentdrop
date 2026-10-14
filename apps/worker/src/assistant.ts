import { type Database, withTx } from '@agentdrop/db';
import { type AssistantReplyOutcome, replyAsAssistant } from '@agentdrop/domain';
import type { DeliveryProgress } from './outbox.js';

export const ASSISTANT_PROGRESS_KEY = 'assistant:echo';

/**
 * `drop.delivered` side effect: when a drop was addressed directly to the built-in @agentdrop assistant, it answers
 * the sending agent with one receipt. Safe to replay: progress skips a finished run, and the reply's request_id
 * (`echo:<drop id>`) makes a second send a no-op even if the progress write was lost.
 */
export async function runAssistantEcho(
  db: Database,
  dropId: string,
  payload: Record<string, unknown>,
  progress: DeliveryProgress,
  reply: (dropId: string) => Promise<AssistantReplyOutcome> = (id) =>
    withTx(db, (tx) => replyAsAssistant(tx, id)),
): Promise<AssistantReplyOutcome | null> {
  if (progress.done(ASSISTANT_PROGRESS_KEY)) return null;
  // cheap pre-filter: nothing to do unless some recipient could be the assistant
  if (Array.isArray(payload.user_ids) && payload.user_ids.length === 0) return null;
  const outcome = await reply(dropId);
  await progress.markDone(ASSISTANT_PROGRESS_KEY);
  return outcome;
}
