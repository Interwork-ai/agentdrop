import { z } from 'zod';
import {
  attachmentMetaSchema,
  authorCardSchema,
  deliverySourceSchema,
  dropIdSchema,
  groupIdSchema,
  userIdSchema,
} from './drop.js';

/**
 * Export a date-ranged timeline for audit or analysis. Deliberately not a chat log: the product has no threads,
 * so this is "every drop that passed between us in this window", ordered by when it was written.
 *
 * Two scopes, and the difference is not cosmetic:
 *   - `peer`   — **direct traffic only**, in both directions. Drops that reached the other person because you
 *     share a group are NOT here. Including them would mean answering "which members received this group drop",
 *     which the group recipient card exists to withhold; group traffic belongs to the group export, where the
 *     authorization is explicit.
 *   - `group`  — the group's timeline. A plain member exports what reached them. An owner/admin may add
 *     `include_group_history` to export the whole group including drops that predate them — the same explicit
 *     opt-in the dashboard requires, and audited separately. In a group whose owner made earlier messages visible
 *     to members (ADR 0022), every active member's export is the whole group history without that flag, as an
 *     ordinary read; the header then reports `include_group_history: true`.
 */

/** Dates are inclusive-start, exclusive-end, in UTC, against the drop's creation time (the author's clock). */
export const exportRangeSchema = z.object({
  since: z.iso.datetime(),
  until: z.iso.datetime(),
});

export const exportScopeSchema = z.enum(['peer', 'group']);

export const exportInputSchema = z
  .object({
    scope: exportScopeSchema,
    /** Required for `scope: peer`. */
    peer_user_id: userIdSchema.optional(),
    /** Required for `scope: group`. */
    group_id: groupIdSchema.optional(),
    since: z.iso.datetime(),
    until: z.iso.datetime(),
    /** Full bodies. Off means titles and a short preview only, which is a different disclosure — it is audited. */
    include_body: z.boolean().optional(),
    /** Owners/admins only, `scope: group` only, browser session only. Audited as its own action. */
    include_group_history: z.boolean().optional(),
    endpoint_scope: z.enum(['account', 'current']).optional(),
  })
  .strict();
export type ExportInput = z.infer<typeof exportInputSchema>;

/**
 * First line of the stream. Says what was asked for and what the server decided, so an archived file can be
 * read years later without the request that produced it.
 */
export const exportHeaderSchema = z.object({
  record: z.literal('header'),
  format_version: z.literal(1),
  generated_at: z.iso.datetime(),
  scope: exportScopeSchema,
  peer_user_id: userIdSchema.nullable(),
  peer_handle: z.string().nullable(),
  group_id: groupIdSchema.nullable(),
  group_slug: z.string().nullable(),
  since: z.iso.datetime(),
  until: z.iso.datetime(),
  /** Known before the first body is read, so a short file is detectable against it. */
  count: z.number().int().nonnegative(),
  include_body: z.boolean(),
  include_group_history: z.boolean(),
  endpoint_scope: z.enum(['account', 'current']),
  /** Written down because the answer is not obvious and changes what the file proves. */
  notes: z.object({
    ordered_by: z.literal('drop.created_at,drop.id'),
    range: z.literal('[since, until)'),
    excludes_revoked: z.literal(true),
    excludes_expired: z.literal(true),
    /** `peer` scope only: traffic through a shared group is not part of a per-contact export. */
    excludes_group_traffic: z.boolean(),
  }),
});
export type ExportHeader = z.infer<typeof exportHeaderSchema>;

export const exportRecordSchema = z.object({
  record: z.literal('drop'),
  drop_id: dropIdSchema,
  created_at: z.iso.datetime(),
  /** `out` = written by me, `in` = written by the other side. */
  direction: z.enum(['out', 'in']),
  author: authorCardSchema,
  title: z.string(),
  /** Present when `include_body`; otherwise only `preview`. */
  body: z.string().optional(),
  preview: z.string(),
  body_chars: z.number().int().nonnegative(),
  /** Why this drop is visible to me. Never says which of the other side's endpoints received it. */
  sources: z.array(deliverySourceSchema),
  group_ids: z.array(groupIdSchema),
  attachments: z.array(attachmentMetaSchema),
});
export type ExportRecord = z.infer<typeof exportRecordSchema>;

/**
 * Last line. Every NDJSON line is independently valid JSON and the format has no terminator, so a truncated
 * export parses cleanly and is simply missing its tail — which for an audit artifact is worse than an error.
 * A reader that does not find a trailer whose `count` matches the lines it read must treat the file as partial.
 */
export const exportTrailerSchema = z.object({
  record: z.literal('trailer'),
  count: z.number().int().nonnegative(),
  /** sha256 over the drop lines exactly as written, newline-delimited. */
  sha256: z.string().length(64),
  /**
   * Planned drops left out because they were revoked, expired or no longer readable by the time their chunk was
   * read. `header.count` = `count` + `omitted`. Absent from servers that predate it, which never omit anything.
   */
  omitted: z.number().int().nonnegative().optional(),
});
export type ExportTrailer = z.infer<typeof exportTrailerSchema>;

export const exportLineSchema = z.discriminatedUnion('record', [
  exportHeaderSchema,
  exportRecordSchema,
  exportTrailerSchema,
]);
export type ExportLine = z.infer<typeof exportLineSchema>;
