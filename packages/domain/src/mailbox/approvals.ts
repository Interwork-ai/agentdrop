import { AgentDropError, type SendEnvelope } from '@agentdrop/contracts';
import { approvals, groupMemberships, sendRequests, type Tx } from '@agentdrop/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { openApproval } from '../content/codec.js';
import { canonicalJson } from '../crypto.js';
import type { MailboxScope } from '../principals.js';
import { assertReadyAttachments, attachmentsReviewHints } from './attachments.js';
import { privateRecipients } from './recipient-privacy.js';
import {
  type ApprovalDecision,
  assertActiveOrigin,
  assertReplyTarget,
  commitDrop,
  endpointSnapshot,
  type ResolvedTargets,
  resolveTargets,
} from './send.js';

export async function defaultApprovalPolicy(
  _tx: Tx,
  _ctx: { scope: MailboxScope; envelope: SendEnvelope; resolved: ResolvedTargets },
): Promise<ApprovalDecision> {
  return { needsApproval: false, reasons: [] };
}

/** Optional stricter policy for deployments that want review-hinted attachments held for a human. */
export async function reviewHintApprovalPolicy(
  tx: Tx,
  ctx: { scope: MailboxScope; envelope: SendEnvelope; resolved: ResolvedTargets },
): Promise<ApprovalDecision> {
  const reasons: string[] = [];
  const hints = await attachmentsReviewHints(tx, ctx.envelope.payload.attachment_ids);
  for (const h of hints) reasons.push(`attachment review: ${h}`);
  return { needsApproval: reasons.length > 0, reasons };
}

export interface ApprovalView {
  approval_id: string;
  request_id: string;
  origin_h_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
  content_hash: string;
  title: string;
  body_preview: string;
  attachment_ids: string[];
  recipients: unknown;
  reasons: string[];
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

async function toView(tx: Tx, row: typeof approvals.$inferSelect): Promise<ApprovalView> {
  const { envelope: env, reasons } = openApproval<SendEnvelope>(row);
  const snap = row.targetSnapshot as { recipients?: unknown };
  return {
    approval_id: row.id,
    request_id: row.requestId,
    origin_h_id: row.originHId,
    status: row.status,
    content_hash: row.contentHash,
    title: env.payload.title,
    body_preview: env.payload.body.slice(0, 400),
    attachment_ids: env.payload.attachment_ids,
    recipients: await privateRecipients(tx, row.actorUserId, snap.recipients, row.targetSnapshot),
    reasons,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    decided_at: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

export async function listApprovals(
  tx: Tx,
  userId: string,
  status?: ApprovalView['status'],
): Promise<ApprovalView[]> {
  const rows = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.actorUserId, userId), ...(status ? [eq(approvals.status, status)] : [])))
    .orderBy(desc(approvals.createdAt))
    .limit(100);
  return Promise.all(rows.map((row) => toView(tx, row)));
}

export async function getApproval(tx: Tx, userId: string, approvalId: string): Promise<ApprovalView> {
  const row = await tx.query.approvals.findFirst({ where: eq(approvals.id, approvalId) });
  if (!row || row.actorUserId !== userId) throw new AgentDropError('NOT_FOUND', 'approval not found');
  return toView(tx, row);
}

/**
 * Human decision in the browser. Approve re-resolves the targets now; if routes/groups changed since the preview
 * the approval is refreshed and STALE_APPROVAL is returned so the human previews again. If the targets can no longer
 * be resolved at all (a mentioned member left, a member lost every receiving agent) the approval is closed as
 * expired, the send request ends not_sent, and STALE_APPROVAL is returned too. Nothing is delivered before an
 * approve that matches the current state.
 */
