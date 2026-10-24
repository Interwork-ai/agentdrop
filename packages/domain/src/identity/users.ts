import { BlockList, isIP } from 'node:net';
import {
  AgentDropError,
  displayNameSchema,
  handleSchema,
  normalizeHandle,
  publicEmailSchema,
} from '@agentdrop/contracts';
import { appUsers, authUsers, harnessEndpoints, type Tx } from '@agentdrop/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { notifyEventStreams } from '../mailbox/revision.js';
import { addAssistantContact, ensureSystemAssistant } from './system-assistant.js';

export interface AppUserRow {
  id: string;
  authUserId: string;
  handle: string;
  displayName: string;
  /** Published to contacts and group co-members (ADR 0012); null when the person has none. */
  publicEmail: string | null;
  directoryRevision: number;
  isAdmin: boolean;
  /** The built-in assistant (@agentdrop). Never signs in, never joins groups, never administered. */
  isSystem: boolean;
  crossHMailboxEnabled: boolean;
  directReceiveAll: boolean;
  feishuWebhook: { url: string; secret: string | null; language: 'en' | 'zh' } | null;
  notificationWebhookUrl: string | null;
  /** Set while an admin has suspended the account: no session and no agent credential may be used. */
  suspendedAt: Date | null;
  suspendedReason: string | null;
  /** Set when the account was closed: the profile is a tombstone and can never be used again. */
  deletedAt: Date | null;
}

const RESERVED_HANDLES = new Set(['admin', 'root', 'agentdrop', 'system', 'support', 'me', 'default']);

export async function getUserByAuthId(tx: Tx, authUserId: string): Promise<AppUserRow | null> {
  const row = await tx.query.appUsers.findFirst({ where: eq(appUsers.authUserId, authUserId) });
  return row ? toRow(row) : null;
}

export async function getUserById(tx: Tx, userId: string): Promise<AppUserRow | null> {
  const row = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, userId) });
  return row ? toRow(row) : null;
}

/** The address this person signs in with. Their own settings page only; never shown to anyone else. */
export async function signInEmailOf(tx: Tx, authUserId: string): Promise<string | null> {
  const [row] = await tx
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, authUserId))
    .limit(1);
  return row?.email ?? null;
}

export async function getUserByHandle(tx: Tx, rawHandle: string): Promise<AppUserRow | null> {
  const handle = normalizeHandle(rawHandle);
  const row = await tx.query.appUsers.findFirst({ where: eq(appUsers.handle, handle) });
  return row ? toRow(row) : null;
}

export function validateHandle(raw: string): string {
  const handle = normalizeHandle(raw);
  const parsed = handleSchema.safeParse(handle);
  if (!parsed.success)
    throw new AgentDropError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'invalid handle', {
      field: 'handle',
    });
  if (RESERVED_HANDLES.has(handle))
    throw new AgentDropError('VALIDATION_FAILED', 'this handle is reserved', { field: 'handle' });
  return handle;
}

export function validateDisplayName(raw: string): string {
  const parsed = displayNameSchema.safeParse(raw);
  if (!parsed.success)
    throw new AgentDropError('VALIDATION_FAILED', 'invalid display name', { field: 'display_name' });
  return parsed.data;
}

/** Creates the application profile for a freshly registered auth user. Idempotent per auth user. */
export async function ensureAppUser(
  tx: Tx,
  input: { authUserId: string; handle: string; displayName: string },
): Promise<AppUserRow> {
  const existing = await getUserByAuthId(tx, input.authUserId);
  if (existing) return existing;
  const handle = validateHandle(input.handle);
  const displayName = validateDisplayName(input.displayName);
  const taken = await tx.query.appUsers.findFirst({ where: eq(appUsers.handle, handle) });
  if (taken) throw new AgentDropError('VALIDATION_FAILED', 'handle already taken', { field: 'handle' });
  const [row] = await tx
    .insert(appUsers)
    .values({ authUserId: input.authUserId, handle, displayName })
    .returning();
  if (!row) throw new AgentDropError('INTERNAL', 'failed to create profile');
  // every new account starts with the built-in assistant as a contact, so a first send works right away
  const assistant = await ensureSystemAssistant(tx);
  if (assistant) await addAssistantContact(tx, row.id, assistant.userId);
  return toRow(row);
}

