import {
  type AdminAuditEvent,
  type AdminOverview,
  type AdminUserDetail,
  type AdminUserSummary,
  AgentDropError,
  type HarnessKey,
  type SignupMode,
} from '@agentdrop/contracts';
import {
  appUsers,
  attachments,
  auditEvents,
  authAccounts,
  authSessions,
  authUsers,
  connections,
  contacts,
  deliveries,
  devices,
  drops,
  feishuAccounts,
  feishuCards,
  feishuLinkCodes,
  groupBindings,
  groupMemberships,
  groups,
  harnessEndpoints,
  hCredentials,
  pushSubscriptions,
  recipientRoutes,
  type Tx,
} from '@agentdrop/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { plaintextRemaining } from '../content/backfill.js';
import { contentEncryptionStatus } from '../content/state.js';
import { revokeEndpoint } from '../identity/endpoints.js';
import { productHealth } from './product-health.js';

/**
 * Operator use-cases. Two rules hold throughout this module:
 *   1. Metadata only. Nothing here reads a drop title, body or attachment name; an operator sees who exists and
 *      what happened, never what anyone wrote. Content stays between the people who exchanged it.
 *   2. Every mutation is written to the audit log with the acting admin, so operator power is itself reviewable.
 */

const LIVE_CONNECTION_WINDOW_S = 90;

export async function adminOverview(
  tx: Tx,
  opts: { serverVersion: string; signupMode: SignupMode },
): Promise<AdminOverview> {
  const remaining = await plaintextRemaining(tx);
  const { rows } = await tx.execute<Record<string, string | number>>(sql`
    select
      (select count(*) from ${appUsers} where deleted_at is null and not is_system) as users_total,
      (select count(*) from ${appUsers} where deleted_at is null and suspended_at is null and not is_system) as users_active,
      (select count(*) from ${appUsers} where deleted_at is null and suspended_at is not null) as users_suspended,
      (select count(*) from ${appUsers} where deleted_at is not null) as users_deleted,
      (select count(*) from ${appUsers} where deleted_at is null and is_admin) as users_admins,
      (select count(*) from ${appUsers} where created_at > now() - interval '7 days' and not is_system) as users_new_7d,
      (select count(*) from ${harnessEndpoints} e
         where not exists (select 1 from ${appUsers} su where su.id = e.user_id and su.is_system)) as endpoints_total,
      (select count(*) from ${harnessEndpoints} e where e.revoked_at is null
         and not exists (select 1 from ${appUsers} su where su.id = e.user_id and su.is_system)) as endpoints_active,
      (select count(*) from ${connections}
         where closed_at is null and last_seen_at > now() - make_interval(secs => ${LIVE_CONNECTION_WINDOW_S})) as live_connections,
      (select count(*) from ${drops}) as drops_total,
      (select count(*) from ${drops} where created_at > now() - interval '24 hours') as drops_24h,
      (select count(*) from ${drops} where created_at > now() - interval '7 days') as drops_7d,
      (select count(*) from ${deliveries}) as deliveries_total,
      (select count(*) from approvals where status = 'pending') as pending_approvals,
      (select count(*) from ${groups}) as groups_total,
      (select count(*) from ${groupMemberships} where status = 'active') as group_members,
      (select count(*) from ${attachments} where status <> 'deleted') as attachments_total,
      (select coalesce(sum(byte_size), 0) from ${attachments} where status <> 'deleted') as attachment_bytes`);
  const r = rows[0] ?? {};
  const n = (k: string) => Number(r[k] ?? 0);

  const byHarness = await tx.execute<{ harness_key: string; count: string }>(sql`
    select harness_key::text as harness_key, count(*) as count
    from ${harnessEndpoints} e where revoked_at is null
      and not exists (select 1 from ${appUsers} su where su.id = e.user_id and su.is_system)
    group by harness_key order by harness_key`);

  return {
    users: {
      total: n('users_total'),
      active: n('users_active'),
      suspended: n('users_suspended'),
      deleted: n('users_deleted'),
      admins: n('users_admins'),
      new_7d: n('users_new_7d'),
    },
    endpoints: {
      total: n('endpoints_total'),
      active: n('endpoints_active'),
      live_connections: n('live_connections'),
      by_harness: byHarness.rows.map((row) => ({
        harness_key: row.harness_key as HarnessKey,
        count: Number(row.count),
      })),
    },
    drops: {
      total: n('drops_total'),
      last_24h: n('drops_24h'),
      last_7d: n('drops_7d'),
      deliveries: n('deliveries_total'),
      pending_approvals: n('pending_approvals'),
    },
    groups: { total: n('groups_total'), active_members: n('group_members') },
    storage: { attachments: n('attachments_total'), bytes: n('attachment_bytes') },
    signup_mode: opts.signupMode,
    server_version: opts.serverVersion,
    encryption: (() => {
      const status = contentEncryptionStatus();
      return { mode: status.mode, key_id: status.kid, plaintext_remaining: remaining };
    })(),
    product_health: await productHealth(tx),
  };
}

