import { AgentDropError, remarkSchema } from '@agentdrop/contracts';
import {
  appUsers,
  contactInviteLinks,
  contacts,
  groupMemberships,
  recipientRoutes,
  type Tx,
} from '@agentdrop/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { addAssistantContact } from '../identity/system-assistant.js';
import {
  bumpDirectoryRevision,
  getUserByHandle,
  getUserById,
  requirePairedAgent,
} from '../identity/users.js';
import { enqueueOutbox } from '../mailbox/outbox.js';
import { blockedEitherWay, hasAcceptedPeerContact } from './directory.js';

export type ContactStatus = 'accepted' | 'invited' | 'requested' | 'blocked' | 'group_only';

export interface ContactView {
  contact_id: string | null;
  user_id: string;
  handle: string;
  display_name: string;
  /** Their published email: accepted contacts only, never with a block either way, as in the directory (ADR 0012). */
  public_email: string | null;
  /** The built-in assistant (@agentdrop): answers every direct drop with a receipt. */
  is_system: boolean;
  /** Owner-private remark. */
  remark: string | null;
  status: ContactStatus;
  preferred_route_id: string | null;
  auto_approve: boolean;
  version: number;
  updated_at: string | null;
  /**
   * A pending request that came from an invite link (ADR 0034): the person who opened it becomes a contact as soon
   * as they pair an agent, without a further click. Shown to both people; false once accepted and for any request
   * made by handle.
   */
  from_invite_link: boolean;
}

/**
 * Whether my row is a request still waiting that a live invite link created, i.e. one the invitee's pairing will
 * accept (ADR 0034, `acceptInviteRequestsOnPairing`): not blocked, the link neither expired nor revoked, and the
 * inviter not suspended.
 */
function pendingFromLink(
  row: typeof contacts.$inferSelect | undefined,
  link: { expiresAt: Date; revokedAt: Date | null } | null | undefined,
  peer: { suspendedAt: Date | null },
): boolean {
  if (!row?.inviteLinkId || !link || row.blockedAt) return false;
  if (row.status !== 'invited' && row.status !== 'requested') return false;
  if (row.status === 'requested' && peer.suspendedAt) return false;
  return !link.revokedAt && link.expiresAt.getTime() > Date.now();
}

async function pairRows(tx: Tx, a: string, b: string) {
  const [mine] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.ownerUserId, a), eq(contacts.peerUserId, b)));
  const [theirs] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.ownerUserId, b), eq(contacts.peerUserId, a)));
  return { mine, theirs };
}

/** Invite by handle: creates my `invited` row and the peer's `requested` row (or accepts a pending request). */
export async function inviteContact(tx: Tx, ownerUserId: string, rawHandle: string): Promise<ContactView> {
  await requirePairedAgent(tx, ownerUserId);
  const peer = await getUserByHandle(tx, rawHandle);
  if (!peer) throw new AgentDropError('NOT_FOUND', 'no user with that handle');
  if (peer.id === ownerUserId) throw new AgentDropError('VALIDATION_FAILED', 'you cannot invite yourself');
  const { mine, theirs } = await pairRows(tx, ownerUserId, peer.id);
  if (mine?.blockedAt || theirs?.blockedAt) throw new AgentDropError('BLOCKED', 'invitation not possible');
  if (mine?.status === 'accepted' && theirs?.status === 'accepted')
    return contactView(tx, ownerUserId, peer.id);
  if (peer.isSystem) {
    // the assistant has nobody to accept for it: re-adding it after a removal takes effect at once
    await addAssistantContact(tx, ownerUserId, peer.id);
    await bumpDirectoryRevision(tx, [ownerUserId, peer.id]);
    await recordAudit(tx, {
      actorUserId: ownerUserId,
      action: 'contact.invite',
      targetId: peer.id,
      result: 'ok',
    });
    return contactView(tx, ownerUserId, peer.id);
  }
  // Already asked and still waiting: asking again must not notify them again, or a loop becomes a flood.
  if (mine?.status === 'invited' && theirs?.status === 'requested')
    return contactView(tx, ownerUserId, peer.id);
  if (mine?.status === 'requested' && theirs?.status === 'invited') {
    return acceptContact(tx, ownerUserId, peer.id);
  }
  const now = new Date();
  // a request asked by handle is a fresh one: whatever link an earlier request came from no longer applies (ADR 0034)
  if (!mine) {
    await tx.insert(contacts).values({ ownerUserId, peerUserId: peer.id, status: 'invited' });
  } else {
    await tx
      .update(contacts)
      .set({ status: 'invited', inviteLinkId: null, updatedAt: now, version: sql`${contacts.version} + 1` })
      .where(eq(contacts.id, mine.id));
  }
  if (!theirs) {
    await tx
      .insert(contacts)
      .values({ ownerUserId: peer.id, peerUserId: ownerUserId, status: 'requested', updatedAt: now });
  } else {
    await tx
      .update(contacts)
      .set({ status: 'requested', inviteLinkId: null, updatedAt: now, version: sql`${contacts.version} + 1` })
      .where(eq(contacts.id, theirs.id));
  }
  await bumpDirectoryRevision(tx, [ownerUserId, peer.id]);
  const me = await getUserById(tx, ownerUserId);
  await enqueueOutbox(tx, 'contact.requested', peer.id, {
    user_id: peer.id,
    from_handle: me?.handle ?? '',
    from_display_name: me?.displayName ?? '',
  });
  await recordAudit(tx, {
    actorUserId: ownerUserId,
    action: 'contact.invite',
    targetId: peer.id,
    result: 'ok',
  });
  return contactView(tx, ownerUserId, peer.id);
}

