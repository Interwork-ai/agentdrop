import { z } from 'zod';
import { groupIdSchema, hIdSchema, userIdSchema } from './drop.js';
import { LIMITS } from './limits.js';
import { displayNameSchema, groupSlugSchema, publicEmailFieldSchema } from './names.js';

const handleInputSchema = z.string().min(1).max(64);

/**
 * Relationship management from the agent side. These tools act as the human (same account) but stay inside
 * safe boundaries: an agent can only bind the endpoint it runs on, and renaming / default receiver / credential
 * revocation stay dashboard-only.
 */

export const pendingRequestsInputSchema = z.object({}).strict();
export const pendingRequestsResultSchema = z.object({
  /** People who invited me; accept with contact_respond. */
  contact_requests_received: z.array(
    z.object({ user_id: userIdSchema, handle: z.string(), display_name: z.string() }),
  ),
  /** People I invited who have not answered yet. */
  contact_requests_sent: z.array(
    z.object({ user_id: userIdSchema, handle: z.string(), display_name: z.string() }),
  ),
  /** Groups I was invited to; accept with group_respond (binds this endpoint). */
  group_invitations: z.array(
    z.object({
      group_id: groupIdSchema,
      slug: z.string(),
      display_name: z.string(),
      member_count: z.number().int(),
      /** Who put me on the list. Part of deciding whether to accept, so the invitee sees it too. */
      invited_by_handle: z.string().nullable().optional(),
    }),
  ),
  /**
   * Somebody a member wants to bring into a group I administer. Only a human decides these: the dashboard, or
   * `agentdrop group approve` at a real terminal. There is deliberately no tool for it.
   */
  group_join_requests: z
    .array(
      z.object({
        group_id: groupIdSchema,
        slug: z.string(),
        display_name: z.string(),
        invitee_handle: z.string(),
        invitee_display_name: z.string(),
        invited_by_handle: z.string(),
        created_at: z.iso.datetime(),
        /** Where a human decides it. There is no tool and no CLI command that decides for them. */
        decide_url: z.string(),
      }),
    )
    .optional(),
  /** My active groups, with the conditions that silently break a group send. */
  groups: z
    .array(
      z.object({
        group_id: groupIdSchema,
        slug: z.string(),
        display_name: z.string(),
        /** This endpoint receives the group. */
        current_h_receives: z.boolean(),
        /** None of my endpoints receive it: a send to this group would be refused because of me. */
        my_binding_missing: z.boolean(),
        /** Other active members without any usable receiving endpoint (admins see the real number). */
        members_needing_repair: z.number().int(),
        /**
         * Deprecated: no longer the real number of receiving agents, which would let a member work out how many
         * agents the others have (ADR 0013). Read `endpoints_over_limit`; this is 0, or limit + 1 when over.
         */
        endpoint_total: z.number().int(),
        endpoint_limit: z.number().int(),
        /** Group sends are refused until members receive with fewer agents. Optional for older servers. */
        endpoints_over_limit: z.boolean().optional(),
      }),
    )
    .optional(),
  viewer: z.object({ user_id: userIdSchema, handle: z.string(), h_id: hIdSchema, agent_name: z.string() }),
});

export const contactRequestInputSchema = z.object({ handle: z.string().min(1).max(64) }).strict();
export const contactRespondInputSchema = z
  .object({ user_id: userIdSchema, decision: z.enum(['accept', 'decline']) })
  .strict();
export const contactResultSchema = z.object({
  user_id: userIdSchema,
  handle: z.string(),
  display_name: z.string(),
  status: z.enum(['accepted', 'invited', 'requested', 'blocked', 'group_only', 'removed']),
});

/**
 * Removing contacts from the terminal (`agentdrop contact remove`). Without `confirm` nothing changes and the
 * response describes each contact so it can be shown to the person first; only an explicit confirmation from
 * them, given in the conversation, may lead to a second call with `confirm: true`. There is no MCP tool for it.
 */
export const contactRemoveInputSchema = z
  .object({
    handles: z.array(z.string().min(1).max(64)).min(1).max(20),
    confirm: z.boolean().default(false),
  })
  .strict();
export const contactRemovalSchema = z.object({
  user_id: userIdSchema,
  handle: z.string(),
  display_name: z.string(),
  /** My private remark for them, if any. */
  remark: z.string().nullable(),
  status: z.enum(['accepted', 'invited', 'requested', 'blocked']),
  contact_since: z.iso.datetime(),
  drops_from_them: z.number().int().nonnegative(),
  drops_to_them: z.number().int().nonnegative(),
  last_drop_at: z.iso.datetime().nullable(),
  /** Removing a contact does not end a shared group: they can still message me there. */
  shared_groups: z.array(z.string()),
  is_system: z.boolean(),
});
export const contactRemoveResultSchema = z.object({
  removed: z.boolean(),
  contacts: z.array(contactRemovalSchema),
});
export type ContactRemoveInput = z.infer<typeof contactRemoveInputSchema>;
export type ContactRemoval = z.infer<typeof contactRemovalSchema>;
export type ContactRemoveResult = z.infer<typeof contactRemoveResultSchema>;

