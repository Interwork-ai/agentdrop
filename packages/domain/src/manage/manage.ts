import { AgentDropError, type ContactRemoval, LIMITS, normalizeHandle } from '@agentdrop/contracts';
import {
  approvals,
  appUsers,
  contacts,
  groupBindings,
  groupJoinRequests,
  groupMemberships,
  groups,
  harnessEndpoints,
  type Tx,
} from '@agentdrop/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { acceptContact, contactView, inviteContact, removeContact } from '../contacts/contacts.js';
import {
  acceptInvite,
  createGroup,
  DEFAULT_MAX_GROUP_MEMBERS,
  declineInvite,
  getGroup,
  type InviteOutcome,
  inviteMembers,
  leaveGroup,
  listJoinRequestsFor,
} from '../groups/groups.js';
import { unreadCount } from '../mailbox/read.js';
import type { MailboxScope } from '../principals.js';

/**
 * Agent-side relationship management. Every operation runs as the human's account but is bounded to the endpoint
 * the agent runs on: it can bind only `scope.hId`, never other devices.
 */

export interface GroupHealth {
  group_id: string;
  slug: string;
  display_name: string;
  current_h_receives: boolean;
  my_binding_missing: boolean;
  members_needing_repair: number;
  endpoint_total: number;
  endpoint_limit: number;
  endpoints_over_limit: boolean;
}

export interface PendingRequests {
  contact_requests_received: Array<{ user_id: string; handle: string; display_name: string }>;
  contact_requests_sent: Array<{ user_id: string; handle: string; display_name: string }>;
  group_invitations: Array<{
    group_id: string;
    slug: string;
    display_name: string;
    member_count: number;
    invited_by_handle: string | null;
  }>;
  group_join_requests: Array<{
    group_id: string;
    slug: string;
    display_name: string;
    invitee_user_id: string;
    invitee_handle: string;
    invitee_display_name: string;
    invited_by_handle: string;
    created_at: string;
  }>;
  groups: GroupHealth[];
}

/**
 * The two states that make a group send fail outright, computed for every group I am in: a member with no
 * usable receiving endpoint (GROUP_RECIPIENT_UNAVAILABLE) and an endpoint total over the per-send limit
 * (TOO_MANY_RECIPIENTS). Both are worth knowing before composing, not at send time.
 */
async function myGroupHealth(tx: Tx, scope: MailboxScope, endpointLimit: number): Promise<GroupHealth[]> {
  const mine = await tx
    .select({ g: groups, role: groupMemberships.role })
    .from(groupMemberships)
    .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
    .where(and(eq(groupMemberships.userId, scope.userId), eq(groupMemberships.status, 'active')));
  if (mine.length === 0) return [];
  const groupIds = mine.map((x) => x.g.id);
  const rows = await tx
    .select({
      groupId: groupMemberships.groupId,
      membershipId: groupMemberships.id,
      userId: groupMemberships.userId,
      liveHId: harnessEndpoints.id,
    })
    .from(groupMemberships)
    .leftJoin(
      groupBindings,
      and(eq(groupBindings.membershipId, groupMemberships.id), isNull(groupBindings.revokedAt)),
    )
    .leftJoin(
      harnessEndpoints,
      and(eq(harnessEndpoints.id, groupBindings.hId), isNull(harnessEndpoints.revokedAt)),
    )
    .where(and(inArray(groupMemberships.groupId, groupIds), eq(groupMemberships.status, 'active')));
  return mine.map(({ g, role }) => {
    const here = rows.filter((r) => r.groupId === g.id);
    const endpoints = new Set(here.map((r) => r.liveHId).filter((h): h is string => h !== null));
    const byMember = new Map<string, boolean>();
    for (const r of here)
      byMember.set(r.membershipId, (byMember.get(r.membershipId) ?? false) || !!r.liveHId);
    const mineHere = here.filter((r) => r.userId === scope.userId);
    return {
      group_id: g.id,
      slug: g.slug,
      display_name: g.displayName,
      current_h_receives: mineHere.some((r) => r.liveHId === scope.hId),
      my_binding_missing: !mineHere.some((r) => r.liveHId !== null),
      // who cannot receive is for owners/admins to repair (as on the group page); a member learns only about
      // themselves, through my_binding_missing
      members_needing_repair:
        role === 'owner' || role === 'admin' ? [...byMember.values()].filter((ok) => !ok).length : 0,
      // only whether the limit is passed, never the total (ADR 0013)
      ...overLimit(endpoints.size, endpointLimit),
    };
  });
}