export async function decideApproval(
  tx: Tx,
  userId: string,
  approvalId: string,
  decision: 'approve' | 'reject',
  maxGroupRecipients: number,
): Promise<{
  status: 'delivered' | 'rejected' | 'stale' | 'expired';
  /** With `stale`: the approval was closed because its targets no longer resolve; the person sends again. */
  closed?: boolean;
  drop_id: string | null;
  recipients?: unknown;
}> {
  const [row] = await tx.select().from(approvals).where(eq(approvals.id, approvalId)).for('update');
  if (!row || row.actorUserId !== userId) throw new AgentDropError('NOT_FOUND', 'approval not found');
  const [req] = await tx
    .select()
    .from(sendRequests)
    .where(and(eq(sendRequests.originHId, row.originHId), eq(sendRequests.requestId, row.requestId)))
    .for('update');
  if (!req) throw new AgentDropError('INTERNAL', 'send request missing');
  if (row.status !== 'pending')
    throw new AgentDropError('APPROVAL_EXPIRED', `approval already ${row.status}`);
  if (row.expiresAt.getTime() <= Date.now()) {
    await tx
      .update(approvals)
      .set({ status: 'expired', decidedAt: new Date() })
      .where(eq(approvals.id, row.id));
    await tx
      .update(sendRequests)
      .set({ outcome: 'not_sent', result: notSent(row.requestId, 'approval expired'), updatedAt: new Date() })
      .where(eq(sendRequests.id, req.id));
    // returned (not thrown) so the expiry commits; the route answers APPROVAL_EXPIRED
    return { status: 'expired', drop_id: null };
  }
  const scope: MailboxScope = { userId, hId: row.originHId, via: 'user_session' };
  const { envelope } = openApproval<SendEnvelope>(row);

  if (decision === 'reject') {
    await tx
      .update(approvals)
      .set({ status: 'rejected', decidedAt: new Date() })
      .where(eq(approvals.id, row.id));
    await tx
      .update(sendRequests)
      .set({ outcome: 'not_sent', result: notSent(row.requestId, 'rejected by user'), updatedAt: new Date() })
      .where(eq(sendRequests.id, req.id));
    await recordAudit(tx, {
      actorUserId: userId,
      hId: row.originHId,
      action: 'approval.reject',
      targetId: row.id,
      result: 'ok',
      requestId: row.requestId,
    });
    return { status: 'rejected', drop_id: null };
  }

  await assertActiveOrigin(tx, scope);
  let resolved: ResolvedTargets;
  try {
    resolved = await resolveTargets(tx, scope, envelope, maxGroupRecipients);
    // the person may have lost access to the drop it answers while it was held
    await assertReplyTarget(tx, scope, envelope);
  } catch (err) {
    if (!recipientsGone(err)) throw err;
    return closeStale(err);
  }
  /*
   * The preview can never be approved as it stands (a mentioned member left, a member can no longer receive, the
   * group's file space filled up): close it instead of failing every approve until
   * it expires. Stale like a version change, but nothing is left to approve again, so the send request ends
   * not_sent and the agent sends again.
   */
  async function closeStale(err: AgentDropError) {
    if (!row || !req) throw new AgentDropError('INTERNAL');
    const now = new Date();
    await tx.update(approvals).set({ status: 'expired', decidedAt: now }).where(eq(approvals.id, row.id));
    await tx
      .update(sendRequests)
      .set({
        outcome: 'not_sent',
        result: notSent(
          row.requestId,
          err.details?.field === 'reply_to'
            ? 'the drop this answers can no longer be read; send again'
            : err.code === 'GROUP_STORAGE_FULL'
              ? "the group's file space is full; send again once a group admin has removed files, or without the files"
              : 'recipients changed since the preview; send again',
        ),
        updatedAt: now,
      })
      .where(eq(sendRequests.id, req.id));
    await recordAudit(tx, {
      actorUserId: userId,
      hId: row.originHId,
      action: 'approval.stale',
      targetId: row.id,
      result: 'conflict',
      requestId: row.requestId,
      meta: { code: err.code, closed: true },
    });
    const snap = row.targetSnapshot as { recipients?: unknown };
    // returned (not thrown) so the closed approval commits; the route answers STALE_APPROVAL
    return {
      status: 'stale' as const,
      closed: true,
      drop_id: null,
      recipients: await privateRecipients(tx, userId, snap.recipients, row.targetSnapshot),
    };
  }
  const previous = row.targetSnapshot as {
    versions?: ResolvedTargets['versions'];
    endpoints?: Array<[string, unknown[]]>;
  };
  // jsonb normalizes key order, so compare canonical encodings; the endpoint snapshot catches changes that do not
  // bump a route/group version (for example a member's endpoint being revoked)
  const same =
    canonicalJson([...(previous.versions ?? [])].sort(byId)) ===
      canonicalJson([...resolved.versions].sort(byId)) &&
    canonicalJson(previous.endpoints ?? null) === canonicalJson(endpointSnapshot(resolved));
  if (!same) {
    await tx
      .update(approvals)
      .set({
        targetSnapshot: {
          recipients: resolved.recipients,
          versions: resolved.versions,
          endpoints: endpointSnapshot(resolved),
        },
      })
      .where(eq(approvals.id, row.id));
    await recordAudit(tx, {
      actorUserId: userId,
      hId: row.originHId,
      action: 'approval.stale',
      targetId: row.id,
      result: 'conflict',
      requestId: row.requestId,
    });
    // returned (not thrown) so the refreshed snapshot commits; the route answers STALE_APPROVAL
    return { status: 'stale', drop_id: null, recipients: resolved.recipients };
  }
  // A held file deleted meanwhile (removed by a group admin, or with an item of the sender's own space) fails the
  // commit with ATTACHMENT_NOT_READY: nothing is delivered and the approval stays for the person to reject.
  await assertReadyAttachments(tx, scope, envelope.payload.attachment_ids);
  const result = await commitDrop(tx, scope, envelope, resolved, row.originKind, {
    hash: row.contentHash,
    version: row.hashVersion,
  });
  await tx
    .update(approvals)
    .set({ status: 'consumed', decidedAt: new Date() })
    .where(eq(approvals.id, row.id));
  await tx
    .update(sendRequests)
    .set({ outcome: 'delivered', resultDropId: result.dropId, result, updatedAt: new Date() })
    .where(eq(sendRequests.id, req.id));
  await recordAudit(tx, {
    actorUserId: userId,
    hId: row.originHId,
    action: 'approval.approve',
    targetId: row.id,
    result: 'ok',
    requestId: row.requestId,
  });
  return { status: 'delivered', drop_id: result.dropId };
}

