import { AgentDropError, type GroupFile } from '@agentdrop/contracts';
import {
  appUsers,
  attachments,
  deliveries,
  dropAttachments,
  drops,
  groupMemberships,
  groups,
  type Tx,
} from '@agentdrop/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getGroupStorageQuota } from '../admin/settings.js';
import { recordAudit } from '../audit.js';
import { remarksFor } from '../contacts/directory.js';
import { openAttachmentMeta } from '../content/codec.js';
import { hasValidGrant } from '../mailbox/authorization.js';
import { enqueueOutbox } from '../mailbox/outbox.js';
import { bumpMailboxes, type MailboxEventInput } from '../mailbox/revision.js';

/*
 * A group's file space (ADR 0029). What a group stores is the bytes of the files still kept for drops sent to it:
 * every `ready` attachment linked to a drop whose frozen `target_snapshot.group_ids` names the group. A drop sent to
 * two groups counts its files in each. Nothing is ever removed on its own: a
 * send that would go past the limit is refused, and the group's owner and admins remove files to make room.
 */

export interface GroupStorage {
  used_bytes: number;
  limit_bytes: number;
}

/** SQL condition on `drops`: sent to this group (containment on the GIN-indexed snapshot). */
function sentToGroup(groupId: string) {
  return sql`${drops.targetSnapshot} @> ${JSON.stringify({ group_ids: [groupId] })}::jsonb`;
}

/** Ids of the files linked to live drops sent to this group (a subquery). */
function groupFileIds(tx: Tx, groupId: string) {
  return tx
    .select({ id: dropAttachments.attachmentId })
    .from(dropAttachments)
    .innerJoin(drops, eq(drops.id, dropAttachments.dropId))
    .where(and(sentToGroup(groupId), isNull(drops.revokedAt)));
}

/** Bytes the group stores now: each ready file of a drop sent to it, once. */
export async function groupStorageUsed(tx: Tx, groupId: string): Promise<number> {
  const rows = await tx
    .select({ sum: sql<string>`coalesce(sum(${attachments.byteSize}), 0)::bigint` })
    .from(attachments)
    .where(and(eq(attachments.status, 'ready'), inArray(attachments.id, groupFileIds(tx, groupId))));
  return Number(rows[0]?.sum ?? 0);
}

export async function groupStorage(tx: Tx, groupId: string): Promise<GroupStorage> {
  const [used, limit] = await Promise.all([groupStorageUsed(tx, groupId), getGroupStorageQuota(tx)]);
  return { used_bytes: used, limit_bytes: limit };
}

/**
 * Refuses a send whose files would push the group past its limit (GROUP_STORAGE_FULL). The caller must hold the
 * group row lock (`for update`) in the same transaction: every send to the group and every removal take that lock
 * first, so the usage read here (a fresh READ COMMITTED snapshot taken after the lock was granted) already includes
 * whatever a competing send committed, and two sends can never both fit into the same remaining space.
 * Only the sender's own uploads count (others are refused later as ATTACHMENT_NOT_OWNED); a file belongs to one
 * drop only (drop_attachments_attachment_uq), so nothing sent now is already counted. A drop without files is never
 * refused.
 */
export async function assertGroupStorageFits(
  tx: Tx,
  groupId: string,
  originHId: string,
  attachmentIds: string[],
): Promise<void> {
  if (attachmentIds.length === 0) return;
  const added = await tx
    .select({ sum: sql<string>`coalesce(sum(${attachments.byteSize}), 0)::bigint` })
    .from(attachments)
    .where(
      and(
        inArray(attachments.id, [...new Set(attachmentIds)]),
        eq(attachments.uploadedByHId, originHId),
        eq(attachments.status, 'ready'),
      ),
    );
  const bytes = Number(added[0]?.sum ?? 0);
  if (bytes === 0) return;
  const { used_bytes: used, limit_bytes: limit } = await groupStorage(tx, groupId);
  if (used + bytes > limit)
    throw new AgentDropError('GROUP_STORAGE_FULL', "the group's file space would be exceeded", {
      group_id: groupId,
      used,
      limit,
      bytes,
    });
}

async function requireGroupAdmin(tx: Tx, groupId: string, userId: string) {
  const m = await tx.query.groupMemberships.findFirst({
    where: and(
      eq(groupMemberships.groupId, groupId),
      eq(groupMemberships.userId, userId),
      eq(groupMemberships.status, 'active'),
    ),
  });
  if (!m) throw new AgentDropError('NOT_FOUND', 'group not found');
  if (m.role !== 'owner' && m.role !== 'admin') throw new AgentDropError('FORBIDDEN', 'admin role required');
  return m;
}

const GROUP_FILES_MAX = 200;

/**
 * The files a group stores, largest first (at most 200), for its owner and admins to choose what to remove. Who
 * sent each file is named as the viewer knows that person (remark, nickname or @handle), never by agent (ADR 0013).
 */
