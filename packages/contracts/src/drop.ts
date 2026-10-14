import { z } from 'zod';
import { hasNoControlChars, LIMITS, utf8Bytes } from './limits.js';
import { publicEmailFieldSchema, resultHarnessKeySchema } from './names.js';

export const dropKindSchema = z.enum(['text', 'context', 'file']);
export type DropKind = z.infer<typeof dropKindSchema>;

export const uuidSchema = z.uuid();
export const attachmentIdSchema = uuidSchema;
export const dropIdSchema = uuidSchema;
export const hIdSchema = uuidSchema;
export const userIdSchema = uuidSchema;
export const groupIdSchema = uuidSchema;
export const routeIdSchema = uuidSchema;

export const extensionKeySchema = z
  .string()
  .regex(
    /^[a-z0-9]+(\.[a-z0-9_-]+)+$/,
    'extension keys are reverse-dns namespaces such as org.agentdrop.context',
  );

/** Request payload for payload_version 1. Identity fields are never client supplied. */
export const dropPayloadV1Schema = z
  .object({
    payload_version: z.literal(1),
    kind: dropKindSchema.default('text'),
    title: z
      .string()
      .min(1)
      .max(LIMITS.TITLE_MAX_CHARS)
      .refine(hasNoControlChars, 'title must not contain control characters'),
    body: z
      .string()
      .refine(
        (b) => utf8Bytes(b) <= LIMITS.BODY_MAX_BYTES,
        `body must be at most ${LIMITS.BODY_MAX_BYTES} UTF-8 bytes`,
      ),
    attachment_ids: z.array(attachmentIdSchema).max(LIMITS.MAX_ATTACHMENTS).default([]),
    extensions: z
      .record(extensionKeySchema, z.unknown())
      .default({})
      .refine(
        (e) => utf8Bytes(JSON.stringify(e)) <= LIMITS.EXTENSIONS_MAX_BYTES,
        `extensions must be at most ${LIMITS.EXTENSIONS_MAX_BYTES} bytes`,
      ),
    expires_at: z.iso.datetime().optional(),
    /**
     * Group members to call on by @handle. Only when the send has exactly one target and it is a group
     * (VALIDATION_FAILED `mentions` otherwise, nothing sent); each must be an active member of it. Delivery is
     * unchanged (the whole group receives); the people named are told "@you".
     */
    mentions: z.array(z.string().min(1).max(64)).max(LIMITS.GROUP_MAX_MEMBERS).optional(),
    /**
     * The drop this one answers (its drop_id). A reference, not a thread: nobody is obliged to answer and it grants
     * no access to the original. The sender must be allowed to read that drop (VALIDATION_FAILED `reply_to`
     * otherwise, nothing sent). Part of the content, so part of idempotency. Sending marks the referenced drop read
     * for the sender (ADR 0016).
     */
    reply_to: dropIdSchema.optional(),
  })
  .strict();
export type DropPayloadV1 = z.infer<typeof dropPayloadV1Schema>;
export type DropPayloadV1Input = z.input<typeof dropPayloadV1Schema>;

export const sendTargetSchema = z.discriminatedUnion('type', [
  /** A person: resolved through my stored preference or their default receiving endpoint. */
  z.object({ type: z.literal('user'), user_id: userIdSchema }).strict(),
  /** A named receiving entry the recipient published to me (for example @wang/research). */
  z.object({ type: z.literal('route'), route_id: routeIdSchema }).strict(),
  /** A persistent group. Expanded server-side to the members' bound endpoints. */
  z.object({ type: z.literal('group'), group_id: groupIdSchema }).strict(),
  /**
   * My own space (ADR 0030): kept for myself and readable from every agent of mine, to move files and notes between
   * my own machines. Reaches every agent of mine, read on arrival, announced nowhere; listed with view `space`.
   * Only on its own: it cannot be combined with other targets.
   */
  z.object({ type: z.literal('self') }).strict(),
]);
export type SendTarget = z.infer<typeof sendTargetSchema>;

export const requestIdSchema = z
  .string()
  .min(8)
  .max(LIMITS.REQUEST_ID_MAX)
  .regex(/^[A-Za-z0-9._:-]+$/, 'request_id must be URL-safe');

export const sendEnvelopeSchema = z
  .object({
    request_id: requestIdSchema,
    targets: z.array(sendTargetSchema).min(1).max(LIMITS.MAX_TARGETS),
    payload: dropPayloadV1Schema,
  })
  .strict();
export type SendEnvelope = z.infer<typeof sendEnvelopeSchema>;
export type SendEnvelopeInput = z.input<typeof sendEnvelopeSchema>;

export const sendOutcomeSchema = z.enum(['delivered', 'needs_approval', 'not_sent', 'unknown']);
export type SendOutcome = z.infer<typeof sendOutcomeSchema>;