type UserRow = {
  user_id: string;
  handle: string;
  display_name: string;
  email: string | null;
  is_admin: boolean;
  is_system: boolean;
  suspended_at: string | null;
  suspended_reason: string | null;
  deleted_at: string | null;
  created_at: string;
  last_seen_at: string | null;
  endpoints: string;
  contacts: string;
  groups: string;
  drops_sent: string;
  drops_received: string;
  storage_bytes: string;
};

function toSummary(r: UserRow): AdminUserSummary {
  const deleted = r.deleted_at !== null;
  return {
    user_id: r.user_id,
    handle: r.handle,
    display_name: r.display_name,
    // a closed account keeps no address: the mailbox it used is gone and the value left in the auth table is a stub
    email: deleted ? null : r.email,
    status: deleted ? 'deleted' : r.suspended_at ? 'suspended' : 'active',
    is_admin: r.is_admin,
    is_system: r.is_system,
    suspended_reason: r.suspended_reason,
    created_at: new Date(r.created_at).toISOString(),
    last_seen_at: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
    endpoints: Number(r.endpoints),
    contacts: Number(r.contacts),
    groups: Number(r.groups),
    drops_sent: Number(r.drops_sent),
    drops_received: Number(r.drops_received),
    storage_bytes: Number(r.storage_bytes),
  };
}

/** The per-user aggregate block, shared by the list and the detail view. */
const USER_COLUMNS = sql`
  u.id as user_id, u.handle, u.display_name, au.email, u.is_admin, u.is_system,
  u.suspended_at, u.suspended_reason, u.deleted_at, u.created_at,
  (select count(*) from ${harnessEndpoints} e where e.user_id = u.id and e.revoked_at is null) as endpoints,
  (select count(*) from ${contacts} c where c.owner_user_id = u.id and c.status = 'accepted' and c.blocked_at is null) as contacts,
  (select count(*) from ${groupMemberships} m where m.user_id = u.id and m.status = 'active') as groups,
  (select count(*) from ${drops} d where d.author_user_id = u.id) as drops_sent,
  (select count(*) from ${deliveries} dl join ${harnessEndpoints} e2 on e2.id = dl.h_id where e2.user_id = u.id) as drops_received,
  (select coalesce(sum(a.byte_size), 0) from ${attachments} a
     join ${harnessEndpoints} e3 on e3.id = a.uploaded_by_h_id
     where e3.user_id = u.id and a.status <> 'deleted') as storage_bytes,
  greatest(
    (select max(cn.last_seen_at) from ${connections} cn join ${harnessEndpoints} e4 on e4.id = cn.h_id where e4.user_id = u.id),
    (select max(s.updated_at) from ${authSessions} s where s.user_id = u.auth_user_id)
  ) as last_seen_at`;

