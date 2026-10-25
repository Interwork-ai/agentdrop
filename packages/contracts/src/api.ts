import { z } from 'zod';
import {
  clientSettingsAppliedInputSchema,
  clientSettingsUpdateInputSchema,
  deviceClientSettingsSchema,
  noticeClaimResponseSchema,
  noticeStateResponseSchema,
  noticeStateSchema,
} from './client-settings.js';
import { directoryLookupInputSchema, directoryLookupResultSchema } from './directory.js';
import { attachmentMetaSchema, dropIdSchema, hIdSchema, userIdSchema, viewerSchema } from './drop.js';
import { apiErrorSchema } from './errors.js';
import { exportInputSchema } from './export.js';
import { feishuAppViewSchema, feishuLinkCodeInputSchema, feishuLinkCodeSchema } from './manage.js';
import { displayNameSchema, harnessKeySchema } from './names.js';
import {
  pushSettingsSchema,
  pushSubscriptionDeleteResultSchema,
  pushSubscriptionInputSchema,
  pushSubscriptionViewSchema,
} from './push.js';
import {
  listDropsInputSchema,
  listDropsResultSchema,
  readDropInputSchema,
  readDropResultSchema,
  sendDropInputSchema,
  sendDropResultSchema,
  setDropStateInputSchema,
  setDropStateResultSchema,
} from './tools.js';

/* ------------------------------------------------------------------ health */
export const healthLiveSchema = z.object({ status: z.literal('ok'), version: z.string() });
export const healthReadySchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.record(z.string(), z.enum(['ok', 'fail'])),
});

/* ------------------------------------------------------------------ identity (H credential) */
export const identitySchema = z.object({
  viewer: viewerSchema,
  device_label: z.string(),
  harness_key: z.string(),
  profile_key: z.string(),
  credential_expires_at: z.iso.datetime().nullable(),
  toolsets: z.array(z.enum(['core', 'files', 'manage', 'standard'])),
  server_version: z.string(),
  limits: z.object({
    max_file_bytes: z.number().int().positive(),
    max_drop_file_bytes: z.number().int().positive(),
    quota_bytes: z.number().int().positive(),
  }),
  /** Account-level notification channels, so an agent does not offer to set up one that is already on. */
  notifications: z.object({ feishu: z.boolean() }).optional(),
});
export type Identity = z.infer<typeof identitySchema>;

/* ------------------------------------------------------------------ pairing (CLI device authorization) */
export const profileKeySchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'profile key must be lowercase alphanumeric');

export const pairingStartInputSchema = z
  .object({
    installation_id: z.uuid(),
    device_label: displayNameSchema,
    harness_key: harnessKeySchema,
    profile_key: profileKeySchema,
    endpoint_label: displayNameSchema,
    bridge_version: z.string().max(64),
    platform: z.string().max(64),
  })
  .strict();
export type PairingStartInput = z.infer<typeof pairingStartInputSchema>;

export const pairingStartResultSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_url: z.string(),
  verification_url_complete: z.string(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});
export type PairingStartResult = z.infer<typeof pairingStartResultSchema>;

export const pairingPollInputSchema = z.object({ device_code: z.string().min(16).max(256) }).strict();
export const pairingPollResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('denied') }),
  z.object({ status: z.literal('expired') }),
  z.object({
    status: z.literal('approved'),
    h_id: hIdSchema,
    credential: z.string(),
    credential_expires_at: z.iso.datetime(),
    user_id: userIdSchema,
    handle: z.string(),
    agent_name: z.string(),
    server_version: z.string(),
  }),
]);
export type PairingPollResult = z.infer<typeof pairingPollResultSchema>;

export const pairingLookupResultSchema = z.object({
  user_code: z.string(),
  device_label: z.string(),
  harness_key: harnessKeySchema,
  profile_key: profileKeySchema,
  endpoint_label: z.string(),
  platform: z.string(),
  bridge_version: z.string(),
  expires_at: z.iso.datetime(),
  /** Whether approving would reuse an existing endpoint of this user (same device/harness/profile). */
  existing_endpoint: z.boolean(),
});

