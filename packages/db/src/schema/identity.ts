import type { DeviceClientSettings, NoticeState } from '@agentdrop/contracts';
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './auth.js';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Human accounts. `handle` is unique and normalized; `display_name` is the editable public nickname. */
export const appUsers = pgTable(
  'app_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authUserId: text('auth_user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'restrict' }),
    handle: text('handle').notNull(),
    displayName: text('display_name').notNull(),
    avatarAttachmentId: uuid('avatar_attachment_id'),
    /** Email the person publishes to contacts and group co-members (ADR 0012). Self-declared; null = none. */
    publicEmail: text('public_email'),
    profileVersion: integer('profile_version').notNull().default(1),
    /** Bumped whenever this user's contacts, groups or names change; returned to clients as directory_revision. */
    directoryRevision: integer('directory_revision').notNull().default(0),
    isAdmin: boolean('is_admin').notNull().default(false),
    /** The built-in AgentDrop assistant. Never logs in, never joins groups, never administered like a person. */
    isSystem: boolean('is_system').notNull().default(false),
    /** When enabled, any active H credential owned by this user may read the user's full mailbox history. */
    crossHMailboxEnabled: boolean('cross_h_mailbox_enabled').notNull().default(true),
    /**
     * A plain send to this person (no specific entry chosen) is delivered to all of their agents (ADR 0008). Off
     * once the person picks one default receiving agent.
     */
    directReceiveAll: boolean('direct_receive_all').notNull().default(true),
    /** The last CLI update reminder sent to this person: which version, when, and how many for it so far. */
    updateReminder: jsonb('update_reminder').$type<{ version: string; sent_at: string; count?: number }>(),
    /** Hashes of what end-of-turn notices already showed this person, shared by all their agents (ADR 0007). */
    noticeState: jsonb('notice_state').$type<NoticeState>(),
    /**
     * Hashes of what this person has seen inside an agent session (prompt submit / session start), separate from
     * what push or Feishu delivered; claiming it also merges into notice_state.
     */
    noticeSeenState: jsonb('notice_seen_state').$type<NoticeState>(),
    /** Feishu group-bot webhook for notices (url, optional signature secret, language); null when not connected. */
    feishuWebhook: jsonb('feishu_webhook').$type<{
      url: string;
      secret: string | null;
      language: 'en' | 'zh';
    }>(),
    /** Set by an admin: every session and agent credential of this account stops working while it is set. */
    suspendedAt: ts('suspended_at'),
    suspendedReason: text('suspended_reason'),
    /** Set when the account was closed by an admin: the profile is anonymized and the login no longer exists. */
    deletedAt: ts('deleted_at'),
    /** Optional user-owned notification webhook (HTTPS). Receives event metadata only, never bodies. */
    notificationWebhookUrl: text('notification_webhook_url'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('app_users_handle_uq').on(t.handle),
    uniqueIndex('app_users_auth_user_uq').on(t.authUserId),
  ],
);

/** Browser push endpoints owned by a human account, never by an H. Endpoint and keys are server-only secrets. */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    endpointHash: text('endpoint_hash').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    deviceLabel: text('device_label').notNull(),
    userAgent: text('user_agent'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    lastSuccessAt: ts('last_success_at'),
    revokedAt: ts('revoked_at'),
    failureCount: integer('failure_count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('push_subscriptions_endpoint_hash_uq').on(t.endpointHash),
    index('push_subscriptions_user_idx').on(t.userId, t.revokedAt),
  ],
);

/** Logical device = one bridge installation (random installation id), never a hardware fingerprint. */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id),
    installationId: uuid('installation_id').notNull(),
    label: text('label').notNull(),
    platform: text('platform'),
    /** Human-owned desired settings and the latest device-reported synchronization status. Null is unmanaged. */
    clientPreferences: jsonb('client_preferences').$type<Omit<DeviceClientSettings, 'device_id'>>(),
    createdAt: ts('created_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('devices_user_installation_uq').on(t.userId, t.installationId)],
);

export const harnessKeyEnum = pgEnum('harness_key', [
  'codex',
  'claude-code',
  'other',
  'opencode',
  'cursor',
  'omp',
  'workbuddy',
]);

/** H: the mailbox unit. Unique per (user, device, harness, profile). `label` is the editable agent name. */
export const harnessEndpoints = pgTable(
  'harness_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    harnessKey: harnessKeyEnum('harness_key').notNull(),
    profileKey: text('profile_key').notNull().default('default'),
    label: text('label').notNull(),
    publicName: text('public_name'),
    nameVersion: integer('name_version').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    uniqueIndex('harness_endpoints_identity_uq').on(t.userId, t.deviceId, t.harnessKey, t.profileKey),
    index('harness_endpoints_user_idx').on(t.userId),
  ],
);

