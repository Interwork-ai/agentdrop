import {
  type DirectoryEntry,
  type DirectoryLookupInput,
  type GroupCard,
  LIMITS,
  type PersonCard,
  searchKey,
} from '@agentdrop/contracts';
import {
  appUsers,
  contacts,
  groupBindings,
  groupMemberships,
  groups,
  recipientRoutes,
  type Tx,
} from '@agentdrop/db';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { MailboxScope } from '../principals.js';
import { publishedRoutesOf } from './routes.js';

interface Candidate {
  userId: string;
  handle: string;
  displayName: string;
  publicEmail: string | null;
  remark: string | null;
  status: PersonCard['contact_status'];
  preferredRouteId: string | null;
  recentAt: number;
  /** Either side blocked the other: the card keeps their name only, no email and no named entries. */
  blocked?: boolean;
}

/** A contact relationship exists in both directions; old isolated accepted rows never grant profile access. */
export function hasAcceptedPeerContact() {
  return sql<boolean>`exists (select 1 from ${contacts} peer_contact
    where peer_contact.owner_user_id = ${contacts.peerUserId}
      and peer_contact.peer_user_id = ${contacts.ownerUserId}
      and peer_contact.status = 'accepted')`;
}

/**
 * Authorized directory: my contacts, people sharing an active group with me, and my groups. Never a global user
 * list. People match on remark, nickname, @handle or published email. Display labels follow remark > nickname > @handle. When a non-empty query matches several entries with the
 * same label the result is flagged ambiguous so the agent asks the user instead of guessing.
 */
export async function directoryLookup(
  tx: Tx,
  scope: MailboxScope,
  input: DirectoryLookupInput,
): Promise<{ entries: DirectoryEntry[]; nextCursor: string | null; ambiguous: boolean }> {
  const limit = Math.min(input.limit ?? LIMITS.DIRECTORY_LIMIT_DEFAULT, LIMITS.DIRECTORY_LIMIT_MAX);
  const offset = decodeCursor(input.cursor);
  const q = input.query ? searchKey(input.query) : '';

  const people: Candidate[] = [];
  if (input.kind !== 'group') {
    // blocking hides profile details in both directions, whoever blocked whom
    const blocked = await blockedEitherWay(tx, scope.userId);
    const contactRows = await tx
      .select({ c: contacts, u: appUsers, reciprocated: hasAcceptedPeerContact() })
      .from(contacts)
      .innerJoin(appUsers, eq(appUsers.id, contacts.peerUserId))
      .where(eq(contacts.ownerUserId, scope.userId))
      .limit(500);
    const seen = new Set<string>();
    for (const { c, u, reciprocated } of contactRows) {
      // a person I blocked stays out, also as a group co-member below
      if (c.blockedAt) {
        seen.add(u.id);
        continue;
      }
      // pending invitations are managed on the contacts page; only accepted contacts get cards and routes
      if (c.status !== 'accepted' || !reciprocated) continue;
      seen.add(u.id);
      const theyBlockedMe = blocked.has(u.id);
      people.push({
        userId: u.id,
        handle: u.handle,
        displayName: u.displayName,
        publicEmail: theyBlockedMe ? null : u.publicEmail,
        remark: c.remark,
        status: c.status,
        preferredRouteId: c.preferredRouteId,
        recentAt: c.updatedAt.getTime(),
        blocked: theyBlockedMe,
      });
    }
    // people sharing an active group with me (group_only), excluding myself and existing contacts
    const shared = await tx.execute<{
      user_id: string;
      handle: string;
      display_name: string;
      public_email: string | null;
      joined_at: string;
    }>(sql`
      select distinct u.id as user_id, u.handle, u.display_name, u.public_email, max(mb.joined_at) as joined_at
      from ${groupMemberships} ma
      join ${groupMemberships} mb on mb.group_id = ma.group_id and mb.user_id <> ma.user_id
      join ${appUsers} u on u.id = mb.user_id
      where ma.user_id = ${scope.userId} and ma.status = 'active' and mb.status = 'active'
      group by u.id, u.handle, u.display_name, u.public_email
      limit 500`);
    for (const r of shared.rows) {
      // neither side can send to the other (canSendTo: BLOCKED), so they are no candidate either
      if (seen.has(r.user_id) || blocked.has(r.user_id)) continue;
      people.push({
        userId: r.user_id,
        handle: r.handle,
        displayName: r.display_name,
        publicEmail: r.public_email,
        remark: null,
        status: 'group_only',
        preferredRouteId: null,
        recentAt: r.joined_at ? new Date(r.joined_at).getTime() : 0,
      });
    }
  }

  const groupCards: GroupCard[] = [];
  if (input.kind !== 'person') {
    const rows = await tx
      .select({
        g: groups,
        m: groupMemberships,
        memberCount: sql<number>`(select count(*)::int from ${groupMemberships} x where x.group_id = ${groups.id} and x.status = 'active')`,
        receives: sql<boolean>`exists(select 1 from ${groupBindings} b where b.membership_id = ${groupMemberships.id} and b.h_id = ${scope.hId} and b.revoked_at is null)`,
      })
      .from(groupMemberships)
      .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
      .where(and(eq(groupMemberships.userId, scope.userId), eq(groupMemberships.status, 'active')))
      .limit(500);
    const matched = rows.filter(({ g, m }) => {
      const keys = [g.displayName, g.slug, m.nickname ?? ''].map(searchKey);
      return !q || keys.some((k) => k.includes(q));
    });
    const rosters = await activeRosters(
      tx,
      scope.userId,
      matched.map(({ g }) => g.id),
    );
    for (const { g, m, memberCount, receives } of matched) {
      groupCards.push({
        kind: 'group',
        group_id: g.id,
        slug: g.slug,
        display_name: g.displayName,
        my_nickname: m.nickname,
        member_count: memberCount,
        active_members: rosters.get(g.id) ?? [],
        current_h_receives: receives,
        target: { type: 'group', group_id: g.id },
      });
    }
  }

  const matchedPeople = people
    .filter((p) => {
      if (!q) return true;
      const keys = [p.remark ?? '', p.displayName, p.handle, `@${p.handle}`, p.publicEmail ?? ''].map(
        searchKey,
      );
      return keys.some((k) => k.includes(q));
    })
    .sort((a, b) => b.recentAt - a.recentAt);

  // Build person cards with default target resolution (preference > peer default)
  const personCards: PersonCard[] = [];
  for (const p of matchedPeople) {
    personCards.push(await personCard(tx, p));
  }

  const all: DirectoryEntry[] = [...personCards, ...groupCards];
  const page = all.slice(offset, offset + limit);
  const nextCursor = offset + limit < all.length ? encodeCursor(offset + limit) : null;

  let ambiguous = false;
  if (q) {
    const labels = new Map<string, number>();
    for (const e of all) {
      const label = searchKey(e.kind === 'person' ? e.display_label : e.display_name);
      labels.set(label, (labels.get(label) ?? 0) + 1);
    }
    ambiguous = [...labels.values()].some((n) => n > 1);
  }
  return { entries: page, nextCursor, ambiguous };
}

