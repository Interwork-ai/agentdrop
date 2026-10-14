import { type ResolvedRecipient, resolvedRecipientSchema } from '@agentdrop/contracts';
import {
  appUsers,
  deliveries,
  deliveryGrants,
  harnessEndpoints,
  recipientRoutes,
  type Tx,
} from '@agentdrop/db';
import { and, eq } from 'drizzle-orm';

/** Render stored snapshots under today's visibility policy, including pre-privacy sends and approvals. */
export async function privateRecipients(
  tx: Tx,
  viewerUserId: string,
  raw: unknown,
  rawSnapshot: unknown = {},
  dropId?: string | null,
): Promise<ResolvedRecipient[]> {
  const snapshot = (rawSnapshot ?? {}) as {
    versions?: Array<{ kind: string; id: string }>;
    endpoints?: Array<[string, Array<{ groupId?: string }>]>;
    group_ids?: string[];
  };
  const parsed = resolvedRecipientSchema.array().safeParse(raw);
  if (!parsed.success) return [];
  const me = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, viewerUserId) });
  const groupIds =
    snapshot.group_ids ?? snapshot.versions?.filter((v) => v.kind === 'group').map((v) => v.id) ?? [];
  const groupPeople = new Map<string, Set<string>>();
  const add = (groupId: string | null | undefined, userId: string) => {
    if (!groupId || userId === viewerUserId) return;
    const members = groupPeople.get(groupId) ?? new Set<string>();
    members.add(userId);
    groupPeople.set(groupId, members);
  };
  if (parsed.data.some((r) => r.type === 'group')) {
    if (dropId) {
      const rows = await tx
        .select({ userId: harnessEndpoints.userId, groupId: deliveryGrants.groupId })
        .from(deliveries)
        .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, deliveries.hId))
        .innerJoin(deliveryGrants, eq(deliveryGrants.deliveryId, deliveries.id))
        .where(eq(deliveries.dropId, dropId));
      for (const row of rows) add(row.groupId, row.userId);
    } else {
      for (const [hId, grants] of snapshot.endpoints ?? []) {
        const h = await tx.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, hId) });
        if (h) for (const grant of grants) add(grant.groupId, h.userId);
      }
    }
  }
  let groupIndex = 0;
  return Promise.all(
    parsed.data.map(async (r) => {
      if (r.type === 'group')
        return { ...r, endpoint_count: groupPeople.get(groupIds[groupIndex++] ?? '')?.size ?? 0 };
      const match = /^@([^/\s]+)(?:\/([^\s]+))?$/.exec(r.label);
      const handle = match?.[1];
      if (handle?.toLowerCase() === me?.handle.toLowerCase()) return r;
      let label = handle ? `@${handle}` : 'recipient';
      // Only an intentionally published entry may retain its alias; automatic aliases in old rows are private.
      if (handle && match?.[2]) {
        const [named] = await tx
          .select({ id: recipientRoutes.id })
          .from(recipientRoutes)
          .innerJoin(appUsers, eq(appUsers.id, recipientRoutes.userId))
          .where(
            and(
              eq(appUsers.handle, handle),
              eq(recipientRoutes.alias, match[2]),
              eq(recipientRoutes.auto, false),
              eq(recipientRoutes.isDefault, false),
              eq(recipientRoutes.visibility, 'contacts'),
            ),
          )
          .limit(1);
        if (named) label = r.label;
      }
      return { ...r, label, endpoint_count: 1, address: label, endpoint_label: null, harness_key: null };
    }),
  );
}
