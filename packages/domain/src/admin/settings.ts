import { AgentDropError, type SignupMode, signupModeSchema } from '@agentdrop/contracts';
import { appSettings, appUsers, type Tx } from '@agentdrop/db';
import { eq } from 'drizzle-orm';
import { recordAudit } from '../audit.js';

const SIGNUP_MODE_KEY = 'signup_mode';

export interface SignupSetting {
  mode: SignupMode;
  updatedAt: Date | null;
  updatedByHandle: string | null;
}

/** Sign-up mode, or the `fallback` (the SIGNUP_MODE env value) while an operator has never changed it. */
export async function getSignupSetting(tx: Tx, fallback: SignupMode): Promise<SignupSetting> {
  const rows = await tx
    .select({ value: appSettings.value, updatedAt: appSettings.updatedAt, handle: appUsers.handle })
    .from(appSettings)
    .leftJoin(appUsers, eq(appUsers.id, appSettings.updatedByUserId))
    .where(eq(appSettings.key, SIGNUP_MODE_KEY))
    .limit(1);
  const row = rows[0];
  if (!row) return { mode: fallback, updatedAt: null, updatedByHandle: null };
  const parsed = signupModeSchema.safeParse((row.value as { mode?: unknown })?.mode);
  return {
    mode: parsed.success ? parsed.data : fallback,
    updatedAt: row.updatedAt,
    updatedByHandle: row.handle ?? null,
  };
}

export async function setSignupMode(tx: Tx, adminUserId: string, mode: SignupMode): Promise<SignupSetting> {
  const parsed = signupModeSchema.safeParse(mode);
  if (!parsed.success) throw new AgentDropError('VALIDATION_FAILED', 'invalid sign-up mode');
  const now = new Date();
  await tx
    .insert(appSettings)
    .values({
      key: SIGNUP_MODE_KEY,
      value: { mode: parsed.data },
      updatedByUserId: adminUserId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: { mode: parsed.data }, updatedByUserId: adminUserId, updatedAt: now },
    });
  await recordAudit(tx, {
    actorUserId: adminUserId,
    action: 'admin.signup_mode.set',
    targetId: parsed.data,
    result: 'ok',
    meta: { mode: parsed.data },
  });
  return getSignupSetting(tx, parsed.data);
}

const GROUP_STORAGE_QUOTA_KEY = 'group_storage_quota_bytes';

/** Built-in default file space per group (ADR 0029): 512 MiB, until the server configures another. */
export const DEFAULT_GROUP_STORAGE_QUOTA_BYTES = 512 * 1024 * 1024;

let configuredGroupStorageQuota = DEFAULT_GROUP_STORAGE_QUOTA_BYTES;

/**
 * The server's GROUP_STORAGE_QUOTA_BYTES, registered once at startup by the API (like content encryption). It is
 * the fallback while no admin has set the value at runtime.
 */
export function configureGroupStorageQuota(bytes: number): void {
  if (!Number.isInteger(bytes) || bytes <= 0)
    throw new Error('group storage quota must be a positive integer');
  configuredGroupStorageQuota = bytes;
}

export interface GroupStorageQuotaSetting {
  bytes: number;
  updatedAt: Date | null;
  updatedByHandle: string | null;
}

/** File space of every group: the admin's runtime value, else `fallback` (the configured env value). */
export async function getGroupStorageQuotaSetting(
  tx: Tx,
  fallback: number = configuredGroupStorageQuota,
): Promise<GroupStorageQuotaSetting> {
  const rows = await tx
    .select({ value: appSettings.value, updatedAt: appSettings.updatedAt, handle: appUsers.handle })
    .from(appSettings)
    .leftJoin(appUsers, eq(appUsers.id, appSettings.updatedByUserId))
    .where(eq(appSettings.key, GROUP_STORAGE_QUOTA_KEY))
    .limit(1);
  const row = rows[0];
  const stored = (row?.value as { bytes?: unknown } | undefined)?.bytes;
  if (!row || typeof stored !== 'number' || !Number.isInteger(stored) || stored <= 0)
    return { bytes: fallback, updatedAt: null, updatedByHandle: null };
  return { bytes: stored, updatedAt: row.updatedAt, updatedByHandle: row.handle ?? null };
}

export async function getGroupStorageQuota(tx: Tx): Promise<number> {
  return (await getGroupStorageQuotaSetting(tx)).bytes;
}

export async function setGroupStorageQuota(
  tx: Tx,
  adminUserId: string,
  bytes: number,
): Promise<GroupStorageQuotaSetting> {
  if (!Number.isInteger(bytes) || bytes < 1024 * 1024 || bytes > 1024 ** 4)
    throw new AgentDropError('VALIDATION_FAILED', 'group storage quota must be between 1 MiB and 1 TiB', {
      field: 'group_storage_quota_bytes',
    });
  const now = new Date();
  await tx
    .insert(appSettings)
    .values({ key: GROUP_STORAGE_QUOTA_KEY, value: { bytes }, updatedByUserId: adminUserId, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: { bytes }, updatedByUserId: adminUserId, updatedAt: now },
    });
  await recordAudit(tx, {
    actorUserId: adminUserId,
    action: 'admin.group_storage_quota.set',
    targetId: String(bytes),
    result: 'ok',
    meta: { bytes },
  });
  return getGroupStorageQuotaSetting(tx);
}
