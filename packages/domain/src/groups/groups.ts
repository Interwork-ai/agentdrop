import { randomBytes } from 'node:crypto';
import {
  AgentDropError,
  displayNameSchema,
  groupDescriptionSchema,
  groupSlugSchema,
  LIMITS,
  normalizeHandle,
  normalizeName,
} from '@agentdrop/contracts';
import {
  appUsers,
  contacts,
  deliveries,
  deliveryGrants,
  groupBindings,
  groupJoinRequests,
  groupMemberships,
  groups,
  harnessEndpoints,
  type Tx,
} from '@agentdrop/db';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { blockedEitherWay, remarksFor } from '../contacts/directory.js';
import { bumpDirectoryRevision, getUserByHandle, requirePairedAgent } from '../identity/users.js';
import { enqueueOutbox } from '../mailbox/outbox.js';
import { bumpMailboxes } from '../mailbox/revision.js';
import { type GroupStorage, groupStorage } from './storage.js';

export type Role = 'owner' | 'admin' | 'member';
export type InvitePolicy = 'open' | 'admin_approval';

/** Deployments may lower this (and tests do); the contract value is the documented default. */
export const DEFAULT_MAX_GROUP_MEMBERS: number = LIMITS.GROUP_MAX_MEMBERS;

/** What an invite call did to one handle. */
export interface InviteOutcome {
  handle: string;
  outcome: 'invited' | 'requested' | 'already_member';
}

export interface JoinRequestView {
  group_id: string;
  slug: string;
  display_name: string;
  invitee_user_id: string;
  invitee_handle: string;
  invitee_display_name: string;
  invited_by_handle: string;
  created_at: string;
}

export interface GroupMemberView {
  membership_id: string;
  user_id: string;
  handle: string;
  /** viewer's remark > member's group nickname > public nickname > @handle */
  display_label: string;
  display_name: string;
  /** Published email of an active member; only active members see it, never across a block (ADR 0012). */
  public_email: string | null;
  nickname: string | null;
  role: Role;
  status: 'invited' | 'active' | 'left' | 'removed';
  joined_at: string | null;
  /** Admin-only diagnostic: an active member without any usable receiving endpoint blocks group sends. */
  needs_repair: boolean;
}

export interface GroupDetail {
  group_id: string;
  slug: string;
  display_name: string;
  description: string | null;
  owner_user_id: string;
  version: number;
  created_at: string;
  invite_policy: InvitePolicy;
  /**
   * Every active member may read the whole group history, including drops sent before they joined (ADR 0022).
   * Shown to every member and invitee; only the owner changes it.
   */
  history_visible: boolean;
  /** Active members + outstanding invitations, against the per-group people limit. */
  member_slots_used: number;
  member_limit: number;
  /** The group's file space (ADR 0029), for active members; absent for an invitee. */
  storage?: GroupStorage;
  /** Deprecated (ADR 0013): 0, or limit + 1 when over. Read `endpoints_over_limit`. */
  endpoint_total: number;
  endpoint_limit: number;
  endpoints_over_limit: boolean;
  /** Who invited me, shown while my own status is `invited`. */
  invited_by_handle: string | null;
  /** Waiting for an owner/admin. Only a human decides these, in the dashboard. Admin-only. */
  join_requests: JoinRequestView[];
  /** Set by calls that invited somebody, so the caller can report what happened per handle. */
  invites?: InviteOutcome[];
  my_membership: {
    membership_id: string;
    role: Role;
    status: 'invited' | 'active';
    nickname: string | null;
    muted: boolean;
    /** When my current membership began (the latest accept); null while invited. */
    joined_at: string | null;
    /** My endpoints bound to receive this group (only my own; never other people's). */
    /** True: every agent of the account receives, including agents paired later. */
    receive_all: boolean;
    binding_h_ids: string[];
  } | null;
  /** Whether the viewing H (if given) receives this group. */
  current_h_receives: boolean | null;
  members: GroupMemberView[];
  active_member_count: number;
  members_needing_repair: number;
}

async function lockGroup(tx: Tx, groupId: string) {
  const [g] = await tx.select().from(groups).where(eq(groups.id, groupId)).for('update');
  if (!g) throw new AgentDropError('NOT_FOUND', 'group not found');
  return g;
}

export async function bumpGroupVersion(tx: Tx, groupId: string): Promise<void> {
  await tx
    .update(groups)
    .set({ version: sql`${groups.version} + 1` })
    .where(eq(groups.id, groupId));
}

async function membershipOf(
  tx: Tx,
  groupId: string,
  userId: string,
  statuses: Array<'invited' | 'active'> = ['active'],
) {
  return tx.query.groupMemberships.findFirst({
    where: and(
      eq(groupMemberships.groupId, groupId),
      eq(groupMemberships.userId, userId),
      inArray(groupMemberships.status, statuses),
    ),
  });
}

async function requireAdmin(tx: Tx, groupId: string, userId: string) {
  const m = await membershipOf(tx, groupId, userId);
  if (!m) throw new AgentDropError('NOT_FOUND', 'group not found');
  if (m.role !== 'owner' && m.role !== 'admin') throw new AgentDropError('FORBIDDEN', 'admin role required');
  return m;
}

/** People who hold a slot: active members plus invitations nobody has answered yet. */
async function usedMemberSlots(tx: Tx, groupId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(groupMemberships)
    .where(
      and(eq(groupMemberships.groupId, groupId), inArray(groupMemberships.status, ['invited', 'active'])),
    );
  return row?.n ?? 0;
}

async function pendingRequestCount(tx: Tx, groupId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(groupJoinRequests)
    .where(and(eq(groupJoinRequests.groupId, groupId), eq(groupJoinRequests.status, 'pending')));
  return row?.n ?? 0;
}

function groupFull(used: number, limit: number): AgentDropError {
  return new AgentDropError(
    'VALIDATION_FAILED',
    'the group is at its member limit; remove someone or start another group',
    { field: 'handles', member_limit: limit, member_slots_used: used },
  );
}

/**
 * A block is a decision about a person, and group fan-out never consults it (see resolveTargets). So a member
 * must not be able to put someone into a group with anyone either side has blocked: that would silently rebuild
 * a channel the block closed. The refusal is deliberately vague about who blocked whom.
 */
async function assertNoBlockWithMembers(
  tx: Tx,
  groupId: string,
  inviteeUserId: string,
  /**
   * Passed in when inviting several people, so one batch does not re-read the roster per handle. Everyone
   * holding a slot counts, not just active members: two invitees who blocked each other would otherwise both
   * accept and end up sharing the group.
   */
  members?: string[],
): Promise<void> {
  members ??= await slotHolderIds(tx, groupId);
  members = members.filter((id) => id !== inviteeUserId);
  if (members.length === 0) return;
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(contacts)
    .where(
      and(
        isNotNull(contacts.blockedAt),
        or(
          and(eq(contacts.ownerUserId, inviteeUserId), inArray(contacts.peerUserId, members)),
          and(inArray(contacts.ownerUserId, members), eq(contacts.peerUserId, inviteeUserId)),
        ),
      ),
    )
    .limit(1);
  if (row) throw new AgentDropError('BLOCKED', 'this person cannot be added to this group');
}