export async function updateDisplayName(tx: Tx, userId: string, raw: string): Promise<AppUserRow> {
  const displayName = validateDisplayName(raw);
  await bumpDirectoryRevision(tx, [userId]);
  const [row] = await tx
    .update(appUsers)
    .set({
      displayName,
      profileVersion: sql`${appUsers.profileVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(appUsers.id, userId))
    .returning();
  if (!row) throw new AgentDropError('NOT_FOUND', 'user not found');
  return toRow(row);
}

/**
 * Publishes (or, with null or an empty string, withdraws) the person's public email (ADR 0012). Browser session
 * only. The address itself never goes into the audit row.
 */
export async function setPublicEmail(tx: Tx, userId: string, raw: string | null): Promise<AppUserRow> {
  let publicEmail: string | null = null;
  if (raw !== null && raw.trim() !== '') {
    const parsed = publicEmailSchema.safeParse(raw);
    if (!parsed.success)
      throw new AgentDropError('VALIDATION_FAILED', 'invalid email address', { field: 'public_email' });
    publicEmail = parsed.data;
  }
  await bumpDirectoryRevision(tx, [userId]);
  const [row] = await tx
    .update(appUsers)
    .set({
      publicEmail,
      profileVersion: sql`${appUsers.profileVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(appUsers.id, userId))
    .returning();
  if (!row) throw new AgentDropError('NOT_FOUND', 'user not found');
  await recordAudit(tx, {
    actorUserId: userId,
    action: publicEmail ? 'profile.public_email.set' : 'profile.public_email.clear',
    targetId: userId,
    result: 'ok',
  });
  return toRow(row);
}

/**
 * Relationships need somewhere to deliver: without a live paired agent a person can be reached by nobody and send
 * nothing, so adding contacts, creating or joining groups waits until the first agent is paired.
 */
export async function requirePairedAgent(tx: Tx, userId: string): Promise<void> {
  const [live] = await tx
    .select({ id: harnessEndpoints.id })
    .from(harnessEndpoints)
    .where(and(eq(harnessEndpoints.userId, userId), isNull(harnessEndpoints.revokedAt)))
    .limit(1);
  if (!live) throw new AgentDropError('AGENT_REQUIRED', 'pair an agent first');
}

/**
 * Moves each person's `directory_revision`, which their event streams announce as `directory.changed` (ADR 0040),
 * and wakes those streams once this transaction commits. Every write to the column goes through here (or, for a
 * bulk update, notifies the same way), or open streams learn of the change only at their next timed re-read.
 * Rows are updated in id order, so two transactions bumping the same people cannot deadlock.
 */
export async function bumpDirectoryRevision(tx: Tx, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)].sort();
  for (const id of ids) {
    await tx
      .update(appUsers)
      .set({ directoryRevision: sql`${appUsers.directoryRevision} + 1` })
      .where(eq(appUsers.id, id));
  }
  await notifyEventStreams(tx, ids);
}

function toRow(row: typeof appUsers.$inferSelect): AppUserRow {
  return {
    id: row.id,
    authUserId: row.authUserId,
    handle: row.handle,
    displayName: row.displayName,
    publicEmail: row.publicEmail ?? null,
    directoryRevision: row.directoryRevision,
    isAdmin: row.isAdmin,
    isSystem: row.isSystem,
    crossHMailboxEnabled: row.crossHMailboxEnabled,
    directReceiveAll: row.directReceiveAll,
    feishuWebhook: row.feishuWebhook ?? null,
    notificationWebhookUrl: row.notificationWebhookUrl,
    suspendedAt: row.suspendedAt,
    suspendedReason: row.suspendedReason,
    deletedAt: row.deletedAt,
  };
}