/** Minimal "who am I right now" block returned with list/read/send. Never includes credentials or other H. */
export const viewerSchema = z.object({
  user_id: userIdSchema,
  handle: z.string(),
  display_name: z.string(),
  /** My own published email (null when I have none), the same for every agent of mine. */
  public_email: publicEmailFieldSchema,
  h_id: hIdSchema,
  agent_name: z.string(),
  directory_revision: z.number().int().nonnegative(),
  mailbox_revision: z.number().int().nonnegative(),
  /** In-band notification: what is waiting for this account/endpoint right now. */
  pending: z.object({
    unread: z.number().int().nonnegative(),
    contact_requests: z.number().int().nonnegative(),
    group_invitations: z.number().int().nonnegative(),
    /**
     * Join requests waiting for me as an owner/admin of the group. Only a human decides them.
     * Optional: a newer bridge must keep working against a server that predates this field.
     */
    group_join_requests: z.number().int().nonnegative().optional(),
    approvals: z.number().int().nonnegative(),
  }),
});
export type Viewer = z.infer<typeof viewerSchema>;

export const attachmentMetaSchema = z.object({
  attachment_id: attachmentIdSchema,
  safe_name: z.string(),
  content_type: z.string(),
  byte_size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  /**
   * True when the file was removed after the drop was sent (a group admin freed the group's file space, or the owner
   * deleted it from their space): it is listed but can no longer be downloaded. Absent on older servers.
   */
  removed: z.boolean().optional(),
});
export type AttachmentMeta = z.infer<typeof attachmentMetaSchema>;

export const authorCardSchema = z.object({
  user_id: userIdSchema,
  handle: z.string(),
  /** Display priority for the viewer: my private remark > their nickname > @handle. Computed per viewer. */
  display_label: z.string(),
  /** The author's per-agent signature, shown only to the author themselves; null for everyone else (ADR 0013). */
  public_name: z.string().nullable(),
  /** The author's published email: the person's, whichever of their agents sent it. Self-declared, unverified. */
  public_email: publicEmailFieldSchema,
});
export type AuthorCard = z.infer<typeof authorCardSchema>;

export const resolvedRecipientSchema = z.object({
  type: z.enum(['user', 'route', 'group']),
  label: z.string(),
  /**
   * My own targets: agents that received it. Another person or entry: 1 (the person). A group: the people other
   * than me it reached. Never how many agents someone else has (ADR 0013).
   */
  endpoint_count: z.number().int().nonnegative(),
  /**
   * Which agent received it, for my own targets only. For other people `address` is the label they are known by
   * and `endpoint_label`/`harness_key` are null (ADR 0013).
   */
  address: z.string().nullable().optional(),
  endpoint_label: z.string().nullable().optional(),
  harness_key: resultHarnessKeySchema.nullable().optional(),
});
export type ResolvedRecipient = z.infer<typeof resolvedRecipientSchema>;

/**
 * Why the viewer may see this drop. `group_admin` and `group_history` are the sources that are not a delivery:
 * `group_admin` is an owner/admin reading their group's full history on explicit request (audited);
 * `group_history` is any active member of a group whose owner made earlier messages visible to members (ADR 0022),
 * including drops sent before they joined. Both are read-only — there is no delivery of theirs to mark read, star
 * or archive, and such a drop is never unread or announced.
 */
export const deliverySourceSchema = z.enum(['direct', 'group', 'sender', 'group_admin', 'group_history']);
export type DeliverySource = z.infer<typeof deliverySourceSchema>;

export const originAgentSchema = z.object({
  h_id: hIdSchema,
  agent_name: z.string(),
  harness_key: resultHarnessKeySchema,
});
export type OriginAgent = z.infer<typeof originAgentSchema>;

export const dropDeliverySchema = z.object({
  h_id: hIdSchema,
  agent_name: z.string(),
  harness_key: resultHarnessKeySchema,
  received_at: z.iso.datetime(),
  read: z.boolean(),
  starred: z.boolean(),
  archived: z.boolean(),
  state_version: z.number().int().nonnegative(),
  sources: z.array(deliverySourceSchema),
  group_ids: z.array(groupIdSchema),
  current: z.boolean(),
});
export type DropDelivery = z.infer<typeof dropDeliverySchema>;

/**
 * Read receipts, shown only to the author. "Read" means the person opened the body (from any of their agents, the
 * web page or the CLI) or marked it read; it never changes the recipient's own unread state. Aggregated per
 * person, never per endpoint: no other person's agents or devices appear here.
 */
export const personReceiptSchema = z.object({
  type: z.enum(['user', 'route']),
  /** Same label as the matching entry of `recipients`, e.g. `@bob` or `@bob/work`. */
  label: z.string(),
  delivered: z.boolean(),
  /** First time this person opened or marked it read; null while unread. */
  read_at: z.iso.datetime().nullable(),
});
export const groupReaderSchema = z.object({
  /** Viewer's remark > public nickname > @handle. */
  display_label: z.string(),
  handle: z.string(),
  read_at: z.iso.datetime(),
});
export const groupReceiptSchema = z.object({
  type: z.literal('group'),
  label: z.string(),
  /** People (excluding the author) who received this drop through the group. */
  member_count: z.number().int().nonnegative(),
  read_count: z.number().int().nonnegative(),
  /** Those who have read it, earliest first. Anyone else counted in member_count has not. */
  readers: z.array(groupReaderSchema),
});
export const recipientStatusSchema = z.discriminatedUnion('type', [personReceiptSchema, groupReceiptSchema]);
export type RecipientStatus = z.infer<typeof recipientStatusSchema>;