/** Opaque credentials bound to exactly one H. Only the SHA-256 of the token is stored. */
export const hCredentials = pgTable(
  'h_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hId: uuid('h_id')
      .notNull()
      .references(() => harnessEndpoints.id),
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('h_credentials_token_hash_uq').on(t.tokenHash), index('h_credentials_h_idx').on(t.hId)],
);

export const pairingStatusEnum = pgEnum('pairing_status', [
  'pending',
  'approved',
  'denied',
  'consumed',
  'expired',
]);

/** CLI pairing (device authorization style). The credential is created only when the approved request is polled. */
export const pairingRequests = pgTable(
  'pairing_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userCode: text('user_code').notNull(),
    deviceCodeHash: text('device_code_hash').notNull(),
    installationId: uuid('installation_id').notNull(),
    deviceLabel: text('device_label').notNull(),
    harnessKey: harnessKeyEnum('harness_key').notNull(),
    profileKey: text('profile_key').notNull(),
    endpointLabel: text('endpoint_label').notNull(),
    bridgeVersion: text('bridge_version').notNull(),
    platform: text('platform').notNull(),
    status: pairingStatusEnum('status').notNull().default('pending'),
    approvedByUserId: uuid('approved_by_user_id').references(() => appUsers.id),
    hId: uuid('h_id').references(() => harnessEndpoints.id),
    lastPolledAt: ts('last_polled_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    decidedAt: ts('decided_at'),
  },
  (t) => [
    uniqueIndex('pairing_requests_user_code_uq').on(t.userCode),
    uniqueIndex('pairing_requests_device_code_uq').on(t.deviceCodeHash),
  ],
);

/** A bridge/MCP connection instance. Temporary; carries no permission of its own. */
export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hId: uuid('h_id')
      .notNull()
      .references(() => harnessEndpoints.id),
    clientName: text('client_name'),
    clientVersion: text('client_version'),
    capabilities: jsonb('capabilities').notNull().default({}),
    bridgeVersion: text('bridge_version'),
    toolset: text('toolset'),
    label: text('label'),
    lastTool: text('last_tool'),
    openedAt: ts('opened_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    closedAt: ts('closed_at'),
  },
  (t) => [index('connections_h_idx').on(t.hId, t.lastSeenAt)],
);

export const routeVisibilityEnum = pgEnum('route_visibility', ['private', 'contacts']);

/**
 * Receiving routes. Exactly one non-revoked default route per user (alias null). Named routes have an alias
 * (`@handle/alias`) and a visibility; external responses never include destination_h_id.
 */
export const recipientRoutes = pgTable(
  'recipient_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id),
    alias: text('alias'),
    label: text('label').notNull(),
    destinationHId: uuid('destination_h_id')
      .notNull()
      .references(() => harnessEndpoints.id),
    isDefault: boolean('is_default').notNull().default(false),
    visibility: routeVisibilityEnum('visibility').notNull().default('private'),
    /** System-managed address of one endpoint (@handle/alias): follows the endpoint's label and lifetime. */
    auto: boolean('auto').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    uniqueIndex('recipient_routes_default_uq')
      .on(t.userId)
      .where(sql`${t.isDefault} = true and ${t.revokedAt} is null`),
    uniqueIndex('recipient_routes_alias_uq')
      .on(t.userId, t.alias)
      .where(sql`${t.alias} is not null and ${t.revokedAt} is null`),
    uniqueIndex('recipient_routes_auto_uq')
      .on(t.destinationHId)
      .where(sql`${t.auto} = true and ${t.revokedAt} is null`),
  ],
);

/**
 * Runtime settings an admin can change without a redeploy (currently the sign-up mode). One row per key; the
 * value is a small JSON document so a setting can grow fields without a migration.
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedByUserId: uuid('updated_by_user_id').references(() => appUsers.id),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * One-time recovery codes (ADR 0036): a person generates a set in Settings and keeps it; one code plus the account
 * email yields a password reset link without email or an administrator. Only a SHA-256 of each code is stored;
 * generating a new set deletes the old one, and a used code keeps its row with `used_at`.
 */
export const accountRecoveryCodes = pgTable(
  'account_recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    usedAt: ts('used_at'),
  },
  (t) => [
    uniqueIndex('account_recovery_codes_hash_uq').on(t.codeHash),
    index('account_recovery_codes_user_idx').on(t.userId),
  ],
);

/** Security-relevant actions. Never stores bodies, tokens or absolute file paths. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorUserId: uuid('actor_user_id'),
    hId: uuid('h_id'),
    action: text('action').notNull(),
    targetId: text('target_id'),
    result: text('result').notNull(),
    requestId: text('request_id'),
    meta: jsonb('meta').notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_events_actor_idx').on(t.actorUserId, t.createdAt),
    index('audit_events_created_idx').on(t.createdAt),
    index('audit_events_action_idx').on(t.action, t.createdAt),
  ],
);