/** Controls whether every H owned by this account may read the account's full mailbox history. */
export async function setCrossHMailboxEnabled(tx: Tx, userId: string, enabled: boolean): Promise<AppUserRow> {
  // What lists show changes scope: open event streams wake now and find their cursor no longer fits (RESYNC_REQUIRED).
  await bumpDirectoryRevision(tx, [userId]);
  const [row] = await tx
    .update(appUsers)
    .set({ crossHMailboxEnabled: enabled, updatedAt: new Date() })
    .where(eq(appUsers.id, userId))
    .returning();
  if (!row) throw new AgentDropError('NOT_FOUND', 'user not found');
  return toRow(row);
}

/*
 * Webhook targets must be public unicast addresses. Loopback, RFC 1918, CGNAT (also Alibaba's 100.100.100.200
 * metadata), link-local (169.254.169.254 metadata), ULA (fd00:ec2::254 metadata), multicast, documentation and
 * reserved ranges are refused. The worker applies the same predicate to every resolved address at delivery time.
 */
const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback, deprecated IPv4-compatible
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, 'ipv6');
}

/** IPv4 carried inside IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) IPv6, in canonical form. */
function embeddedIpv4(canonicalV6: string): string | null {
  const m = /^(?:::ffff|64:ff9b:):([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonicalV6);
  if (!m?.[1] || !m[2]) return null;
  const hi = Number.parseInt(m[1], 16);
  const lo = Number.parseInt(m[2], 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/** True only for a literal IP address that is publicly routable unicast. */
export function isPublicUnicastAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(bare);
  if (family === 4) return !NON_PUBLIC.check(bare, 'ipv4');
  if (family !== 6) return false;
  let canonical: string;
  try {
    canonical = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  } catch {
    return false;
  }
  const v4 = embeddedIpv4(canonical);
  if (v4) return !NON_PUBLIC.check(v4, 'ipv4');
  // short forms such as 64:ff9b::1 embed 0.0.0.x
  if (canonical.startsWith('::ffff:') || canonical.startsWith('64:ff9b::')) return false;
  return !NON_PUBLIC.check(canonical, 'ipv6');
}

/**
 * Save-time check on the host name alone: `localhost` names and literal non-public IPs are refused. Names are
 * resolved only by the worker at delivery, because DNS can change after saving.
 */
export function webhookHostForbidden(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const bare = host.replace(/^\[|\]$/g, '');
  return isIP(bare) !== 0 && !isPublicUnicastAddress(bare);
}

/**
 * Per-user notification webhook: https only, no credentials, no loopback/private literal host. Null clears it.
 * allowPrivateNetwork mirrors the worker's WEBHOOK_ALLOW_PRIVATE_NETWORK for self-hosted intranet deployments.
 */
export async function setNotificationWebhook(
  tx: Tx,
  userId: string,
  raw: string | null,
  options: { allowPrivateNetwork?: boolean } = {},
): Promise<void> {
  let value: string | null = null;
  if (raw?.trim()) {
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      throw new AgentDropError('VALIDATION_FAILED', 'invalid webhook URL', {
        field: 'notification_webhook_url',
      });
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new AgentDropError('VALIDATION_FAILED', 'webhook must be an https URL without credentials', {
        field: 'notification_webhook_url',
      });
    }
    if (!options.allowPrivateNetwork && webhookHostForbidden(url)) {
      throw new AgentDropError('VALIDATION_FAILED', 'webhook must point to a public internet host', {
        field: 'notification_webhook_url',
      });
    }
    value = url.toString();
  }
  await tx
    .update(appUsers)
    .set({ notificationWebhookUrl: value, updatedAt: new Date() })
    .where(eq(appUsers.id, userId));
}
