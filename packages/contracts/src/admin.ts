import { z } from 'zod';
import { hIdSchema, userIdSchema } from './drop.js';
import { harnessKeySchema } from './names.js';

/**
 * Operator (admin) surface. Every shape here is deliberately metadata only: an admin can see who exists, which
 * agents they paired, how much they sent and what happened on the server, but never the title, body or attachment
 * names of anybody's drops. Reading other people's content is not an ability this API grants.
 */

/** open: anyone who can reach the server may register · closed: nobody can register. */
export const signupModeSchema = z.enum(['open', 'closed']);
export type SignupMode = z.infer<typeof signupModeSchema>;

export const adminSettingsSchema = z.object({
  signup_mode: signupModeSchema,
  /**
   * File space of every group, in bytes (ADR 0029): a send whose attachments would push a group past it is refused.
   * The server's GROUP_STORAGE_QUOTA_BYTES until an admin changes it. Absent on older servers.
   */
  group_storage_quota_bytes: z.number().int().positive().optional(),
  updated_at: z.iso.datetime().nullable(),
  updated_by_handle: z.string().nullable(),
});
export type AdminSettings = z.infer<typeof adminSettingsSchema>;

export const adminSettingsInputSchema = z
  .object({
    signup_mode: signupModeSchema.optional(),
    /** 1 MiB to 1 TiB. */
    group_storage_quota_bytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(1024 ** 4)
      .optional(),
  })
  .strict()
  .refine((v) => v.signup_mode !== undefined || v.group_storage_quota_bytes !== undefined, {
    message: 'set signup_mode or group_storage_quota_bytes',
  });

const count = z.number().int().nonnegative();

/** Of `eligible` messages, how many were `answered`; `share` is answered / eligible, null when nothing is eligible. */
const answeredShareSchema = z.object({
  answered: count,
  eligible: count,
  share: z.number().min(0).max(1).nullable(),
});

/**
 * Product health (ADR 0035), computed from timestamps, ids and counts only: never a title, body, file name, person's
 * name or handle. Excludes the built-in assistant (its account, its messages, and messages addressed only to it),
 * My space, and messages a person addressed only to their own agents. A "message to people" is one addressed to at
 * least one group or at least one person other than its author and the assistant.
 */
export const adminProductHealthSchema = z.object({
  /** Messages to people answered by someone other than their author within 72 hours of being sent. */
  answered_72h: z.object({ last_7d: answeredShareSchema, last_28d: answeredShareSchema }),
  /** Distinct people who sent at least one message to people in the window. */
  active_senders: z.object({ last_7d: count, last_28d: count }),
  /** Messages to people sent in the last 7 days: to at least one group, or only to people. */
  sent_7d: z.object({ direct: count, group: count }),
  /** Accounts created in the last 28 days and what each did within 7 days of signing up. */
  activation: z.object({
    signups_28d: count,
    /** Of those, created less than 7 days ago: their first week is not over, so the counts below can still grow. */
    in_first_week: count,
    paired_agent: count,
    tried_assistant: count,
    sent_to_people: count,
  }),
  /**
   * Messages to people delivered in the last 7 days, one entry per recipient person (not per agent): how many there
   * were, how many that person has marked read, and the median time from delivery to read.
   */
  read_latency_7d: z.object({
    delivered: count,
    read: count,
    median_seconds: z.number().nonnegative().nullable(),
  }),
});
export type AdminProductHealth = z.infer<typeof adminProductHealthSchema>;

