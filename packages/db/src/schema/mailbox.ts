import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUsers, harnessEndpoints, recipientRoutes } from './identity.js';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
/** Ciphertexts and wrapped keys (docs/plan/CONTENT_ENCRYPTION.md). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/* ------------------------------------------------------------------ contacts */
export const contactStatusEnum = pgEnum('contact_status', ['invited', 'requested', 'accepted']);

/**
 * One row per direction. `remark`, `preferred_route_id` and `auto_approve` are private to the owner and never
 * appear in the peer's view, sender cards, drops or audit logs.
 */
/**
 * A shareable link that makes whoever opens it a contact of its owner. Only the sha256 of the token is stored,
 * so a link can be revoked but never shown again.
 */
export const contactInviteLinks = pgTable(
  'contact_invite_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => appUsers.id),
    tokenHash: text('token_hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    useCount: integer('use_count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('contact_invite_links_token_uq').on(t.tokenHash),
    index('contact_invite_links_owner_idx').on(t.ownerUserId),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => appUsers.id),
    peerUserId: uuid('peer_user_id')
      .notNull()
      .references(() => appUsers.id),
    status: contactStatusEnum('status').notNull(),
    blockedAt: ts('blocked_at'),
    remark: text('remark'),
    preferredRouteId: uuid('preferred_route_id').references(() => recipientRoutes.id),
    /** Human-set policy: sends to this contact do not need a browser approval. Never changeable via MCP. */
    autoApprove: boolean('auto_approve').notNull().default(false),
    /**
     * The invite link a pending request came from (ADR 0034): set on both rows when someone without a paired agent
     * opens a link, so their first pairing accepts it. Cleared when the pair is asked again by handle; null for
     * every other request and for rows that existed before it.
     */
    inviteLinkId: uuid('invite_link_id').references(() => contactInviteLinks.id),
    version: integer('version').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('contacts_owner_peer_uq').on(t.ownerUserId, t.peerUserId),
    index('contacts_peer_idx').on(t.peerUserId),
  ],
);

/* ------------------------------------------------------------------ groups */
export const membershipRoleEnum = pgEnum('membership_role', ['owner', 'admin', 'member']);
export const membershipStatusEnum = pgEnum('membership_status', ['invited', 'active', 'left', 'removed']);
export const groupInvitePolicyEnum = pgEnum('group_invite_policy', ['open', 'admin_approval']);

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    avatarAttachmentId: uuid('avatar_attachment_id'),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => appUsers.id),
    /**
     * Who may add members. `open`: any active member invites directly. `admin_approval`: a plain member's
     * invitation becomes a join request an owner/admin must approve. Owners and admins always invite directly.
     */
    memberInvitePolicy: groupInvitePolicyEnum('member_invite_policy').notNull().default('open'),
    /**
     * Whether every active member may read the group's whole history, including drops sent before they joined
     * (ADR 0022). Read-only access through the one authorization predicate (`group_history` source); only the
     * owner changes it. Off by default and for every group that existed before it.
     */
    historyVisible: boolean('history_visible').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('groups_slug_uq').on(t.slug)],
);

/** Re-joining creates a new membership row; old rows are never reactivated. */
export const groupMemberships = pgTable(
  'group_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id),
    role: membershipRoleEnum('role').notNull().default('member'),
    status: membershipStatusEnum('status').notNull().default('invited'),
    nickname: text('nickname'),
    invitedByUserId: uuid('invited_by_user_id').references(() => appUsers.id),
    muted: boolean('muted').notNull().default(false),
    /**
     * Receive with every agent of this account, including ones paired later (bindings are kept in sync), instead
     * of an explicit selection. New memberships default to it; rows created before it existed keep `false`.
     */
    receiveAll: boolean('receive_all').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
    joinedAt: ts('joined_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    uniqueIndex('group_memberships_live_uq')
      .on(t.groupId, t.userId)
      .where(sql`${t.status} in ('invited', 'active')`),
    index('group_memberships_user_idx').on(t.userId),
  ],
);

export const groupJoinRequestStatusEnum = pgEnum('group_join_request_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
]);

