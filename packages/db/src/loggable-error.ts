import { DrizzleQueryError } from 'drizzle-orm/errors';

/*
 * What may be logged about an error (AGENTS.md rule 7: no secrets or people's data in logs). A failed query's
 * message is the SQL with its parameters (emails, titles, keys), and PostgreSQL's own messages can quote the value
 * that failed; for both only the class, PostgreSQL's code and the constraint/table/column names are kept. Any other
 * error keeps its message and stack.
 */

/** A PostgreSQL error from `pg`: a five-character SQLSTATE and a severity. */
function pgError(err: unknown): (Error & Record<string, unknown>) | null {
  const e = err as (Error & Record<string, unknown>) | null;
  return e &&
    typeof e === 'object' &&
    typeof e.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(e.code) &&
    'severity' in e
    ? e
    : null;
}

export function loggableError(err: unknown): Record<string, unknown> {
  if (err instanceof DrizzleQueryError || pgError(err)) {
    const pg = pgError(err) ?? pgError((err as { cause?: unknown }).cause);
    return {
      type: err instanceof DrizzleQueryError ? 'DrizzleQueryError' : 'DatabaseError',
      message: 'database query failed',
      ...(pg ? { pgCode: pg.code, constraint: pg.constraint, table: pg.table, column: pg.column } : {}),
    };
  }
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return {
      type: err.name,
      message: err.message,
      stack: err.stack,
      ...(cause !== undefined ? { cause: loggableError(cause) } : {}),
    };
  }
  return { message: String(err) };
}

/** One line for a log field or an aggregated failure message. */
export function loggableErrorText(err: unknown): string {
  const fields = loggableError(err);
  return fields.pgCode ? `${fields.message} (${String(fields.pgCode)})` : String(fields.message);
}
