import { auditEvents, type Tx } from '@agentdrop/db';

export interface AuditEntry {
  actorUserId?: string | null;
  hId?: string | null;
  action: string;
  targetId?: string | null;
  result: 'ok' | 'denied' | 'error' | 'conflict';
  requestId?: string | null;
  /** Only ids, counts and sizes. Never bodies, names, tokens or absolute paths. */
  meta?: Record<string, string | number | boolean | null>;
}

export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditEvents).values({
    actorUserId: entry.actorUserId ?? null,
    hId: entry.hId ?? null,
    action: entry.action,
    targetId: entry.targetId ?? null,
    result: entry.result,
    requestId: entry.requestId ?? null,
    meta: entry.meta ?? {},
  });
}
