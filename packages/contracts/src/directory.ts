import { z } from 'zod';
import { groupIdSchema, hIdSchema, routeIdSchema, sendTargetSchema, userIdSchema } from './drop.js';
import { LIMITS } from './limits.js';
import { publicEmailFieldSchema, resultHarnessKeySchema } from './names.js';

export const directoryKindSchema = z.enum(['person', 'group', 'route']);
export type DirectoryKind = z.infer<typeof directoryKindSchema>;

/**
 * A named entry a contact chose to publish: `@handle/alias`. Other people's agents are never listed (ADR 0013):
 * `auto` is always false and `harness_key` always `other` for them; both remain for older bridges.
 */
export const routeCardSchema = z.object({
  route_id: routeIdSchema,
  alias: z.string(),
  label: z.string(),
  harness_key: resultHarnessKeySchema,
  auto: z.boolean(),
  target: sendTargetSchema,
});
export type RouteCard = z.infer<typeof routeCardSchema>;

export const personCardSchema = z.object({
  kind: z.literal('person'),
  user_id: userIdSchema,
  handle: z.string(),
  /** My private remark > their public nickname > @handle. */
  display_label: z.string(),
  display_name: z.string(),
  remark: z.string().nullable(),
  /** The email this person published. Self-declared, unverified. */
  public_email: publicEmailFieldSchema,
  /** The target used when sending to "this person" (follows my preference or their default). */
  default_target: sendTargetSchema,
  default_target_label: z.string(),
  /** Always null for other people: which of their agents receive is theirs to know (ADR 0013). */
  default_endpoint: z
    .object({ label: z.string(), harness_key: resultHarnessKeySchema, address: z.string() })
    .nullable(),
  /** No longer sent (ADR 0013); kept in the schema for older servers. */
  receives_on_all_agents: z.boolean().optional(),
  /** True when default_target is my explicitly remembered preference for this contact. */
  preference_applied: z.boolean(),
  /** Set when a remembered preference exists but is no longer valid; sending to default_target will fail. */
  preference_problem: z.enum(['PREFERRED_ROUTE_UNAVAILABLE']).nullable(),
  alternatives: z.array(routeCardSchema),
  contact_status: z.enum(['accepted', 'invited', 'requested', 'blocked', 'group_only']),
});
export type PersonCard = z.infer<typeof personCardSchema>;

export const groupCardSchema = z.object({
  kind: z.literal('group'),
  group_id: groupIdSchema,
  slug: z.string(),
  display_name: z.string(),
  my_nickname: z.string().nullable(),
  member_count: z.number().int().nonnegative(),
  /**
   * Who is in the group (active members, the viewer included), so an agent can tell the user who it reaches.
   * Optional so bridges and servers of different versions keep working.
   */
  active_members: z
    .array(
      z.object({
        handle: z.string(),
        /** Viewer's remark > group nickname > public nickname > @handle. */
        display_label: z.string(),
        role: z.enum(['owner', 'admin', 'member']),
        public_email: publicEmailFieldSchema,
      }),
    )
    .optional(),
  /** Whether the current viewer's H is bound to receive this group's drops. */
  current_h_receives: z.boolean(),
  target: sendTargetSchema,
});
export type GroupCard = z.infer<typeof groupCardSchema>;

export const directoryEntrySchema = z.discriminatedUnion('kind', [personCardSchema, groupCardSchema]);
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

export const directoryLookupInputSchema = z
  .object({
    query: z.string().max(128).optional(),
    kind: z.enum(['person', 'group']).optional(),
    limit: z.number().int().min(1).max(LIMITS.DIRECTORY_LIMIT_MAX).optional(),
    cursor: z.string().max(512).optional(),
  })
  .strict();
export type DirectoryLookupInput = z.infer<typeof directoryLookupInputSchema>;

export const directoryLookupResultSchema = z.object({
  entries: z.array(directoryEntrySchema),
  next_cursor: z.string().nullable(),
  directory_revision: z.number().int().nonnegative(),
  /** True when the query matched more than one entry with the same display label; the caller must ask the user. */
  ambiguous: z.boolean(),
  viewer: z.object({
    user_id: userIdSchema,
    handle: z.string(),
    display_name: z.string(),
    public_email: publicEmailFieldSchema,
    h_id: hIdSchema,
    agent_name: z.string(),
  }),
});
export type DirectoryLookupResult = z.infer<typeof directoryLookupResultSchema>;