/** The group's receiving-agent capacity as a member may see it: over the limit or not, never the count. */
export function overLimit(
  total: number,
  limit: number,
): { endpoint_total: number; endpoint_limit: number; endpoints_over_limit: boolean } {
  const over = total > limit;
  return { endpoint_total: over ? limit + 1 : 0, endpoint_limit: limit, endpoints_over_limit: over };
}

export async function pendingRequests(
  tx: Tx,
  scope: MailboxScope,
  endpointLimit: number = LIMITS.MAX_GROUP_RECIPIENT_H,
): Promise<PendingRequests> {
  const rows = await tx
    .select({ c: contacts, u: appUsers })
    .from(contacts)
    .innerJoin(appUsers, eq(appUsers.id, contacts.peerUserId))
    .where(eq(contacts.ownerUserId, scope.userId));
  const person = (u: typeof appUsers.$inferSelect) => ({
    user_id: u.id,
    handle: u.handle,
    display_name: u.displayName,
  });
  const invites = await tx
    .select({
      g: groups,
      invitedBy: groupMemberships.invitedByUserId,
      count: sql<number>`(select count(*)::int from ${groupMemberships} x where x.group_id = ${groups.id} and x.status = 'active')`,
    })
    .from(groupMemberships)
    .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
    .where(and(eq(groupMemberships.userId, scope.userId), eq(groupMemberships.status, 'invited')));
  // Whoever invited me is part of deciding whether to accept, so the invitee sees it too, not just admins.
  const inviterIds = [...new Set(invites.map((i) => i.invitedBy).filter((id): id is string => !!id))];
  const inviters = inviterIds.length
    ? await tx.select().from(appUsers).where(inArray(appUsers.id, inviterIds))
    : [];
  const handleOf = new Map(inviters.map((u) => [u.id, u.handle]));
  const [joinRequests, groupHealth] = await Promise.all([
    listJoinRequestsFor(tx, scope.userId),
    myGroupHealth(tx, scope, endpointLimit),
  ]);
  return {
    contact_requests_received: rows
      .filter((r) => r.c.status === 'requested' && !r.c.blockedAt)
      .map((r) => person(r.u)),
    contact_requests_sent: rows
      .filter((r) => r.c.status === 'invited' && !r.c.blockedAt)
      .map((r) => person(r.u)),
    group_invitations: invites.map(({ g, count, invitedBy }) => ({
      group_id: g.id,
      slug: g.slug,
      display_name: g.displayName,
      member_count: count,
      invited_by_handle: invitedBy ? (handleOf.get(invitedBy) ?? null) : null,
    })),
    group_join_requests: joinRequests,
    groups: groupHealth,
  };
}

export interface ContactResult {
  user_id: string;
  handle: string;
  display_name: string;
  status: 'accepted' | 'invited' | 'requested' | 'blocked' | 'group_only' | 'removed';
}

export async function contactRequest(tx: Tx, scope: MailboxScope, handle: string): Promise<ContactResult> {
  const v = await inviteContact(tx, scope.userId, handle);
  return { user_id: v.user_id, handle: v.handle, display_name: v.display_name, status: v.status };
}

/**
 * `agentdrop contact remove`: all or nothing across the named handles. Without `confirm` it only describes them,
 * so the person can see exactly who would be removed; with `confirm` it removes them. Every handle must be one
 * of my contacts (accepted, invited, requested or blocked), otherwise nothing happens.
 */
