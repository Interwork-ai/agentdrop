import { z } from 'zod';

/*
 * The per-person event stream (ADR 0040). Events are hints: they carry a type and the id of what changed, never
 * content. Titles, bodies and names are read through the mailbox routes, under the one authorization predicate.
 */

export const EVENT_TYPES = [
  'delivery.created',
  'delivery.state',
  'grant.revoked',
  'drop.revoked',
  'attachment.removed',
  /** The person's contacts, groups, invitations or names changed: refetch pending_requests or the directory. */
  'directory.changed',
] as const;
export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventTypeSchema>;

export const streamEventSchema = z.object({
  type: eventTypeSchema,
  /** The drop the event is about; null for `directory.changed`. */
  drop_id: z.uuid().nullable(),
});
export type StreamEvent = z.infer<typeof streamEventSchema>;

/** Longest a long-poll request waits for an event before answering with none. */
export const EVENTS_MAX_WAIT_S = 25;
export const EVENTS_LIMIT_DEFAULT = 100;
export const EVENTS_LIMIT_MAX = 500;
/**
 * Longest cursor, in characters. It travels in the query string and in `Last-Event-ID`, so it stays far below the
 * usual 16 KB limit on a request line or header. The server never issues a longer one: a person with so many agents
 * that their cursor would not fit (several hundred) gets NOT_FOUND, as from a server without the stream.
 */
export const EVENTS_CURSOR_MAX = 8192;

export const eventsInputSchema = z
  .object({
    /** Opaque. Absent: subscribe from now (no backlog); the result carries the cursor to continue from. */
    cursor: z.string().min(1).max(EVENTS_CURSOR_MAX).optional(),
    /** Long-poll: seconds to wait when nothing is pending; 0 answers at once. */
    wait: z.number().int().min(0).max(EVENTS_MAX_WAIT_S).optional(),
    limit: z.number().int().min(1).max(EVENTS_LIMIT_MAX).optional(),
    /** As for list_drops: `current` narrows to the calling agent; account-wide follows the person's setting. */
    endpoint_scope: z.enum(['account', 'current']).optional(),
  })
  .strict();
export type EventsInput = z.infer<typeof eventsInputSchema>;

export const eventsResultSchema = z.object({
  events: z.array(streamEventSchema),
  /** Opaque; pass it back to continue after these events. A stale or foreign cursor answers RESYNC_REQUIRED. */
  cursor: z.string(),
  /** More events are already waiting: call again at once. */
  has_more: z.boolean(),
});
export type EventsResult = z.infer<typeof eventsResultSchema>;

/** `/.well-known/agentdrop`: what this server speaks, so clients detect features instead of inferring them. */
export const WELL_KNOWN_CAPABILITIES = ['events'] as const;
export const wellKnownSchema = z.object({
  protocol: z.literal('agentdrop/v1'),
  server_version: z.string(),
  capabilities: z.array(z.string()),
});
export type WellKnown = z.infer<typeof wellKnownSchema>;