/**
 * Active members of groups the viewer is an active member of, so an agent can say who a group reaches and whom
 * to address. Labels follow the viewer: my remark > their group nickname > their nickname > @handle.
 */
async function activeRosters(
  tx: Tx,
  viewerUserId: string,
  groupIds: string[],
): Promise<Map<string, NonNullable<GroupCard['active_members']>>> {
  const out = new Map<string, NonNullable<GroupCard['active_members']>>();
  if (groupIds.length === 0) return out;
  const rows = await tx
    .select({ m: groupMemberships, u: appUsers })
    .from(groupMemberships)
    .innerJoin(appUsers, eq(appUsers.id, groupMemberships.userId))
    .where(and(inArray(groupMemberships.groupId, groupIds), eq(groupMemberships.status, 'active')))
    .orderBy(groupMemberships.joinedAt);
  const remarks = await remarksFor(
    tx,
    viewerUserId,
    rows.map((r) => r.u.id),
  );
  const blocked = await blockedEitherWay(
    tx,
    viewerUserId,
    rows.map((r) => r.u.id),
  );
  for (const { m, u } of rows) {
    const list = out.get(m.groupId) ?? [];
    list.push({
      handle: u.handle,
      display_label: remarks.get(u.id) ?? m.nickname ?? u.displayName ?? `@${u.handle}`,
      role: m.role,
      public_email: blocked.has(u.id) ? null : u.publicEmail,
    });
    out.set(m.groupId, list);
  }
  return out;
}

/**
 * What I see of another person: who they are and the named entries they chose to publish. Never their agents —
 * not their names, harnesses or how many there are (ADR 0013); a plain send goes where the recipient decided.
 */
