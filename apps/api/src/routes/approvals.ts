import { describeError, z } from '@agentdrop/contracts';
import { withTx } from '@agentdrop/db';
import { decideApproval, getApproval, listApprovals } from '@agentdrop/domain';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireUser, userPrincipalOf } from '../plugins/principals.js';
import { parse } from '../plugins/validate.js';

/** Drafts & Approvals: human confirmation of outgoing drops. Only reachable with a browser session. */
export async function approvalRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', requireUser(ctx));

  app.get('/v1/me/approvals', async (req) => {
    const p = userPrincipalOf(req);
    const q = parse(
      z.object({ status: z.enum(['pending', 'approved', 'rejected', 'expired', 'consumed']).optional() }),
      req.query,
    );
    return { approvals: await listApprovals(ctx.db.drizzle, p.userId, q.status) };
  });

  app.get('/v1/me/approvals/:id', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    return getApproval(ctx.db.drizzle, p.userId, id);
  });

  app.post('/v1/me/approvals/:id/decide', async (req, reply) => {
    const p = userPrincipalOf(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ decision: z.enum(['approve', 'reject']) }).strict(), req.body);
    const res = await withTx(ctx.db, (tx) =>
      decideApproval(tx, p.userId, id, body.decision, ctx.config.MAX_GROUP_RECIPIENTS),
    );
    if (res.status === 'expired') {
      return reply.status(410).send(describeError('APPROVAL_EXPIRED', 'the approval expired; send again'));
    }
    if (res.status === 'stale') {
      // the refreshed preview is committed; the human must look again and approve once more
      return reply.status(409).send(
        res.closed
          ? describeError(
              'STALE_APPROVAL',
              'recipients changed since the preview and this send was cancelled; send again',
              { recipients: res.recipients, closed: true },
            )
          : describeError('STALE_APPROVAL', 'targets changed since the preview; review and approve again', {
              recipients: res.recipients,
            }),
      );
    }
    return { status: res.status, drop_id: res.drop_id };
  });
}
