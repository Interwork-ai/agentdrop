import type { FastifyInstance, FastifyRequest } from 'fastify';

/** `agentdrop-bridge/<major>.<minor>.<patch>` from the user agent, or null for anything else (CLI, browser). */
function bridgeVersion(req: FastifyRequest): [number, number, number] | null {
  const ua = req.headers['user-agent'];
  const m = typeof ua === 'string' ? /^agentdrop-bridge\/(\d+)\.(\d+)\.(\d+)/.exec(ua) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Bridges before 0.4.11 pass results through unparsed while advertising `additionalProperties: false`, so a
 * strict MCP client would reject a field their schemas do not list. From 0.4.11 the bridge parses against its own
 * schema and strips what it does not know.
 */
export function bridgeBefore0411(req: FastifyRequest): boolean {
  const v = bridgeVersion(req);
  if (!v) return false;
  const [major, minor, patch] = v;
  return major === 0 && (minor < 4 || (minor === 4 && patch < 11));
}

/** `agentdrop-<client>/<major>.<minor>.<patch>` for any AgentDrop client (bridge, CLI, hook, autorun), else null. */
function clientVersion(req: FastifyRequest): [number, number, number] | null {
  const ua = req.headers['user-agent'];
  const m = typeof ua === 'string' ? /^agentdrop-[a-z]+\/(\d+)\.(\d+)\.(\d+)/.exec(ua) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Clients before 0.5.9 parse `sources` against an enum without `group_history` (ADR 0022): the bridge would turn
 * the whole result into RESULT_SCHEMA_MISMATCH and the CLI would refuse an export record. They get `group` instead,
 * which is how the drop reached the group; `deliveries` stays empty, so it still reads as not delivered to them.
 */
export function clientBeforeGroupHistory(req: FastifyRequest): boolean {
  const v = clientVersion(req);
  if (!v) return false;
  const [major, minor, patch] = v;
  return major === 0 && (minor < 5 || (minor === 5 && patch < 9));
}

/**
 * Harness keys added in 0.5.9. Older clients parse `harness_key` against an enum without them, so the bridge would
 * reject the whole result and the CLI an export record; they are told `other`, the key for an agent of no named kind.
 * From 0.5.9 the bridge reads any key it does not know as `other` itself, so a later harness needs no entry here.
 */
const NEWER_HARNESS_KEYS = new Set(['omp']);

/** Replaces a 0.5.9 harness key in every `harness_key` field (outside drop extensions) by `other`. */
export function withoutNewerHarnessKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNewerHarnessKeys);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'harness_key' && typeof v === 'string' && NEWER_HARNESS_KEYS.has(v)) out[k] = 'other';
    else out[k] = k === 'extensions' ? v : withoutNewerHarnessKeys(v);
  }
  return out;
}

/** Replaces `group_history` in every `sources` array (outside drop extensions) by `group`, once. */
export function withoutGroupHistorySource(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutGroupHistorySource);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'sources' && Array.isArray(v) && v.includes('group_history'))
      out[k] = [...new Set(v.map((x) => (x === 'group_history' ? 'group' : x)))];
    else out[k] = k === 'extensions' ? v : withoutGroupHistorySource(v);
  }
  return out;
}

/**
 * Result fields added after 0.4.11. Each name is used nowhere else in any result, so removing the key wherever it
 * appears is exact: `public_email` (ADR 0012), `group_labels`, `mentions`, `mentioned_me`, `muted`, `reply_to` and `replies` on drops (ADR 0016), `active_members` on group cards, `history_visible` on groups (ADR 0022).
 */
const NEWER_FIELDS = new Set([
  'public_email',
  'group_labels',
  'active_members',
  'mentions',
  'mentioned_me',
  'endpoints_over_limit',
  'muted',
  'reply_to',
  'replies',
  'history_visible',
  // group file space (ADR 0029)
  'storage',
]);

/** Removes the newer fields, leaving drop extensions (sender-defined data) untouched. */
export function withoutNewerFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNewerFields);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (NEWER_FIELDS.has(k)) continue;
    // `removed` on a file (ADR 0029/0030); the name is used elsewhere too, so only inside attachment lists
    if (k === 'attachments' && Array.isArray(v)) {
      out[k] = v.map((a) => {
        if (!a || typeof a !== 'object') return a;
        const { removed: _omit, ...rest } = a as Record<string, unknown>;
        return withoutNewerFields(rest);
      });
      continue;
    }
    out[k] = k === 'extensions' ? v : withoutNewerFields(v);
  }
  return out;
}

/** Registers the trim on every route of an H-credential plugin. */
export function trimNewerFieldsForOldBridges(app: FastifyInstance): void {
  app.addHook('preSerialization', async (req, _reply, payload) => {
    const trimmed = bridgeBefore0411(req) ? withoutNewerFields(payload) : payload;
    return clientBeforeGroupHistory(req)
      ? withoutNewerHarnessKeys(withoutGroupHistorySource(trimmed))
      : trimmed;
  });
}