export async function contactRemoveFromAgent(
  tx: Tx,
  scope: MailboxScope,
  handles: string[],
  confirm: boolean,
): Promise<{ removed: boolean; contacts: ContactRemoval[] }> {
  const wanted = [...new Set(handles.map((h) => normalizeHandle(h.trim().replace(/^@/, ''))))];
  const found: ContactRemoval[] = [];
  const missing: string[] = [];
  for (const handle of wanted) {
    const [row] = await tx
      .select({ c: contacts, u: appUsers })
      .from(contacts)
      .innerJoin(appUsers, eq(appUsers.id, contacts.peerUserId))
      .where(and(eq(contacts.ownerUserId, scope.userId), eq(appUsers.handle, handle)));
    if (!row) {
      missing.push(handle);
      continue;
    }
    const peer = row.u.id;
    const counts = await tx.execute<{ from_them: number; to_them: number; last_at: Date | null }>(sql`
      select
        (select count(distinct d.drop_id)::int from deliveries d
           join harness_endpoints h on h.id = d.h_id join drops x on x.id = d.drop_id
           where h.user_id = ${scope.userId} and x.author_user_id = ${peer}) as from_them,
        (select count(distinct d.drop_id)::int from deliveries d
           join harness_endpoints h on h.id = d.h_id join drops x on x.id = d.drop_id
           where h.user_id = ${peer} and x.author_user_id = ${scope.userId}) as to_them,
        (select max(x.created_at) from deliveries d
           join harness_endpoints h on h.id = d.h_id join drops x on x.id = d.drop_id
           where (h.user_id = ${scope.userId} and x.author_user_id = ${peer})
              or (h.user_id = ${peer} and x.author_user_id = ${scope.userId})) as last_at`);
    const groupsShared = await tx.execute<{ slug: string }>(sql`
      select distinct g.slug from ${groups} g
        join ${groupMemberships} a on a.group_id = g.id and a.user_id = ${scope.userId} and a.status = 'active'
        join ${groupMemberships} b on b.group_id = g.id and b.user_id = ${peer} and b.status = 'active'
      order by g.slug`);
    const c = counts.rows[0];
    found.push({
      user_id: peer,
      handle: row.u.handle,
      display_name: row.u.displayName,
      remark: row.c.remark,
      status: row.c.blockedAt ? 'blocked' : (row.c.status as ContactRemoval['status']),
      contact_since: row.c.createdAt.toISOString(),
      drops_from_them: c?.from_them ?? 0,
      drops_to_them: c?.to_them ?? 0,
      last_drop_at: c?.last_at ? new Date(c.last_at).toISOString() : null,
      shared_groups: groupsShared.rows.map((r) => r.slug),
      is_system: row.u.isSystem,
    });
  }
  if (missing.length > 0)
    throw new AgentDropError('NOT_FOUND', 'not among your contacts; nothing was removed', {
      handles: missing,
    });
  if (!confirm) return { removed: false, contacts: found };
  for (const contact of found) await removeContact(tx, scope.userId, contact.user_id);
  return { removed: true, contacts: found };
}

export async function contactRespond(
  tx: Tx,
  scope: MailboxScope,
  peerUserId: string,
  decision: 'accept' | 'decline',
): Promise<ContactResult> {
  const current = await contactView(tx, scope.userId, peerUserId);
  if (current.status !== 'requested')
    throw new AgentDropError('NOT_FOUND', 'no pending request from this person');
  if (decision === 'accept') {
    const v = await acceptContact(tx, scope.userId, peerUserId);
    return { user_id: v.user_id, handle: v.handle, display_name: v.display_name, status: v.status };
  }
  await removeContact(tx, scope.userId, peerUserId);
  return {
    user_id: current.user_id,
    handle: current.handle,
    display_name: current.display_name,
    status: 'removed',
  };
}

export interface GroupResult {
  group_id: string;
  slug: string;
  display_name: string;
  my_role: 'owner' | 'admin' | 'member' | null;
  my_status: 'invited' | 'active' | 'left';
  current_h_receives: boolean;
  invite_policy: 'open' | 'admin_approval';
  history_visible: boolean;
  member_limit: number;
  member_slots_used: number;
  join_requests_pending: number;
  /** The group's file space (ADR 0029); absent while only invited. */
  storage?: { used_bytes: number; limit_bytes: number };
  invites: InviteOutcome[];
  active_member_count: number;
  members: Array<{
    handle: string;
    display_label: string;
    role: 'owner' | 'admin' | 'member';
    status: 'invited' | 'active';
    public_email?: string | null;
  }>;
}

async function groupResult(
  tx: Tx,
  scope: MailboxScope,
  groupId: string,
  maxMembers = DEFAULT_MAX_GROUP_MEMBERS,
  invites: InviteOutcome[] = [],
): Promise<GroupResult> {
  const d = await getGroup(tx, scope.userId, groupId, scope.hId, maxMembers);
  return {
    group_id: d.group_id,
    slug: d.slug,
    display_name: d.display_name,
    my_role: d.my_membership?.status === 'active' ? d.my_membership.role : null,
    my_status: d.my_membership?.status ?? 'left',
    current_h_receives: d.current_h_receives === true,
    invite_policy: d.invite_policy,
    history_visible: d.history_visible,
    member_limit: d.member_limit,
    member_slots_used: d.member_slots_used,
    join_requests_pending: d.join_requests.length,
    ...(d.storage ? { storage: d.storage } : {}),
    invites,
    active_member_count: d.active_member_count,
    members: d.members
      .filter((m) => m.status === 'invited' || m.status === 'active')
      .map((m) => ({
        handle: m.handle,
        display_label: m.display_label,
        role: m.role,
        status: m.status as 'invited' | 'active',
        public_email: m.public_email,
      })),
  };
}

