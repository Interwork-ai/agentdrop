import { z } from '@agentdrop/contracts';
import { withTx } from '@agentdrop/db';
import {
  acceptContact,
  acceptInviteLink,
  blockContact,
  createInviteLink,
  createNamedRoute,
  inviteContact,
  listContacts,
  listInviteLinks,
  listMyRoutes,
  previewInviteLink,
  removeContact,
  revokeInviteLink,
  revokeNamedRoute,
  updateContactSettings,
  updateNamedRoute,
} from '@agentdrop/domain';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { createIpLimiter, requireUser, userPrincipalOf } from '../plugins/principals.js';
import { parse } from '../plugins/validate.js';

const peerParam = z.object({ user_id: z.uuid() });
const tokenParam = z.object({ token: z.string().min(1).max(256) });

/** Where a contact invite link points: the dashboard's /invite/<token> page (token in the path, not a query). */
export function inviteLinkUrl(ctx: AppContext, token: string): string {
  return `${ctx.config.WEB_ORIGIN ?? ctx.config.PUBLIC_BASE_URL}/invite/${token}`;
}

/** Unauthenticated preview of a contact invite link: inviter name and whether it still works. Rate limited. */
export async function inviteLinkPublicRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const limiter = createIpLimiter(ctx, { name: 'invite-preview', windowMs: 60_000, max: 60 });
  app.get('/v1/invite/:token', { preHandler: [limiter] }, async (req) => {
    const { token } = parse(tokenParam, req.params);
    return previewInviteLink(ctx.db.drizzle, token);
  });
}

/** Contacts and receiving routes: browser session only. Remarks and preferences never leave the owner's view. */
export async function contactRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', requireUser(ctx));

  app.get('/v1/me/contacts', async (req) => {
    const p = userPrincipalOf(req);
    return { contacts: await listContacts(ctx.db.drizzle, p.userId) };
  });

  app.post('/v1/me/contacts/invite', async (req) => {
    const p = userPrincipalOf(req);
    const body = parse(z.object({ handle: z.string().min(1).max(64) }).strict(), req.body);
    return withTx(ctx.db, (tx) => inviteContact(tx, p.userId, body.handle));
  });

  app.post('/v1/me/contacts/:user_id/accept', async (req) => {
    const p = userPrincipalOf(req);
    const { user_id } = parse(peerParam, req.params);
    return withTx(ctx.db, (tx) => acceptContact(tx, p.userId, user_id));
  });

  app.delete('/v1/me/contacts/:user_id', async (req) => {
    const p = userPrincipalOf(req);
    const { user_id } = parse(peerParam, req.params);
    await withTx(ctx.db, (tx) => removeContact(tx, p.userId, user_id));
    return { ok: true };
  });

  app.post('/v1/me/contacts/:user_id/block', async (req) => {
    const p = userPrincipalOf(req);
    const { user_id } = parse(peerParam, req.params);
    const body = parse(z.object({ blocked: z.boolean() }).strict(), req.body);
    await withTx(ctx.db, (tx) => blockContact(tx, p.userId, user_id, body.blocked));
    return { ok: true };
  });

  app.patch('/v1/me/contacts/:user_id', async (req) => {
    const p = userPrincipalOf(req);
    const { user_id } = parse(peerParam, req.params);
    const body = parse(
      z
        .object({
          remark: z.string().max(64).nullable().optional(),
          preferred_route_id: z.uuid().nullable().optional(),
          auto_approve: z.boolean().optional(),
          expected_version: z.number().int().optional(),
        })
        .strict(),
      req.body,
    );
    return withTx(ctx.db, (tx) =>
      updateContactSettings(tx, p.userId, user_id, {
        ...(body.remark !== undefined ? { remark: body.remark } : {}),
        ...(body.preferred_route_id !== undefined ? { preferredRouteId: body.preferred_route_id } : {}),
        ...(body.auto_approve !== undefined ? { autoApprove: body.auto_approve } : {}),
        ...(body.expected_version !== undefined ? { expectedVersion: body.expected_version } : {}),
      }),
    );
  });

  /* ---------------------------------------------------------------- contact invite links */
  app.get('/v1/me/invite-links', async (req) => {
    const p = userPrincipalOf(req);
    return { links: await listInviteLinks(ctx.db.drizzle, p.userId) };
  });

  /** The plain link is in this response only; afterwards the link can be revoked but not shown again. */
  app.post('/v1/me/invite-links', async (req, reply) => {
    const p = userPrincipalOf(req);
    const link = await withTx(ctx.db, (tx) => createInviteLink(tx, p.userId));
    return reply.status(201).send({ ...link, url: inviteLinkUrl(ctx, link.token) });
  });

  app.post('/v1/me/invite-links/:link_id/revoke', async (req) => {
    const p = userPrincipalOf(req);
    const { link_id } = parse(z.object({ link_id: z.uuid() }), req.params);
    return withTx(ctx.db, (tx) => revokeInviteLink(tx, p.userId, link_id));
  });

  app.post('/v1/me/invite/:token/accept', async (req) => {
    const p = userPrincipalOf(req);
    const { token } = parse(tokenParam, req.params);
    return withTx(ctx.db, (tx) => acceptInviteLink(tx, p.userId, token));
  });

  /* ---------------------------------------------------------------- my receiving routes */
  app.get('/v1/me/routes', async (req) => {
    const p = userPrincipalOf(req);
    return { routes: await listMyRoutes(ctx.db.drizzle, p.userId) };
  });

  app.post('/v1/me/routes', async (req) => {
    const p = userPrincipalOf(req);
    const body = parse(
      z
        .object({
          alias: z.string().min(1).max(32),
          label: z.string().min(1).max(64),
          h_id: z.uuid(),
          visibility: z.enum(['private', 'contacts']).default('contacts'),
        })
        .strict(),
      req.body,
    );
    return withTx(ctx.db, (tx) =>
      createNamedRoute(tx, p.userId, {
        alias: body.alias,
        label: body.label,
        hId: body.h_id,
        visibility: body.visibility,
      }),
    );
  });

  app.patch('/v1/me/routes/:route_id', async (req) => {
    const p = userPrincipalOf(req);
    const { route_id } = parse(z.object({ route_id: z.uuid() }), req.params);
    const body = parse(
      z
        .object({
          label: z.string().min(1).max(64).optional(),
          h_id: z.uuid().optional(),
          visibility: z.enum(['private', 'contacts']).optional(),
        })
        .strict(),
      req.body,
    );
    return withTx(ctx.db, (tx) =>
      updateNamedRoute(tx, p.userId, route_id, {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.h_id !== undefined ? { hId: body.h_id } : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
      }),
    );
  });

  app.post('/v1/me/routes/:route_id/revoke', async (req) => {
    const p = userPrincipalOf(req);
    const { route_id } = parse(z.object({ route_id: z.uuid() }), req.params);
    await withTx(ctx.db, (tx) => revokeNamedRoute(tx, p.userId, route_id));
    return { ok: true };
  });
}
