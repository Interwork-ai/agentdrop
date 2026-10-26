import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { loggableError, loggableErrorText } from './loggable-error.js';

/** What `pg` throws: a DatabaseError with an SQLSTATE, a severity and a message that may quote the value. */
function pgError(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { severity: 'ERROR', ...fields });
}

describe('loggableError keeps people’s data out of logs', () => {
  it('drops the SQL parameters of a failed query and keeps what identifies the failure', () => {
    const cause = pgError('duplicate key value violates unique constraint "rate_limits_pkey"', {
      code: '23505',
      constraint: 'rate_limits_pkey',
      table: 'rate_limits',
      detail: 'Key (key)=(reset:alice@example.com) already exists.',
    });
    const err = new DrizzleQueryError(
      'insert into rate_limits (key) values ($1)',
      ['reset:alice@example.com'],
      cause,
    );
    const fields = loggableError(err);
    expect(JSON.stringify(fields)).not.toContain('alice@example.com');
    expect(JSON.stringify(fields)).not.toContain('insert into');
    expect(fields).toEqual({
      type: 'DrizzleQueryError',
      message: 'database query failed',
      pgCode: '23505',
      constraint: 'rate_limits_pkey',
      table: 'rate_limits',
      column: undefined,
    });
    expect(loggableErrorText(err)).toBe('database query failed (23505)');
  });

  it('drops a PostgreSQL message that quotes the value, also when it is the cause of another error', () => {
    const pg = pgError('invalid input syntax for type uuid: "wang@example.com"', { code: '22P02' });
    expect(JSON.stringify(loggableError(pg))).not.toContain('wang@example.com');
    const wrapped = new Error('send failed', { cause: pg });
    expect(JSON.stringify(loggableError(wrapped))).not.toContain('wang@example.com');
    expect(loggableError(wrapped)).toMatchObject({ message: 'send failed', cause: { pgCode: '22P02' } });
  });

  it('keeps the message and stack of any other error', () => {
    const fields = loggableError(new TypeError('x is not a function'));
    expect(fields).toMatchObject({ type: 'TypeError', message: 'x is not a function' });
    expect(String(fields.stack)).toContain('TypeError');
    expect(loggableErrorText('plain')).toBe('plain');
  });
});