export async function acceptContact(tx: Tx, ownerUserId: string, peerUserId: string): Promise<ContactView> {
  await requirePairedAgent(tx, ownerUserId);
  const { mine, theirs } = await pairRows(tx, ownerUserId, peerUserId);
  if (!mine || !theirs) throw new AgentDropError('NOT_FOUND', 'no pending invitation');
  if (mine.blockedAt || theirs.blockedAt) throw new AgentDropError('BLOCKED', 'invitation not possible');
  if (mine.status === 'accepted' && theirs.status === 'accepted')
    return contactView(tx, ownerUserId, peerUserId);
  if (mine.status !== 'requested' || theirs.status !== 'invited')
    throw new AgentDropError('VALIDATION_FAILED', 'nothing to accept');
  const now = new Date();
  await tx
    .update(contacts)
    .set({ status: 'accepted', updatedAt: now, version: sql`${contacts.version} + 1` })
    .where(eq(contacts.id, mine.id));
  await tx
    .update(contacts)
    .set({ status: 'accepted', updatedAt: now, version: sql`${contacts.version} + 1` })
    .where(eq(contacts.id, theirs.id));
  await bumpDirectoryRevision(tx, [ownerUserId, peerUserId]);
  const me = await getUserById(tx, ownerUserId);
  await enqueueOutbox(tx, 'contact.accepted', peerUserId, {
    user_id: peerUserId,
    from_handle: me?.handle ?? '',
    from_display_name: me?.displayName ?? '',
  });
  await recordAudit(tx, {
    actorUserId: ownerUserId,
    action: 'contact.accept',
    targetId: peerUserId,
    result: 'ok',
  });
  return contactView(tx, ownerUserId, peerUserId);
}

/** Removes the relationship in both directions (invites included). Existing drops keep their grants. */
export async function removeContact(tx: Tx, ownerUserId: string, peerUserId: string): Promise<void> {
  const { mine, theirs } = await pairRows(tx, ownerUserId, peerUserId);
  if (mine) await tx.delete(contacts).where(eq(contacts.id, mine.id));
  if (theirs && !theirs.blockedAt) await tx.delete(contacts).where(eq(contacts.id, theirs.id));
  else if (theirs) {
    // Preserve their block, not a one-sided accepted relationship that would revive on unblock.
    await tx
      .update(contacts)
      .set({
        status: 'invited',
        inviteLinkId: null,
        autoApprove: false,
        updatedAt: new Date(),
        version: sql`${contacts.version} + 1`,
      })
      .where(eq(contacts.id, theirs.id));
  }
  await bumpDirectoryRevision(tx, [ownerUserId, peerUserId]);
  await recordAudit(tx, {
    actorUserId: ownerUserId,
    action: 'contact.remove',
    targetId: peerUserId,
    result: 'ok',
  });
}