export async function adminListUsers(
  tx: Tx,
  input: {
    query?: string | undefined;
    status?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  },
): Promise<{ users: AdminUserSummary[]; nextCursor: string | null; total: number }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = decodeCursor(input.cursor);
  const q = input.query?.trim().replace(/^@/, '').toLowerCase() ?? '';
  const like = `%${q}%`;
  const status = input.status ?? 'all';
  const filter = sql`
    ${q ? sql`(lower(u.handle) like ${like} or lower(u.display_name) like ${like} or lower(au.email) like ${like})` : sql`true`}
    and ${
      status === 'active'
        ? sql`u.deleted_at is null and u.suspended_at is null`
        : status === 'suspended'
          ? sql`u.deleted_at is null and u.suspended_at is not null`
          : status === 'deleted'
            ? sql`u.deleted_at is not null`
            : status === 'admin'
              ? sql`u.is_admin and u.deleted_at is null`
              : sql`true`
    }`;
  const { rows } = await tx.execute<UserRow>(sql`
    select ${USER_COLUMNS}
    from ${appUsers} u join ${authUsers} au on au.id = u.auth_user_id
    where ${filter}
    order by u.created_at desc
    limit ${limit + 1} offset ${offset}`);
  const counted = await tx.execute<{ count: string }>(sql`
    select count(*) as count from ${appUsers} u join ${authUsers} au on au.id = u.auth_user_id where ${filter}`);
  const page = rows.slice(0, limit);
  return {
    users: page.map(toSummary),
    nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    total: Number(counted.rows[0]?.count ?? 0),
  };
}

export async function adminUserDetail(tx: Tx, userId: string): Promise<AdminUserDetail> {
  const { rows } = await tx.execute<UserRow>(sql`
    select ${USER_COLUMNS}
    from ${appUsers} u join ${authUsers} au on au.id = u.auth_user_id
    where u.id = ${userId} limit 1`);
  const row = rows[0];
  if (!row) throw new AgentDropError('NOT_FOUND', 'user not found');

  const endpointRows = await tx.execute<Record<string, string | number | boolean | null>>(sql`
    select e.id as h_id, e.label, e.harness_key::text as harness_key, e.profile_key,
           d.label as device_label, d.platform, e.created_at, e.revoked_at,
           (select r.alias from ${recipientRoutes} r
              where r.destination_h_id = e.id and r.auto and r.revoked_at is null limit 1) as alias,
           exists(select 1 from ${recipientRoutes} r2
              where r2.destination_h_id = e.id and r2.is_default and r2.revoked_at is null) as is_default_receiver,
           (select max(cn.last_seen_at) from ${connections} cn where cn.h_id = e.id) as last_seen_at,
           (select count(*) from ${connections} cn2 where cn2.h_id = e.id and cn2.closed_at is null
              and cn2.last_seen_at > now() - make_interval(secs => ${LIVE_CONNECTION_WINDOW_S})) as live_connections,
           (select count(*) from ${deliveries} dl where dl.h_id = e.id) as drops_received
    from ${harnessEndpoints} e join ${devices} d on d.id = e.device_id
    where e.user_id = ${userId}
    order by e.created_at`);

  const groupRows = await tx.execute<Record<string, string>>(sql`
    select g.id as group_id, g.slug, g.display_name, m.role::text as role, m.status::text as status
    from ${groupMemberships} m join ${groups} g on g.id = m.group_id
    where m.user_id = ${userId} and m.status in ('active', 'invited')
    order by g.slug`);

  const contactRows = await tx.execute<Record<string, string | null>>(sql`
    select p.id as user_id, p.handle, c.status::text as status, (c.blocked_at is not null) as blocked
    from ${contacts} c join ${appUsers} p on p.id = c.peer_user_id
    where c.owner_user_id = ${userId}
    order by p.handle limit 200`);

  const activity = await tx.execute<Record<string, string | number | null>>(sql`
    select id, action, result, target_id, created_at
    from ${auditEvents} where actor_user_id = ${userId}
    order by id desc limit 50`);

  return {
    ...toSummary(row),
    endpoint_list: endpointRows.rows.map((e) => ({
      h_id: String(e.h_id),
      label: String(e.label),
      harness_key: e.harness_key as HarnessKey,
      profile_key: String(e.profile_key),
      device_label: String(e.device_label),
      platform: e.platform === null ? null : String(e.platform),
      address: e.alias ? `@${row.handle}/${String(e.alias)}` : null,
      is_default_receiver: Boolean(e.is_default_receiver),
      created_at: new Date(String(e.created_at)).toISOString(),
      revoked_at: e.revoked_at ? new Date(String(e.revoked_at)).toISOString() : null,
      last_seen_at: e.last_seen_at ? new Date(String(e.last_seen_at)).toISOString() : null,
      live_connections: Number(e.live_connections),
      drops_received: Number(e.drops_received),
    })),
    group_list: groupRows.rows.map((g) => ({
      group_id: String(g.group_id),
      slug: String(g.slug),
      display_name: String(g.display_name),
      role: g.role as 'owner' | 'admin' | 'member',
      status: String(g.status),
    })),
    contact_list: contactRows.rows.map((c) => ({
      user_id: String(c.user_id),
      handle: String(c.handle),
      status: String(c.status),
      blocked: Boolean(c.blocked),
    })),
    recent_activity: activity.rows.map((a) => ({
      id: Number(a.id),
      action: String(a.action),
      result: String(a.result),
      target_id: a.target_id === null ? null : String(a.target_id),
      created_at: new Date(String(a.created_at)).toISOString(),
    })),
  };
}