/**
 * A member's invitation awaiting owner/admin approval under `groups.member_invite_policy = 'admin_approval'`.
 * At most one pending request per (group, invitee); decided rows are kept for audit and never reused.
 */
export const groupJoinRequests = pgTable(
  'group_join_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id),
    inviteeUserId: uuid('invitee_user_id')
      .notNull()
      .references(() => appUsers.id),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => appUsers.id),
    status: groupJoinRequestStatusEnum('status').notNull().default('pending'),
    createdAt: ts('created_at').notNull().defaultNow(),
    decidedAt: ts('decided_at'),
    decidedByUserId: uuid('decided_by_user_id').references(() => appUsers.id),
  },
  (t) => [
    uniqueIndex('group_join_requests_live_uq')
      .on(t.groupId, t.inviteeUserId)
      .where(sql`${t.status} = 'pending'`),
    index('group_join_requests_group_idx').on(t.groupId, t.status),
  ],
);

/** Which of the member's endpoints receive this group's drops. The H must belong to the membership's user. */
export const groupBindings = pgTable(
  'group_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => groupMemberships.id),
    hId: uuid('h_id')
      .notNull()
      .references(() => harnessEndpoints.id),
    enabledAt: ts('enabled_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    uniqueIndex('group_bindings_live_uq').on(t.membershipId, t.hId).where(sql`${t.revokedAt} is null`),
    index('group_bindings_h_idx').on(t.hId),
  ],
);

/* ------------------------------------------------------------------ attachments */
export const attachmentStatusEnum = pgEnum('attachment_status', ['staging', 'ready', 'failed', 'deleted']);

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uploadedByHId: uuid('uploaded_by_h_id')
      .notNull()
      .references(() => harnessEndpoints.id),
    storageKey: text('storage_key').notNull(),
    /** Plaintext metadata; null once `meta_enc` holds it (encrypted rows). */
    safeName: text('safe_name'),
    contentType: text('content_type'),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull().default(0),
    sha256: text('sha256'),
    /** Wrapped data key; when set, `meta_enc` holds {safe_name, content_type, sha256} and plaintext is never read. */
    dek: bytea('dek'),
    metaEnc: bytea('meta_enc'),
    /** 0 = stored bytes are plaintext, 1 = segmented AEAD (content/stream.ts). */
    blobFormat: smallint('blob_format').notNull().default(0),
    /** Plaintext object replaced by the backfill, deleted afterwards. */
    legacyStorageKey: text('legacy_storage_key'),
    status: attachmentStatusEnum('status').notNull().default('staging'),
    reviewHints: jsonb('review_hints').notNull().default([]),
    createdAt: ts('created_at').notNull().defaultNow(),
    finalizedAt: ts('finalized_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('attachments_h_idx').on(t.uploadedByHId, t.status),
    uniqueIndex('attachments_storage_key_uq').on(t.storageKey),
  ],
);

/* ------------------------------------------------------------------ drops */
export const originKindEnum = pgEnum('origin_kind', ['mcp', 'web']);