/** Blocking keeps my row (so the block survives) and drops the peer's ability to send to me. */
export async function blockContact(
  tx: Tx,
  ownerUserId: string,
  peerUserId: string,
  blocked: boolean,
): Promise<void> {
  const { mine, theirs } = await pairRows(tx, ownerUserId, peerUserId);
  const now = new Date();
  if (!mine) {
    if (!blocked) return;
    await tx.insert(contacts).values({ ownerUserId, peerUserId, status: 'invited', blockedAt: now });
  } else if (!blocked && !theirs) {
    // An isolated row records only a block (a stranger, or a contact who removed us meanwhile).
    await tx.delete(contacts).where(eq(contacts.id, mine.id));
  } else {
    await tx
      .update(contacts)
      .set({ blockedAt: blocked ? now : null, updatedAt: now, version: sql`${contacts.version} + 1` })
      .where(eq(contacts.id, mine.id));
  }
  await bumpDirectoryRevision(tx, [ownerUserId, peerUserId]);
  await recordAudit(tx, {
    actorUserId: ownerUserId,
    action: blocked ? 'contact.block' : 'contact.unblock',
    targetId: peerUserId,
    result: 'ok',
  });
}

export interface ContactSettings {
  remark?: string | null;
  preferredRouteId?: string | null;
  autoApprove?: boolean;
  expectedVersion?: number;
}

/** Owner-private settings: remark, explicit send preference (a published route of the peer), approval policy. */
export async function updateContactSettings(
  tx: Tx,
  ownerUserId: string,
  peerUserId: string,
  input: ContactSettings,
): Promise<ContactView> {
  const { mine } = await pairRows(tx, ownerUserId, peerUserId);
  if (!mine) throw new AgentDropError('NOT_FOUND', 'contact not found');
  if (input.expectedVersion !== undefined && input.expectedVersion !== mine.version) {
    throw new AgentDropError('VERSION_CONFLICT', 'contact changed', { current_version: mine.version });
  }
  const patch: Partial<typeof contacts.$inferInsert> = {};
  if (input.remark !== undefined) {
    if (input.remark === null || input.remark.trim() === '') patch.remark = null;
    else {
      const parsed = remarkSchema.safeParse(input.remark);
      if (!parsed.success)
        throw new AgentDropError('VALIDATION_FAILED', 'invalid remark', { field: 'remark' });
      patch.remark = parsed.data;
    }
  }
  if (input.preferredRouteId !== undefined) {
    if (input.preferredRouteId === null) patch.preferredRouteId = null;
    else {
      const route = await tx.query.recipientRoutes.findFirst({
        where: and(eq(recipientRoutes.id, input.preferredRouteId), isNull(recipientRoutes.revokedAt)),
      });
      // automatic per-agent addresses are private (ADR 0013): only a published named entry can be remembered
      if (
        !route ||
        route.userId !== peerUserId ||
        route.isDefault ||
        route.auto ||
        route.visibility !== 'contacts'
      ) {
        throw new AgentDropError('ROUTE_UNAVAILABLE', 'that entry is not published by this contact');
      }
      patch.preferredRouteId = route.id;
    }
  }
  if (input.autoApprove !== undefined) patch.autoApprove = input.autoApprove;
  await tx
    .update(contacts)
    .set({ ...patch, updatedAt: new Date(), version: sql`${contacts.version} + 1` })
    .where(eq(contacts.id, mine.id));
  await bumpDirectoryRevision(tx, [ownerUserId]);
  await recordAudit(tx, {
    actorUserId: ownerUserId,
    action: 'contact.settings',
    targetId: peerUserId,
    result: 'ok',
    meta: { fields: Object.keys(patch).join(',') },
  });
  return contactView(tx, ownerUserId, peerUserId);
}