async function loadTarget(tx: Tx, adminUserId: string, userId: string) {
  if (userId === adminUserId)
    throw new AgentDropError('FORBIDDEN', 'you cannot apply this to your own account');
  const user = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, userId) });
  if (!user) throw new AgentDropError('NOT_FOUND', 'user not found');
  if (user.isSystem)
    throw new AgentDropError('FORBIDDEN', 'the built-in assistant is managed by the server itself');
  if (user.deletedAt) throw new AgentDropError('VALIDATION_FAILED', 'this account is already closed');
  return user;
}

/** Refuses to leave the server without an administrator. */
async function assertNotLastAdmin(tx: Tx, userId: string): Promise<void> {
  const { rows } = await tx.execute<{ count: string }>(sql`
    select count(*) as count from ${appUsers}
    where is_admin and deleted_at is null and suspended_at is null and id <> ${userId}`);
  if (Number(rows[0]?.count ?? 0) === 0)
    throw new AgentDropError('FORBIDDEN', 'this is the last active administrator');
}

/** Suspends an account: browser sessions and every agent credential stop working until it is lifted. */
export async function adminSuspendUser(
  tx: Tx,
  adminUserId: string,
  userId: string,
  reason: string | null,
): Promise<void> {
  const user = await loadTarget(tx, adminUserId, userId);
  if (user.isAdmin) await assertNotLastAdmin(tx, userId);
  await tx
    .update(appUsers)
    .set({ suspendedAt: new Date(), suspendedReason: reason?.trim() || null, updatedAt: new Date() })
    .where(eq(appUsers.id, userId));
  // drop browser sessions immediately; agent credentials are refused by the authenticator while suspended
  await tx.delete(authSessions).where(eq(authSessions.userId, user.authUserId));
  await recordAudit(tx, {
    actorUserId: adminUserId,
    action: 'admin.user.suspend',
    targetId: userId,
    result: 'ok',
    meta: { handle: user.handle, has_reason: Boolean(reason) },
  });
}

export async function adminUnsuspendUser(tx: Tx, adminUserId: string, userId: string): Promise<void> {
  const user = await loadTarget(tx, adminUserId, userId);
  await tx
    .update(appUsers)
    .set({ suspendedAt: null, suspendedReason: null, updatedAt: new Date() })
    .where(eq(appUsers.id, userId));
  await recordAudit(tx, {
    actorUserId: adminUserId,
    action: 'admin.user.unsuspend',
    targetId: userId,
    result: 'ok',
    meta: { handle: user.handle },
  });
}

export async function adminSetUserAdmin(
  tx: Tx,
  adminUserId: string,
  userId: string,
  isAdmin: boolean,
): Promise<void> {
  const user = await loadTarget(tx, adminUserId, userId);
  if (!isAdmin && user.isAdmin) await assertNotLastAdmin(tx, userId);
  if (isAdmin && user.suspendedAt)
    throw new AgentDropError('VALIDATION_FAILED', 'lift the suspension before granting admin');
  await tx.update(appUsers).set({ isAdmin, updatedAt: new Date() }).where(eq(appUsers.id, userId));
  await recordAudit(tx, {
    actorUserId: adminUserId,
    action: isAdmin ? 'admin.user.grant_admin' : 'admin.user.revoke_admin',
    targetId: userId,
    result: 'ok',
    meta: { handle: user.handle },
  });
}