/** A live membership supersedes any request that was still waiting for an admin. */
async function cancelPendingRequest(tx: Tx, groupId: string, inviteeUserId: string): Promise<void> {
  await tx
    .update(groupJoinRequests)
    .set({ status: 'cancelled', decidedAt: new Date() })
    .where(
      and(
        eq(groupJoinRequests.groupId, groupId),
        eq(groupJoinRequests.inviteeUserId, inviteeUserId),
        eq(groupJoinRequests.status, 'pending'),
      ),
    );
}

async function assertOwnEndpoints(tx: Tx, userId: string, hIds: string[]): Promise<void> {
  if (hIds.length === 0) return;
  const rows = await tx
    .select()
    .from(harnessEndpoints)
    .where(inArray(harnessEndpoints.id, [...new Set(hIds)]));
  for (const id of new Set(hIds)) {
    const h = rows.find((r) => r.id === id);
    if (!h || h.userId !== userId) throw new AgentDropError('NOT_FOUND', 'endpoint not found', { h_id: id });
    if (h.revokedAt) throw new AgentDropError('VALIDATION_FAILED', 'endpoint is revoked', { h_id: id });
  }
}

/** Every agent of the account that can currently receive (not revoked). */
async function activeEndpointIds(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: harnessEndpoints.id })
    .from(harnessEndpoints)
    .where(and(eq(harnessEndpoints.userId, userId), isNull(harnessEndpoints.revokedAt)));
  return rows.map((r) => r.id);
}

/**
 * How a member receives a group: with all of their agents (the default, and it follows agents paired later) or
 * with an explicit selection. Resolved here to the concrete endpoints bound right now.
 */
export type ReceiveChoice = { all: true } | { all: false; hIds: string[] };

async function resolveReceive(tx: Tx, userId: string, choice: ReceiveChoice): Promise<string[]> {
  await requirePairedAgent(tx, userId);
  if (choice.all) return activeEndpointIds(tx, userId);
  if (choice.hIds.length === 0)
    throw new AgentDropError('VALIDATION_FAILED', 'choose at least one receiving endpoint');
  await assertOwnEndpoints(tx, userId, choice.hIds);
  return [...new Set(choice.hIds)];
}

/**
 * A newly paired agent joins every group its account receives with "all agents". Called in the pairing
 * transaction; each group is locked and its version bumped so a pending send is re-previewed, as for any binding
 * change. History before this moment is not backfilled.
 */
export async function bindNewEndpointToGroups(tx: Tx, userId: string, hId: string): Promise<number> {
  const memberships = await tx
    .select({ id: groupMemberships.id, groupId: groupMemberships.groupId })
    .from(groupMemberships)
    .where(
      and(
        eq(groupMemberships.userId, userId),
        eq(groupMemberships.status, 'active'),
        eq(groupMemberships.receiveAll, true),
      ),
    )
    .orderBy(asc(groupMemberships.groupId));
  let bound = 0;
  for (const m of memberships) {
    await lockGroup(tx, m.groupId);
    const inserted = await tx
      .insert(groupBindings)
      .values({ membershipId: m.id, hId })
      .onConflictDoNothing()
      .returning({ id: groupBindings.id });
    if (inserted.length === 0) continue;
    bound += 1;
    await bumpGroupVersion(tx, m.groupId);
  }
  if (bound > 0) await bumpDirectoryRevision(tx, [userId]);
  return bound;
}

/**
 * After one of a person's agents was revoked (ADR 0015). A member who picked specific agents and has none of them
 * left receives with all of their agents again. A person with no live agent at all leaves every group, as if the
 * account were closed: a member who cannot receive would otherwise stop every group send, and an owner passes the
 * group to the longest-standing admin, else the oldest member. Invitations stay open for when they pair again.
 */
export async function reconcileGroupsAfterAgentLoss(tx: Tx, userId: string): Promise<void> {
  const live = await activeEndpointIds(tx, userId);
  const memberships = await tx
    .select()
    .from(groupMemberships)
    .where(and(eq(groupMemberships.userId, userId), eq(groupMemberships.status, 'active')))
    .orderBy(asc(groupMemberships.groupId));
  // Only groups that may need a change are locked (in id order, like every multi-group path), and the membership is
  // read again under the lock: a concurrent transfer, removal or rebinding may have changed it meanwhile.
  for (const seen of memberships) {
    if (live.length > 0 && seen.receiveAll) continue;
    await lockGroup(tx, seen.groupId);
    const m = await membershipOf(tx, seen.groupId, userId);
    if (!m) continue;
    if (live.length === 0) {
      if (m.role === 'owner') await passOwnership(tx, m);
      await endMembership(tx, { ...m, role: m.role === 'owner' ? 'member' : m.role }, 'left', userId);
      continue;
    }
    if (m.receiveAll) continue;
    const usable = await tx
      .select({ id: groupBindings.id })
      .from(groupBindings)
      .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, groupBindings.hId))
      .where(
        and(
          eq(groupBindings.membershipId, m.id),
          isNull(groupBindings.revokedAt),
          isNull(harnessEndpoints.revokedAt),
        ),
      );
    if (usable.length > 0) continue;
    await tx
      .update(groupMemberships)
      .set({ receiveAll: true, version: sql`${groupMemberships.version} + 1` })
      .where(eq(groupMemberships.id, m.id));
    await tx
      .insert(groupBindings)
      .values(live.map((hId) => ({ membershipId: m.id, hId })))
      .onConflictDoNothing();
    await bumpGroupVersion(tx, m.groupId);
  }
  if (memberships.length > 0) await bumpDirectoryRevision(tx, [userId]);
}

/** The owner is leaving: the longest-standing admin takes over, else the oldest active member. */
async function passOwnership(tx: Tx, owner: typeof groupMemberships.$inferSelect): Promise<void> {
  const heir = await tx.execute<{ id: string; user_id: string }>(sql`
    select id, user_id from ${groupMemberships}
    where group_id = ${owner.groupId} and status = 'active' and user_id <> ${owner.userId}
    order by case role when 'admin' then 0 else 1 end, joined_at nulls last, id
    limit 1`);
  const next = heir.rows[0];
  await tx
    .update(groupMemberships)
    .set({ role: 'member', version: sql`${groupMemberships.version} + 1` })
    .where(eq(groupMemberships.id, owner.id));
  if (!next) {
    // nobody is left to run the group: nobody should be let into it either
    await tx
      .update(groupMemberships)
      .set({ status: 'removed', revokedAt: new Date(), version: sql`${groupMemberships.version} + 1` })
      .where(and(eq(groupMemberships.groupId, owner.groupId), eq(groupMemberships.status, 'invited')));
    await tx
      .update(groupJoinRequests)
      .set({ status: 'cancelled', decidedAt: new Date() })
      .where(and(eq(groupJoinRequests.groupId, owner.groupId), eq(groupJoinRequests.status, 'pending')));
    return;
  }
  await tx
    .update(groupMemberships)
    .set({ role: 'owner', version: sql`${groupMemberships.version} + 1` })
    .where(eq(groupMemberships.id, next.id));
  await tx
    .update(groups)
    .set({ ownerUserId: next.user_id, version: sql`${groups.version} + 1` })
    .where(eq(groups.id, owner.groupId));
  await recordAudit(tx, {
    actorUserId: owner.userId,
    action: 'group.owner.succession',
    targetId: owner.groupId,
    result: 'ok',
  });
}

