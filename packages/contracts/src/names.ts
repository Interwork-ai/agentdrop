import { z } from 'zod';
import { hasNoControlChars, LIMITS } from './limits.js';

/**
 * Human-facing names (nicknames, agent names, group names, remarks) are untrusted text.
 * They are NFC-normalized, trimmed, bounded and free of control characters; display keeps the user's spelling.
 */
export function normalizeName(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Search key: case-folded, whitespace-collapsed, NFKC so full-width and half-width forms match. */
export function searchKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export const handleSchema = z
  .string()
  .min(LIMITS.HANDLE_MIN)
  .max(LIMITS.HANDLE_MAX)
  .regex(
    /^[a-z0-9][a-z0-9_]*$/,
    'handle: lowercase letters, digits and underscore, must start with a letter or digit',
  );

export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, '').toLowerCase();
}

export const routeAliasSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'alias: lowercase letters, digits, dash, underscore');

export const displayNameSchema = z
  .string()
  .transform(normalizeName)
  .pipe(z.string().min(LIMITS.NAME_MIN_CHARS).max(LIMITS.NAME_MAX_CHARS).refine(hasNoControlChars));

/**
 * The address a person publishes on their profile (ADR 0012). Self-declared and never verified: an identifier
 * for other tools, not a login and not a channel AgentDrop sends to.
 */
export const publicEmailSchema = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.email().max(LIMITS.EMAIL_MAX_CHARS).refine(hasNoControlChars));

/**
 * A person's published email, on every view of that person or of one of their agents. Self-declared, unverified.
 * Optional so bridges and servers of different versions keep accepting each other's results.
 */
export const publicEmailFieldSchema = z.string().nullable().optional();

export const remarkSchema = z
  .string()
  .transform(normalizeName)
  .pipe(z.string().max(LIMITS.REMARK_MAX_CHARS).refine(hasNoControlChars));

export const groupDescriptionSchema = z
  .string()
  .transform((v) => v.normalize('NFC').trim())
  .pipe(z.string().max(LIMITS.GROUP_DESCRIPTION_MAX_CHARS).refine(hasNoControlChars));

export const groupSlugSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'group slug: lowercase letters, digits, dash, underscore');

/** Which agent product an owned paired endpoint runs. Never disclosed for other people's endpoints. */
export const harnessKeySchema = z.enum(['codex', 'claude-code', 'other', 'opencode', 'cursor', 'omp']);
export type HarnessKey = z.infer<typeof harnessKeySchema>;

/**
 * `harness_key` in a result. A harness a newer server knows and this version does not reads as `other`, so a bridge
 * shows the agent instead of rejecting the whole result (RESULT_SCHEMA_MISMATCH). Requests keep the strict enum.
 */
export const resultHarnessKeySchema = z.preprocess(
  (value) =>
    typeof value === 'string' && !(harnessKeySchema.options as readonly string[]).includes(value)
      ? 'other'
      : value,
  harnessKeySchema,
);