/** Revokes one agent of any user (same effect as the owner revoking it from their own dashboard). */
export async function adminRevokeEndpoint(tx: Tx, adminUserId: string, hId: string): Promise<void> {
  const h = await tx.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, hId) });
  if (!h) throw new AgentDropError('NOT_FOUND', 'endpoint not found');
  const owner = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, h.userId) });
  if (owner?.isSystem)
    throw new AgentDropError('FORBIDDEN', 'the built-in assistant is managed by the server itself');
  if (h.revokedAt) return;
  // exactly what the owner's own revoke does, including ADR 0015 (default receiver, groups when it was the last)
  await revokeEndpoint(tx, h.userId, hId);
  await recordAudit(tx, {
    actorUserId: adminUserId,
    hId,
    action: 'admin.endpoint.revoke',
    targetId: hId,
    result: 'ok',
    meta: { owner_user_id: h.userId },
  });
}

/**
 * Closes an account for good. Drops other people already received are NOT deleted: a delivered drop belongs to its
 * recipient and the product never recalls one. What goes away is everything this account can still use or reveal:
 * login, sessions, credentials, agents, devices, addresses, contacts, memberships and the profile itself.
 */
export async function adminCloseAccount(
  tx: Tx,
  adminUserId: string,
  userId: string,
  confirmHandle: string,
): Promise<{ handle: string }> {
  const user = await loadTarget(tx, adminUserId, userId);
  if (confirmHandle.trim().replace(/^@/, '').toLowerCase() !== user.handle)
    throw new AgentDropError('VALIDATION_FAILED', 'the typed handle does not match this account', {
      field: 'confirm_handle',
    });
  if (user.isAdmin) await assertNotLastAdmin(tx, userId);
  const now = new Date();

  // 1. every agent of this user, and everything that authorizes one
  const hIds = (
    await tx
      .select({ id: harnessEndpoints.id })
      .from(harnessEndpoints)
      .where(eq(harnessEndpoints.userId, userId))
  ).map((r) => r.id);
  for (const hId of hIds) {
    await tx
      .update(hCredentials)
      .set({ revokedAt: now })
      .where(and(eq(hCredentials.hId, hId), isNull(hCredentials.revokedAt)));
    await tx
      .update(connections)
      .set({ closedAt: now })
      .where(and(eq(connections.hId, hId), isNull(connections.closedAt)));
  }
  await tx
    .update(harnessEndpoints)
    .set({ revokedAt: now })
    .where(and(eq(harnessEndpoints.userId, userId), isNull(harnessEndpoints.revokedAt)));
  await tx
    .update(devices)
    .set({ revokedAt: now })
    .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
  await tx
    .update(recipientRoutes)
    .set({ revokedAt: now, version: sql`${recipientRoutes.version} + 1` })
    .where(and(eq(recipientRoutes.userId, userId), isNull(recipientRoutes.revokedAt)));

  // 2. relationships in both directions, and group bindings that would keep delivering
  await tx.delete(contacts).where(eq(contacts.ownerUserId, userId));
  await tx.delete(contacts).where(eq(contacts.peerUserId, userId));
  const memberships = await tx
    .select({ id: groupMemberships.id, groupId: groupMemberships.groupId, role: groupMemberships.role })
    .from(groupMemberships)
    .where(eq(groupMemberships.userId, userId));
  for (const m of memberships) {
    await tx
      .update(groupBindings)
      .set({ revokedAt: now })
      .where(and(eq(groupBindings.membershipId, m.id), isNull(groupBindings.revokedAt)));
    await tx
      .update(groupMemberships)
      .set({ status: 'removed', version: sql`${groupMemberships.version} + 1` })
      .where(eq(groupMemberships.id, m.id));
    // a group must not be left without an owner: promote the longest-standing admin, else the oldest member
    if (m.role === 'owner') {
      const heir = await tx.execute<{ id: string; user_id: string }>(sql`
        select id, user_id from ${groupMemberships}
        where group_id = ${m.groupId} and status = 'active' and user_id <> ${userId}
        order by case role when 'admin' then 0 else 1 end, joined_at nulls last, id
        limit 1`);
      const next = heir.rows[0];
      if (next) {
        await tx
          .update(groupMemberships)
          .set({ role: 'owner', version: sql`${groupMemberships.version} + 1` })
          .where(eq(groupMemberships.id, next.id));
        await tx
          .update(groups)
          .set({ ownerUserId: next.user_id, version: sql`${groups.version} + 1` })
          .where(eq(groups.id, m.groupId));
      }
    }
  }

  // 3. the login itself: sessions and the stored password go away, the address is released for re-use
  await tx.delete(authSessions).where(eq(authSessions.userId, user.authUserId));
  await tx.delete(authAccounts).where(eq(authAccounts.userId, user.authUserId));
  await tx
    .update(authUsers)
    .set({ email: `closed+${userId}@account.invalid`, name: 'closed account', updatedAt: now })
    .where(eq(authUsers.id, user.authUserId));

  // Browser push endpoints are bearer-like capabilities. Closing an account must stop notifications immediately,
  // including an outbox event that was committed shortly before closure and is processed afterward.
  await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  // so is a linked Feishu account (ADR 0039): no card goes to it again, and no card is updated
  await tx.delete(feishuAccounts).where(eq(feishuAccounts.userId, userId));
  await tx.delete(feishuCards).where(eq(feishuCards.userId, userId));
  await tx.delete(feishuLinkCodes).where(eq(feishuLinkCodes.userId, userId));

  // 4. the profile: the handle is retired (not recycled) so old references stay unambiguous
  await tx
    .update(appUsers)
    .set({
      handle: `closed_${userId.replace(/-/g, '').slice(0, 12)}`,
      displayName: '已注销账号',
      publicEmail: null,
      notificationWebhookUrl: null,
      feishuWebhook: null,
      isAdmin: false,
      suspendedAt: now,
      suspendedReason: null,
      deletedAt: now,
      directoryRevision: sql`${appUsers.directoryRevision} + 1`,
      profileVersion: sql`${appUsers.profileVersion} + 1`,
      updatedAt: now,
    })
    .where(eq(appUsers.id, userId));

  await recordAudit(tx, {
    actorUserId: adminUserId,
    action: 'admin.user.close',
    targetId: userId,
    result: 'ok',
    meta: { handle: user.handle, endpoints: hIds.length, memberships: memberships.length },
  });
  return { handle: user.handle };
}

