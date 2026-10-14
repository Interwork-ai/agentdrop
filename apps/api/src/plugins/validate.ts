import type { z } from 'zod';

/** Parses with a Zod schema; ZodError is translated by the global error handler into VALIDATION_FAILED. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  return schema.parse(value);
}