/** The creator receives with all of their agents unless they pick specific ones. */
export async function createGroup(
  tx: Tx,
  ownerUserId: string,
  input: {
    /** Omitted: the creator's handle, with a random suffix when that is taken (`freeSlug`). */
    slug?: string | null;
    /** Omitted: the creator's nickname and how many were invited (`defaultGroupName`). */
    displayName?: string | null;
    description?: string | null;
    receive: ReceiveChoice;
    nickname?: string | null;
    /** Invited in the same transaction; they still have to accept and choose their own endpoint. */
    inviteHandles?: string[];
    /** Earlier messages visible to members who join later (ADR 0022). Off unless the creator, the owner, asks. */
    historyVisible?: boolean;
  },
  maxMembers: number = DEFAULT_MAX_GROUP_MEMBERS,
): Promise<GroupDetail> {
  const owner = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, ownerUserId) });
  if (!owner) throw new AgentDropError('NOT_FOUND', 'account not found');
  const explicitSlug = input.slug?.trim() ? input.slug.trim().toLowerCase() : null;
  if (explicitSlug !== null && !groupSlugSchema.safeParse(explicitSlug).success)
    throw new AgentDropError('VALIDATION_FAILED', 'invalid slug', { field: 'slug' });
  const invited = new Set(
    (input.inviteHandles ?? []).map(normalizeHandle).filter((h) => h && h !== owner.handle),
  ).size;
  const name = displayNameSchema.safeParse(
    input.displayName?.trim()
      ? input.displayName
      : defaultGroupName(owner.displayName || `@${owner.handle}`, invited),
  );
  if (!name.success)
    throw new AgentDropError('VALIDATION_FAILED', 'invalid display name', { field: 'display_name' });
  const description = input.description ? groupDescriptionSchema.parse(input.description) : null;
  const bindingHIds = await resolveReceive(tx, ownerUserId, input.receive);
  if (explicitSlug !== null) {
    const clash = await tx.query.groups.findFirst({ where: eq(groups.slug, explicitSlug) });
    if (clash) throw new AgentDropError('VALIDATION_FAILED', 'slug already in use', { field: 'slug' });
  }
  /*
   * The look-up above only sees committed groups: a concurrent creation of the same slug surfaces as a unique
   * violation at insert. The insert runs in a savepoint so that violation leaves the transaction usable: a
   * derived slug tries again with a new suffix, an explicit one is reported like any other clash.
   */
  let g: typeof groups.$inferSelect | undefined;
  for (let attempt = 0; !g; attempt++) {
    const slug = explicitSlug ?? (await freeSlug(tx, owner.handle, attempt > 0));
    try {
      [g] = await tx.transaction((sp) =>
        sp
          .insert(groups)
          .values({
            slug,
            displayName: name.data,
            description,
            ownerUserId,
            historyVisible: input.historyVisible === true,
          })
          .returning(),
      );
      if (!g) throw new AgentDropError('INTERNAL');
    } catch (err) {
      if (!isSlugClash(err)) throw err;
      if (explicitSlug !== null)
        throw new AgentDropError('VALIDATION_FAILED', 'slug already in use', { field: 'slug' });
      if (attempt >= 4) throw new AgentDropError('INTERNAL', 'could not find a free group slug');
    }
  }
  const [m] = await tx
    .insert(groupMemberships)
    .values({
      groupId: g.id,
      userId: ownerUserId,
      role: 'owner',
      status: 'active',
      joinedAt: new Date(),
      nickname: input.nickname ?? null,
      receiveAll: input.receive.all,
    })
    .returning();
  if (!m) throw new AgentDropError('INTERNAL');
  await tx.insert(groupBindings).values(bindingHIds.map((hId) => ({ membershipId: m.id, hId })));
  await recordAudit(tx, {
    actorUserId: ownerUserId,
    action: 'group.create',
    targetId: g.id,
    result: 'ok',
    meta: {
      bindings: bindingHIds.length,
      receive_all: input.receive.all,
      invited: input.inviteHandles?.length ?? 0,
      history_visible: input.historyVisible === true,
    },
  });
  // The creator is the owner, so these always go out as direct invitations regardless of the policy.
  const invites = await inviteInto(tx, g, 'owner', ownerUserId, input.inviteHandles ?? [], maxMembers, [
    ownerUserId,
  ]);
  const detail = await getGroup(tx, ownerUserId, g.id, null, maxMembers);
  return { ...detail, invites };
}

/**
 * The name a group gets when its creator gives none: the creator's public nickname, then " +N" for the N people
 * invited in the same call. Fixed at creation and never updated. Invitees' names stay out of it: a group name is
 * shown to everyone who is invited later, and nobody agreed to be named in a group they may never join. One
 * neutral spelling for every reader, capped at GROUP_DEFAULT_NAME_MAX_CHARS (the nickname is shortened, never
 * the count).
 */
export function defaultGroupName(creatorName: string, invited: number): string {
  const max = LIMITS.GROUP_DEFAULT_NAME_MAX_CHARS;
  const suffix = invited > 0 ? ` +${invited}` : '';
  const room = max - suffix.length;
  const chars = Array.from(normalizeName(creatorName));
  const base = chars.length > room ? `${chars.slice(0, room - 1).join('')}…` : chars.join('');
  return `${base}${suffix}`;
}

/** A slug from the creator's handle, with a random suffix when that is taken (or `suffixed` asks for one). */
async function freeSlug(tx: Tx, handle: string, suffixed: boolean): Promise<string> {
  // handles already fit the slug alphabet; this only guards the shape should either rule change
  let base = handle
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 25);
  if (base.length < 2) base = 'group';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate =
      attempt === 0 && !suffixed ? base : `${base.replace(/[-_]+$/, '')}-${randomBytes(3).toString('hex')}`;
    const clash = await tx.query.groups.findFirst({ where: eq(groups.slug, candidate) });
    if (!clash) return candidate;
  }
  throw new AgentDropError('INTERNAL', 'could not find a free group slug');
}

