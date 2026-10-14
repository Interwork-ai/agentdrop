import { AgentDropError, type HarnessKey } from '@agentdrop/contracts';
import { appUsers, devices, harnessEndpoints, hCredentials, type Tx } from '@agentdrop/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { CREDENTIAL_PREFIX, generateCredential, hashToken } from '../crypto.js';
import type { HPrincipal } from '../principals.js';

export const H_SCOPES = ['mailbox', 'manage'] as const;

export interface IssuedCredential {
  credentialId: string;
  token: string;
  expiresAt: Date;
}

export async function issueCredential(tx: Tx, hId: string, maxDays: number): Promise<IssuedCredential> {
  const token = generateCredential();
  const expiresAt = new Date(Date.now() + maxDays * 24 * 3600 * 1000);
  const [row] = await tx
    .insert(hCredentials)
    .values({ hId, tokenHash: hashToken(token), scopes: [...H_SCOPES], expiresAt })
    .returning({ id: hCredentials.id });
  if (!row) throw new AgentDropError('INTERNAL', 'credential insert failed');
  return { credentialId: row.id, token, expiresAt };
}

export interface AuthenticatedH {
  principal: HPrincipal;
  endpoint: {
    hId: string;
    label: string;
    publicName: string | null;
    harnessKey: HarnessKey;
    profileKey: string;
    deviceLabel: string;
  };
  user: {
    userId: string;
    handle: string;
    displayName: string;
    publicEmail: string | null;
    directoryRevision: number;
  };
  credentialExpiresAt: Date;
}

const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Resolves a bearer token into an HPrincipal. Fails closed on revoked credentials, revoked endpoints,
 * revoked devices and expiry. The token itself is never logged or returned.
 */
export async function authenticateHCredential(tx: Tx, bearer: string | undefined): Promise<AuthenticatedH> {
  if (!bearer?.startsWith(CREDENTIAL_PREFIX)) throw new AgentDropError('UNAUTHORIZED', 'missing credential');
  const tokenHash = hashToken(bearer);
  const rows = await tx
    .select({
      cred: hCredentials,
      h: harnessEndpoints,
      device: { label: devices.label, revokedAt: devices.revokedAt },
      user: {
        id: appUsers.id,
        handle: appUsers.handle,
        displayName: appUsers.displayName,
        publicEmail: appUsers.publicEmail,
        directoryRevision: appUsers.directoryRevision,
        suspendedAt: appUsers.suspendedAt,
        suspendedReason: appUsers.suspendedReason,
        deletedAt: appUsers.deletedAt,
      },
    })
    .from(hCredentials)
    .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, hCredentials.hId))
    .innerJoin(devices, eq(devices.id, harnessEndpoints.deviceId))
    .innerJoin(appUsers, eq(appUsers.id, harnessEndpoints.userId))
    .where(eq(hCredentials.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AgentDropError('UNAUTHORIZED', 'invalid credential');
  const now = Date.now();
  if (row.cred.revokedAt || row.cred.expiresAt.getTime() <= now) {
    throw new AgentDropError('UNAUTHORIZED', 'credential expired or revoked');
  }
  if (row.user.deletedAt) throw new AgentDropError('UNAUTHORIZED', 'this account was closed');
  if (row.user.suspendedAt)
    throw new AgentDropError(
      'ACCOUNT_SUSPENDED',
      row.user.suspendedReason ? `account suspended: ${row.user.suspendedReason}` : 'account suspended',
    );
  if (row.h.revokedAt || row.device.revokedAt)
    throw new AgentDropError('ENDPOINT_REVOKED', 'endpoint revoked');
  if (!row.cred.lastUsedAt || now - row.cred.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    await tx
      .update(hCredentials)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(hCredentials.id, row.cred.id));
  }
  return {
    principal: {
      kind: 'h',
      userId: row.user.id,
      hId: row.h.id,
      scopes: row.cred.scopes,
      credentialId: row.cred.id,
    },
    endpoint: {
      hId: row.h.id,
      label: row.h.label,
      publicName: row.h.publicName,
      harnessKey: row.h.harnessKey,
      profileKey: row.h.profileKey,
      deviceLabel: row.device.label,
    },
    user: {
      userId: row.user.id,
      handle: row.user.handle,
      displayName: row.user.displayName,
      publicEmail: row.user.publicEmail,
      directoryRevision: row.user.directoryRevision,
    },
    credentialExpiresAt: row.cred.expiresAt,
  };
}

/** Revokes every active credential of an H. The mailbox content is untouched. */
export async function revokeCredentialsForEndpoint(
  tx: Tx,
  actorUserId: string,
  hId: string,
): Promise<{ revoked: number }> {
  const h = await tx.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, hId) });
  if (!h || h.userId !== actorUserId) throw new AgentDropError('NOT_FOUND', 'endpoint not found');
  const rows = await tx
    .update(hCredentials)
    .set({ revokedAt: new Date() })
    .where(and(eq(hCredentials.hId, hId), isNull(hCredentials.revokedAt)))
    .returning({ id: hCredentials.id });
  await recordAudit(tx, {
    actorUserId,
    hId,
    action: 'credential.revoke',
    result: 'ok',
    meta: { count: rows.length },
  });
  return { revoked: rows.length };
}

export async function activeCredentialSummary(
  tx: Tx,
  hId: string,
): Promise<{ active: number; soonestExpiry: Date | null; lastUsedAt: Date | null }> {
  const rows = await tx
    .select({
      count: sql<number>`count(*)::int`,
      soonest: sql<Date | null>`min(${hCredentials.expiresAt})`,
      lastUsed: sql<Date | null>`max(${hCredentials.lastUsedAt})`,
    })
    .from(hCredentials)
    .where(
      and(eq(hCredentials.hId, hId), isNull(hCredentials.revokedAt), sql`${hCredentials.expiresAt} > now()`),
    );
  const r = rows[0];
  return {
    active: r?.count ?? 0,
    soonestExpiry: r?.soonest ? new Date(r.soonest) : null,
    lastUsedAt: r?.lastUsed ? new Date(r.lastUsed) : null,
  };
}
