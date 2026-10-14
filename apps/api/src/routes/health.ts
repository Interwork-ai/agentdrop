import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
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