/** A concurrent writer took the slug between our look-up and our write (Postgres 23505 on groups_slug_uq). */
function isSlugClash(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    const pg = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (pg.code === '23505' && pg.constraint === 'groups_slug_uq') return true;
    e = pg.cause;
  }
  return false;
}

export async function updateGroup(
  tx: Tx,
  actorUserId: string,
  groupId: string,
  input: { displayName?: string; description?: string | null; slug?: string },
): Promise<GroupDetail> {
  await lockGroup(tx, groupId);
  await requireAdmin(tx, groupId, actorUserId);
  const patch: Partial<typeof groups.$inferInsert> = {};
  if (input.displayName !== undefined) {
    const name = displayNameSchema.safeParse(input.displayName);
    if (!name.success)
      throw new AgentDropError('VALIDATION_FAILED', 'invalid display name', { field: 'display_name' });
    patch.displayName = name.data;
  }
  if (input.description !== undefined)
    patch.description = input.description ? groupDescriptionSchema.parse(input.description) : null;
  if (input.slug !== undefined) {
    const slug = groupSlugSchema.safeParse(input.slug.trim().toLowerCase());
    if (!slug.success) throw new AgentDropError('VALIDATION_FAILED', 'invalid slug', { field: 'slug' });
    const clash = await tx.query.groups.findFirst({ where: eq(groups.slug, slug.data) });
    if (clash && clash.id !== groupId)
      throw new AgentDropError('VALIDATION_FAILED', 'slug already in use', { field: 'slug' });
    patch.slug = slug.data;
  }
  try {
    // savepoint: a concurrent rename to the same slug is a unique violation, reported like any other clash
    await tx.transaction((sp) =>
      sp
        .update(groups)
        .set({ ...patch, version: sql`${groups.version} + 1` })
        .where(eq(groups.id, groupId)),
    );
  } catch (err) {
    if (isSlugClash(err))
      throw new AgentDropError('VALIDATION_FAILED', 'slug already in use', { field: 'slug' });
    throw err;
  }
  const members = await tx
    .select({ userId: groupMemberships.userId })
    .from(groupMemberships)
    .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.status, 'active')));
  await bumpDirectoryRevision(
    tx,
    members.map((m) => m.userId),
  );
  await recordAudit(tx, { actorUserId, action: 'group.update', targetId: groupId, result: 'ok' });
  return getGroup(tx, actorUserId, groupId, null);
}

async function adminUserIds(tx: Tx, groupId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: groupMemberships.userId })
    .from(groupMemberships)
    .where(
      and(
        eq(groupMemberships.groupId, groupId),
        eq(groupMemberships.status, 'active'),
        inArray(groupMemberships.role, ['owner', 'admin']),
      ),
    );
  return rows.map((r) => r.userId);
}

/**
 * Bring people in. Owners and admins always invite directly; for a plain member the group's policy decides
 * between a direct invitation and a join request an admin has to approve. All-or-nothing: if one handle cannot
 * be invited, nobody is. A previous left/removed membership never comes back — a new row is created.
 *
 * Handles are resolved before anything is written so the whole call takes one pass and one directory bump:
 * a per-handle bump would order `app_users` updates by caller-supplied handle order and deadlock against a
 * concurrent invite of the same people in the other order.
 */
async function inviteInto(
  tx: Tx,
  group: typeof groups.$inferSelect,
  actorRole: Role,
  actorUserId: string,
  rawHandles: string[],
  maxMembers: number,
  /**
   * Other `app_users` rows this transaction must bump. They join the one sorted bump at the end instead of
   * being bumped earlier: owner-then-invitees in two passes deadlocks against a concurrent create that invites
   * the same two people the other way round.
   */
  alsoBump: string[] = [],
): Promise<InviteOutcome[]> {
  // Case-folded the same way getUserByHandle folds it, or `Bob` and `bob` become two inserts of one person.
  const wanted = [...new Set(rawHandles.map(normalizeHandle).filter((h) => h.length > 0))];
  if (wanted.length === 0) {
    await bumpDirectoryRevision(tx, alsoBump);
    return [];
  }
  if (wanted.length > maxMembers)
    throw new AgentDropError('VALIDATION_FAILED', 'too many handles in one call', {
      field: 'handles',
      limit: maxMembers,
    });

  const resolved: Array<{ handle: string; userId: string }> = [];
  const unknown: string[] = [];
  for (const handle of wanted) {
    const peer = await getUserByHandle(tx, handle);
    if (!peer) unknown.push(handle);
    else if (peer.isSystem)
      throw new AgentDropError('VALIDATION_FAILED', 'the built-in assistant cannot join groups', {
        field: 'handles',
        handle,
      });
    else resolved.push({ handle, userId: peer.id });
  }
  if (unknown.length > 0)
    throw new AgentDropError('NOT_FOUND', 'no user with that handle', { handles: unknown });
  if (resolved.some((r) => r.userId === actorUserId))
    throw new AgentDropError('VALIDATION_FAILED', 'you are already in this group', { field: 'handles' });

  const direct = actorRole === 'owner' || actorRole === 'admin' || group.memberInvitePolicy === 'open';
  const slotHolders = await slotHolderIds(tx, group.id);
  const outcomes: InviteOutcome[] = [];
  const toInvite: Array<{ handle: string; userId: string }> = [];
  const toRequest: Array<{ handle: string; userId: string }> = [];
  for (const { handle, userId } of resolved) {
    if (await membershipOf(tx, group.id, userId, ['invited', 'active'])) {
      outcomes.push({ handle, outcome: 'already_member' });
      continue;
    }
    // Earlier handles in this batch count as members too: they are about to be invited alongside this one.
    await assertNoBlockWithMembers(tx, group.id, userId, [
      ...slotHolders,
      ...toInvite.map((t) => t.userId),
      ...toRequest.map((t) => t.userId),
    ]);
    if (direct) {
      toInvite.push({ handle, userId });
      outcomes.push({ handle, outcome: 'invited' });
      continue;
    }
    const waiting = await tx.query.groupJoinRequests.findFirst({
      where: and(
        eq(groupJoinRequests.groupId, group.id),
        eq(groupJoinRequests.inviteeUserId, userId),
        eq(groupJoinRequests.status, 'pending'),
      ),
    });
    if (!waiting) toRequest.push({ handle, userId });
    outcomes.push({ handle, outcome: 'requested' });
  }

  if (toInvite.length > 0) {
    const used = await usedMemberSlots(tx, group.id);
    if (used + toInvite.length > maxMembers) throw groupFull(used, maxMembers);
  }
  if (toRequest.length > 0) {
    // Requests do not hold member slots, but they must not be an unbounded queue an admin can never drain.
    const waitingNow = await pendingRequestCount(tx, group.id);
    if (waitingNow + toRequest.length > maxMembers)
      throw new AgentDropError('VALIDATION_FAILED', 'too many join requests are already waiting', {
        field: 'handles',
        limit: maxMembers,
        pending: waitingNow,
      });
  }

  const invited: string[] = [];
  if (toInvite.length > 0) {
    await tx.insert(groupMemberships).values(
      toInvite.map((t) => ({
        groupId: group.id,
        userId: t.userId,
        role: 'member' as const,
        status: 'invited' as const,
        invitedByUserId: actorUserId,
      })),
    );
    for (const t of toInvite) {
      await cancelPendingRequest(tx, group.id, t.userId);
      await enqueueOutbox(tx, 'group.invited', group.id, {
        user_id: t.userId,
        group_id: group.id,
        group_name: group.displayName,
        group_slug: group.slug,
      });
      invited.push(t.userId);
    }
  }
  if (toRequest.length > 0) {
    await tx.insert(groupJoinRequests).values(
      toRequest.map((t) => ({
        groupId: group.id,
        inviteeUserId: t.userId,
        invitedByUserId: actorUserId,
      })),
    );
    for (const adminId of await adminUserIds(tx, group.id)) {
      await enqueueOutbox(tx, 'group.join_requested', group.id, {
        user_id: adminId,
        group_id: group.id,
        group_name: group.displayName,
        group_slug: group.slug,
        count: toRequest.length,
        // Lets a server-side channel record each request under the same key an agent's notice uses.
        invitee_handles: toRequest.map((t) => t.handle),
      });
    }
  }
  // Deliberately no bumpGroupVersion: an invitation changes no receiving endpoint, and the version is what
  // decideApproval compares, so bumping here would invalidate unrelated pending sends (STALE_APPROVAL).
  await bumpDirectoryRevision(tx, [...alsoBump, ...invited]);
  await recordAudit(tx, {
    actorUserId,
    action: toInvite.length === 0 && toRequest.length > 0 ? 'group.invite_requested' : 'group.invite',
    targetId: group.id,
    result: 'ok',
    meta: { invited: toInvite.length, requested: toRequest.length },
  });
  return outcomes;
}

