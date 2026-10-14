import { AgentDropError } from '@agentdrop/contracts';
import { appUsers, authUsers, authVerifications, type Tx } from '@agentdrop/db';
import { and, eq, like } from 'drizzle-orm';
import { recordAudit } from '../audit.js';

export interface PasswordResetTarget {
  userId: string;
  authUserId: string;
  handle: string;
  email: string;
}

/**
 * First half of an administrator-generated reset link: checks the account may be reset and retires any reset link
 * still outstanding for it, so only the link about to be handed over works. Closed accounts and the built-in
 * assistant have no password to reset.
 */
export async function adminPreparePasswordReset(tx: Tx, userId: string): Promise<PasswordResetTarget> {
  const user = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, userId) });
  if (!user) throw new AgentDropError('NOT_FOUND', 'user not found');
  if (user.deletedAt) throw new AgentDropError('VALIDATION_FAILED', 'this account is already closed');
  if (user.isSystem) throw new AgentDropError('FORBIDDEN', 'the built-in assistant has no password');
  const auth = await tx.query.authUsers.findFirst({ where: eq(authUsers.id, user.authUserId) });
  if (!auth) throw new AgentDropError('NOT_FOUND', 'user not found');
  // Better Auth stores reset tokens as identifier `reset-password:<token>` with the auth user id as value
  await tx
    .delete(authVerifications)
    .where(
      and(
        eq(authVerifications.value, user.authUserId),
        like(authVerifications.identifier, 'reset-password:%'),
      ),
    );
  return { userId: user.id, authUserId: user.authUserId, handle: user.handle, email: auth.email };
}

/** Second half: the audit entry. Records who generated a link for whom, never the link or its token. */
export async function adminRecordPasswordResetLink(
  tx: Tx,
  adminUserId: string,
  target: PasswordResetTarget,
): Promise<void> {
  await recordAudit(tx, {
    actorUserId: adminUserId,
    action: 'admin.password_reset_link',
    targetId: target.userId,
    result: 'ok',
    meta: { handle: target.handle },
  });
}
