import { DrizzleQueryError } from 'drizzle-orm/errors';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { withRedaction } from './app.js';
import { registerErrorHandler } from './plugins/errors.js';

describe('the API logs a failed query without its parameters (AGENTS.md rule 7)', () => {
  it('keeps an email bound into a query out of the unhandled-error log line', async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: withRedaction({
        level: 'error',
        stream: { write: (line: string) => lines.push(line) },
      }) as never,
    });
    registerErrorHandler(app);
    const cause = Object.assign(new Error('value too long for type character varying'), {
      code: '22001',
      severity: 'ERROR',
    });
    app.get('/boom', async () => {
      throw new DrizzleQueryError(
        'insert into rate_limits (key) values ($1)',
        ['reset:alice@example.com'],
        cause,
      );
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('alice@example.com');
    const logged = lines.join('\n');
    expect(logged).toContain('unhandled error');
    expect(logged).toContain('22001');
    expect(logged).not.toContain('alice@example.com');
    expect(logged).not.toContain('insert into');
    await app.close();
  });
});