export async function inviteMembers(
  tx: Tx,
  actorUserId: string,
  groupId: string,
  rawHandles: string[],
  maxMembers: number,
): Promise<InviteOutcome[]> {
  await requirePairedAgent(tx, actorUserId);
  const group = await lockGroup(tx, groupId);
  const me = await membershipOf(tx, groupId, actorUserId);
  if (!me) throw new AgentDropError('NOT_FOUND', 'group not found');
  return inviteInto(tx, group, me.role, actorUserId, rawHandles, maxMembers);
}

/**
 * An owner/admin decides a member's join request. Deliberately unreachable from an H credential: approving
 * gives a third party a mailbox relationship with every other member, which is not a self-scoped action and
 * cannot be delegated to an agent. The dashboard is the only place this happens.
 */
export async function decideJoinRequest(
  tx: Tx,
  actorUserId: string,
  groupId: string,
  inviteeUserId: string,
  decision: 'approve' | 'reject',
  maxMembers: number = DEFAULT_MAX_GROUP_MEMBERS,
): Promise<GroupDetail> {
  const group = await lockGroup(tx, groupId);
  await requireAdmin(tx, groupId, actorUserId);
  const req = await tx.query.groupJoinRequests.findFirst({
    where: and(
      eq(groupJoinRequests.groupId, groupId),
      eq(groupJoinRequests.inviteeUserId, inviteeUserId),
      eq(groupJoinRequests.status, 'pending'),
    ),
  });
  if (!req) throw new AgentDropError('NOT_FOUND', 'no pending join request for this person');
  // Somebody may have been invited directly while the request waited; then approving is a no-op.
  const live = await membershipOf(tx, groupId, inviteeUserId, ['invited', 'active']);
  const admits = decision === 'approve' && !live;
  if (admits) {
    // Capacity first: a full group leaves the request pending instead of consuming it.
    const used = await usedMemberSlots(tx, groupId);
    if (used + 1 > maxMembers) throw groupFull(used, maxMembers);
    await assertNoBlockWithMembers(tx, groupId, inviteeUserId);
  }
  const decided = await tx
    .update(groupJoinRequests)
    .set({
      status: decision === 'approve' ? 'approved' : 'rejected',
      decidedAt: new Date(),
      decidedByUserId: actorUserId,
    })
    .where(and(eq(groupJoinRequests.id, req.id), eq(groupJoinRequests.status, 'pending')))
    .returning({ id: groupJoinRequests.id });
  if (decided.length === 0) throw new AgentDropError('NOT_FOUND', 'no pending join request for this person');
  if (admits) {
    await tx.insert(groupMemberships).values({
      groupId,
      userId: inviteeUserId,
      role: 'member',
      status: 'invited',
      invitedByUserId: req.invitedByUserId,
    });
    await enqueueOutbox(tx, 'group.invited', groupId, {
      user_id: inviteeUserId,
      group_id: groupId,
      group_name: group.displayName,
      group_slug: group.slug,
    });
    await bumpDirectoryRevision(tx, [inviteeUserId]);
  }
  await recordAudit(tx, {
    actorUserId,
    action: decision === 'approve' ? 'group.request.approve' : 'group.request.reject',
    targetId: groupId,
    result: 'ok',
    meta: { user_id: inviteeUserId, admitted: admits },
  });
  return getGroup(tx, actorUserId, groupId, null, maxMembers);
}

/** Who may bring people in. Admin-level, and never exposed as a tool: an agent cannot open a group up. */
export async function setInvitePolicy(
  tx: Tx,
  actorUserId: string,
  groupId: string,
  policy: InvitePolicy,
): Promise<GroupDetail> {
  await lockGroup(tx, groupId);
  await requireAdmin(tx, groupId, actorUserId);
  await tx.update(groups).set({ memberInvitePolicy: policy }).where(eq(groups.id, groupId));
  await recordAudit(tx, {
    actorUserId,
    action: 'group.policy',
    targetId: groupId,
    result: 'ok',
    meta: { policy },
  });
  return getGroup(tx, actorUserId, groupId, null);
}

/**
 * Whether members can read the group's earlier messages, including those from before they joined (ADR 0022).
 * Owner only: it decides what every later member may read, so an admin cannot widen (or narrow) it. Browser-only,
 * like the invite policy. Turning it off takes the history away again; drops delivered to a member stay theirs.
 * Nothing is delivered and nobody is notified either way.
 */
export async function setHistoryVisible(
  tx: Tx,
  actorUserId: string,
  groupId: string,
  visible: boolean,
): Promise<GroupDetail> {
  await lockGroup(tx, groupId);
  const m = await membershipOf(tx, groupId, actorUserId);
  if (!m) throw new AgentDropError('NOT_FOUND', 'group not found');
  if (m.role !== 'owner')
    throw new AgentDropError('FORBIDDEN', 'only the group owner can change who sees earlier messages');
  await tx.update(groups).set({ historyVisible: visible }).where(eq(groups.id, groupId));
  await recordAudit(tx, {
    actorUserId,
    action: 'group.history_visible',
    targetId: groupId,
    result: 'ok',
    meta: { history_visible: visible },
  });
  return getGroup(tx, actorUserId, groupId, null);
}

