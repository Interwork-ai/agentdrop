import { AgentDropError } from '@agentdrop/contracts';
import { appUsers, contactInviteLinks, contacts, harnessEndpoints, type Tx } from '@agentdrop/db';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { generateDeviceCode, hashToken } from '../crypto.js';
import { bumpDirectoryRevision, requirePairedAgent } from '../identity/users.js';
import { enqueueOutbox } from '../mailbox/outbox.js';
import { type ContactView, contactView } from './contacts.js';

/**
 * Shareable contact links: whoever opens one (signed in, or while signing up) becomes an accepted contact of its
 * owner right away, or, without a paired agent yet, receives a contact request from the owner (ADR 0014) that their
 * first pairing accepts on its own (ADR 0034). Reusable until it expires or is revoked. Only the sha256 of the token
 * is stored, so the plain link is shown once, at creation.
 */
export const INVITE_LINK_TTL_MS = 7 * 24 * 3600 * 1000;
export const MAX_ACTIVE_INVITE_LINKS = 5;

export interface InviteLinkView {
  link_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  use_count: number;
  status: 'active' | 'expired' | 'revoked';
}

export interface CreatedInviteLink extends InviteLinkView {
  /** Plain token: returned once, never stored. */
  token: string;
}

export interface InviteLinkPreview {
  valid: boolean;
  /** Why the link cannot be used any more; null while it is valid. */
  reason: 'expired' | 'revoked' | null;
  inviter: { handle: string; display_name: string };
  expires_at: string;
}

function statusOf(row: typeof contactInviteLinks.$inferSelect, now = Date.now()): InviteLinkView['status'] {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt.getTime() <= now) return 'expired';
  return 'active';
}

function toView(row: typeof contactInviteLinks.$inferSelect): InviteLinkView {
  return {
    link_id: row.id,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
    use_count: row.useCount,
    status: statusOf(row),
  };
}

/** Tokens are base64url; anything else is rejected before it reaches the database. */
function tokenHashOf(token: string): string {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) throw new AgentDropError('NOT_FOUND', 'invite link not found');
  return hashToken(token);
}

export async function createInviteLink(tx: Tx, userId: string): Promise<CreatedInviteLink> {
  await requirePairedAgent(tx, userId);
  // serialize per owner so two tabs cannot both slip under the active-link limit
  const [owner] = await tx
    .select({ id: appUsers.id, isSystem: appUsers.isSystem })
    .from(appUsers)
    .where(eq(appUsers.id, userId))
    .for('update');
  if (!owner || owner.isSystem) throw new AgentDropError('UNAUTHORIZED');
  const [active] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(contactInviteLinks)
    .where(
      and(
        eq(contactInviteLinks.ownerUserId, userId),
        isNull(contactInviteLinks.revokedAt),
        gt(contactInviteLinks.expiresAt, new Date()),
      ),
    );
  if ((active?.count ?? 0) >= MAX_ACTIVE_INVITE_LINKS)
    throw new AgentDropError(
      'VALIDATION_FAILED',
      `at most ${MAX_ACTIVE_INVITE_LINKS} active invite links; revoke one first`,
      { limit: MAX_ACTIVE_INVITE_LINKS },
    );
  const token = generateDeviceCode();
  const [row] = await tx
    .insert(contactInviteLinks)
    .values({
      ownerUserId: userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + INVITE_LINK_TTL_MS),
    })
    .returning();
  if (!row) throw new AgentDropError('INTERNAL');
  await recordAudit(tx, {
    actorUserId: userId,
    action: 'invite_link.create',
    targetId: row.id,
    result: 'ok',
  });
  return { ...toView(row), token };
}

export async function listInviteLinks(tx: Tx, userId: string): Promise<InviteLinkView[]> {
  const rows = await tx
    .select()
    .from(contactInviteLinks)
    .where(eq(contactInviteLinks.ownerUserId, userId))
    .orderBy(desc(contactInviteLinks.createdAt))
    .limit(50);
  return rows.map(toView);
}

