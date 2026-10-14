import {
  clientSettingsAppliedInputSchema,
  connectionHeartbeatInputSchema,
  connectionOpenInputSchema,
  noticeStateSchema,
  type Viewer,
  z,
} from '@agentdrop/contracts';
import { withTx } from '@agentdrop/db';
import {
  claimNoticeState,
  claimSeenNoticeState,
  closeConnection,
  getFeishuWebhook,
  getHClientSettings,
  getMailboxRevision,
  getNoticeState,
  getSeenNoticeState,
  HEARTBEAT_INTERVAL_S,
  heartbeatConnection,
  openConnection,
  pendingCounts,
  prepareDeviceRecovery,
  putNoticeState,
  reportHClientSettingsApplied,
} from '@agentdrop/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { trimNewerFieldsForOldBridges } from '../plugins/old-bridge.js';
import { createKeyLimiter, hPrincipalOf, requireH } from '../plugins/principals.js';
import { parse } from '../plugins/validate.js';
import { issueResetLink } from '../reset-link.js';

export function viewerOf(
  req: FastifyRequest,
  mailboxRevision = 0,
  pending: Viewer['pending'] = {
    unread: 0,
    contact_requests: 0,
    group_invitations: 0,
    group_join_requests: 0,
    approvals: 0,
  },
): Viewer {
  const a = req.hAuth;
  if (!a) throw new Error('viewerOf called without hAuth');
  return {
    pending,
    user_id: a.user.userId,
    handle: a.user.handle,
    display_name: a.user.displayName,
    public_email: a.user.publicEmail,
    h_id: a.endpoint.hId,
    agent_name: a.endpoint.label,
    directory_revision: a.user.directoryRevision,
    mailbox_revision: mailboxRevision,
  };
}

/** Endpoint-scoped routes (H credential). Mailbox routes are added in PR-02. */
export async function hIdentityRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', requireH(ctx));
  trimNewerFieldsForOldBridges(app);

  /*
   * Getting back into the account from a paired device (ADR 0036): `agentdrop account recover`, run by the person
   * at a terminal, gets a one-time reset link for the web password. Not an MCP tool. A few per hour per account.
   */
  const recoverLimiter = createKeyLimiter(app, {
    windowMs: 3_600_000,
    max: 5,
    key: (req) => `recover:${req.hAuth?.principal.userId ?? req.ip}`,
  });
  app.post('/v1/h/account/recovery-link', async (req, reply) => {
    parse(z.object({}).strict(), req.body ?? {});
    const p = hPrincipalOf(req);
    await recoverLimiter(req);
    const target = await withTx(ctx.db, (tx) => prepareDeviceRecovery(tx, p.userId, p.hId));
    reply.header('Cache-Control', 'no-store');
    return issueResetLink(ctx, target);
  });

  app.get('/v1/h/client-settings', async (req) => {
    parse(z.object({}).strict(), req.query);
    return withTx(ctx.db, (tx) => getHClientSettings(tx, hPrincipalOf(req)));
  });

  app.post('/v1/h/client-settings/applied', async (req) => {
    parse(z.object({}).strict(), req.query);
    const body = parse(clientSettingsAppliedInputSchema, req.body);
    return withTx(ctx.db, (tx) => reportHClientSettingsApplied(tx, hPrincipalOf(req), body));
  });

  // Shared by every agent of the account, so the user id comes from the credential, never from the request.
  app.get('/v1/h/notice-state', async (req) => {
    parse(z.object({}).strict(), req.query);
    return withTx(ctx.db, (tx) => getNoticeState(tx, hPrincipalOf(req).userId));
  });

  app.put('/v1/h/notice-state', async (req) => {
    parse(z.object({}).strict(), req.query);
    const body = parse(noticeStateSchema, req.body);
    return withTx(ctx.db, (tx) => putNoticeState(tx, hPrincipalOf(req).userId, body));
  });

  app.post('/v1/h/notice-state/claim', async (req) => {
    parse(z.object({}).strict(), req.query);
    const body = parse(noticeStateSchema, req.body);
    return withTx(ctx.db, (tx) => claimNoticeState(tx, hPrincipalOf(req).userId, body));
  });

  // What the person has seen inside an agent session; push and Feishu never write it.
  app.get('/v1/h/notice-state/seen', async (req) => {
    parse(z.object({}).strict(), req.query);
    return withTx(ctx.db, (tx) => getSeenNoticeState(tx, hPrincipalOf(req).userId));
  });

  app.post('/v1/h/notice-state/seen/claim', async (req) => {
    parse(z.object({}).strict(), req.query);
    const body = parse(noticeStateSchema, req.body);
    return withTx(ctx.db, (tx) => claimSeenNoticeState(tx, hPrincipalOf(req).userId, body));
  });

  app.get('/v1/h/identity', async (req) => {
    const a = req.hAuth;
    if (!a) throw new Error('unreachable');
    return {
      viewer: viewerOf(
        req,
        await getMailboxRevision(ctx.db.drizzle, a.endpoint.hId),
        await pendingCounts(ctx.db.drizzle, {
          userId: a.user.userId,
          hId: a.endpoint.hId,
          via: 'h_credential',
        }),
      ),
      device_label: a.endpoint.deviceLabel,
      harness_key: a.endpoint.harnessKey,
      profile_key: a.endpoint.profileKey,
      credential_expires_at: a.credentialExpiresAt.toISOString(),
      toolsets: ['core', 'standard'],
      server_version: ctx.config.APP_VERSION,
      limits: {
        max_file_bytes: ctx.config.MAX_FILE_BYTES,
        max_drop_file_bytes: ctx.config.MAX_DROP_FILE_BYTES,
        quota_bytes: ctx.config.H_STORAGE_QUOTA_BYTES,
      },
      notifications: { feishu: (await getFeishuWebhook(ctx.db.drizzle, a.user.userId)) !== null },
    };
  });

  app.post('/v1/h/connections', async (req) => {
    const a = req.hAuth;
    if (!a) throw new Error('unreachable');
    const body = parse(connectionOpenInputSchema, req.body);
    const res = await withTx(ctx.db, (tx) =>
      openConnection(tx, a.endpoint.hId, {
        clientName: body.client_name,
        clientVersion: body.client_version,
        capabilities: body.capabilities,
        bridgeVersion: body.bridge_version,
        toolset: body.toolset,
      }),
    );
    return {
      connection_id: res.connectionId,
      heartbeat_interval_s: HEARTBEAT_INTERVAL_S,
      viewer: viewerOf(req),
    };
  });

  app.post('/v1/h/connections/heartbeat', async (req) => {
    const a = req.hAuth;
    if (!a) throw new Error('unreachable');
    const body = parse(connectionHeartbeatInputSchema, req.body);
    await withTx(ctx.db, (tx) => heartbeatConnection(tx, a.endpoint.hId, body.connection_id, body.last_tool));
    return { ok: true };
  });

  app.post('/v1/h/connections/close', async (req) => {
    const a = req.hAuth;
    if (!a) throw new Error('unreachable');
    const body = parse(connectionHeartbeatInputSchema, req.body);
    await withTx(ctx.db, (tx) => closeConnection(tx, a.endpoint.hId, body.connection_id));
    return { ok: true };
  });
}
