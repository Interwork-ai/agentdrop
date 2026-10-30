import {
  AgentDropError,
  contactRemoveInputSchema,
  contactRequestInputSchema,
  contactRespondInputSchema,
  feishuConnectInputSchema,
  feishuWatchInputSchema,
  groupCreateInputSchema,
  groupInviteInputSchema,
  groupLeaveInputSchema,
  groupRespondInputSchema,
  z,
} from '@agentdrop/contracts';
import { withTx } from '@agentdrop/db';
import {
  connectFeishuWebhook,
  contactRemoveFromAgent,
  contactRequest,
  contactRespond,
  decideApproval,
  disconnectFeishuWebhook,
  feishuWatchView,
  groupCreateFromAgent,
  groupInviteFromAgent,
  groupLeaveFromAgent,
  groupRespondFromAgent,
  listApprovals,
  type MailboxScope,
  pendingRequests,
  setFeishuWatchTerms,
} from '@agentdrop/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type AppContext, dashboardLink } from '../context.js';
import { trimNewerFieldsForOldBridges } from '../plugins/old-bridge.js';
import { requireH } from '../plugins/principals.js';
import { parse } from '../plugins/validate.js';

/** Agent-side relationship management (H credential with the `manage` scope). */
export async function hManageRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', requireH(ctx));
  trimNewerFieldsForOldBridges(app);
  app.addHook('preHandler', async (req) => {
    if (!req.hAuth?.principal.scopes.includes('manage')) {
      throw new AgentDropError('FORBIDDEN', 'this credential has no manage scope; re-pair to enable it');
    }
  });
  const scopeOf = (req: FastifyRequest): MailboxScope => {
    const a = req.hAuth;
    if (!a) throw new AgentDropError('UNAUTHORIZED');
    return { userId: a.user.userId, hId: a.endpoint.hId, via: 'h_credential' };
  };
  const viewer = (req: FastifyRequest) => {
    const a = req.hAuth;
    if (!a) throw new AgentDropError('UNAUTHORIZED');
    return {
      user_id: a.user.userId,
      handle: a.user.handle,
      h_id: a.endpoint.hId,
      agent_name: a.endpoint.label,
    };
  };

  app.get('/v1/h/requests', async (req) => {
    const pending = await pendingRequests(ctx.db.drizzle, scopeOf(req), ctx.config.MAX_GROUP_RECIPIENTS);
    return {
      ...pending,
      // Agents may report a join request; only a person decides one, in the browser.
      group_join_requests: pending.group_join_requests.map((r) => ({
        ...r,
        decide_url: `${ctx.config.PUBLIC_BASE_URL.replace(/\/$/, '')}/app/groups/${r.group_id}`,
      })),
      viewer: viewer(req),
    };
  });

  app.post('/v1/h/contacts/request', async (req) => {
    const body = parse(contactRequestInputSchema, req.body);
    return withTx(ctx.db, (tx) => contactRequest(tx, scopeOf(req), body.handle));
  });

  // `agentdrop settings --feishu-webhook`: the person pastes their own bot address; see the skill's feishu reference.
  app.put('/v1/h/feishu', async (req) => {
    const body = parse(feishuConnectInputSchema, req.body);
    return withTx(ctx.db, (tx) =>
      connectFeishuWebhook(tx, scopeOf(req).userId, body, {
        link: dashboardLink(ctx),
        via: 'agent',
        ...(ctx.feishuFetch ? { fetchImpl: ctx.feishuFetch } : {}),
      }),
    );
  });
  app.delete('/v1/h/feishu', async (req) =>
    withTx(ctx.db, (tx) => disconnectFeishuWebhook(tx, scopeOf(req).userId, 'agent')),
  );

  // `agentdrop settings --feishu-watch`: the watch terms for updates from Feishu groups (ADR 0041).
  app.get('/v1/h/feishu-watch', async (req) =>
    withTx(ctx.db, (tx) => feishuWatchView(tx, scopeOf(req).userId, ctx.feishuApp?.appId ?? null)),
  );
  app.put('/v1/h/feishu-watch', async (req) => {
    const body = parse(feishuWatchInputSchema, req.body);
    return withTx(ctx.db, async (tx) => {
      await setFeishuWatchTerms(tx, scopeOf(req).userId, body.terms, 'agent');
      return feishuWatchView(tx, scopeOf(req).userId, ctx.feishuApp?.appId ?? null);
    });
  });

  // Terminal command only (no MCP tool). The confirmation is the person's, obtained before `confirm: true`.
  app.post('/v1/h/contacts/remove', async (req) => {
    const body = parse(contactRemoveInputSchema, req.body);
    return withTx(ctx.db, (tx) => contactRemoveFromAgent(tx, scopeOf(req), body.handles, body.confirm));
  });

  app.post('/v1/h/contacts/respond', async (req) => {
    const body = parse(contactRespondInputSchema, req.body);
    return withTx(ctx.db, (tx) => contactRespond(tx, scopeOf(req), body.user_id, body.decision));
  });

  app.post('/v1/h/groups', async (req) => {
    const body = parse(groupCreateInputSchema, req.body);
    return withTx(ctx.db, (tx) =>
      groupCreateFromAgent(
        tx,
        scopeOf(req),
        {
          slug: body.slug,
          displayName: body.display_name,
          description: body.description,
          inviteHandles: body.invite_handles,
        },
        ctx.config.MAX_GROUP_MEMBERS,
      ),
    );
  });

  app.post('/v1/h/groups/invite', async (req) => {
    const body = parse(groupInviteInputSchema, req.body);
    const handles = [...(body.handles ?? []), ...(body.handle ? [body.handle] : [])];
    return withTx(ctx.db, (tx) =>
      groupInviteFromAgent(tx, scopeOf(req), body.group_id, handles, ctx.config.MAX_GROUP_MEMBERS),
    );
  });

  app.post('/v1/h/groups/respond', async (req) => {
    const body = parse(groupRespondInputSchema, req.body);
    return withTx(ctx.db, (tx) =>
      groupRespondFromAgent(tx, scopeOf(req), body.group_id, body.decision, body.nickname),
    );
  });

  /* Approvals from the terminal: listing is read-only; deciding is done by `agentdrop approve`, which insists on a
     real TTY so a model driving a shell tool cannot approve its own send. */
  app.get('/v1/h/approvals', async (req) => {
    const scope = scopeOf(req);
    return { approvals: await listApprovals(ctx.db.drizzle, scope.userId, 'pending') };
  });

  app.post('/v1/h/approvals/:id/decide', async (req, reply) => {
    const scope = scopeOf(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ decision: z.enum(['approve', 'reject']) }).strict(), req.body);
    const res = await withTx(ctx.db, (tx) =>
      decideApproval(tx, scope.userId, id, body.decision, ctx.config.MAX_GROUP_RECIPIENTS),
    );
    if (res.status === 'expired') return reply.status(410).send({ status: 'expired' });
    if (res.status === 'stale')
      return reply
        .status(409)
        .send({ status: 'stale', recipients: res.recipients, ...(res.closed ? { closed: true } : {}) });
    return { status: res.status, drop_id: res.drop_id };
  });

  app.post('/v1/h/groups/leave', async (req) => {
    const body = parse(groupLeaveInputSchema, req.body);
    return withTx(ctx.db, (tx) => groupLeaveFromAgent(tx, scopeOf(req), body.group_id));
  });
}
