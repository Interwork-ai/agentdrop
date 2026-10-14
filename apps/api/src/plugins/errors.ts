import { AgentDropError, describeError, httpStatusFor } from '@agentdrop/contracts';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** Translates thrown errors into the stable ApiError envelope. Never leaks stacks or secrets. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AgentDropError) {
      if (err.code === 'INTERNAL') req.log.error({ err, requestId: req.id }, 'internal error');
      return reply.status(err.status).send(err.toApiError());
    }
    if (err instanceof ZodError) {
      return reply.status(400).send(
        describeError('VALIDATION_FAILED', 'request validation failed', {
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }),
      );
    }
    const fe = err as FastifyError;
    if (fe.statusCode === 413 || fe.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send(describeError('PAYLOAD_TOO_LARGE', 'request body too large'));
    }
    if (fe.statusCode === 415 || fe.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.status(415).send(describeError('VALIDATION_FAILED', 'unsupported media type'));
    }
    if (fe.statusCode === 400 && typeof fe.code === 'string' && fe.code.startsWith('FST_ERR_CTP')) {
      return reply.status(400).send(describeError('VALIDATION_FAILED', 'malformed request body'));
    }
    if (fe.statusCode === 429) {
      return reply.status(429).send(describeError('RATE_LIMITED'));
    }
    req.log.error({ err, requestId: req.id }, 'unhandled error');
    return reply.status(httpStatusFor('INTERNAL')).send(describeError('INTERNAL', 'internal error'));
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send(describeError('NOT_FOUND', 'route not found'));
  });
}