/** Immutable once committed. Author identity is server-derived; remarks are never part of the snapshot. */
export const drops = pgTable(
  'drops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => appUsers.id),
    originHId: uuid('origin_h_id')
      .notNull()
      .references(() => harnessEndpoints.id),
    originKind: originKindEnum('origin_kind').notNull(),
    payloadVersion: integer('payload_version').notNull().default(1),
    kind: text('kind').notNull(),
    /** Plaintext content; null on encrypted rows, where `dek` and the `*_enc` columns hold it. */
    title: text('title'),
    body: text('body'),
    bodyChars: integer('body_chars').notNull(),
    extensions: jsonb('extensions').default({}),
    dek: bytea('dek'),
    titleEnc: bytea('title_enc'),
    bodyEnc: bytea('body_enc'),
    extensionsEnc: bytea('extensions_enc'),
    /** Public nickname / handle / public agent name at send time. No private remarks, no device labels. */
    authorSnapshot: jsonb('author_snapshot').notNull(),
    /** Resolved targets (ids, labels, counts) frozen at commit. */
    targetSnapshot: jsonb('target_snapshot').notNull(),
    contentHash: text('content_hash').notNull(),
    /** 1 = sha256 hex, 2 = `<hmac kid>:<hmac of the sha256>` (content/cipher.ts contentHmac). */
    hashVersion: smallint('hash_version').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    /**
     * The drop this one answers (`payload.reply_to`, ADR 0016). A reference only: it grants nothing, and readers see
     * it only when they may read the original. Set null if the original row is ever deleted.
     */
    replyToDropId: uuid('reply_to_drop_id').references((): AnyPgColumn => drops.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('drops_origin_idx').on(t.originHId, t.createdAt),
    /** "Which drops answer this one" for reply counts on sent drops. Partial: most drops answer nothing. */
    index('drops_reply_to_idx').on(t.replyToDropId, t.createdAt).where(sql`${t.replyToDropId} is not null`),
    /*
     * "What did this person write between two dates" has no index otherwise: `drops_origin_idx` is keyed by the
     * sending endpoint, and an author is a user who may send from several. A date-ranged export of one
     * correspondent reads exactly this way, and without the index it sequentially scans every drop on the server.
     */
    index('drops_author_created_idx').on(t.authorUserId, t.createdAt),
    /*
     * Outbound half of the same question: "what did I send this person". The author-visible answer is the
     * frozen `target_snapshot.user_ids`, queried as a containment (`@> {"user_ids":["…"]}`), which needs GIN.
     * Not answered by joining the recipient's deliveries: the export's "what did I send this person" must not
     * pull in group traffic. Read receipts (`recipient_status`) are the one author-facing view that does join
     * deliveries, and they name people only, never which of their endpoints received the drop.
     */
    index('drops_targets_idx').using('gin', t.targetSnapshot),
    /** Server-wide date windows: the operator overview's 24 h / 7 d / 28 d counts and product health (ADR 0035). */
    index('drops_created_idx').on(t.createdAt),
  ],
);

export const dropAttachments = pgTable(
  'drop_attachments',
  {
    dropId: uuid('drop_id')
      .notNull()
      .references(() => drops.id),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => attachments.id),
    ordinal: integer('ordinal').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.dropId, t.attachmentId] }),
    uniqueIndex('drop_attachments_attachment_uq').on(t.attachmentId),
  ],
);

/** Mailbox entry of one drop in one H. State flags are shared by every session of that H. */
export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dropId: uuid('drop_id')
      .notNull()
      .references(() => drops.id),
    hId: uuid('h_id')
      .notNull()
      .references(() => harnessEndpoints.id),
    receivedAt: ts('received_at').notNull().defaultNow(),
    readAt: ts('read_at'),
    /**
     * First time the recipient opened the body (any of their agents, the dashboard or the CLI). Independent of
     * `read_at`, which only a deliberate mark sets; this is what the sender sees as "read".
     */
    openedAt: ts('opened_at'),
    starredAt: ts('starred_at'),
    archivedAt: ts('archived_at'),
    stateVersion: integer('state_version').notNull().default(0),
  },
  (t) => [
    uniqueIndex('deliveries_drop_h_uq').on(t.dropId, t.hId),
    index('deliveries_h_received_idx').on(t.hId, t.receivedAt, t.id),
    index('deliveries_h_unread_idx').on(t.hId).where(sql`${t.readAt} is null and ${t.archivedAt} is null`),
  ],
);

export const grantKindEnum = pgEnum('grant_kind', ['direct', 'group']);

