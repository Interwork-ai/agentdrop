import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  AgentDropError,
  type ExportHeader,
  type ExportTrailer,
  exportInputSchema,
  z,
} from '@agentdrop/contracts';
import { harnessEndpoints, withTx } from '@agentdrop/db';
import { EXPORT_CHUNK, type MailboxScope, planExport, readExportChunk } from '@agentdrop/domain';
import { safeFilename } from '@agentdrop/security';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import {
  clientBeforeGroupHistory,
  withoutGroupHistorySource,
  withoutNewerHarnessKeys,
} from '../plugins/old-bridge.js';
import { createKeyLimiter, requireH, requireUser, userPrincipalOf } from '../plugins/principals.js';
import { parse } from '../plugins/validate.js';

/**
 * Date-ranged export as newline-delimited JSON.
 *
 * The response is deliberately three kinds of line: a header that already knows the count, one line per drop,
 * and a trailer carrying the count again plus a digest of the drop lines. NDJSON has no terminator and every
 * line parses on its own, so without a trailer a truncated download is indistinguishable from a complete one —
 * which for an audit artifact is worse than an outright error.
 *
 * Two phases, matching `planExport` / `readExportChunk`: the plan and its audit row commit in a short
 * transaction before the first byte, then bodies are read with no transaction open. Streaming inside a
 * transaction would pin one of ten pooled connections for the whole download.
 */

const EXPORT_PER_MIN = 6;

function coerce(query: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((query ?? {}) as Record<string, string | undefined>)) {
    if (v === undefined || v === '') continue;
    if (k === 'include_body' || k === 'include_group_history') out[k] = v === 'true' || v === '1';
    else out[k] = v;
  }
  return out;
}

function filenameFor(header: ExportHeader): string {
  const who =
    header.scope === 'peer' ? `@${header.peer_handle ?? 'contact'}` : `#${header.group_slug ?? 'group'}`;
  const day = (iso: string) => iso.slice(0, 10);
  return safeFilename(
    `agentdrop-${who}-${day(header.since)}-${day(header.until)}.jsonl`,
    'agentdrop-export.jsonl',
  );
}

function registerExportRoute(
  app: FastifyInstance,
  ctx: AppContext,
  prefix: string,
  resolve: (req: FastifyRequest) => Promise<MailboxScope>,
  opts: { allowGroupHistory: boolean },
): void {
  const limiter = createKeyLimiter(ctx, {
    name: 'export',
    windowMs: 60_000,
    max: EXPORT_PER_MIN,
    key: (req) => req.hAuth?.user.userId ?? req.userPrincipal?.userId ?? req.ip,
  });

  app.get(`${prefix}/export`, { preHandler: limiter }, async (req, reply) => {
    const scope = await resolve(req);
    const input = parse(exportInputSchema, coerce(req.query));
    /*
     * A group's pre-membership history is the one thing here that is not already reachable with this
     * credential: an agent holding it can list and read everything delivered to its endpoint, but not that.
     * It stays on a browser session for the same reason approving a join request does.
     */
    if (input.include_group_history && !opts.allowGroupHistory)
      throw new AgentDropError(
        'FORBIDDEN',
        'exporting a group history needs the dashboard; an agent credential cannot do it',
      );

    const plan = await withTx(ctx.db, (tx) => planExport(tx, scope, input));
    const header: ExportHeader = {
      record: 'header',
      format_version: 1,
      generated_at: new Date().toISOString(),
      ...plan.header,
    };

    reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filenameFor(header))}`,
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');

    const includeBody = input.include_body === true;
    const legacySources = clientBeforeGroupHistory(req);
    async function* lines(): AsyncGenerator<string> {
      yield `${JSON.stringify(header)}\n`;
      const digest = createHash('sha256');
      let written = 0;
      for (let i = 0; i < plan.dropIds.length; i += EXPORT_CHUNK) {
        const ids = plan.dropIds.slice(i, i + EXPORT_CHUNK);
        const records = await readExportChunk(ctx.db, scope, plan, ids, includeBody);
        for (const record of records) {
          const line = `${JSON.stringify(legacySources ? withoutNewerHarnessKeys(withoutGroupHistorySource(record)) : record)}\n`;
          digest.update(line);
          written += 1;
          yield line;
        }
      }
      const trailer: ExportTrailer = {
        record: 'trailer',
        count: written,
        sha256: digest.digest('hex'),
        omitted: plan.dropIds.length - written,
      };
      yield `${JSON.stringify(trailer)}\n`;
    }

    return reply.send(Readable.from(lines()));
  });
}

export async function hExportRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', requireH(ctx));
  registerExportRoute(
    app,
    ctx,
    '/v1/h',
    async (req) => {
      const a = req.hAuth;
      if (!a) throw new AgentDropError('UNAUTHORIZED');
      return { userId: a.user.userId, hId: a.endpoint.hId, via: 'h_credential' };
    },
    { allowGroupHistory: false },
  );
}

export async function webExportRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', requireUser(ctx));
  registerExportRoute(
    app,
    ctx,
    '/v1/me/endpoints/:h_id',
    async (req) => {
      const p = userPrincipalOf(req);
      const { h_id } = parse(z.object({ h_id: z.uuid() }), req.params);
      const h = await ctx.db.drizzle.query.harnessEndpoints.findFirst({
        where: eq(harnessEndpoints.id, h_id),
      });
      if (!h || h.userId !== p.userId) throw new AgentDropError('NOT_FOUND', 'endpoint not found');
      return { userId: p.userId, hId: h.id, via: 'user_session' };
    },
    { allowGroupHistory: true },
  );
}
