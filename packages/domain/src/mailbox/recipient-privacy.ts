import { type ResolvedRecipient, resolvedRecipientSchema } from '@agentdrop/contracts';
import {
  appUsers,
  deliveries,
  deliveryGrants,
  harnessEndpoints,
  recipientRoutes,
  type Tx,
} from '@agentdrop/db';
import { and, eq, inArray, or } from 'drizzle-orm';

interface Snapshot {
  versions?: Array<{ kind: string; id: string }>;
  endpoints?: Array<[string, Array<{ groupId?: string }>]>;
  group_ids?: string[];
}

/** One stored snapshot to render: its recipients, the snapshot they came from, and the drop it is (null for an approval). */
export interface StoredRecipients {
  raw: unknown;
  snapshot?: unknown;
  dropId?: string | null | undefined;
}

/** Render stored snapshots under today's visibility policy, including pre-privacy sends and approvals. */
export async function privateRecipients(
  tx: Tx,
  viewerUserId: string,
  raw: unknown,
  rawSnapshot: unknown = {},
  dropId?: string | null,
): Promise<ResolvedRecipient[]> {
  return (await privateRecipientsMany(tx, viewerUserId, [{ raw, snapshot: rawSnapshot, dropId }]))[0] ?? [];
}

/**
 * `privateRecipients` for many snapshots at once, in the same order: a list page costs a fixed number of queries
 * (the viewer, the group deliveries of every drop, the published entries named) however many drops it shows.
 */
export async function privateRecipientsMany(
  tx: Tx,
  viewerUserId: string,
  items: StoredRecipients[],
): Promise<ResolvedRecipient[][]> {
  const parsed = items.map((item) => {
    const recipients = resolvedRecipientSchema.array().safeParse(item.raw);
    return {
      ...item,
      snapshot: (item.snapshot ?? {}) as Snapshot,
      recipients: recipients.success ? recipients.data : null,
    };
  });
  if (parsed.every((p) => !p.recipients)) return parsed.map(() => []);
  const me = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, viewerUserId) });

  // Who other than the viewer each group reached: from the drop's deliveries, or an approval's frozen endpoints.
  const withGroups = parsed.filter((p) => p.recipients?.some((r) => r.type === 'group'));
  const dropIds = [...new Set(withGroups.map((p) => p.dropId).filter((id): id is string => Boolean(id)))];
  const deliveredRows = dropIds.length
    ? await tx
        .select({
          dropId: deliveries.dropId,
          userId: harnessEndpoints.userId,
          groupId: deliveryGrants.groupId,
        })
        .from(deliveries)
        .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, deliveries.hId))
        .innerJoin(deliveryGrants, eq(deliveryGrants.deliveryId, deliveries.id))
        .where(inArray(deliveries.dropId, dropIds))
    : [];
  // grouped by drop, so rendering a page reads each delivery once instead of once per drop
  const deliveredTo = new Map<string, Array<{ userId: string; groupId: string | null }>>();
  for (const row of deliveredRows) {
    const list = deliveredTo.get(row.dropId) ?? [];
    list.push(row);
    deliveredTo.set(row.dropId, list);
  }
  const frozenHIds = [
    ...new Set(
      withGroups.filter((p) => !p.dropId).flatMap((p) => (p.snapshot.endpoints ?? []).map(([hId]) => hId)),
    ),
  ];
  const ownerOf = new Map(
    (frozenHIds.length
      ? await tx
          .select({ id: harnessEndpoints.id, userId: harnessEndpoints.userId })
          .from(harnessEndpoints)
          .where(inArray(harnessEndpoints.id, frozenHIds))
      : []
    ).map((h) => [h.id, h.userId]),
  );

  // Only an intentionally published entry may keep its alias; automatic aliases in old rows are private.
  const named = new Map<string, { handle: string; alias: string }>();
  for (const p of parsed)
    for (const r of p.recipients ?? []) {
      const m = /^@([^/\s]+)\/([^\s]+)$/.exec(r.label);
      if (m?.[1] && m[2] && m[1].toLowerCase() !== me?.handle.toLowerCase())
        named.set(`${m[1].toLowerCase()}/${m[2]}`, { handle: m[1].toLowerCase(), alias: m[2] });
    }
  const publishedRows = named.size
    ? await tx
        .select({ handle: appUsers.handle, alias: recipientRoutes.alias })
        .from(recipientRoutes)
        .innerJoin(appUsers, eq(appUsers.id, recipientRoutes.userId))
        .where(
          and(
            or(
              ...[...named.values()].map((n) =>
                and(eq(appUsers.handle, n.handle), eq(recipientRoutes.alias, n.alias)),
              ),
            ),
            eq(recipientRoutes.auto, false),
            eq(recipientRoutes.isDefault, false),
            eq(recipientRoutes.visibility, 'contacts'),
          ),
        )
    : [];
  const published = new Set(publishedRows.map((row) => `${row.handle}/${row.alias}`));

  return parsed.map((p) => {
    if (!p.recipients) return [];
    const groupPeople = new Map<string, Set<string>>();
    const add = (groupId: string | null | undefined, userId: string | undefined) => {
      if (!groupId || !userId || userId === viewerUserId) return;
      const members = groupPeople.get(groupId) ?? new Set<string>();
      members.add(userId);
      groupPeople.set(groupId, members);
    };
    if (p.dropId) {
      for (const row of deliveredTo.get(p.dropId) ?? []) add(row.groupId, row.userId);
    } else {
      for (const [hId, grants] of p.snapshot.endpoints ?? [])
        for (const g of grants) add(g.groupId, ownerOf.get(hId));
    }
    const groupIds =
      p.snapshot.group_ids ?? p.snapshot.versions?.filter((v) => v.kind === 'group').map((v) => v.id) ?? [];
    let groupIndex = 0;
    return p.recipients.map((r) => {
      if (r.type === 'group')
        return { ...r, endpoint_count: groupPeople.get(groupIds[groupIndex++] ?? '')?.size ?? 0 };
      const match = /^@([^/\s]+)(?:\/([^\s]+))?$/.exec(r.label);
      const handle = match?.[1];
      if (handle?.toLowerCase() === me?.handle.toLowerCase()) return r;
      const label =
        handle && match?.[2] && published.has(`${handle.toLowerCase()}/${match[2]}`)
          ? r.label
          : handle
            ? `@${handle}`
            : 'recipient';
      return { ...r, label, endpoint_count: 1, address: label, endpoint_label: null, harness_key: null };
    });
  });
}
