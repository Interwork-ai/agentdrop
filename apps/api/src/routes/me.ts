import {
  AgentDropError,
  clientSettingsUpdateInputSchema,
  displayNameSchema,
  feishuConnectInputSchema,
  feishuLinkCodeInputSchema,
  pairingDecisionInputSchema,
  pushSubscriptionInputSchema,
  z,
} from '@agentdrop/contracts';
import { withTx } from '@agentdrop/db';
import {
  connectFeishuWebhook,
  contentEncryptionStatus,
  createFeishuLinkCode,
  decidePairing,
  disconnectFeishuWebhook,
  feishuAppView,
  feishuBotLink,
  feishuView,
  generateRecoveryCodes,
  getDeviceClientSettings,
  getUserById,
  listConnectionsForUser,
  listDevices,
  listEndpoints,
  listPushSubscriptions,
  lookupPairing,
  recoveryCodeStatus,
  renameDevice,
  renameEndpoint,
  revokeCredentialsForEndpoint,
  revokeDevice,
  revokeEndpoint,
  revokePushSubscription,
  setCrossHMailboxEnabled,
  setDefaultReceivingEndpoint,
  setDirectReceiveAll,
  setEndpointPublicName,
  setNotificationWebhook,
  setPublicEmail,
  signInEmailOf,
  takeOverEndpoint,
  unlinkFeishuAccount,
  updateDeviceClientSettings,
  updateDisplayName,
  upsertPushSubscription,
} from '@agentdrop/domain';
import { isAPIError } from 'better-auth/api';
import type { FastifyInstance } from 'fastify';
import { authHeaders } from '../auth.js';
import { type AppContext, dashboardLink } from '../context.js';
import { requireUser, userPrincipalOf } from '../plugins/principals.js';
import { parse } from '../plugins/validate.js';

const idParam = z.object({ id: z.uuid() });