export async function personCard(tx: Tx, p: Candidate): Promise<PersonCard> {
  const displayLabel = p.remark || p.displayName || `@${p.handle}`;
  // named entries are for accepted contacts only; people I merely share a group with cannot be sent to anyway,
  // and neither can anyone on either side of a block
  const published = p.status === 'accepted' && !p.blocked ? await publishedRoutesOf(tx, p.userId) : [];
  const alternatives = published.map((r) => ({
    route_id: r.id,
    alias: r.alias ?? '',
    label: r.label,
    // the field is required by older bridges; 'other' discloses nothing about the agent behind the entry
    harness_key: 'other' as const,
    auto: false,
    target: { type: 'route' as const, route_id: r.id },
  }));
  let preferenceApplied = false;
  let preferenceProblem: PersonCard['preference_problem'] = null;
  let remembered: (typeof published)[number] | undefined;
  if (p.preferredRouteId) {
    remembered = published.find((a) => a.id === p.preferredRouteId);
    if (remembered) preferenceApplied = true;
    // a remembered automatic address is no longer something I can see or choose: sends follow the person again
    else if (!(await isAutoRoute(tx, p.preferredRouteId))) preferenceProblem = 'PREFERRED_ROUTE_UNAVAILABLE';
  }
  const defaultLabel = preferenceProblem
    ? 'remembered entry unavailable: choose explicitly'
    : remembered
      ? `${remembered.label} @${p.handle}/${remembered.alias ?? ''} (remembered)`
      : `@${p.handle} (they decide which of their agents receive it)`;
  return {
    kind: 'person',
    user_id: p.userId,
    handle: p.handle,
    display_label: displayLabel,
    display_name: p.displayName,
    remark: p.remark,
    public_email: p.blocked ? null : p.publicEmail,
    default_target: { type: 'user', user_id: p.userId },
    default_target_label: defaultLabel,
    default_endpoint: null,
    preference_applied: preferenceApplied,
    preference_problem: preferenceProblem,
    alternatives,
    contact_status: p.status,
  };
}

async function isAutoRoute(tx: Tx, routeId: string): Promise<boolean> {
  const r = await tx.query.recipientRoutes.findFirst({ where: eq(recipientRoutes.id, routeId) });
  return r?.auto === true;
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

export async function viewerDisplayLabelFor(
  tx: Tx,
  viewerUserId: string,
  authorUserId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ remark: contacts.remark })
    .from(contacts)
    .where(
      and(
        eq(contacts.ownerUserId, viewerUserId),
        eq(contacts.peerUserId, authorUserId),
        isNull(contacts.blockedAt),
      ),
    );
  return rows[0]?.remark ?? null;
}

/**
 * People on either side of a block with the viewer: the viewer blocked them, or they blocked the viewer. Blocking
 * hides profile details (public email, named entries, email search) both ways, as sending already is (`canSendTo`).
 * Without `peerIds`, every such person.
 */
export async function blockedEitherWay(
  tx: Tx,
  viewerUserId: string,
  peerIds?: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = peerIds ? [...new Set(peerIds)].filter((id) => id !== viewerUserId) : undefined;
  if (ids && ids.length === 0) return out;
  const rows = await tx
    .select({ owner: contacts.ownerUserId, peer: contacts.peerUserId })
    .from(contacts)
    .where(
      and(
        isNotNull(contacts.blockedAt),
        or(
          and(eq(contacts.ownerUserId, viewerUserId), ...(ids ? [inArray(contacts.peerUserId, ids)] : [])),
          and(eq(contacts.peerUserId, viewerUserId), ...(ids ? [inArray(contacts.ownerUserId, ids)] : [])),
        ),
      ),
    );
  for (const r of rows) out.add(r.owner === viewerUserId ? r.peer : r.owner);
  return out;
}

/**
 * Of `peerIds`: who the viewer already sees as a person (ADR 0012) — accepted contacts and active co-members of a
 * group, nobody on either side of a block — and who is on either side of a block with the viewer.
 */
export async function profileVisibility(
  tx: Tx,
  viewerUserId: string,
  peerIds: string[],
): Promise<{ related: Set<string>; blocked: Set<string> }> {
  const related = new Set<string>();
  const ids = [...new Set(peerIds)].filter((id) => id !== viewerUserId);
  if (ids.length === 0) return { related, blocked: new Set() };
  const accepted = await tx
    .select({ peer: contacts.peerUserId })
    .from(contacts)
    .where(
      and(
        eq(contacts.ownerUserId, viewerUserId),
        eq(contacts.status, 'accepted'),
        hasAcceptedPeerContact(),
        inArray(contacts.peerUserId, ids),
      ),
    );
  const shared = await tx.execute<{ user_id: string }>(sql`
    select distinct mb.user_id
    from ${groupMemberships} ma
    join ${groupMemberships} mb on mb.group_id = ma.group_id
    where ma.user_id = ${viewerUserId} and ma.status = 'active' and mb.status = 'active'
      and mb.user_id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`);
  const blocked = await blockedEitherWay(tx, viewerUserId, ids);
  for (const r of accepted) related.add(r.peer);
  for (const r of shared.rows) related.add(r.user_id);
  for (const id of blocked) related.delete(id);
  return { related, blocked };
}

export async function remarksFor(
  tx: Tx,
  viewerUserId: string,
  authorUserIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ids = [...new Set(authorUserIds)];
  if (ids.length === 0) return map;
  const rows = await tx
    .select({ peer: contacts.peerUserId, remark: contacts.remark })
    .from(contacts)
    .where(and(eq(contacts.ownerUserId, viewerUserId), inArray(contacts.peerUserId, ids)));
  for (const r of rows) if (r.remark) map.set(r.peer, r.remark);
  return map;
}
