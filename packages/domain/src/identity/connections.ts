import { AgentDropError } from '@agentdrop/contracts';
import { connections, type Tx } from '@agentdrop/db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

export const HEARTBEAT_INTERVAL_S = 30;
export const CONNECTION_STALE_S = 90;

export interface OpenConnectionInput {
  clientName: string | null;
  clientVersion: string | null;
  capabilities: Record<string, unknown>;
  bridgeVersion: string;
  toolset: 'core' | 'standard';
}

export async function openConnection(
  tx: Tx,
  hId: string,
  input: OpenConnectionInput,
): Promise<{ connectionId: string }> {
  const [row] = await tx
    .insert(connections)
    .values({
      hId,
      clientName: input.clientName,
      clientVersion: input.clientVersion,
      capabilities: input.capabilities,
      bridgeVersion: input.bridgeVersion,
      toolset: input.toolset,
    })
    .returning({ id: connections.id });
  if (!row) throw new AgentDropError('INTERNAL', 'connection insert failed');
  return { connectionId: row.id };
}

export async function heartbeatConnection(
  tx: Tx,
  hId: string,
  connectionId: string,
  lastTool: string | null | undefined,
): Promise<void> {
  const res = await tx
    .update(connections)
    .set({ lastSeenAt: new Date(), ...(lastTool !== undefined ? { lastTool } : {}) })
    .where(and(eq(connections.id, connectionId), eq(connections.hId, hId), isNull(connections.closedAt)))
    .returning({ id: connections.id });
  if (res.length === 0) throw new AgentDropError('NOT_FOUND', 'connection not found');
}

export async function closeConnection(tx: Tx, hId: string, connectionId: string): Promise<void> {
  await tx
    .update(connections)
    .set({ closedAt: new Date() })
    .where(and(eq(connections.id, connectionId), eq(connections.hId, hId), isNull(connections.closedAt)));
}

export interface ConnectionView {
  connection_id: string;
  h_id: string;
  client_name: string | null;
  client_version: string | null;
  bridge_version: string | null;
  toolset: string | null;
  last_tool: string | null;
  opened_at: string;
  last_seen_at: string;
  closed_at: string | null;
  /** live | stale (no heartbeat for 90s) | closed. Never a statement about model activity. */
  status: 'live' | 'stale' | 'closed';
}

export async function listConnectionsForUser(tx: Tx, hIds: string[], limit = 100): Promise<ConnectionView[]> {
  if (hIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(connections)
    .where(inArray(connections.hId, hIds))
    .orderBy(desc(connections.lastSeenAt))
    .limit(limit);
  const now = Date.now();
  return rows.map((c) => ({
    connection_id: c.id,
    h_id: c.hId,
    client_name: c.clientName,
    client_version: c.clientVersion,
    bridge_version: c.bridgeVersion,
    toolset: c.toolset,
    last_tool: c.lastTool,
    opened_at: c.openedAt.toISOString(),
    last_seen_at: c.lastSeenAt.toISOString(),
    closed_at: c.closedAt ? c.closedAt.toISOString() : null,
    status: c.closedAt
      ? 'closed'
      : now - c.lastSeenAt.getTime() > CONNECTION_STALE_S * 1000
        ? 'stale'
        : 'live',
  }));
}

export async function countLiveConnections(tx: Tx, hId: string): Promise<number> {
  const rows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(connections)
    .where(
      and(
        eq(connections.hId, hId),
        isNull(connections.closedAt),
        sql`${connections.lastSeenAt} > now() - interval '${sql.raw(String(CONNECTION_STALE_S))} seconds'`,
      ),
    );
  return rows[0]?.count ?? 0;
}
