import { AgentDropError } from '@agentdrop/contracts';
import type { PasswordResetTarget } from '@agentdrop/domain';
import { PASSWORD_RESET_TTL_S, resetLinkCapture } from './auth.js';
import type { AppContext } from './context.js';

/**
 * A one-time password reset link for an account whose reset was already prepared (older links retired, audited
 * by the caller). Better Auth makes the token; the link is captured instead of mailed and returned exactly once.
 * Shared by the administrator's reset link and the self-service recovery paths (ADR 0036).
 */
export async function issueResetLink(
  ctx: AppContext,
  target: PasswordResetTarget,
): Promise<{ url: string; expires_at: string }> {
  const capture: { link?: string } = {};
  await resetLinkCapture.run(capture, () =>
    ctx.auth.api.requestPasswordReset({ body: { email: target.email } }),
  );
  if (!capture.link) throw new AgentDropError('INTERNAL', 'reset link was not generated');
  return { url: capture.link, expires_at: new Date(Date.now() + PASSWORD_RESET_TTL_S * 1000).toISOString() };
}