export async function adminListAudit(
  tx: Tx,
  input: {
    action?: string | undefined;
    actorUserId?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  },
): Promise<{ events: AdminAuditEvent[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const before = input.cursor ? Number(input.cursor) : null;
  const { rows } = await tx.execute<Record<string, string | number | null>>(sql`
    select a.id, a.actor_user_id, u.handle as actor_handle, a.h_id, a.action, a.target_id,
           a.result, a.meta, a.created_at
    from ${auditEvents} a left join ${appUsers} u on u.id = a.actor_user_id
    where ${before !== null && Number.isFinite(before) ? sql`a.id < ${before}` : sql`true`}
      and ${input.action ? sql`a.action like ${`${input.action}%`}` : sql`true`}
      and ${input.actorUserId ? sql`a.actor_user_id = ${input.actorUserId}` : sql`true`}
    order by a.id desc limit ${limit + 1}`);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    events: page.map((a) => ({
      id: Number(a.id),
      actor_user_id: a.actor_user_id === null ? null : String(a.actor_user_id),
      actor_handle: a.actor_handle === null ? null : String(a.actor_handle),
      h_id: a.h_id === null ? null : String(a.h_id),
      action: String(a.action),
      target_id: a.target_id === null ? null : String(a.target_id),
      result: String(a.result),
      meta: (a.meta ?? {}) as Record<string, unknown>,
      created_at: new Date(String(a.created_at)).toISOString(),
    })),
    nextCursor: rows.length > limit && last ? String(last.id) : null,
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    return typeof parsed.o === 'number' && parsed.o >= 0 ? Math.floor(parsed.o) : 0;
  } catch {
    return 0;
  }
}