export async function groupCreateFromAgent(
  tx: Tx,
  scope: MailboxScope,
  input: {
    slug?: string | undefined;
    displayName?: string | undefined;
    description?: string | undefined;
    inviteHandles?: string[] | undefined;
  },
  maxMembers = DEFAULT_MAX_GROUP_MEMBERS,
): Promise<GroupResult> {
  const d = await createGroup(
    tx,
    scope.userId,
    {
      slug: input.slug ?? null,
      displayName: input.displayName ?? null,
      description: input.description ?? null,
      // Like the dashboard: the account receives with all of its agents, including ones paired later.
      receive: { all: true },
      ...(input.inviteHandles ? { inviteHandles: input.inviteHandles } : {}),
    },
    maxMembers,
  );
  return groupResult(tx, scope, d.group_id, maxMembers, d.invites ?? []);
}

export async function groupInviteFromAgent(
  tx: Tx,
  scope: MailboxScope,
  groupId: string,
  handles: string[],
  maxMembers = DEFAULT_MAX_GROUP_MEMBERS,
): Promise<GroupResult> {
  const invites = await inviteMembers(tx, scope.userId, groupId, handles, maxMembers);
  return groupResult(tx, scope, groupId, maxMembers, invites);
}

export async function groupRespondFromAgent(
  tx: Tx,
  scope: MailboxScope,
  groupId: string,
  decision: 'accept' | 'decline',
  nickname: string | undefined,
): Promise<GroupResult> {
  if (decision === 'accept') {
    await acceptInvite(tx, scope.userId, groupId, { receive: { all: true }, nickname: nickname ?? null });
    return groupResult(tx, scope, groupId);
  }
  const before = await groupResult(tx, scope, groupId);
  await declineInvite(tx, scope.userId, groupId);
  return { ...before, my_role: null, my_status: 'left', current_h_receives: false };
}

export async function groupLeaveFromAgent(
  tx: Tx,
  scope: MailboxScope,
  groupId: string,
): Promise<GroupResult> {
  const before = await groupResult(tx, scope, groupId);
  await leaveGroup(tx, scope.userId, groupId);
  return {
    ...before,
    my_role: null,
    my_status: 'left',
    current_h_receives: false,
    active_member_count: before.active_member_count - 1,
  };
}

export interface PendingCounts {
  unread: number;
  contact_requests: number;
  group_invitations: number;
  group_join_requests: number;
  approvals: number;
}

/** Cheap counts surfaced in every viewer block so an agent notices new requests without polling explicitly. */
export async function pendingCounts(tx: Tx, scope: MailboxScope): Promise<PendingCounts> {
  const [unread, requests, invites, joinRequests, pendingApprovals] = await Promise.all([
    unreadCount(tx, scope.hId),
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(contacts)
      .where(
        and(
          eq(contacts.ownerUserId, scope.userId),
          eq(contacts.status, 'requested'),
          sql`${contacts.blockedAt} is null`,
        ),
      ),
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(groupMemberships)
      .where(and(eq(groupMemberships.userId, scope.userId), eq(groupMemberships.status, 'invited'))),
    // Join requests waiting for me as an owner/admin: the one counter that is about other people's membership.
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(groupJoinRequests)
      .innerJoin(groupMemberships, eq(groupMemberships.groupId, groupJoinRequests.groupId))
      .where(
        and(
          eq(groupJoinRequests.status, 'pending'),
          eq(groupMemberships.userId, scope.userId),
          eq(groupMemberships.status, 'active'),
          inArray(groupMemberships.role, ['owner', 'admin']),
        ),
      ),
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(approvals)
      .where(and(eq(approvals.actorUserId, scope.userId), eq(approvals.status, 'pending'))),
  ]);
  return {
    unread,
    contact_requests: requests[0]?.n ?? 0,
    group_invitations: invites[0]?.n ?? 0,
    group_join_requests: joinRequests[0]?.n ?? 0,
    approvals: pendingApprovals[0]?.n ?? 0,
  };
}