export async function contactView(tx: Tx, ownerUserId: string, peerUserId: string): Promise<ContactView> {
  const { mine, theirs } = await pairRows(tx, ownerUserId, peerUserId);
  const peer = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, peerUserId) });
  if (!peer) throw new AgentDropError('NOT_FOUND');
  return {
    contact_id: mine?.id ?? null,
    user_id: peer.id,
    handle: peer.handle,
    display_name: peer.displayName,
    // a block either way hides it: blocking me must not leave me reading their address
    public_email:
      mine?.status === 'accepted' && theirs?.status === 'accepted' && !mine.blockedAt && !theirs.blockedAt
        ? peer.publicEmail
        : null,
    is_system: peer.isSystem,
    remark: mine?.remark ?? null,
    status: mine ? (mine.blockedAt ? 'blocked' : mine.status) : 'group_only',
    preferred_route_id: mine?.preferredRouteId ?? null,
    auto_approve: mine?.autoApprove ?? false,
    version: mine?.version ?? 0,
    updated_at: mine?.updatedAt.toISOString() ?? null,
    from_invite_link: pendingFromLink(
      mine,
      mine?.inviteLinkId
        ? await tx.query.contactInviteLinks.findFirst({ where: eq(contactInviteLinks.id, mine.inviteLinkId) })
        : null,
      peer,
    ),
  };
}

export async function listContacts(tx: Tx, ownerUserId: string): Promise<ContactView[]> {
  const rows = await tx
    .select({
      c: contacts,
      u: appUsers,
      reciprocated: hasAcceptedPeerContact(),
      link: { expiresAt: contactInviteLinks.expiresAt, revokedAt: contactInviteLinks.revokedAt },
    })
    .from(contacts)
    .innerJoin(appUsers, eq(appUsers.id, contacts.peerUserId))
    .leftJoin(contactInviteLinks, eq(contactInviteLinks.id, contacts.inviteLinkId))
    .where(eq(contacts.ownerUserId, ownerUserId))
    .orderBy(sql`${contacts.updatedAt} desc`);
  const blocked = await blockedEitherWay(
    tx,
    ownerUserId,
    rows.map((r) => r.u.id),
  );
  return rows.map(({ c, u, reciprocated, link }) => ({
    contact_id: c.id,
    user_id: u.id,
    handle: u.handle,
    display_name: u.displayName,
    public_email: c.status === 'accepted' && reciprocated && !blocked.has(u.id) ? u.publicEmail : null,
    is_system: u.isSystem,
    remark: c.remark,
    status: c.blockedAt ? 'blocked' : c.status,
    preferred_route_id: c.preferredRouteId,
    auto_approve: c.autoApprove,
    version: c.version,
    updated_at: c.updatedAt.toISOString(),
    from_invite_link: pendingFromLink(c, link, u),
  }));
}

/**
 * Whether `senderUserId` may address `peerUserId`: self, an accepted and unblocked contact, or a shared active
 * group. The reason is returned so callers can map it to NOT_A_CONTACT / BLOCKED without leaking more.
 */
export async function canSendTo(
  tx: Tx,
  senderUserId: string,
  peerUserId: string,
): Promise<{ allowed: true } | { allowed: false; reason: 'NOT_A_CONTACT' | 'BLOCKED' }> {
  if (senderUserId === peerUserId) return { allowed: true };
  const { mine, theirs } = await pairRows(tx, senderUserId, peerUserId);
  if (theirs?.blockedAt || mine?.blockedAt) return { allowed: false, reason: 'BLOCKED' };
  if (mine?.status === 'accepted' && theirs?.status === 'accepted') return { allowed: true };
  const shared = await sharesActiveGroup(tx, senderUserId, peerUserId);
  if (shared) return { allowed: true };
  return { allowed: false, reason: 'NOT_A_CONTACT' };
}

export async function sharesActiveGroup(tx: Tx, a: string, b: string): Promise<boolean> {
  const rows = await tx.execute<{ one: number }>(sql`
    select 1 as one
    from ${groupMemberships} ma
    join ${groupMemberships} mb on mb.group_id = ma.group_id
    where ma.user_id = ${a} and mb.user_id = ${b}
      and ma.status = 'active' and mb.status = 'active'
    limit 1`);
  return rows.rows.length > 0;
}