/**
 * Target errors that mean the approved preview no longer holds (someone left, blocked, removed an entry, lost their
 * agents, the group grew past its limit…), as opposed to a server fault. The approval is closed instead of staying
 * pending with every click failing; the person sends again.
 */
const TARGETS_CHANGED = new Set([
  'GROUP_RECIPIENT_UNAVAILABLE',
  'NOT_FOUND',
  'NOT_A_CONTACT',
  'BLOCKED',
  'ROUTE_UNAVAILABLE',
  'PREFERRED_ROUTE_UNAVAILABLE',
  'NO_DELIVERY_ROUTE',
  'TOO_MANY_RECIPIENTS',
  // the group's file space filled up while the send was held (ADR 0029)
  'GROUP_STORAGE_FULL',
]);
function recipientsGone(err: unknown): err is AgentDropError {
  if (!(err instanceof AgentDropError)) return false;
  if (TARGETS_CHANGED.has(err.code)) return true;
  return (
    err.code === 'VALIDATION_FAILED' &&
    (err.details?.field === 'mentions' || err.details?.field === 'reply_to')
  );
}

function byId(a: { kind: string; id: string }, b: { kind: string; id: string }): number {
  return `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`);
}

function notSent(requestId: string, error: string) {
  return {
    outcome: 'not_sent',
    requestId,
    dropId: null,
    recipients: [],
    approvalUrl: null,
    retryable: false,
    error,
  };
}

/** Whether the user still has active memberships (used by approval previews for group labels). */
export async function activeGroupIds(tx: Tx, userId: string, groupIds: string[]): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const rows = await tx
    .select({ g: groupMemberships.groupId })
    .from(groupMemberships)
    .where(
      and(
        eq(groupMemberships.userId, userId),
        eq(groupMemberships.status, 'active'),
        inArray(groupMemberships.groupId, groupIds),
      ),
    );
  return rows.map((r) => r.g);
}