/** Why an H may read a delivery. Several grants can coexist; revoking one never touches the others. */
export const deliveryGrants = pgTable(
  'delivery_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id),
    kind: grantKindEnum('kind').notNull(),
    routeId: uuid('route_id').references(() => recipientRoutes.id),
    groupId: uuid('group_id').references(() => groups.id),
    membershipId: uuid('membership_id').references(() => groupMemberships.id),
    bindingId: uuid('binding_id').references(() => groupBindings.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    index('delivery_grants_delivery_idx').on(t.deliveryId),
    index('delivery_grants_membership_idx').on(t.membershipId),
    index('delivery_grants_binding_idx').on(t.bindingId),
    /* Exporting one group's range reads grants by group; without this it scans every grant on the server. */
    index('delivery_grants_group_idx').on(t.groupId),
    check(
      'delivery_grants_provenance_chk',
      sql`(${t.kind} = 'direct' and ${t.routeId} is not null and ${t.groupId} is null and ${t.membershipId} is null and ${t.bindingId} is null)
        or (${t.kind} = 'group' and ${t.groupId} is not null and ${t.membershipId} is not null and ${t.bindingId} is not null and ${t.routeId} is null)`,
    ),
  ],
);

/* ------------------------------------------------------------------ send requests / approvals */
export const sendOutcomeEnum = pgEnum('send_outcome', ['delivered', 'needs_approval', 'not_sent']);

/** Business idempotency key: (origin H, request_id). Same key + same hash returns the stored result. */
export const sendRequests = pgTable(
  'send_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    originHId: uuid('origin_h_id')
      .notNull()
      .references(() => harnessEndpoints.id),
    requestId: text('request_id').notNull(),
    requestHash: text('request_hash').notNull(),
    hashVersion: smallint('hash_version').notNull().default(1),
    outcome: sendOutcomeEnum('outcome').notNull(),
    resultDropId: uuid('result_drop_id').references(() => drops.id),
    approvalId: uuid('approval_id'),
    result: jsonb('result').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('send_requests_origin_request_uq').on(t.originHId, t.requestId)],
);

export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
  'consumed',
]);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => appUsers.id),
    originHId: uuid('origin_h_id')
      .notNull()
      .references(() => harnessEndpoints.id),
    requestId: text('request_id').notNull(),
    contentHash: text('content_hash').notNull(),
    hashVersion: smallint('hash_version').notNull().default(1),
    /** Plaintext envelope; `{}` on encrypted rows, where `payload_enc` holds {envelope, reasons}. */
    envelope: jsonb('envelope').notNull(),
    targetSnapshot: jsonb('target_snapshot').notNull(),
    reasons: jsonb('reasons').notNull().default([]),
    dek: bytea('dek'),
    payloadEnc: bytea('payload_enc'),
    originKind: originKindEnum('origin_kind').notNull().default('mcp'),
    status: approvalStatusEnum('status').notNull().default('pending'),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    decidedAt: ts('decided_at'),
  },
  (t) => [index('approvals_actor_idx').on(t.actorUserId, t.status)],
);

/* ------------------------------------------------------------------ mailbox revision / outbox */
export const mailboxHeads = pgTable('mailbox_heads', {
  hId: uuid('h_id')
    .primaryKey()
    .references(() => harnessEndpoints.id),
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const mailboxEvents = pgTable(
  'mailbox_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    hId: uuid('h_id')
      .notNull()
      .references(() => harnessEndpoints.id),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    dropId: uuid('drop_id'),
    deliveryId: uuid('delivery_id'),
    payload: jsonb('payload').notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('mailbox_events_h_revision_uq').on(t.hId, t.revision)],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').notNull().default({}),
    attempts: integer('attempts').notNull().default(0),
    availableAt: ts('available_at').notNull().defaultNow(),
    lockedUntil: ts('locked_until'),
    deliveredAt: ts('delivered_at'),
    deadAt: ts('dead_at'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('outbox_events_pending_idx')
      .on(t.availableAt)
      .where(sql`${t.deliveredAt} is null and ${t.deadAt} is null`),
  ],
);

/* ------------------------------------------------------------------ content encryption state */
/** One row per master key id: a known plaintext sealed under it, checked at startup (plan §5.1). */
export const contentKeyChecks = pgTable('content_key_checks', {
  kid: text('kid').primaryKey(),
  check: bytea('check').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Single row (id = 1): whether plaintext columns may still be read, and backfill progress. */
export const contentState = pgTable('content_state', {
  id: smallint('id').primaryKey().default(1),
  plaintextReads: boolean('plaintext_reads').notNull().default(true),
  backfill: jsonb('backfill').notNull().default({}),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