/** Join requests waiting for this user as an owner/admin, across every group or just one. */
export async function listJoinRequestsFor(
  tx: Tx,
  userId: string,
  groupId?: string,
): Promise<JoinRequestView[]> {
  const conds = [
    eq(groupJoinRequests.status, 'pending'),
    eq(groupMemberships.userId, userId),
    eq(groupMemberships.status, 'active'),
    inArray(groupMemberships.role, ['owner', 'admin']),
  ];
  if (groupId) conds.push(eq(groupJoinRequests.groupId, groupId));
  const rows = await tx
    .select({ r: groupJoinRequests, g: groups })
    .from(groupJoinRequests)
    .innerJoin(groups, eq(groups.id, groupJoinRequests.groupId))
    .innerJoin(groupMemberships, eq(groupMemberships.groupId, groupJoinRequests.groupId))
    .where(and(...conds))
    .orderBy(asc(groupJoinRequests.createdAt));
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.flatMap((x) => [x.r.inviteeUserId, x.r.invitedByUserId]))];
  const people = await tx.select().from(appUsers).where(inArray(appUsers.id, ids));
  const by = new Map(people.map((p) => [p.id, p]));
  return rows.map(({ r, g }) => ({
    group_id: g.id,
    slug: g.slug,
    display_name: g.displayName,
    invitee_user_id: r.inviteeUserId,
    invitee_handle: by.get(r.inviteeUserId)?.handle ?? '',
    invitee_display_name: by.get(r.inviteeUserId)?.displayName ?? '',
    invited_by_handle: by.get(r.invitedByUserId)?.handle ?? '',
    created_at: r.createdAt.toISOString(),
  }));
}

/**
 * Accepting an invitation receives with all of the invitee's agents unless they pick specific ones. Nobody else
 * can choose for them. History before this moment is never backfilled.
 */
export async function acceptInvite(
  tx: Tx,
  userId: string,
  groupId: string,
  input: { receive: ReceiveChoice; nickname?: string | null },
): Promise<GroupDetail> {
  await lockGroup(tx, groupId);
  const m = await membershipOf(tx, groupId, userId, ['invited']);
  if (!m) throw new AgentDropError('NOT_FOUND', 'no pending invitation');
  const hIds = await resolveReceive(tx, userId, input.receive);
  // A block placed while the invitation waited must still keep these two apart. Only active members count
  // here: between two invitees who blocked each other, whoever accepts first gets in and the other cannot.
  await assertNoBlockWithMembers(tx, groupId, userId, await activeUserIds(tx, groupId));
  const nickname = input.nickname ? displayNameSchema.parse(input.nickname) : null;
  await tx
    .update(groupMemberships)
    .set({
      status: 'active',
      joinedAt: new Date(),
      nickname,
      receiveAll: input.receive.all,
      version: sql`${groupMemberships.version} + 1`,
    })
    .where(eq(groupMemberships.id, m.id));
  await tx.insert(groupBindings).values(hIds.map((hId) => ({ membershipId: m.id, hId })));
  await bumpGroupVersion(tx, groupId);
  const members = await activeUserIds(tx, groupId);
  await bumpDirectoryRevision(tx, members);
  await recordAudit(tx, {
    actorUserId: userId,
    action: 'group.join',
    targetId: groupId,
    result: 'ok',
    meta: { bindings: hIds.length, receive_all: input.receive.all },
  });
  return getGroup(tx, userId, groupId, null);
}

export async function declineInvite(tx: Tx, userId: string, groupId: string): Promise<void> {
  await lockGroup(tx, groupId);
  const m = await membershipOf(tx, groupId, userId, ['invited']);
  if (!m) throw new AgentDropError('NOT_FOUND', 'no pending invitation');
  await tx
    .update(groupMemberships)
    .set({ status: 'left', revokedAt: new Date() })
    .where(eq(groupMemberships.id, m.id));
  // No bumpGroupVersion: an unanswered invitation had no receiving endpoint, so no pending send is stale.
  await bumpDirectoryRevision(tx, [userId]);
}

/** Leaving (or being removed) revokes the membership, its bindings and every grant that came from it. */
async function endMembership(
  tx: Tx,
  membership: typeof groupMemberships.$inferSelect,
  status: 'left' | 'removed',
  actorUserId: string,
) {
  const now = new Date();
  await tx
    .update(groupMemberships)
    .set({ status, revokedAt: now, version: sql`${groupMemberships.version} + 1` })
    .where(eq(groupMemberships.id, membership.id));
  await tx
    .update(groupBindings)
    .set({ revokedAt: now })
    .where(and(eq(groupBindings.membershipId, membership.id), isNull(groupBindings.revokedAt)));
  await revokeGrantsForMembership(tx, membership.id);
  // Requests this person filed are theirs; nobody should be admitted later on behalf of someone who is gone.
  await tx
    .update(groupJoinRequests)
    .set({ status: 'cancelled', decidedAt: now })
    .where(
      and(
        eq(groupJoinRequests.groupId, membership.groupId),
        eq(groupJoinRequests.invitedByUserId, membership.userId),
        eq(groupJoinRequests.status, 'pending'),
      ),
    );
  if (membership.status === 'active') await bumpGroupVersion(tx, membership.groupId);
  const members = await activeUserIds(tx, membership.groupId);
  await bumpDirectoryRevision(tx, [...members, membership.userId]);
  await recordAudit(tx, {
    actorUserId,
    action: status === 'left' ? 'group.leave' : 'group.remove',
    targetId: membership.groupId,
    result: 'ok',
    meta: { user_id: membership.userId },
  });
}

async function revokeGrantsForMembership(tx: Tx, membershipId: string, bindingIds?: string[]): Promise<void> {
  const conds = [eq(deliveryGrants.membershipId, membershipId), isNull(deliveryGrants.revokedAt)];
  if (bindingIds) conds.push(inArray(deliveryGrants.bindingId, bindingIds));
  const revoked = await tx
    .update(deliveryGrants)
    .set({ revokedAt: new Date() })
    .where(and(...conds))
    .returning({ deliveryId: deliveryGrants.deliveryId });
  if (revoked.length === 0) return;
  const ids = [...new Set(revoked.map((r) => r.deliveryId))];
  const dels = await tx
    .select({ id: deliveries.id, hId: deliveries.hId, dropId: deliveries.dropId })
    .from(deliveries)
    .where(inArray(deliveries.id, ids));
  await bumpMailboxes(
    tx,
    dels.map((d) => ({ hId: d.hId, type: 'grant.revoked' as const, dropId: d.dropId, deliveryId: d.id })),
  );
}