export async function revokeInviteLink(tx: Tx, userId: string, linkId: string): Promise<InviteLinkView> {
  const row = await tx.query.contactInviteLinks.findFirst({ where: eq(contactInviteLinks.id, linkId) });
  if (!row || row.ownerUserId !== userId) throw new AgentDropError('NOT_FOUND', 'invite link not found');
  if (row.revokedAt) return toView(row);
  const [updated] = await tx
    .update(contactInviteLinks)
    .set({ revokedAt: new Date() })
    .where(eq(contactInviteLinks.id, linkId))
    .returning();
  if (!updated) throw new AgentDropError('INTERNAL');
  await recordAudit(tx, {
    actorUserId: userId,
    action: 'invite_link.revoke',
    targetId: linkId,
    result: 'ok',
  });
  return toView(updated);
}

/** Public: who is inviting and whether the link still works. Unknown tokens are NOT_FOUND. */
export async function previewInviteLink(tx: Tx, token: string): Promise<InviteLinkPreview> {
  const hash = tokenHashOf(token);
  const [row] = await tx
    .select({ link: contactInviteLinks, owner: appUsers })
    .from(contactInviteLinks)
    .innerJoin(appUsers, eq(appUsers.id, contactInviteLinks.ownerUserId))
    .where(eq(contactInviteLinks.tokenHash, hash))
    .limit(1);
  if (!row || row.owner.deletedAt) throw new AgentDropError('NOT_FOUND', 'invite link not found');
  const status = statusOf(row.link);
  // a suspended inviter cannot use the contact, so the link is as good as revoked
  const reason = status === 'active' ? (row.owner.suspendedAt ? 'revoked' : null) : status;
  return {
    valid: reason === null,
    reason,
    inviter: { handle: row.owner.handle, display_name: row.owner.displayName },
    expires_at: row.link.expiresAt.toISOString(),
  };
}

export interface AcceptInviteLinkResult {
  contact: ContactView;
  /** False when the two were already contacts, or when the link only left a pending request (see `pending`). */
  created: boolean;
  /**
   * True when the accepter has no paired agent yet (ADR 0014): the link owner's contact request is waiting on the
   * accepter's Contacts page instead, and they accept it once an agent is paired. `contact.status` is 'requested'.
   */
  pending: boolean;
}

/** Whether the user has at least one live paired agent (the condition `requirePairedAgent` enforces). */
async function hasPairedAgent(tx: Tx, userId: string): Promise<boolean> {
  const [live] = await tx
    .select({ id: harnessEndpoints.id })
    .from(harnessEndpoints)
    .where(and(eq(harnessEndpoints.userId, userId), isNull(harnessEndpoints.revokedAt)))
    .limit(1);
  return !!live;
}

/**
 * Makes `userId` and the link owner accepted contacts in both directions. Refuses expired or revoked links, the
 * owner's own link and any pair where either side blocked the other; an existing accepted pair is a no-op.
 *
 * Without a paired agent the accepter cannot form a relationship yet (ADR 0014). The link is then turned into
 * server state: a contact request from the link owner to the accepter, the same rows an invitation by handle
 * creates (owner `invited`, accepter `requested`). It waits on the accepter's Contacts page, in any browser, until
 * they pair an agent and accept it there; a second use of the link is a no-op.
 */
