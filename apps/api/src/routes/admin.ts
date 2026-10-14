import {
  adminDeleteInputSchema,
  adminSetAdminInputSchema,
  adminSettingsInputSchema,
  adminSuspendInputSchema,
  z,
} from '@agentdrop/contracts';
import { withTx } from '@agentdrop/db';
import {
  adminCloseAccount,
  adminListAudit,
  adminListUsers,
  adminOverview,
  adminPreparePasswordReset,
  adminRecordPasswordResetLink,
  adminRevokeEndpoint,
  adminSetUserAdmin,
  adminSuspendUser,
  adminUnsuspendUser,
  adminUserDetail,
  getGroupStorageQuotaSetting,
  getSignupSetting,
  setGroupStorageQuota,
  setSignupMode,
} from '@agentdrop/domain';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireAdmin, requireUser, userPrincipalOf } from '../plugins/principals.js';
import { parse } from '../plugins/validate.js';
import { issueResetLink } from '../reset-link.js';

const idParam = z.object({ id: z.uuid() });

/**
 * Operator console. Every route needs a browser session that belongs to an administrator; nothing here is reachable
 * with an agent credential. The console exposes accounts, agents, activity and counters — never message content.
 */
export async function adminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', requireUser(ctx));
  app.addHook('preHandler', requireAdmin());

  app.get('/v1/admin/overview', async () => {
    const setting = await getSignupSetting(ctx.db.drizzle, ctx.config.SIGNUP_MODE);
    return adminOverview(ctx.db.drizzle, {
      serverVersion: ctx.config.APP_VERSION,
      signupMode: setting.mode,
    });
  });

  app.get('/v1/admin/users', async (req) => {
    const q = parse(
      z
        .object({
          query: z.string().max(128).optional(),
          status: z.enum(['all', 'active', 'suspended', 'deleted', 'admin']).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          cursor: z.string().max(512).optional(),
        })
        .strict(),
      req.query,
    );
    const res = await adminListUsers(ctx.db.drizzle, q);
    return { users: res.users, next_cursor: res.nextCursor, total: res.total };
  });

  app.get('/v1/admin/users/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return adminUserDetail(ctx.db.drizzle, id);
  });

  app.post('/v1/admin/users/:id/suspend', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(adminSuspendInputSchema, req.body ?? {});
    await withTx(ctx.db, (tx) => adminSuspendUser(tx, p.userId, id, body.reason ?? null));
    return { ok: true };
  });

  app.post('/v1/admin/users/:id/unsuspend', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    await withTx(ctx.db, (tx) => adminUnsuspendUser(tx, p.userId, id));
    return { ok: true };
  });

  app.post('/v1/admin/users/:id/admin', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(adminSetAdminInputSchema, req.body);
    await withTx(ctx.db, (tx) => adminSetUserAdmin(tx, p.userId, id, body.is_admin));
    return { ok: true };
  });

  /** Irreversible: see adminCloseAccount for exactly what is removed and what deliberately stays. */
  app.post('/v1/admin/users/:id/close', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(adminDeleteInputSchema, req.body);
    const res = await withTx(ctx.db, (tx) => adminCloseAccount(tx, p.userId, id, body.confirm_handle));
    return { ok: true, handle: res.handle };
  });

  /**
   * Fallback for servers without SMTP (and for people who lost their mailbox): a one-time reset link the admin hands
   * over privately. Returned exactly once; the token is not written to the audit log or anywhere readable.
   */
  app.post('/v1/admin/users/:id/password-reset-link', async (req, reply) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const target = await withTx(ctx.db, (tx) => adminPreparePasswordReset(tx, id));
    const link = await issueResetLink(ctx, target);
    await withTx(ctx.db, (tx) => adminRecordPasswordResetLink(tx, p.userId, target));
    reply.header('Cache-Control', 'no-store');
    return link;
  });

  app.post('/v1/admin/endpoints/:id/revoke', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    await withTx(ctx.db, (tx) => adminRevokeEndpoint(tx, p.userId, id));
    return { ok: true };
  });

  app.get('/v1/admin/audit', async (req) => {
    const q = parse(
      z
        .object({
          action: z.string().max(64).optional(),
          actor_user_id: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          cursor: z.string().max(64).optional(),
        })
        .strict(),
      req.query,
    );
    const res = await adminListAudit(ctx.db.drizzle, {
      action: q.action,
      actorUserId: q.actor_user_id,
      limit: q.limit,
      cursor: q.cursor,
    });
    return { events: res.events, next_cursor: res.nextCursor };
  });

  /** Sign-up mode and the group file space (ADR 0029); `updated_*` describe whichever of the two changed last. */
  const settingsView = async (tx: Parameters<typeof getSignupSetting>[0]) => {
    const [s, q] = await Promise.all([
      getSignupSetting(tx, ctx.config.SIGNUP_MODE),
      getGroupStorageQuotaSetting(tx, ctx.config.GROUP_STORAGE_QUOTA_BYTES),
    ]);
    const latest =
      q.updatedAt && (!s.updatedAt || q.updatedAt > s.updatedAt)
        ? { at: q.updatedAt, by: q.updatedByHandle }
        : { at: s.updatedAt, by: s.updatedByHandle };
    return {
      signup_mode: s.mode,
      group_storage_quota_bytes: q.bytes,
      updated_at: latest.at ? latest.at.toISOString() : null,
      updated_by_handle: latest.by,
    };
  };

  app.get('/v1/admin/settings', async () => settingsView(ctx.db.drizzle));

  app.patch('/v1/admin/settings', async (req) => {
    const p = userPrincipalOf(req);
    const body = parse(adminSettingsInputSchema, req.body);
    return withTx(ctx.db, async (tx) => {
      if (body.signup_mode !== undefined) await setSignupMode(tx, p.userId, body.signup_mode);
      if (body.group_storage_quota_bytes !== undefined)
        await setGroupStorageQuota(tx, p.userId, body.group_storage_quota_bytes);
      return settingsView(tx);
    });
  });
}