export async function leaveGroup(tx: Tx, userId: string, groupId: string): Promise<void> {
  await lockGroup(tx, groupId);
  const m = await membershipOf(tx, groupId, userId);
  if (!m) throw new AgentDropError('NOT_FOUND', 'group not found');
  if (m.role === 'owner')
    throw new AgentDropError('VALIDATION_FAILED', 'the owner cannot leave; transfer ownership first');
  await endMembership(tx, m, 'left', userId);
}

export async function removeMember(
  tx: Tx,
  actorUserId: string,
  groupId: string,
  userId: string,
): Promise<void> {
  await lockGroup(tx, groupId);
  await requireAdmin(tx, groupId, actorUserId);
  const m = await membershipOf(tx, groupId, userId, ['invited', 'active']);
  if (!m) throw new AgentDropError('NOT_FOUND', 'member not found');
  if (m.role === 'owner') throw new AgentDropError('FORBIDDEN', 'the owner cannot be removed');
  await endMembership(tx, m, 'removed', actorUserId);
}

export async function setMemberRole(
  tx: Tx,
  actorUserId: string,
  groupId: string,
  userId: string,
  role: 'admin' | 'member',
): Promise<void> {
  await lockGroup(tx, groupId);
  const actor = await membershipOf(tx, groupId, actorUserId);
  if (actor?.role !== 'owner') throw new AgentDropError('FORBIDDEN', 'owner role required');
  const m = await membershipOf(tx, groupId, userId);
  if (!m || m.role === 'owner') throw new AgentDropError('NOT_FOUND', 'member not found');
  await tx
    .update(groupMemberships)
    .set({ role, version: sql`${groupMemberships.version} + 1` })
    .where(eq(groupMemberships.id, m.id));
  await bumpGroupVersion(tx, groupId);
  await recordAudit(tx, {
    actorUserId,
    action: 'group.role',
    targetId: groupId,
    result: 'ok',
    meta: { user_id: userId, role },
  });
}

export async function transferOwnership(
  tx: Tx,
  actorUserId: string,
  groupId: string,
  userId: string,
): Promise<void> {
  await lockGroup(tx, groupId);
  const actor = await membershipOf(tx, groupId, actorUserId);
  if (actor?.role !== 'owner') throw new AgentDropError('FORBIDDEN', 'owner role required');
  const m = await membershipOf(tx, groupId, userId);
  if (!m) throw new AgentDropError('NOT_FOUND', 'member not found');
  // an owner who cannot receive would leave the group unable to send (ADR 0015)
  await requirePairedAgent(tx, userId);
  await tx.update(groupMemberships).set({ role: 'admin' }).where(eq(groupMemberships.id, actor.id));
  await tx.update(groupMemberships).set({ role: 'owner' }).where(eq(groupMemberships.id, m.id));
  await tx
    .update(groups)
    .set({ ownerUserId: userId, version: sql`${groups.version} + 1` })
    .where(eq(groups.id, groupId));
  await recordAudit(tx, {
    actorUserId,
    action: 'group.transfer',
    targetId: groupId,
    result: 'ok',
    meta: { user_id: userId },
  });
}

/**
 * Replaces the set of MY endpoints that receive this group. Removed endpoints lose their group grants for new
 * reads immediately; added endpoints only receive future drops. An empty set is allowed but flags the member as
 * "needs repair" and blocks group sends until fixed.
 */
export async function setMyBindings(
  tx: Tx,
  userId: string,
  groupId: string,
  receive: ReceiveChoice,
): Promise<GroupDetail> {
  await lockGroup(tx, groupId);
  const m = await membershipOf(tx, groupId, userId);
  if (!m) throw new AgentDropError('NOT_FOUND', 'group not found');
  // An empty selection would make every group send fail (ADR 0015): choose at least one agent, or leave.
  const hIds = await resolveReceive(tx, userId, receive);
  if (m.receiveAll !== receive.all)
    await tx
      .update(groupMemberships)
      .set({ receiveAll: receive.all, version: sql`${groupMemberships.version} + 1` })
      .where(eq(groupMemberships.id, m.id));
  const wanted = new Set(hIds);
  const current = await tx
    .select()
    .from(groupBindings)
    .where(and(eq(groupBindings.membershipId, m.id), isNull(groupBindings.revokedAt)));
  const toRevoke = current.filter((b) => !wanted.has(b.hId));
  if (toRevoke.length > 0) {
    await tx
      .update(groupBindings)
      .set({ revokedAt: new Date() })
      .where(
        inArray(
          groupBindings.id,
          toRevoke.map((b) => b.id),
        ),
      );
    await revokeGrantsForMembership(
      tx,
      m.id,
      toRevoke.map((b) => b.id),
    );
  }
  const existing = new Set(current.map((b) => b.hId));
  const toAdd = [...wanted].filter((h) => !existing.has(h));
  if (toAdd.length > 0)
    await tx.insert(groupBindings).values(toAdd.map((hId) => ({ membershipId: m.id, hId })));
  await bumpGroupVersion(tx, groupId);
  await bumpDirectoryRevision(tx, [userId]);
  await recordAudit(tx, {
    actorUserId: userId,
    action: 'group.bindings',
    targetId: groupId,
    result: 'ok',
    meta: { added: toAdd.length, removed: toRevoke.length, receive_all: receive.all },
  });
  return getGroup(tx, userId, groupId, null);
}

export async function setMyMembership(
  tx: Tx,
  userId: string,
  groupId: string,
  input: { nickname?: string | null; muted?: boolean },
): Promise<void> {
  const m = await membershipOf(tx, groupId, userId);
  if (!m) throw new AgentDropError('NOT_FOUND', 'group not found');
  const patch: Partial<typeof groupMemberships.$inferInsert> = {};
  if (input.nickname !== undefined)
    patch.nickname = input.nickname ? displayNameSchema.parse(input.nickname) : null;
  if (input.muted !== undefined) patch.muted = input.muted;
  await tx
    .update(groupMemberships)
    .set({ ...patch, version: sql`${groupMemberships.version} + 1` })
    .where(eq(groupMemberships.id, m.id));
  if (input.nickname !== undefined) await bumpDirectoryRevision(tx, await activeUserIds(tx, groupId));
}

async function slotHolderIds(tx: Tx, groupId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: groupMemberships.userId })
    .from(groupMemberships)
    .where(
      and(eq(groupMemberships.groupId, groupId), inArray(groupMemberships.status, ['invited', 'active'])),
    );
  return rows.map((r) => r.userId);
}

async function activeUserIds(tx: Tx, groupId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: groupMemberships.userId })
    .from(groupMemberships)
    .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.status, 'active')));
  return rows.map((r) => r.userId);
}

export interface GroupSummary {
  group_id: string;
  slug: string;
  display_name: string;
  role: Role | null;
  status: 'invited' | 'active';
  my_nickname: string | null;
  muted: boolean;
  active_member_count: number;
  current_h_receives: boolean | null;
}

