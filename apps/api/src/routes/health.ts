import { WELL_KNOWN_CAPABILITIES, type WellKnown } from '@agentdrop/contracts';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // What this server speaks, so clients detect features (the event stream, ADR 0040) instead of inferring them.
  app.get(
    '/.well-known/agentdrop',
    async (): Promise<WellKnown> => ({
      protocol: 'agentdrop/v1',
      server_version: ctx.config.APP_VERSION,
      capabilities: [...WELL_KNOWN_CAPABILITIES],
    }),
  );

  app.get('/health/live', async () => ({ status: 'ok' as const, version: ctx.config.APP_VERSION }));

  app.get('/health/ready', async (_req, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = {};
    try {
      await ctx.db.ping();
      checks.database = 'ok';
    } catch (err) {
      app.log.warn({ err }, 'readiness: database check failed');
      checks.database = 'fail';
    }
    try {
      await ctx.storage.ping();
      checks.storage = 'ok';
    } catch (err) {
      app.log.warn({ err }, 'readiness: storage check failed');
      checks.storage = 'fail';
    }
    const ready = Object.values(checks).every((c) => c === 'ok');
    // No configuration values are returned here, only pass/fail per dependency.
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });
}