/** Account management with a browser session (UserPrincipal). Nothing here is reachable with an H credential. */
export async function meRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', requireUser(ctx));

  app.get('/v1/me/devices/:id/client-settings', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    return getDeviceClientSettings(ctx.db.drizzle, p.userId, id);
  });

  app.put('/v1/me/devices/:id/client-settings', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(clientSettingsUpdateInputSchema, req.body);
    return withTx(ctx.db, (tx) => updateDeviceClientSettings(tx, p.userId, id, body));
  });

  /** Recovery codes (ADR 0036): how many are left; the codes themselves are shown only when generated. */
  app.get('/v1/me/recovery-codes', async (req) =>
    recoveryCodeStatus(ctx.db.drizzle, userPrincipalOf(req).userId),
  );

  /** A new set replaces the old one. The current password is asked again: a session alone must not mint codes. */
  app.post('/v1/me/recovery-codes', async (req, reply) => {
    const p = userPrincipalOf(req);
    const body = parse(z.object({ password: z.string().min(1).max(256) }).strict(), req.body);
    const ok = await ctx.auth.api
      .verifyPassword({ body: { password: body.password }, headers: authHeaders(req) })
      .then((r) => r.status === true)
      .catch((err: unknown) => {
        if (isAPIError(err)) return false;
        throw err;
      });
    if (!ok)
      throw new AgentDropError('VALIDATION_FAILED', 'the password is not correct', {
        field: 'password',
        reason: 'password_incorrect',
      });
    const codes = await withTx(ctx.db, (tx) => generateRecoveryCodes(tx, p.userId));
    reply.header('Cache-Control', 'no-store');
    return { codes, status: await recoveryCodeStatus(ctx.db.drizzle, p.userId) };
  });

  app.get('/v1/me', async (req) => {
    const p = userPrincipalOf(req);
    const [user, endpoints, signInEmail] = await Promise.all([
      getUserById(ctx.db.drizzle, p.userId),
      listEndpoints(ctx.db.drizzle, p.userId),
      signInEmailOf(ctx.db.drizzle, p.authUserId),
    ]);
    return {
      user_id: p.userId,
      handle: user?.handle,
      display_name: user?.displayName,
      /** Shown to contacts and group co-members (ADR 0012); null when none is published. */
      public_email: user?.publicEmail ?? null,
      /** Only so Settings can offer "use my sign-in email"; never part of anyone else's view. */
      sign_in_email: signInEmail,
      directory_revision: user?.directoryRevision ?? 0,
      is_admin: p.isAdmin,
      cross_h_mailbox_enabled: user?.crossHMailboxEnabled ?? true,
      feishu: feishuView(user?.feishuWebhook),
      /** Whether this server encrypts new content at rest (docs/plan/CONTENT_ENCRYPTION.md), for the help page. */
      content_encryption: contentEncryptionStatus().mode,
      /** Plain sends to me reach all of my agents (ADR 0008); false once one default receiver is chosen. */
      direct_receive_all: user?.directReceiveAll ?? true,
      notification_webhook_url: user?.notificationWebhookUrl ?? null,
      endpoints,
    };
  });

  // Feishu group-bot notices (docs/FEISHU.md). Connecting sends a test message and saves only if Feishu accepts it.
  app.put('/v1/me/feishu', async (req) => {
    const p = userPrincipalOf(req);
    const body = parse(feishuConnectInputSchema, req.body);
    return withTx(ctx.db, (tx) =>
      connectFeishuWebhook(tx, p.userId, body, {
        link: dashboardLink(ctx),
        via: 'dashboard',
        ...(ctx.feishuFetch ? { fetchImpl: ctx.feishuFetch } : {}),
      }),
    );
  });
  app.delete('/v1/me/feishu', async (req) => {
    const p = userPrincipalOf(req);
    return withTx(ctx.db, (tx) => disconnectFeishuWebhook(tx, p.userId, 'dashboard'));
  });

  // Linking a Feishu account to the server's own Feishu app (ADR 0039, docs/FEISHU.md).
  app.get('/v1/me/feishu-app', async (req) => {
    const p = userPrincipalOf(req);
    return withTx(ctx.db, (tx) => feishuAppView(tx, p.userId, ctx.feishuApp ?? null));
  });

  app.post('/v1/me/feishu-app/code', async (req) => {
    const p = userPrincipalOf(req);
    const body = parse(feishuLinkCodeInputSchema, req.body ?? {});
    const app = ctx.feishuApp;
    if (!app) throw new AgentDropError('NOT_FOUND', 'this server has no Feishu app configured');
    const code = await withTx(ctx.db, (tx) => createFeishuLinkCode(tx, p.userId, body.language ?? 'en'));
    return { ...code, bot_link: feishuBotLink(app) };
  });

  app.delete('/v1/me/feishu-app', async (req) => {
    const p = userPrincipalOf(req);
    return withTx(ctx.db, async (tx) => {
      await unlinkFeishuAccount(tx, p.userId);
      return feishuAppView(tx, p.userId, ctx.feishuApp ?? null);
    });
  });

  app.patch('/v1/me/mailbox-settings', async (req) => {
    const p = userPrincipalOf(req);
    const body = parse(z.object({ cross_h_mailbox_enabled: z.boolean() }).strict(), req.body);
    const user = await withTx(ctx.db, (tx) =>
      setCrossHMailboxEnabled(tx, p.userId, body.cross_h_mailbox_enabled),
    );
    return { cross_h_mailbox_enabled: user.crossHMailboxEnabled };
  });

  app.patch('/v1/me/notifications', async (req) => {
    const p = userPrincipalOf(req);
    const body = parse(z.object({ webhook_url: z.string().max(2048).nullable() }).strict(), req.body);
    await withTx(ctx.db, (tx) =>
      setNotificationWebhook(tx, p.userId, body.webhook_url, {
        allowPrivateNetwork: ctx.config.WEBHOOK_ALLOW_PRIVATE_NETWORK,
      }),
    );
    return { ok: true };
  });

  app.get('/v1/me/push', async (req) => {
    const p = userPrincipalOf(req);
    const available = Boolean(ctx.config.WEB_PUSH_VAPID_PUBLIC_KEY);
    return {
      available,
      vapid_public_key: available ? (ctx.config.WEB_PUSH_VAPID_PUBLIC_KEY ?? null) : null,
      subscriptions: await listPushSubscriptions(ctx.db.drizzle, p.userId),
    };
  });

  app.post('/v1/me/push/subscriptions', async (req) => {
    const p = userPrincipalOf(req);
    const body = parse(pushSubscriptionInputSchema, req.body);
    return withTx(ctx.db, (tx) =>
      upsertPushSubscription(tx, p.userId, body, req.headers['user-agent']?.slice(0, 512) ?? null),
    );
  });

  app.delete('/v1/me/push/subscriptions/:id', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    await withTx(ctx.db, (tx) => revokePushSubscription(tx, p.userId, id));
    return { ok: true as const };
  });

  app.patch('/v1/me', async (req) => {
    const p = userPrincipalOf(req);
    const body = parse(z.object({ display_name: displayNameSchema }).strict(), req.body);
    const user = await withTx(ctx.db, (tx) => updateDisplayName(tx, p.userId, body.display_name));
    return { display_name: user.displayName, directory_revision: user.directoryRevision };
  });

  // The public email is set here only, with a browser session; agent credentials can read it but not change it.
  app.put('/v1/me/public-email', async (req) => {
    const p = userPrincipalOf(req);
    const body = parse(z.object({ public_email: z.string().max(512).nullable() }).strict(), req.body);
    const user = await withTx(ctx.db, (tx) => setPublicEmail(tx, p.userId, body.public_email));
    return { public_email: user.publicEmail, directory_revision: user.directoryRevision };
  });

  /* ---------------------------------------------------------------- endpoints (my agents) */
  app.get('/v1/me/endpoints', async (req) => {
    const p = userPrincipalOf(req);
    return { endpoints: await listEndpoints(ctx.db.drizzle, p.userId) };
  });

  app.patch('/v1/me/endpoints/:id', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z
        .object({
          label: displayNameSchema.optional(),
          public_name: z.string().max(64).nullable().optional(),
        })
        .strict(),
      req.body,
    );
    await withTx(ctx.db, async (tx) => {
      if (body.label !== undefined) await renameEndpoint(tx, p.userId, id, body.label);
      if (body.public_name !== undefined) await setEndpointPublicName(tx, p.userId, id, body.public_name);
    });
    return { ok: true };
  });

  app.post('/v1/me/endpoints/:id/revoke', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    await withTx(ctx.db, (tx) => revokeEndpoint(tx, p.userId, id));
    return { ok: true };
  });

  /* The agent :id takes over another of mine (ADR 0011): its addresses and group bindings, then it is revoked. */
  app.post('/v1/me/endpoints/:id/take-over', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ from_h_id: z.uuid() }).strict(), req.body);
    return withTx(ctx.db, (tx) => takeOverEndpoint(tx, p.userId, body.from_h_id, id));
  });

  app.post('/v1/me/endpoints/:id/credentials/revoke', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    return withTx(ctx.db, (tx) => revokeCredentialsForEndpoint(tx, p.userId, id));
  });

  app.post('/v1/me/default-endpoint', async (req) => {
    const p = userPrincipalOf(req);
    const body = parse(
      z.union([z.object({ h_id: z.uuid() }).strict(), z.object({ all: z.literal(true) }).strict()]),
      req.body,
    );
    await withTx(ctx.db, (tx) =>
      'all' in body
        ? setDirectReceiveAll(tx, p.userId)
        : setDefaultReceivingEndpoint(tx, p.userId, body.h_id),
    );
    return {
      ok: true,
      note: 'Only future personal sends are affected; group bindings and history are unchanged.',
    };
  });

  /* ---------------------------------------------------------------- devices */
  app.get('/v1/me/devices', async (req) => {
    const p = userPrincipalOf(req);
    return { devices: await listDevices(ctx.db.drizzle, p.userId) };
  });

  app.patch('/v1/me/devices/:id', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ label: displayNameSchema }).strict(), req.body);
    await withTx(ctx.db, (tx) => renameDevice(tx, p.userId, id, body.label));
    return { ok: true };
  });

  app.post('/v1/me/devices/:id/revoke', async (req) => {
    const p = userPrincipalOf(req);
    const { id } = parse(idParam, req.params);
    await withTx(ctx.db, (tx) => revokeDevice(tx, p.userId, id));
    return { ok: true };
  });

  /* ---------------------------------------------------------------- connections */
  app.get('/v1/me/connections', async (req) => {
    const p = userPrincipalOf(req);
    const endpoints = await listEndpoints(ctx.db.drizzle, p.userId);
    const connections = await listConnectionsForUser(
      ctx.db.drizzle,
      endpoints.map((e) => e.h_id),
    );
    return { connections, native_sessions: { status: 'not_connected' } };
  });

  /* ---------------------------------------------------------------- pairing approval (browser) */
  app.get('/v1/me/pairing/:code', async (req) => {
    const p = userPrincipalOf(req);
    const { code } = parse(z.object({ code: z.string().min(4).max(32) }), req.params);
    return lookupPairing(ctx.db.drizzle, p.userId, code);
  });

  app.post('/v1/me/pairing/decide', async (req) => {
    const p = userPrincipalOf(req);
    const body = parse(pairingDecisionInputSchema, req.body);
    const res = await withTx(ctx.db, (tx) =>
      decidePairing(tx, p.userId, {
        userCode: body.user_code,
        decision: body.decision,
        endpointLabel: body.endpoint_label,
        makeDefault: body.make_default,
      }),
    );
    return { decision: body.decision, h_id: res.hId };
  });
}
