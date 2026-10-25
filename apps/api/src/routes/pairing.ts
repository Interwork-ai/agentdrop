import { pairingPollInputSchema, pairingStartInputSchema } from '@agentdrop/contracts';
import { withTx } from '@agentdrop/db';
import { PAIRING_POLL_INTERVAL_S, pollPairing, startPairing } from '@agentdrop/domain';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { createIpLimiter } from '../plugins/principals.js';
import { parse } from '../plugins/validate.js';

/** Unauthenticated CLI side of pairing. The browser side lives under /v1/me/pairing. */
export async function pairingRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const startLimiter = createIpLimiter(ctx, {
    name: 'pairing-start',
    windowMs: 60_000,
    max: ctx.config.PAIRING_START_PER_MIN,
  });
  const pollLimiter = createIpLimiter(ctx, {
    name: 'pairing-poll',
    windowMs: 60_000,
    max: ctx.config.PAIRING_START_PER_MIN * 12,
  });

  app.post('/v1/pairing/start', { preHandler: [startLimiter] }, async (req) => {
    const input = parse(pairingStartInputSchema, req.body);
    const res = await withTx(ctx.db, (tx) => startPairing(tx, input, ctx.config.PAIRING_CODE_TTL_S));
    const base = ctx.config.WEB_ORIGIN ?? ctx.config.PUBLIC_BASE_URL;
    return {
      device_code: res.deviceCode,
      user_code: res.userCode,
      verification_url: `${base}/pair`,
      verification_url_complete: `${base}/pair?code=${encodeURIComponent(res.userCode)}`,
      expires_in: Math.max(1, Math.floor((res.expiresAt.getTime() - Date.now()) / 1000)),
      interval: PAIRING_POLL_INTERVAL_S,
    };
  });

  app.post('/v1/pairing/poll', { preHandler: [pollLimiter] }, async (req) => {
    const input = parse(pairingPollInputSchema, req.body);
    const out = await withTx(ctx.db, (tx) =>
      pollPairing(tx, input.device_code, ctx.config.H_CREDENTIAL_MAX_DAYS),
    );
    if (out.status !== 'approved') return { status: out.status };
    return {
      status: 'approved',
      h_id: out.hId,
      credential: out.credential,
      credential_expires_at: out.credentialExpiresAt.toISOString(),
      user_id: out.userId,
      handle: out.handle,
      agent_name: out.agentName,
      server_version: ctx.config.APP_VERSION,
    };
  });
}