export async function listGroupFiles(
  tx: Tx,
  userId: string,
  groupId: string,
): Promise<{ storage: GroupStorage; files: GroupFile[] }> {
  const group = await tx.query.groups.findFirst({ where: eq(groups.id, groupId) });
  if (!group) throw new AgentDropError('NOT_FOUND', 'group not found');
  await requireGroupAdmin(tx, groupId, userId);
  const rows = await tx.execute<{
    attachment_id: string;
    drop_id: string;
    author_user_id: string;
    created_at: string;
    byte_size: string;
  }>(sql`
    select f.attachment_id, f.drop_id, f.author_user_id, f.created_at, f.byte_size from (
      select distinct on (a.id) a.id as attachment_id, d.id as drop_id, d.author_user_id,
        to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
        d.created_at as sort_at, a.byte_size
      from ${attachments} a
      join ${dropAttachments} da on da.attachment_id = a.id
      join ${drops} d on d.id = da.drop_id
      where a.status = 'ready' and d.revoked_at is null
        and d.target_snapshot @> ${JSON.stringify({ group_ids: [groupId] })}::jsonb
      order by a.id, d.created_at asc
    ) f
    order by f.byte_size desc, f.sort_at desc, f.attachment_id
    limit ${GROUP_FILES_MAX}`);
  const list = rows.rows;
  const metas = list.length
    ? await tx
        .select()
        .from(attachments)
        .where(
          inArray(
            attachments.id,
            list.map((r) => r.attachment_id),
          ),
        )
    : [];
  const metaById = new Map(metas.map((a) => [a.id, a]));
  const people = [...new Set(list.map((r) => r.author_user_id))];
  const [users, remarks] = await Promise.all([
    people.length
      ? tx
          .select({ id: appUsers.id, handle: appUsers.handle, displayName: appUsers.displayName })
          .from(appUsers)
          .where(inArray(appUsers.id, people))
      : Promise.resolve([]),
    remarksFor(tx, userId, people),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const files: GroupFile[] = list.flatMap((r) => {
    const a = metaById.get(r.attachment_id);
    if (!a) return [];
    const u = userById.get(r.author_user_id);
    return [
      {
        drop_id: r.drop_id,
        attachment_id: r.attachment_id,
        safe_name: openAttachmentMeta(a).safeName,
        byte_size: Number(r.byte_size),
        from_label: remarks.get(r.author_user_id) ?? u?.displayName ?? (u ? `@${u.handle}` : ''),
        sent_at: r.created_at,
      },
    ];
  });
  return { storage: await groupStorage(tx, groupId), files };
}

/**
 * The group's owner or an admin removes one file stored for the group to free its space. The drop stays; the file
 * is listed as removed and can no longer be downloaded (FILE_REMOVED), by anyone. The bytes
 * leave the uploader's quota too, and the object is deleted by the worker (`attachment.cleanup`).
 */
export async function removeGroupFile(
  tx: Tx,
  userId: string,
  groupId: string,
  attachmentId: string,
): Promise<{ removed: true; freed_bytes: number; storage: GroupStorage }> {
  // the same lock a send to the group takes before it checks the space
  const [group] = await tx.select().from(groups).where(eq(groups.id, groupId)).for('update');
  if (!group) throw new AgentDropError('NOT_FOUND', 'group not found');
  await requireGroupAdmin(tx, groupId, userId);
  const linked = await tx
    .select({ dropId: drops.id })
    .from(dropAttachments)
    .innerJoin(drops, eq(drops.id, dropAttachments.dropId))
    .where(and(eq(dropAttachments.attachmentId, attachmentId), sentToGroup(groupId), isNull(drops.revokedAt)))
    .limit(1);
  if (linked.length === 0) throw new AgentDropError('NOT_FOUND', 'file not found');
  const [row] = await tx.select().from(attachments).where(eq(attachments.id, attachmentId)).for('update');
  if (row?.status !== 'ready') throw new AgentDropError('NOT_FOUND', 'file not found');
  const freed = row.byteSize;
  await tx
    .update(attachments)
    .set({ status: 'deleted', byteSize: 0, deletedAt: new Date() })
    .where(eq(attachments.id, row.id));
  await enqueueOutbox(tx, 'attachment.cleanup', row.id, { storage_key: row.storageKey });
  await recordAudit(tx, {
    actorUserId: userId,
    action: 'group.file.remove',
    targetId: row.id,
    result: 'ok',
    meta: { group_id: groupId, bytes: freed },
  });
  await bumpMailboxes(tx, await attachmentReaders(tx, [row.id], 'attachment.removed'));
  return { removed: true, freed_bytes: freed, storage: await groupStorage(tx, groupId) };
}

/**
 * One mailbox event for every agent that may still read a drop these files are linked to (a delivery with a valid
 * grant, AGENTS.md rule 4) or that sent it, so open views refresh and show the file as removed. Someone whose grant
 * was revoked, such as a former group member, learns nothing about a drop they can no longer open.
 */
export async function attachmentReaders(
  tx: Tx,
  attachmentIds: string[],
  type: MailboxEventInput['type'],
): Promise<MailboxEventInput[]> {
  if (attachmentIds.length === 0) return [];
  const linkedDrops = await tx
    .selectDistinct({ id: drops.id, originHId: drops.originHId })
    .from(dropAttachments)
    .innerJoin(drops, eq(drops.id, dropAttachments.dropId))
    .where(inArray(dropAttachments.attachmentId, attachmentIds));
  if (linkedDrops.length === 0) return [];
  const rows = await tx
    .select({ hId: deliveries.hId, dropId: deliveries.dropId, deliveryId: deliveries.id })
    .from(deliveries)
    .where(
      and(
        inArray(
          deliveries.dropId,
          linkedDrops.map((d) => d.id),
        ),
        hasValidGrant(deliveries.id),
      ),
    );
  const events: MailboxEventInput[] = rows.map((r) => ({
    hId: r.hId,
    type,
    dropId: r.dropId,
    deliveryId: r.deliveryId,
  }));
  for (const d of linkedDrops)
    if (!events.some((e) => e.hId === d.originHId && e.dropId === d.id))
      events.push({ hId: d.originHId, type, dropId: d.id });
  return events;
}