export async function acceptInviteLink(
  tx: Tx,
  userId: string,
  token: string,
): Promise<AcceptInviteLinkResult> {
  const hash = tokenHashOf(token);
  const [link] = await tx
    .select()
    .from(contactInviteLinks)
    .where(eq(contactInviteLinks.tokenHash, hash))
    .for('update');
  if (!link) throw new AgentDropError('NOT_FOUND', 'invite link not found');
  const status = statusOf(link);
  if (status !== 'active')
    throw new AgentDropError('VALIDATION_FAILED', `this invite link is ${status}`, { reason: status });
  const ownerId = link.ownerUserId;
  if (ownerId === userId)
    throw new AgentDropError('VALIDATION_FAILED', 'this is your own invite link', { reason: 'self' });
  const owner = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, ownerId) });
  if (!owner || owner.deletedAt) throw new AgentDropError('NOT_FOUND', 'invite link not found');
  if (owner.suspendedAt)
    throw new AgentDropError('VALIDATION_FAILED', 'this invite link is revoked', { reason: 'revoked' });

  // lock whatever rows exist so a concurrent block or removal of this pair waits for us
  const pair = await tx
    .select()
    .from(contacts)
    .where(
      sql`(${contacts.ownerUserId} = ${userId} and ${contacts.peerUserId} = ${ownerId})
       or (${contacts.ownerUserId} = ${ownerId} and ${contacts.peerUserId} = ${userId})`,
    )
    .orderBy(contacts.id)
    .for('update');
  const mine = pair.find((c) => c.ownerUserId === userId);
  const theirs = pair.find((c) => c.ownerUserId === ownerId);
  if (mine?.blockedAt || theirs?.blockedAt) throw new AgentDropError('BLOCKED', 'invitation not possible');
  if (mine?.status === 'accepted' && theirs?.status === 'accepted')
    return { contact: await contactView(tx, userId, ownerId), created: false, pending: false };
  // the owner already asked this person (by this link or by handle): nothing new to record or announce
  const alreadyRequested = mine?.status === 'requested' && theirs?.status === 'invited';

  const now = new Date();
  if (!(await hasPairedAgent(tx, userId))) {
    if (alreadyRequested) {
      // The owner already asked (by handle, or by this or another link). Opening the link is the person saying yes,
      // so a request that has no link yet takes this one: their first pairing accepts it (ADR 0034).
      if (!mine.inviteLinkId || !theirs.inviteLinkId)
        await tx
          .update(contacts)
          .set({ inviteLinkId: link.id })
          .where(and(inArray(contacts.id, [mine.id, theirs.id]), isNull(contacts.inviteLinkId)));
      return { contact: await contactView(tx, userId, ownerId), created: false, pending: true };
    }
    // The owner's link is their invitation: record it as one, pointing at the accepter, with the link it came from
    // so that the accepter's first pairing accepts it (ADR 0034).
    for (const [row, ownerUserId, peerUserId, rowStatus] of [
      [theirs, ownerId, userId, 'invited'],
      [mine, userId, ownerId, 'requested'],
    ] as const) {
      if (row) {
        await tx
          .update(contacts)
          .set({
            status: rowStatus,
            inviteLinkId: link.id,
            ...(row.status !== rowStatus ? { updatedAt: now, version: sql`${contacts.version} + 1` } : {}),
          })
          .where(eq(contacts.id, row.id));
      } else {
        await tx
          .insert(contacts)
          .values({ ownerUserId, peerUserId, status: rowStatus, inviteLinkId: link.id, updatedAt: now })
          .onConflictDoNothing({ target: [contacts.ownerUserId, contacts.peerUserId] });
      }
    }
    await tx
      .update(contactInviteLinks)
      .set({ useCount: sql`${contactInviteLinks.useCount} + 1` })
      .where(eq(contactInviteLinks.id, link.id));
    await bumpDirectoryRevision(tx, [userId, ownerId]);
    await enqueueOutbox(tx, 'contact.requested', userId, {
      user_id: userId,
      from_handle: owner.handle,
      from_display_name: owner.displayName,
    });
    await recordAudit(tx, {
      actorUserId: userId,
      action: 'invite_link.accept',
      targetId: link.id,
      result: 'ok',
      meta: { owner_user_id: ownerId, pending: true },
    });
    return { contact: await contactView(tx, userId, ownerId), created: false, pending: true };
  }

  for (const [row, ownerUserId, peerUserId] of [
    [mine, userId, ownerId],
    [theirs, ownerId, userId],
  ] as const) {
    if (row) {
      await tx
        .update(contacts)
        .set({ status: 'accepted', updatedAt: now, version: sql`${contacts.version} + 1` })
        .where(eq(contacts.id, row.id));
    } else {
      // a concurrent accept of the other side's link may have inserted it meanwhile
      await tx
        .insert(contacts)
        .values({ ownerUserId, peerUserId, status: 'accepted', updatedAt: now })
        .onConflictDoUpdate({
          target: [contacts.ownerUserId, contacts.peerUserId],
          set: { status: 'accepted', updatedAt: now, version: sql`${contacts.version} + 1` },
        });
    }
  }
  // a request this link left while the accepter had no agent was already counted
  if (!alreadyRequested)
    await tx
      .update(contactInviteLinks)
      .set({ useCount: sql`${contactInviteLinks.useCount} + 1` })
      .where(eq(contactInviteLinks.id, link.id));
  await bumpDirectoryRevision(tx, [userId, ownerId]);
  const me = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, userId) });
  await enqueueOutbox(tx, 'contact.accepted', ownerId, {
    user_id: ownerId,
    from_handle: me?.handle ?? '',
    from_display_name: me?.displayName ?? '',
  });
  await recordAudit(tx, {
    actorUserId: userId,
    action: 'invite_link.accept',
    targetId: link.id,
    result: 'ok',
    meta: { owner_user_id: ownerId },
  });
  return { contact: await contactView(tx, userId, ownerId), created: true, pending: false };
}