export const pairingDecisionInputSchema = z
  .object({
    user_code: z.string().min(4).max(32),
    decision: z.enum(['approve', 'deny']),
    /** Optional: rename the agent at approval time. Ignored when the endpoint already exists. */
    endpoint_label: displayNameSchema.optional(),
    /** Make this endpoint my default receiving endpoint (only offered when I have none). */
    make_default: z.boolean().optional(),
  })
  .strict();

/* ------------------------------------------------------------------ connections (bridge heartbeat) */
export const connectionOpenInputSchema = z
  .object({
    client_name: z.string().max(128).nullable(),
    client_version: z.string().max(64).nullable(),
    capabilities: z.record(z.string(), z.unknown()).default({}),
    bridge_version: z.string().max(64),
    toolset: z.enum(['core', 'standard']),
  })
  .strict();
export const connectionOpenResultSchema = z.object({
  connection_id: z.uuid(),
  heartbeat_interval_s: z.number().int().positive(),
  viewer: viewerSchema,
});
export const connectionHeartbeatInputSchema = z
  .object({ connection_id: z.uuid(), last_tool: z.string().max(64).nullable().optional() })
  .strict();

/* ------------------------------------------------------------------ send request status */
export const sendRequestStatusSchema = z.object({
  request_id: z.string(),
  outcome: z.enum(['delivered', 'needs_approval', 'not_sent']).nullable(),
  drop_id: z.string().nullable(),
  approval_url: z.string().nullable(),
});

/* ------------------------------------------------------------------ mark everything read (ADR 0018) */
/**
 * The person's "mark all as read": every unread, not archived drop they received, or only those that reached them
 * through `group_id`, up to `up_to` (what the list showed; anything received later stays unread). Read state is the
 * person's (ADR 0007). At most LIMITS.MARK_ALL_READ_MAX drops per call; `remaining` says whether to call again.
 */
export const markAllReadInputSchema = z
  .object({
    group_id: z.uuid().optional(),
    up_to: z.iso.datetime().optional(),
  })
  .strict();
export type MarkAllReadInput = z.infer<typeof markAllReadInputSchema>;
export const markAllReadResultSchema = z.object({
  marked: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  unread_count: z.number().int().nonnegative(),
  viewer: viewerSchema,
});

/* ------------------------------------------------------------------ attachments (H credential) */
export const attachmentStagedResultSchema = attachmentMetaSchema.extend({ status: z.enum(['ready']) });

/** Deleting one item from my own space (ADR 0030): the drop is revoked and its files deleted. */
export const spaceDeleteResultSchema = z.object({
  drop_id: dropIdSchema,
  deleted: z.literal(true),
  /** Bytes of files freed (counted against the agent that uploaded them). */
  freed_bytes: z.number().int().nonnegative(),
});
export type SpaceDeleteResult = z.infer<typeof spaceDeleteResultSchema>;

/* ------------------------------------------------------------------ route registry for OpenAPI generation */
export interface RouteContract {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  auth: 'none' | 'h_credential' | 'user_session';
  summary: string;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
}