/** Connecting a Feishu group-bot webhook for notices (docs/FEISHU.md). */
export const feishuConnectInputSchema = z
  .object({
    url: z.string().min(1).max(300),
    /** Only when signature verification is on for the bot. */
    secret: z.string().max(200).nullable().optional(),
    language: z.enum(['en', 'zh']).optional(),
  })
  .strict();

/** Who may bring people in, and whether an admin has to approve it first. Owners/admins always invite directly. */
export const groupInvitePolicySchema = z.enum(['open', 'admin_approval']);

/**
 * The group's settings, changed from the dashboard only (`PATCH /v1/me/groups/{id}/policy`, browser session).
 * `member_invite_policy`: owners and admins. `history_visible` (ADR 0022): the owner only; anyone else is
 * FORBIDDEN. At least one of them must be given.
 */
export const groupSettingsInputSchema = z
  .object({
    member_invite_policy: groupInvitePolicySchema.optional(),
    history_visible: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.member_invite_policy !== undefined || v.history_visible !== undefined, {
    message: 'nothing to change',
  });
export type GroupSettingsInput = z.infer<typeof groupSettingsInputSchema>;

export const groupCreateInputSchema = z
  .object({
    /** Omitted: the creator's handle, with a random suffix when taken. */
    slug: groupSlugSchema.optional(),
    /**
     * Omitted: the creator's nickname plus the number of people invited in the same call ("Alice +2"), capped at
     * GROUP_DEFAULT_NAME_MAX_CHARS. Invitees' names never appear in it.
     */
    display_name: displayNameSchema.optional(),
    description: z.string().max(512).optional(),
    /** Invite these handles immediately. They join only after accepting and choosing their own endpoint. */
    invite_handles: z
      .array(handleInputSchema)
      .max(LIMITS.GROUP_MAX_MEMBERS - 1)
      .optional(),
  })
  .strict();
export const groupInviteInputSchema = z
  .object({
    group_id: groupIdSchema,
    /** One or more handles. `handle` is the older single-value spelling and still works. */
    handles: z.array(handleInputSchema).max(LIMITS.GROUP_MAX_MEMBERS).optional(),
    handle: handleInputSchema.optional(),
  })
  .strict();
export const groupRespondInputSchema = z
  .object({
    group_id: groupIdSchema,
    decision: z.enum(['accept', 'decline']),
    nickname: displayNameSchema.optional(),
  })
  .strict();
export const groupLeaveInputSchema = z.object({ group_id: groupIdSchema }).strict();

export const groupResultSchema = z.object({
  group_id: groupIdSchema,
  slug: z.string(),
  display_name: z.string(),
  my_role: z.enum(['owner', 'admin', 'member']).nullable(),
  my_status: z.enum(['invited', 'active', 'left']),
  /** Whether the endpoint this agent runs on receives the group. */
  current_h_receives: z.boolean(),
  /* Everything below is optional so a newer bridge keeps working against an older server. */
  invite_policy: groupInvitePolicySchema.optional(),
  /**
   * Whether every active member can read the whole group history, including messages from before they joined
   * (read-only, `sources: ['group_history']`; ADR 0022). Only the owner changes it, in the dashboard.
   */
  history_visible: z.boolean().optional(),
  /** People per group: active members plus outstanding invitations. */
  member_limit: z.number().int().optional(),
  member_slots_used: z.number().int().optional(),
  /** Join requests waiting for an admin. Only a human decides them, in the dashboard. */
  join_requests_pending: z.number().int().optional(),
  /**
   * The group's file space (ADR 0029): bytes of files still stored for drops sent to the group, and its limit. A
   * send whose attachments would go past the limit is refused with GROUP_STORAGE_FULL.
   */
  storage: z
    .object({ used_bytes: z.number().int().nonnegative(), limit_bytes: z.number().int().positive() })
    .optional(),
  /** What this call did, per handle. Absent for calls that invited nobody. */
  invites: z
    .array(z.object({ handle: z.string(), outcome: z.enum(['invited', 'requested', 'already_member']) }))
    .optional(),
  active_member_count: z.number().int(),
  members: z.array(
    z.object({
      handle: z.string(),
      display_label: z.string(),
      role: z.enum(['owner', 'admin', 'member']),
      status: z.enum(['invited', 'active']),
      /** Published email of an active member, shown to active members only. Self-declared, unverified. */
      public_email: publicEmailFieldSchema,
    }),
  ),
});

export const MANAGE_TOOL_NAMES = [
  'pending_requests',
  'contact_request',
  'contact_respond',
  'group_create',
  'group_invite',
  'group_respond',
  'group_leave',
] as const;

/** One file stored for a group, for the owner and admins freeing space (ADR 0029). Dashboard only. */
export const groupFileSchema = z.object({
  drop_id: z.string(),
  attachment_id: z.string(),
  safe_name: z.string(),
  byte_size: z.number().int().nonnegative(),
  /** Who sent it, as the viewer knows them. */
  from_label: z.string(),
  sent_at: z.iso.datetime(),
});
export type GroupFile = z.infer<typeof groupFileSchema>;
export const groupFilesResultSchema = z.object({
  storage: z.object({ used_bytes: z.number().int().nonnegative(), limit_bytes: z.number().int().positive() }),
  /** Largest first; at most 200. */
  files: z.array(groupFileSchema),
});
export type GroupFilesResult = z.infer<typeof groupFilesResultSchema>;
