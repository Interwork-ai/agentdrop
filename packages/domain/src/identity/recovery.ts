import { createHash, randomInt } from 'node:crypto';
import { AgentDropError } from '@agentdrop/contracts';
import { accountRecoveryCodes, appUsers, authUsers, type Database, type Tx } from '@agentdrop/db';
import { and, count, eq, isNull, max, sql } from 'drizzle-orm';
import { adminPreparePasswordReset, type PasswordResetTarget } from '../admin/password-reset.js';
import { recordAudit } from '../audit.js';

/*
 * Getting back into an account without email or an administrator (ADR 0036). Two ways lead to the same one-time
 * password reset link the console hands out:
 *   - from a device: a paired agent's credential, used by the person at a terminal (`agentdrop account recover`);
 *   - with a recovery code: one of the codes the person generated in Settings, together with the account email.
 * The link itself is made by the caller through Better Auth, exactly as for an administrator's reset link.
 */

/** Codes per set. */
export const RECOVERY_CODE_COUNT = 10;
/** Crockford-style base32 without i, l, o, u: easy to read back and to type. 12 characters ≈ 60 bits. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const CODE_LENGTH = 12;

/** "k7m2-q9xa-3fpw": three groups of four. */
function newCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/**
 * How a typed code is compared: case, spaces and dashes do not matter, and the letters people confuse with digits
 * (o, i, l) read as the digits. Anything else outside the alphabet makes it no code at all.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const raw = input.toLowerCase().replace(/[\s-]/g, '').replace(/o/g, '0').replace(/[il]/g, '1');
  if (raw.length !== CODE_LENGTH || [...raw].some((c) => !ALPHABET.includes(c))) return null;
  return raw;
}

function hashCode(normalized: string): string {
  return createHash('sha256').update(`agentdrop-recovery:${normalized}`).digest('hex');
}

export interface RecoveryCodeStatus {
  /** Codes in the current set that were not used yet; 0 when no set exists. */
  remaining: number;
  total: number;
  /** When the current set was generated; null when none exists. */
  created_at: string | null;
}

export async function recoveryCodeStatus(
  db: Database['drizzle'] | Tx,
  userId: string,
): Promise<RecoveryCodeStatus> {
  const [row] = await db
    .select({
      total: count(),
      remaining: sql<number>`count(*) filter (where ${accountRecoveryCodes.usedAt} is null)`.mapWith(Number),
      createdAt: max(accountRecoveryCodes.createdAt),
    })
    .from(accountRecoveryCodes)
    .where(eq(accountRecoveryCodes.userId, userId));
  return {
    remaining: row?.remaining ?? 0,
    total: row?.total ?? 0,
    created_at: row?.createdAt ? row.createdAt.toISOString() : null,
  };
}

/**
 * A new set of codes replaces the old one. Returned once in plain text; only their hashes are kept. The caller
 * has already confirmed the person's password.
 */
export async function generateRecoveryCodes(tx: Tx, userId: string): Promise<string[]> {
  await tx.delete(accountRecoveryCodes).where(eq(accountRecoveryCodes.userId, userId));
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newCode);
  const now = new Date();
  await tx.insert(accountRecoveryCodes).values(
    codes.map((code) => ({
      userId,
      codeHash: hashCode(normalizeRecoveryCode(code) as string),
      createdAt: now,
    })),
  );
  await recordAudit(tx, {
    actorUserId: userId,
    action: 'account.recovery_codes_generated',
    targetId: userId,
    result: 'ok',
    meta: { count: RECOVERY_CODE_COUNT },
  });
  return codes;
}

/** The one answer for every failed redemption: it never tells which part was wrong or whether the email exists. */
const NOT_VALID = () =>
  new AgentDropError('VALIDATION_FAILED', 'the email or the recovery code is not valid', {
    reason: 'recovery_code_invalid',
  });

/**
 * Spends one unused code of the account with this email and prepares its reset link (older reset links for it
 * stop working). The code is used up even if the person never opens the link; the remaining codes stay valid.
 */
export async function redeemRecoveryCode(tx: Tx, email: string, code: string): Promise<PasswordResetTarget> {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) throw NOT_VALID();
  const [row] = await tx
    .select({ codeId: accountRecoveryCodes.id, userId: appUsers.id, suspendedAt: appUsers.suspendedAt })
    .from(accountRecoveryCodes)
    .innerJoin(appUsers, eq(appUsers.id, accountRecoveryCodes.userId))
    .innerJoin(authUsers, eq(authUsers.id, appUsers.authUserId))
    .where(
      and(
        eq(accountRecoveryCodes.codeHash, hashCode(normalized)),
        isNull(accountRecoveryCodes.usedAt),
        eq(sql`lower(${authUsers.email})`, email.trim().toLowerCase()),
        isNull(appUsers.deletedAt),
        eq(appUsers.isSystem, false),
      ),
    )
    .for('update', { of: accountRecoveryCodes });
  if (!row) throw NOT_VALID();
  if (row.suspendedAt) throw new AgentDropError('ACCOUNT_SUSPENDED', 'account suspended');
  await tx
    .update(accountRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(eq(accountRecoveryCodes.id, row.codeId));
  const target = await adminPreparePasswordReset(tx, row.userId);
  await recordAudit(tx, {
    actorUserId: row.userId,
    action: 'account.recovery_code_used',
    targetId: row.userId,
    result: 'ok',
  });
  return target;
}

/**
 * The device path: the paired agent's credential identifies the account. Refused for a suspended account (an
 * administrator decides that one); a closed account has no credential left to call this with.
 */
export async function prepareDeviceRecovery(
  tx: Tx,
  userId: string,
  hId: string,
): Promise<PasswordResetTarget> {
  const user = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, userId) });
  if (user?.suspendedAt) throw new AgentDropError('ACCOUNT_SUSPENDED', 'account suspended');
  const target = await adminPreparePasswordReset(tx, userId);
  await recordAudit(tx, {
    actorUserId: userId,
    hId,
    action: 'account.recovery_link',
    targetId: userId,
    result: 'ok',
    meta: { via: 'device' },
  });
  return target;
}