export const H_ROUTES = {
  clientSettings: {
    method: 'GET',
    path: '/v1/h/client-settings',
    auth: 'h_credential',
    summary: 'Read desired client settings for this endpoint device',
    response: deviceClientSettingsSchema,
  },
  clientSettingsApplied: {
    method: 'POST',
    path: '/v1/h/client-settings/applied',
    auth: 'h_credential',
    summary: 'Report this device synchronization status for the current settings version',
    body: clientSettingsAppliedInputSchema,
    response: deviceClientSettingsSchema,
  },
  noticeState: {
    method: 'GET',
    path: '/v1/h/notice-state',
    auth: 'h_credential',
    summary: 'What this account has already been shown in end-of-turn notices (shared by all of its agents)',
    response: noticeStateResponseSchema,
  },
  noticeStatePut: {
    method: 'PUT',
    path: '/v1/h/notice-state',
    auth: 'h_credential',
    summary: 'Replace what this account has been shown in end-of-turn notices',
    body: noticeStateSchema,
    response: noticeStateResponseSchema,
  },
  noticeClaim: {
    method: 'POST',
    path: '/v1/h/notice-state/claim',
    auth: 'h_credential',
    summary:
      'Atomically record what is pending now as shown and return the previous record: of concurrent claims by agents of one account, only one sees an item as new',
    body: noticeStateSchema,
    response: noticeClaimResponseSchema,
  },
  noticeSeenState: {
    method: 'GET',
    path: '/v1/h/notice-state/seen',
    auth: 'h_credential',
    summary:
      'What this account has already seen inside an agent session (shared by all of its agents; browser push and Feishu never write it)',
    response: noticeStateResponseSchema,
  },
  noticeSeenClaim: {
    method: 'POST',
    path: '/v1/h/notice-state/seen/claim',
    auth: 'h_credential',
    summary:
      'Atomically record what is pending now as seen in an agent and return the previous seen record (of concurrent claims only one sees an item as new); also records it as shown',
    body: noticeStateSchema,
    response: noticeClaimResponseSchema,
  },
  identity: {
    method: 'GET',
    path: '/v1/h/identity',
    auth: 'h_credential',
    summary: 'Who is the current endpoint',
    response: identitySchema,
  },
  directory: {
    method: 'GET',
    path: '/v1/h/directory',
    auth: 'h_credential',
    summary: 'Authorized directory lookup',
    query: directoryLookupInputSchema,
    response: directoryLookupResultSchema,
  },
  listDrops: {
    method: 'GET',
    path: '/v1/h/drops',
    auth: 'h_credential',
    summary: 'List drops of the current endpoint',
    query: listDropsInputSchema,
    response: listDropsResultSchema,
  },
  readDrop: {
    method: 'GET',
    path: '/v1/h/drops/{drop_id}',
    auth: 'h_credential',
    summary: 'Read one drop (bounded)',
    query: readDropInputSchema.omit({ drop_id: true }),
    response: readDropResultSchema,
  },
  sendDrop: {
    method: 'POST',
    path: '/v1/h/drops',
    auth: 'h_credential',
    summary: 'Send a drop (idempotent by request_id)',
    body: sendDropInputSchema,
    response: sendDropResultSchema,
  },
  setDropState: {
    method: 'PATCH',
    path: '/v1/h/drops/{drop_id}/state',
    auth: 'h_credential',
    summary: 'Update shared read/starred/archived state',
    body: setDropStateInputSchema,
    response: setDropStateResultSchema,
  },
  markAllRead: {
    method: 'POST',
    path: '/v1/h/drops/mark-read',
    auth: 'h_credential',
    summary: "Mark the person's unread drops read (all, or one group's), up to a point in time",
    body: markAllReadInputSchema,
    response: markAllReadResultSchema,
  },
  sendRequestStatus: {
    method: 'GET',
    path: '/v1/h/send-requests/{request_id}',
    auth: 'h_credential',
    summary: 'Look up the result of an earlier send by request_id',
    response: sendRequestStatusSchema,
  },
  deleteSpaceItem: {
    method: 'DELETE',
    path: '/v1/h/space/{drop_id}',
    auth: 'h_credential',
    summary:
      "Delete one item of the account's own space (a drop it sent to itself): revoked, its files freed",
    response: spaceDeleteResultSchema,
  },
  uploadAttachment: {
    method: 'POST',
    path: '/v1/h/attachments',
    auth: 'h_credential',
    summary: 'Stream-upload one file as a staged attachment (multipart or octet-stream)',
    response: attachmentStagedResultSchema,
  },
  downloadAttachment: {
    method: 'GET',
    path: '/v1/h/drops/{drop_id}/attachments/{attachment_id}',
    auth: 'h_credential',
    summary: 'Download an attachment through the authorization of the given drop',
    response: z.any(),
  },
  exportTimeline: {
    method: 'GET',
    path: '/v1/h/export',
    auth: 'h_credential',
    summary:
      'Stream a date-ranged timeline as newline-delimited JSON (header line, one line per drop, trailer with count and digest)',
    query: exportInputSchema,
    /* Not JSON: the body is NDJSON, same as the attachment route above. */
    response: z.any(),
  },
  connectionOpen: {
    method: 'POST',
    path: '/v1/h/connections',
    auth: 'h_credential',
    summary: 'Register a bridge connection',
    body: connectionOpenInputSchema,
    response: connectionOpenResultSchema,
  },
  connectionHeartbeat: {
    method: 'POST',
    path: '/v1/h/connections/heartbeat',
    auth: 'h_credential',
    summary: 'Heartbeat a bridge connection',
    body: connectionHeartbeatInputSchema,
    response: z.object({ ok: z.literal(true) }),
  },
} as const satisfies Record<string, RouteContract>;