/** Server-wide counters for the overview page. Counts only: no titles, bodies or file names. */
export const adminOverviewSchema = z.object({
  users: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    suspended: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    admins: z.number().int().nonnegative(),
    new_7d: z.number().int().nonnegative(),
  }),
  endpoints: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    live_connections: z.number().int().nonnegative(),
    by_harness: z.array(z.object({ harness_key: harnessKeySchema, count: z.number().int().nonnegative() })),
  }),
  drops: z.object({
    total: z.number().int().nonnegative(),
    last_24h: z.number().int().nonnegative(),
    last_7d: z.number().int().nonnegative(),
    deliveries: z.number().int().nonnegative(),
    pending_approvals: z.number().int().nonnegative(),
  }),
  groups: z.object({ total: z.number().int().nonnegative(), active_members: z.number().int().nonnegative() }),
  storage: z.object({
    attachments: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  signup_mode: signupModeSchema,
  server_version: z.string(),
  /** Content encryption at rest (docs/plan/CONTENT_ENCRYPTION.md): switch, active key id, rows not yet encrypted. */
  encryption: z
    .object({
      mode: z.enum(['off', 'on']),
      key_id: z.string().nullable(),
      plaintext_remaining: z.object({
        drops: z.number().int().nonnegative(),
        approvals: z.number().int().nonnegative(),
        attachments: z.number().int().nonnegative(),
      }),
    })
    .optional(),
  /** Metadata-only product metrics (ADR 0035). Absent on older servers. */
  product_health: adminProductHealthSchema.optional(),
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;

export const adminUserStatusSchema = z.enum(['active', 'suspended', 'deleted']);

export const adminUserSummarySchema = z.object({
  user_id: userIdSchema,
  handle: z.string(),
  display_name: z.string(),
  email: z.string().nullable(),
  status: adminUserStatusSchema,
  is_admin: z.boolean(),
  /** The built-in @agentdrop assistant: listed for transparency, never administered like a person. */
  is_system: z.boolean().optional(),
  suspended_reason: z.string().nullable(),
  created_at: z.iso.datetime(),
  last_seen_at: z.iso.datetime().nullable(),
  endpoints: z.number().int().nonnegative(),
  contacts: z.number().int().nonnegative(),
  groups: z.number().int().nonnegative(),
  drops_sent: z.number().int().nonnegative(),
  drops_received: z.number().int().nonnegative(),
  storage_bytes: z.number().int().nonnegative(),
});
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;

export const adminEndpointSchema = z.object({
  h_id: hIdSchema,
  label: z.string(),
  harness_key: harnessKeySchema,
  profile_key: z.string(),
  device_label: z.string(),
  platform: z.string().nullable(),
  address: z.string().nullable(),
  is_default_receiver: z.boolean(),
  created_at: z.iso.datetime(),
  revoked_at: z.iso.datetime().nullable(),
  last_seen_at: z.iso.datetime().nullable(),
  live_connections: z.number().int().nonnegative(),
  drops_received: z.number().int().nonnegative(),
});

export const adminUserDetailSchema = adminUserSummarySchema.extend({
  endpoint_list: z.array(adminEndpointSchema),
  group_list: z.array(
    z.object({
      group_id: z.string(),
      slug: z.string(),
      display_name: z.string(),
      role: z.enum(['owner', 'admin', 'member']),
      status: z.string(),
    }),
  ),
  /** Counts per peer; never the content exchanged with them. */
  contact_list: z.array(
    z.object({ user_id: userIdSchema, handle: z.string(), status: z.string(), blocked: z.boolean() }),
  ),
  recent_activity: z.array(
    z.object({
      id: z.number().int(),
      action: z.string(),
      result: z.string(),
      target_id: z.string().nullable(),
      created_at: z.iso.datetime(),
    }),
  ),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

export const adminUserListSchema = z.object({
  users: z.array(adminUserSummarySchema),
  next_cursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
});

export const adminAuditEventSchema = z.object({
  id: z.number().int(),
  actor_user_id: userIdSchema.nullable(),
  actor_handle: z.string().nullable(),
  h_id: hIdSchema.nullable(),
  action: z.string(),
  target_id: z.string().nullable(),
  result: z.string(),
  meta: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime(),
});
export type AdminAuditEvent = z.infer<typeof adminAuditEventSchema>;

export const adminAuditListSchema = z.object({
  events: z.array(adminAuditEventSchema),
  next_cursor: z.string().nullable(),
});

export const adminSuspendInputSchema = z.object({ reason: z.string().max(200).optional() }).strict();
export const adminSetAdminInputSchema = z.object({ is_admin: z.boolean() }).strict();
/** Closing an account is irreversible, so the admin must type the handle to confirm it. */
export const adminDeleteInputSchema = z.object({ confirm_handle: z.string().min(1) }).strict();

/** Public: the sign-up page asks for this before showing the form. */
export const signupPolicySchema = z.object({
  mode: signupModeSchema,
  /** `email`: the server mails reset links. `admin`: no SMTP; an administrator generates a link to hand over. */
  password_reset: z.enum(['email', 'admin']),
});

/** A one-time password reset link generated by an administrator. Shown once; it is never stored in readable form. */
export const adminPasswordResetLinkSchema = z.object({
  url: z.string(),
  expires_at: z.iso.datetime(),
});
export type AdminPasswordResetLink = z.infer<typeof adminPasswordResetLinkSchema>;