/**
 * ADR 0034: called when `userId` pairs an agent (in the pairing approval's transaction). Every contact request still
 * waiting from an invite link they opened without an agent is accepted now, as if they had clicked Accept, and the
 * link's owner is told the usual way (`contact.accepted`, naming the person only, ADR 0013). A request is accepted
 * only while its link is still live (not expired or revoked, owner not suspended or deleted) and neither side has
 * blocked the other; anything else stays pending for the person to decide on Contacts. Requests made by handle
 * carry no link and are left as they are. Idempotent: a later pairing finds nothing left to accept.
 */
export async function acceptInviteRequestsOnPairing(tx: Tx, userId: string): Promise<number> {
  const waiting = await tx
    .select({ peerUserId: contacts.peerUserId })
    .from(contacts)
    .where(
      and(
        eq(contacts.ownerUserId, userId),
        eq(contacts.status, 'requested'),
        sql`${contacts.inviteLinkId} is not null`,
      ),
    )
    .orderBy(contacts.peerUserId);
  if (waiting.length === 0) return 0;
  const me = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, userId) });
  if (!me || me.deletedAt || me.suspendedAt) return 0;
  let accepted = 0;
  for (const { peerUserId: ownerId } of waiting) {
    const pair = await tx
      .select()
      .from(contacts)
      .where(
        sql`(${contacts.ownerUserId} = ${userId} and ${contacts.peerUserId} = ${ownerId})
         or (${contacts.ownerUserId} = ${ownerId} and ${contacts.peerUserId} = ${userId})`,
      )
      .orderBy(contacts.id)
      .for('update');
    const mine = pair.find((c) => c.ownerUserId === userId);
    const theirs = pair.find((c) => c.ownerUserId === ownerId);
    if (!mine?.inviteLinkId || mine.status !== 'requested' || theirs?.status !== 'invited') continue;
    if (mine.blockedAt || theirs.blockedAt) continue;
    const link = await tx.query.contactInviteLinks.findFirst({
      where: eq(contactInviteLinks.id, mine.inviteLinkId),
    });
    if (!link || link.ownerUserId !== ownerId || statusOf(link) !== 'active') continue;
    const owner = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, ownerId) });
    if (!owner || owner.deletedAt || owner.suspendedAt) continue;
    const now = new Date();
    await tx
      .update(contacts)
      .set({ status: 'accepted', updatedAt: now, version: sql`${contacts.version} + 1` })
      .where(inArray(contacts.id, [mine.id, theirs.id]));
    await bumpDirectoryRevision(tx, [userId, ownerId]);
    await enqueueOutbox(tx, 'contact.accepted', ownerId, {
      user_id: ownerId,
      from_handle: me.handle,
      from_display_name: me.displayName,
    });
    await recordAudit(tx, {
      actorUserId: userId,
      action: 'invite_link.accept',
      targetId: link.id,
      result: 'ok',
      meta: { owner_user_id: ownerId, on_pairing: true },
    });
    accepted++;
  }
  return accepted;
}