export async function listMyGroups(
  tx: Tx,
  userId: string,
  viewerHId: string | null,
): Promise<GroupSummary[]> {
  const rows = await tx
    .select({
      g: groups,
      m: groupMemberships,
      count: sql<number>`(select count(*)::int from ${groupMemberships} x where x.group_id = ${groups.id} and x.status = 'active')`,
      receives: viewerHId
        ? sql<boolean>`exists(select 1 from ${groupBindings} b where b.membership_id = ${groupMemberships.id} and b.h_id = ${viewerHId} and b.revoked_at is null)`
        : sql<boolean>`false`,
    })
    .from(groupMemberships)
    .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
    .where(and(eq(groupMemberships.userId, userId), inArray(groupMemberships.status, ['invited', 'active'])))
    .orderBy(asc(groups.displayName));
  return rows.map(({ g, m, count, receives }) => ({
    group_id: g.id,
    slug: g.slug,
    display_name: g.displayName,
    role: m.status === 'active' ? m.role : null,
    status: m.status as 'invited' | 'active',
    my_nickname: m.nickname,
    muted: m.muted,
    active_member_count: count,
    current_h_receives: viewerHId ? receives : null,
  }));
}

/** Group page for a member (or invitee). Never lists other members' endpoints; only whether they need repair (admins). */
export async function getGroup(
  tx: Tx,
  userId: string,
  groupId: string,
  viewerHId: string | null,
  maxMembers: number = DEFAULT_MAX_GROUP_MEMBERS,
  endpointLimit: number = LIMITS.MAX_GROUP_RECIPIENT_H,
): Promise<GroupDetail> {
  const g = await tx.query.groups.findFirst({ where: eq(groups.id, groupId) });
  if (!g) throw new AgentDropError('NOT_FOUND', 'group not found');
  const me = await membershipOf(tx, groupId, userId, ['invited', 'active']);
  if (!me) throw new AgentDropError('NOT_FOUND', 'group not found');
  const isAdmin = me.status === 'active' && (me.role === 'owner' || me.role === 'admin');
  const rows = await tx
    .select({ m: groupMemberships, u: appUsers })
    .from(groupMemberships)
    .innerJoin(appUsers, eq(appUsers.id, groupMemberships.userId))
    .where(
      and(eq(groupMemberships.groupId, groupId), inArray(groupMemberships.status, ['invited', 'active'])),
    )
    .orderBy(asc(groupMemberships.createdAt));
  const remarks = await remarksFor(
    tx,
    userId,
    rows.map((r) => r.u.id),
  );
  const usable = await tx
    .select({ membershipId: groupBindings.membershipId, n: sql<number>`count(*)::int` })
    .from(groupBindings)
    .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, groupBindings.hId))
    .where(
      and(
        inArray(
          groupBindings.membershipId,
          rows.map((r) => r.m.id),
        ),
        isNull(groupBindings.revokedAt),
        isNull(harnessEndpoints.revokedAt),
      ),
    )
    .groupBy(groupBindings.membershipId);
  const usableBy = new Map(usable.map((u) => [u.membershipId, u.n]));
  // a block either way hides the address, as in the contact list and the directory
  const blocked = await blockedEitherWay(
    tx,
    userId,
    rows.map((r) => r.u.id),
  );
  const members: GroupMemberView[] = rows.map(({ m, u }) => ({
    membership_id: m.id,
    user_id: u.id,
    handle: u.handle,
    display_label: remarks.get(u.id) ?? m.nickname ?? u.displayName ?? `@${u.handle}`,
    display_name: u.displayName,
    public_email:
      me.status === 'active' && m.status === 'active' && !blocked.has(u.id) ? u.publicEmail : null,
    nickname: m.nickname,
    role: m.role,
    status: m.status,
    joined_at: m.joinedAt ? m.joinedAt.toISOString() : null,
    needs_repair:
      isAdmin || u.id === userId ? m.status === 'active' && (usableBy.get(m.id) ?? 0) === 0 : false,
  }));
  const myBindings =
    me.status === 'active'
      ? await tx
          .select({ hId: groupBindings.hId })
          .from(groupBindings)
          .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, groupBindings.hId))
          // A revoked endpoint receives nothing; listing it would make every later binding edit echo it back
          // and be refused as "endpoint is revoked".
          .where(
            and(
              eq(groupBindings.membershipId, me.id),
              isNull(groupBindings.revokedAt),
              isNull(harnessEndpoints.revokedAt),
            ),
          )
      : [];
  const active = members.filter((m) => m.status === 'active');
  const [endpoints] = await tx
    .select({ n: sql<number>`count(distinct ${groupBindings.hId})::int` })
    .from(groupBindings)
    .innerJoin(groupMemberships, eq(groupMemberships.id, groupBindings.membershipId))
    .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, groupBindings.hId))
    .where(
      and(
        eq(groupMemberships.groupId, groupId),
        eq(groupMemberships.status, 'active'),
        isNull(groupBindings.revokedAt),
        isNull(harnessEndpoints.revokedAt),
      ),
    );
  const invitedBy = me.invitedByUserId
    ? await tx.query.appUsers.findFirst({ where: eq(appUsers.id, me.invitedByUserId) })
    : null;
  /*
   * Someone who has not accepted yet is not in the group: they get enough to decide (name, size, who asked)
   * but not the roster, otherwise any member could hand a full member list to an arbitrary handle.
   */
  const pending = me.status === 'invited';
  return {
    group_id: g.id,
    slug: g.slug,
    display_name: g.displayName,
    description: g.description,
    owner_user_id: g.ownerUserId,
    version: g.version,
    created_at: g.createdAt.toISOString(),
    invite_policy: g.memberInvitePolicy,
    history_visible: g.historyVisible,
    member_slots_used: members.filter((m) => m.status === 'invited' || m.status === 'active').length,
    member_limit: maxMembers,
    ...(pending ? {} : { storage: await groupStorage(tx, g.id) }),
    // whether group sends are refused, never how many agents the members have (ADR 0013)
    endpoint_total: (endpoints?.n ?? 0) > endpointLimit ? endpointLimit + 1 : 0,
    endpoint_limit: endpointLimit,
    endpoints_over_limit: (endpoints?.n ?? 0) > endpointLimit,
    invited_by_handle: pending ? (invitedBy?.handle ?? null) : null,
    join_requests: isAdmin ? await listJoinRequestsFor(tx, userId, groupId) : [],
    my_membership: {
      membership_id: me.id,
      role: me.role,
      status: me.status as 'invited' | 'active',
      nickname: me.nickname,
      muted: me.muted,
      joined_at: me.joinedAt ? me.joinedAt.toISOString() : null,
      receive_all: me.receiveAll,
      binding_h_ids: myBindings.map((b) => b.hId),
    },
    current_h_receives: viewerHId ? myBindings.some((b) => b.hId === viewerHId) : null,
    members: pending ? [] : members,
    active_member_count: active.length,
    members_needing_repair: isAdmin ? active.filter((m) => m.needs_repair).length : 0,
  };
}
