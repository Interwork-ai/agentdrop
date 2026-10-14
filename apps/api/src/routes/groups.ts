import { groupSettingsInputSchema, z } from '@agentdrop/contracts';
import { withTx } from '@agentdrop/db';
import {
  acceptInvite,
  createGroup,
  decideJoinRequest,
  declineInvite,
  getGroup,
  inviteMembers,
  leaveGroup,
  listGroupFiles,
  listJoinRequestsFor,
  listMyGroups,
  type ReceiveChoice,
  removeGroupFile,
  removeMember,
  setHistoryVisible,
  setInvitePolicy,
  setMemberRole,
  setMyBindings,
  setMyMembership,
  transferOwnership,
  updateGroup,
} from '@agentdrop/domain';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireUser, userPrincipalOf } from '../plugins/principals.js';
import { parse } from '../plugins/validate.js';

const idParam = z.object({ id: z.uuid() });
const memberParam = z.object({ id: z.uuid(), user_id: z.uuid() });
const fileParam = z.object({ id: z.uuid(), attachment_id: z.uuid() });

/** Group management: browser session only. Sending to groups and reading group timelines reuse send/list. */
export async function groupRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', requireUser(ctx));

  app.get('/v1/me/groups', async (req) => {
    const p = userPrincipalOf(req);
    const q = parse(z.object({ h_id: z.uuid().optional() }), req.query);
    return { groups: await listMyGroups(ctx.db.drizzle, p.userId, q.h_id ?? null) };
  });

  app.post('/v1/me/groups', async (req) => {
    const p = userPrincipalOf(req);
    const body = parse(
      z
        .object({
          /** Omitted or empty: derived from the creator's handle (see createGroup). */
          slug: z.string().max(32).optional(),
          display_name: z.string().max(64).optional(),
          description: z.string().max(512).nullable().optional(),
          /** Default true: every agent of the account receives, including ones paired later. */
          receive_all: z.boolean().optional(),
          binding_h_ids: z.array(z.uuid()).max(10).optional(),
          nickname: z.string().max(64).nullable().optional(),
          invite_handles: z.array(z.string().min(1).max(64)).max(64).optional(),
          /** Earlier messages visible to members who join later (ADR 0022). Default false. */
          history_visible: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    return withTx(ctx.db, (tx) =>
      createGroup(
        tx,
        p.userId,
        {
          slug: body.slug ?? null,
          displayName: body.display_name ?? null,
          description: body.description ?? null,
          receive: receiveChoice(body.receive_all, body.binding_h_ids),
          nickname: body.nickname ?? null,
          ...(body.invite_handles ? { inviteHandles: body.invite_handles } : {}),
          ...(body.history_visible !== undefined ? { historyVisible: body.history_visible } : {}),
        },
        ctx.config.MAX_GROUP_MEMBERS,
      ),
    );
  });

  app.get('/v1/me/groups/:id', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ h_id: z.uuid().optional() }), req.query);
    return getGroup(
      ctx.db.drizzle,
      p.userId,
      id,
      q.h_id ?? null,
      ctx.config.MAX_GROUP_MEMBERS,
      ctx.config.MAX_GROUP_RECIPIENTS,
    );
  });

  app.patch('/v1/me/groups/:id', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z
        .object({
          display_name: z.string().min(1).max(64).optional(),
          description: z.string().max(512).nullable().optional(),
          /** Owners/admins; checked against the slug rules (lowercased) and for uniqueness by updateGroup. */
          slug: z.string().min(1).max(32).optional(),
        })
        .strict(),
      req.body,
    );
    return withTx(ctx.db, (tx) =>
      updateGroup(tx, p.userId, id, {
        ...(body.display_name !== undefined ? { displayName: body.display_name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
      }),
    );
  });

  app.post('/v1/me/groups/:id/invite', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z
        .object({
          handle: z.string().min(1).max(64).optional(),
          handles: z.array(z.string().min(1).max(64)).max(64).optional(),
        })
        .strict(),
      req.body,
    );
    const handles = [...(body.handles ?? []), ...(body.handle ? [body.handle] : [])];
    return withTx(ctx.db, async (tx) => {
      const invites = await inviteMembers(tx, p.userId, id, handles, ctx.config.MAX_GROUP_MEMBERS);
      const detail = await getGroup(
        tx,
        p.userId,
        id,
        null,
        ctx.config.MAX_GROUP_MEMBERS,
        ctx.config.MAX_GROUP_RECIPIENTS,
      );
      return { ...detail, invites };
    });
  });

  /**
   * The group's settings, browser-only: no credential an agent holds can change them. Who may bring people in is
   * admin-level; whether members see earlier messages (ADR 0022) is the owner's alone. One transaction, so a
   * request that is refused for either part changes nothing.
   */
  app.patch('/v1/me/groups/:id/policy', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(groupSettingsInputSchema, req.body);
    return withTx(ctx.db, async (tx) => {
      let detail = null;
      if (body.history_visible !== undefined)
        detail = await setHistoryVisible(tx, p.userId, id, body.history_visible);
      if (body.member_invite_policy !== undefined)
        detail = await setInvitePolicy(tx, p.userId, id, body.member_invite_policy);
      return detail;
    });
  });

  /**
   * The files the group stores, largest first, for its owner and admins to free space (ADR 0029). Browser only:
   * removing a file from everyone's copy of a drop is not something an agent credential does.
   */
  app.get('/v1/me/groups/:id/files', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    return listGroupFiles(ctx.db.drizzle, p.userId, id);
  });

  app.delete('/v1/me/groups/:id/files/:attachment_id', async (req) => {
    const p = userPrincipalOf(req);
    const { id, attachment_id } = parse(fileParam, req.params);
    return withTx(ctx.db, (tx) => removeGroupFile(tx, p.userId, id, attachment_id));
  });

  app.get('/v1/me/groups/:id/requests', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    return { join_requests: await listJoinRequestsFor(ctx.db.drizzle, p.userId, id) };
  });

  /*
   * Approving admits somebody to every other member's mailbox, so it stays on a browser session with CSRF and
   * origin checks. There is deliberately no H-credential equivalent: see AGENTS.md and SPEC §3.
   */
  app.post('/v1/me/groups/:id/requests/:user_id/decide', async (req) => {
    const p = userPrincipalOf(req);
    const { id, user_id } = parse(memberParam, req.params);
    const body = parse(z.object({ decision: z.enum(['approve', 'reject']) }).strict(), req.body);
    return withTx(ctx.db, (tx) =>
      decideJoinRequest(tx, p.userId, id, user_id, body.decision, ctx.config.MAX_GROUP_MEMBERS),
    );
  });

  app.post('/v1/me/groups/:id/accept', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z
        .object({
          receive_all: z.boolean().optional(),
          h_ids: z.array(z.uuid()).max(10).optional(),
          nickname: z.string().max(64).nullable().optional(),
        })
        .strict(),
      req.body,
    );
    return withTx(ctx.db, (tx) =>
      acceptInvite(tx, p.userId, id, {
        receive: receiveChoice(body.receive_all, body.h_ids),
        nickname: body.nickname ?? null,
      }),
    );
  });

  app.post('/v1/me/groups/:id/decline', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    await withTx(ctx.db, (tx) => declineInvite(tx, p.userId, id));
    return { ok: true };
  });

  app.post('/v1/me/groups/:id/leave', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    await withTx(ctx.db, (tx) => leaveGroup(tx, p.userId, id));
    return { ok: true };
  });

  app.post('/v1/me/groups/:id/members/:user_id/remove', async (req) => {
    const p = userPrincipalOf(req);
    const { id, user_id } = parse(memberParam, req.params);
    await withTx(ctx.db, (tx) => removeMember(tx, p.userId, id, user_id));
    return { ok: true };
  });

  app.patch('/v1/me/groups/:id/members/:user_id', async (req) => {
    const p = userPrincipalOf(req);
    const { id, user_id } = parse(memberParam, req.params);
    const body = parse(z.object({ role: z.enum(['admin', 'member', 'owner']) }).strict(), req.body);
    await withTx(ctx.db, (tx) =>
      body.role === 'owner'
        ? transferOwnership(tx, p.userId, id, user_id)
        : setMemberRole(tx, p.userId, id, user_id, body.role),
    );
    return { ok: true };
  });

  app.put('/v1/me/groups/:id/bindings', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({ receive_all: z.boolean().optional(), h_ids: z.array(z.uuid()).max(10) }).strict(),
      req.body,
    );
    // Editing bindings keeps the old meaning (an explicit selection) unless all agents is asked for.
    return withTx(ctx.db, (tx) =>
      setMyBindings(tx, p.userId, id, body.receive_all ? { all: true } : { all: false, hIds: body.h_ids }),
    );
  });

  app.patch('/v1/me/groups/:id/me', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z
        .object({ nickname: z.string().max(64).nullable().optional(), muted: z.boolean().optional() })
        .strict(),
      req.body,
    );
    await withTx(ctx.db, (tx) =>
      setMyMembership(tx, p.userId, id, {
        ...(body.nickname !== undefined ? { nickname: body.nickname } : {}),
        ...(body.muted !== undefined ? { muted: body.muted } : {}),
      }),
    );
    return { ok: true };
  });
}

/**
 * All agents unless the request picks specific ones. A client that predates the option sends only an agent list;
 * honouring that list keeps its behaviour unchanged.
 */
function receiveChoice(receiveAll: boolean | undefined, hIds: string[] | undefined): ReceiveChoice {
  if (receiveAll === true) return { all: true };
  if (receiveAll === false || (hIds && hIds.length > 0)) return { all: false, hIds: hIds ?? [] };
  return { all: true };
}