export const PUBLIC_ROUTES = {
  healthLive: {
    method: 'GET',
    path: '/health/live',
    auth: 'none',
    summary: 'Process liveness',
    response: healthLiveSchema,
  },
  healthReady: {
    method: 'GET',
    path: '/health/ready',
    auth: 'none',
    summary: 'Dependency readiness',
    response: healthReadySchema,
  },
  pairingStart: {
    method: 'POST',
    path: '/v1/pairing/start',
    auth: 'none',
    summary: 'Start CLI pairing (device authorization)',
    body: pairingStartInputSchema,
    response: pairingStartResultSchema,
  },
  pairingPoll: {
    method: 'POST',
    path: '/v1/pairing/poll',
    auth: 'none',
    summary: 'Poll pairing status; returns the endpoint credential exactly once',
    body: pairingPollInputSchema,
    response: pairingPollResultSchema,
  },
} as const satisfies Record<string, RouteContract>;

export const ERROR_RESPONSE = apiErrorSchema;

export const USER_ROUTES = {
  pushSettings: {
    method: 'GET',
    path: '/v1/me/push',
    auth: 'user_session',
    summary: 'Read Web Push availability and sanitized owned subscriptions',
    response: pushSettingsSchema,
  },
  upsertPushSubscription: {
    method: 'POST',
    path: '/v1/me/push/subscriptions',
    auth: 'user_session',
    summary: 'Create or refresh an account-level browser push subscription',
    body: pushSubscriptionInputSchema,
    response: pushSubscriptionViewSchema,
  },
  deletePushSubscription: {
    method: 'DELETE',
    path: '/v1/me/push/subscriptions/{id}',
    auth: 'user_session',
    summary: 'Revoke an owned browser push subscription',
    response: pushSubscriptionDeleteResultSchema,
  },
  deviceClientSettings: {
    method: 'GET',
    path: '/v1/me/devices/{id}/client-settings',
    auth: 'user_session',
    summary: 'Read owned device client settings and reported synchronization status',
    response: deviceClientSettingsSchema,
  },
  updateDeviceClientSettings: {
    method: 'PUT',
    path: '/v1/me/devices/{id}/client-settings',
    auth: 'user_session',
    summary: 'Set desired client settings for an active owned device',
    body: clientSettingsUpdateInputSchema,
    response: deviceClientSettingsSchema,
  },
  feishuApp: {
    method: 'GET',
    path: '/v1/me/feishu-app',
    auth: 'user_session',
    summary:
      "Whether the server has a Feishu app and whether the person's Feishu account is linked (ADR 0039)",
    response: feishuAppViewSchema,
  },
  feishuAppCode: {
    method: 'POST',
    path: '/v1/me/feishu-app/code',
    auth: 'user_session',
    summary: 'A one-time code to send to the Feishu bot, linking the Feishu account (10 minutes)',
    body: feishuLinkCodeInputSchema,
    response: feishuLinkCodeSchema,
  },
  feishuAppUnlink: {
    method: 'DELETE',
    path: '/v1/me/feishu-app',
    auth: 'user_session',
    summary: 'Unlink the Feishu account; notices go back to the group bot, if any',
    response: feishuAppViewSchema,
  },
} as const satisfies Record<string, RouteContract>;