/** A group this drop reached the viewer through, named so a person or model can tell group traffic apart. */
export const groupLabelSchema = z.object({
  group_id: groupIdSchema,
  display_name: z.string(),
  slug: z.string(),
});
export type GroupLabel = z.infer<typeof groupLabelSchema>;

/**
 * The drop a drop answers, as the viewer may see it: present only when the viewer may read the original under the
 * same authorization as reading it directly. Null when it answers nothing, or the original is unreadable for the
 * viewer, expired or gone; a null never says which.
 */
export const replyRefSchema = z.object({
  drop_id: dropIdSchema,
  title: z.string(),
  /**
   * True when the viewing person wrote the answered drop (from any of their agents or the dashboard), false when
   * someone else did. Absent from servers before 0.5.9.
   */
  mine: z.boolean().optional(),
});
export type ReplyRef = z.infer<typeof replyRefSchema>;

/**
 * Answers to a drop the viewer sent: drops that name it in `reply_to` and that the viewer may read (normally the
 * replies delivered to them). `authors` are the people who wrote them (labels follow the viewer), most recent
 * first; people only, never their agents (ADR 0013).
 */
export const repliesInfoSchema = z.object({
  count: z.number().int().nonnegative(),
  latest_at: z.iso.datetime().nullable(),
  authors: z.array(z.object({ handle: z.string(), display_label: z.string() })).optional(),
});
export type RepliesInfo = z.infer<typeof repliesInfoSchema>;

export const dropSummarySchema = z.object({
  drop_id: dropIdSchema,
  kind: dropKindSchema,
  title: z.string(),
  preview: z.string(),
  author: authorCardSchema,
  attachment_count: z.number().int().nonnegative(),
  received_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  sources: z.array(deliverySourceSchema),
  group_ids: z.array(groupIdSchema),
  /** Names of `group_ids`, same order. Optional so bridges and servers of different versions keep working. */
  group_labels: z.array(groupLabelSchema).optional(),
  /**
   * Members the author called on by @handle in a group drop (labels follow the viewer). Only for the author and
   * for readers who reached it through that group (as members or its owner/admins); empty for everyone else.
   */
  mentions: z.array(z.object({ handle: z.string(), display_label: z.string() })).optional(),
  /** True when the viewer is among `mentions`. */
  mentioned_me: z.boolean().optional(),
  /**
   * It reached the viewer only through groups they muted (not also sent to them directly): people are not
   * notified unless `mentioned_me`. Still unread and listed as usual; models still see it.
   */
  muted: z.boolean().optional(),
  read: z.boolean(),
  starred: z.boolean(),
  archived: z.boolean(),
  state_version: z.number().int().nonnegative(),
  /** Present only when the origin belongs to the viewer's account. */
  origin_agent: originAgentSchema.nullable(),
  /** Valid deliveries belonging to the viewer, including the current endpoint when applicable. */
  deliveries: z.array(dropDeliverySchema),
  /** Frozen targets are exposed only to the author. */
  recipients: z.array(resolvedRecipientSchema),
  /**
   * Author only, one entry per `recipients` entry: whether each person has read it. Optional so bridges and
   * servers of different versions keep accepting each other's results.
   */
  recipient_status: z.array(recipientStatusSchema).optional(),
  /** Which drop this one answers (payload.reply_to), when the viewer may read it; null otherwise. */
  reply_to: replyRefSchema.nullable().optional(),
  /** Only on drops the viewer sent: readable replies to it. Absent on drops the viewer did not send. */
  replies: repliesInfoSchema.optional(),
});
export type DropSummary = z.infer<typeof dropSummarySchema>;

export const dropDetailSchema = dropSummarySchema.extend({
  body_chunk: z.string(),
  body_offset: z.number().int().nonnegative(),
  body_total_chars: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
  attachments: z.array(attachmentMetaSchema),
  extensions: z.record(z.string(), z.unknown()),
  expires_at: z.iso.datetime().nullable(),
});
export type DropDetail = z.infer<typeof dropDetailSchema>;

export const sendResultSchema = z.object({
  outcome: sendOutcomeSchema,
  request_id: requestIdSchema,
  drop_id: dropIdSchema.nullable(),
  recipients: z.array(resolvedRecipientSchema),
  approval_url: z.string().nullable(),
  retryable: z.boolean(),
  error: z.string().nullable(),
  viewer: viewerSchema,
});
export type SendResult = z.infer<typeof sendResultSchema>;
