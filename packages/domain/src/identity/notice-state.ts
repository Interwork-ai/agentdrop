import { AgentDropError, mergeNoticeState, type NoticeState, noticeStateSchema } from '@agentdrop/contracts';
import { appUsers, type Tx } from '@agentdrop/db';
import { eq } from 'drizzle-orm';

/**
 * What end-of-turn notices have already shown this person, kept per account so every agent shares it (ADR 0007).
 * Last write wins: two agents finishing a turn at the same moment can at worst announce the same item twice.
 */
export async function getNoticeState(tx: Tx, userId: string): Promise<{ state: NoticeState | null }> {
  const user = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, userId) });
  if (!user) throw new AgentDropError('NOT_FOUND', 'user not found');
  const parsed = noticeStateSchema.safeParse(user.noticeState);
  return { state: parsed.success ? parsed.data : null };
}

/**
 * The race-free way to announce (ADR 0007): the account row is locked, the current pending items are merged into
 * the record, and the record from before is returned. Two agents finishing a turn at the same moment — on any
 * machine — serialize here, so an item is new for exactly one of them.
 */
export async function claimNoticeState(
  tx: Tx,
  userId: string,
  current: NoticeState,
): Promise<{ previous: NoticeState | null }> {
  const valid = noticeStateSchema.parse(current);
  const [user] = await tx.select().from(appUsers).where(eq(appUsers.id, userId)).for('update');
  if (!user) throw new AgentDropError('NOT_FOUND', 'user not found');
  const parsed = noticeStateSchema.safeParse(user.noticeState);
  const previous = parsed.success ? parsed.data : null;
  await tx
    .update(appUsers)
    .set({ noticeState: mergeNoticeState(previous, valid) })
    .where(eq(appUsers.id, userId));
  return { previous };
}

/**
 * What this person has already seen inside an agent session (prompt submit / session start), kept per account and
 * separate from the record above: browser push and Feishu never write it, so an item they delivered is still shown
 * once in an agent.
 */
export async function getSeenNoticeState(tx: Tx, userId: string): Promise<{ state: NoticeState | null }> {
  const user = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, userId) });
  if (!user) throw new AgentDropError('NOT_FOUND', 'user not found');
  const parsed = noticeStateSchema.safeParse(user.noticeSeenState);
  return { state: parsed.success ? parsed.data : null };
}

/**
 * Like claimNoticeState, for the "seen in an agent" record: the account row is locked, the previous seen record is
 * returned and `current` is merged into it, so of concurrent claims only one sees an item as new. `current` is also
 * merged into the shared "already shown" record, so older CLIs and the push/Feishu dedupe treat it as shown.
 */
export async function claimSeenNoticeState(
  tx: Tx,
  userId: string,
  current: NoticeState,
): Promise<{ previous: NoticeState | null }> {
  const valid = noticeStateSchema.parse(current);
  const [user] = await tx.select().from(appUsers).where(eq(appUsers.id, userId)).for('update');
  if (!user) throw new AgentDropError('NOT_FOUND', 'user not found');
  const seen = noticeStateSchema.safeParse(user.noticeSeenState);
  const previous = seen.success ? seen.data : null;
  const shown = noticeStateSchema.safeParse(user.noticeState);
  await tx
    .update(appUsers)
    .set({
      noticeSeenState: mergeNoticeState(previous, valid),
      noticeState: mergeNoticeState(shown.success ? shown.data : null, valid),
    })
    .where(eq(appUsers.id, userId));
  return { previous };
}

export async function putNoticeState(
  tx: Tx,
  userId: string,
  state: NoticeState,
): Promise<{ state: NoticeState }> {
  const valid = noticeStateSchema.parse(state);
  await tx.update(appUsers).set({ noticeState: valid }).where(eq(appUsers.id, userId));
  return { state: valid };
}

/**
 * Claims one item for a server-side channel (Feishu): true when it had not been announced yet and is now recorded
 * as shown; false when some channel already announced it. The account row lock serializes this with the agents'
 * claims, so the item goes out once. Call releaseNoticeItem when sending then fails.
 */
export async function claimNoticeItem(
  tx: Tx,
  userId: string,
  list: 'drops' | 'contacts' | 'invitations' | 'join_requests',
  key: string,
): Promise<boolean> {
  const [user] = await tx.select().from(appUsers).where(eq(appUsers.id, userId)).for('update');
  if (!user) return false;
  const parsed = noticeStateSchema.safeParse(user.noticeState);
  const state: NoticeState = parsed.success
    ? parsed.data
    : { drops: [], contacts: [], invitations: [], join_requests: [], approvals: 0 };
  if (state[list].includes(key)) return false;
  const next = { ...state, [list]: [...state[list], key].slice(list === 'drops' ? -500 : -200) };
  await tx.update(appUsers).set({ noticeState: next }).where(eq(appUsers.id, userId));
  return true;
}

export async function releaseNoticeItem(
  tx: Tx,
  userId: string,
  list: 'drops' | 'contacts' | 'invitations' | 'join_requests',
  key: string,
): Promise<void> {
  const [user] = await tx.select().from(appUsers).where(eq(appUsers.id, userId)).for('update');
  const parsed = noticeStateSchema.safeParse(user?.noticeState);
  if (!user || !parsed.success) return;
  await tx
    .update(appUsers)
    .set({ noticeState: { ...parsed.data, [list]: parsed.data[list].filter((k) => k !== key) } })
    .where(eq(appUsers.id, userId));
}
