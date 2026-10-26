import {
  AgentDropError,
  normalizeHandle,
  type ResolvedRecipient,
  type SendEnvelope,
  type SendOutcome,
  sendEnvelopeSchema,
} from '@agentdrop/contracts';
import {
  approvals,
  appUsers,
  deliveries,
  deliveryGrants,
  devices,
  dropAttachments,
  drops,
  groupBindings,
  groupMemberships,
  groups,
  harnessEndpoints,
  recipientRoutes,
  sendRequests,
  type Tx,
} from '@agentdrop/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { canSendTo } from '../contacts/contacts.js';
import { hashMatches, newRowId, sealApproval, sealDrop, storedHash } from '../content/codec.js';
import { contentCipher, writesEncrypted } from '../content/state.js';
import { contentHash } from '../crypto.js';
import { assertGroupStorageFits } from '../groups/storage.js';
import { getUserByHandle } from '../identity/users.js';
import type { MailboxScope } from '../principals.js';
import { assertReadyAttachments } from './attachments.js';
import { loadAuthorizedDrop } from './authorization.js';
import { enqueueOutbox } from './outbox.js';
import { privateRecipients } from './recipient-privacy.js';
import { bumpMailboxes } from './revision.js';
import { markReadForPerson } from './state.js';

/** Drops to and from the built-in assistant are test traffic: they expire after 30 days. */
export const SYSTEM_DROP_TTL_MS = 30 * 24 * 3600 * 1000;

export interface GrantSpec {
  kind: 'direct' | 'group';
  routeId?: string;
  groupId?: string;
  membershipId?: string;
  bindingId?: string;
}

export interface ResolvedTargets {
  /** One entry per destination H (deduplicated); several grants may point at the same H. */
  endpoints: Map<string, GrantSpec[]>;
  recipients: ResolvedRecipient[];
  /** Versions of routes/groups involved; compared again after a human approval (STALE_APPROVAL). */
  versions: Array<{ kind: 'route' | 'group' | 'user'; id: string; version: number }>;
  /**
   * Stable ids of the addressed people/groups (internal; used by approval policy and history checks). `self`: a
   * drop kept in the sender's own space (ADR 0030), frozen into the drop's target snapshot as `self: true`.
   */
  snapshot: { user_ids: string[]; group_ids: string[]; mention_user_ids: string[]; self?: boolean };
}

export interface ApprovalDecision {
  needsApproval: boolean;
  reasons: string[];
}

export interface SendOptions {
  /** Internal assistant echo only. Validated against an actual incoming drop; never populated from HTTP input. */
  assistantReplyToDropId?: string;
  originKind: 'mcp' | 'web';
  maxGroupRecipients: number;
  maxDropFileBytes?: number;
  /** Human-approval policy hook (PR-04). Default: never. */
  approvalPolicy?: (
    tx: Tx,
    ctx: { scope: MailboxScope; envelope: SendEnvelope; resolved: ResolvedTargets },
  ) => Promise<ApprovalDecision>;
  approvalUrlFor?: (approvalId: string) => string;
  approvalTtlMs?: number;
}

export interface SendUseCaseResult {
  outcome: SendOutcome;
  requestId: string;
  dropId: string | null;
  recipients: ResolvedRecipient[];
  approvalUrl: string | null;
  retryable: boolean;
  error: string | null;
}

/**
 * One reliable send. All targets succeed or nothing is written. Identity comes from `scope`; the request_id is the
 * caller's idempotency key. Everything (request, drop, deliveries, grants, mailbox revisions, outbox, audit) is
 * committed in the caller's transaction.
 */
export async function sendDrop(
  tx: Tx,
  scope: MailboxScope,
  rawEnvelope: unknown,
  opts: SendOptions,
): Promise<SendUseCaseResult> {
  const envelope = sendEnvelopeSchema.parse(rawEnvelope);
  const v1Hash = contentHash({ targets: envelope.targets, payload: envelope.payload });
  const requestHash = storedHash(v1Hash);
  await assertActiveOrigin(tx, scope);

  // 1. reserve the idempotency key (unique index serializes concurrent retries)
  const reserved = await tx
    .insert(sendRequests)
    .values({
      originHId: scope.hId,
      requestId: envelope.request_id,
      requestHash: requestHash.hash,
      hashVersion: requestHash.version,
      outcome: 'not_sent',
      result: {},
    })
    .onConflictDoNothing()
    .returning({ id: sendRequests.id });
  if (reserved.length === 0) {
    const [existing] = await tx
      .select()
      .from(sendRequests)
      .where(and(eq(sendRequests.originHId, scope.hId), eq(sendRequests.requestId, envelope.request_id)))
      .for('update');
    if (!existing) throw new AgentDropError('INTERNAL', 'idempotency row vanished');
    if (!hashMatches(v1Hash, existing.requestHash, existing.hashVersion)) {
      throw new AgentDropError('IDEMPOTENCY_CONFLICT', 'request_id reused with different content');
    }
    const result = existing.result as SendUseCaseResult;
    const stored = existing.resultDropId
      ? await tx.query.drops.findFirst({ where: eq(drops.id, existing.resultDropId) })
      : existing.approvalId
        ? await tx.query.approvals.findFirst({ where: eq(approvals.id, existing.approvalId) })
        : undefined;
    return {
      ...result,
      recipients: await privateRecipients(
        tx,
        scope.userId,
        result.recipients,
        stored?.targetSnapshot ?? {},
        existing.resultDropId,
      ),
    };
  }
  const requestRowId = reserved[0]?.id;
  if (!requestRowId) throw new AgentDropError('INTERNAL');

  // 2. resolve targets under current authorization (re-validated server side, never trusted from the client)
  const resolved = await resolveTargets(
    tx,
    scope,
    envelope,
    opts.maxGroupRecipients,
    opts.assistantReplyToDropId,
  );

  // 2b. the drop this one answers must be one the sender may read; checked again when a held send is approved
  await assertReplyTarget(tx, scope, envelope);

  // 3. attachments must be ready and owned by this H
  await assertReadyAttachments(tx, scope, envelope.payload.attachment_ids, opts.maxDropFileBytes);

  // 4. human approval gate
  const decision = opts.approvalPolicy
    ? await opts.approvalPolicy(tx, { scope, envelope, resolved })
    : { needsApproval: false, reasons: [] };
  if (decision.needsApproval) {
    const approvalId = newRowId();
    const [appr] = await tx
      .insert(approvals)
      .values({
        id: approvalId,
        actorUserId: scope.userId,
        originHId: scope.hId,
        requestId: envelope.request_id,
        contentHash: requestHash.hash,
        hashVersion: requestHash.version,
        // the envelope and the reasons (which can name attachments) are content: sealed together
        ...sealApproval(approvalId, { envelope, reasons: decision.reasons }),
        targetSnapshot: {
          recipients: resolved.recipients,
          versions: resolved.versions,
          endpoints: endpointSnapshot(resolved),
        },
        originKind: opts.originKind,
        expiresAt: new Date(Date.now() + (opts.approvalTtlMs ?? 24 * 3600 * 1000)),
      })
      .returning({ id: approvals.id });
    if (!appr) throw new AgentDropError('INTERNAL');
    const result: SendUseCaseResult = {
      outcome: 'needs_approval',
      requestId: envelope.request_id,
      dropId: null,
      recipients: resolved.recipients,
      approvalUrl: opts.approvalUrlFor ? opts.approvalUrlFor(appr.id) : null,
      retryable: false,
      error: null,
    };
    await tx
      .update(sendRequests)
      .set({ outcome: 'needs_approval', approvalId: appr.id, result, updatedAt: new Date() })
      .where(eq(sendRequests.id, requestRowId));
    await enqueueOutbox(tx, 'approval.created', appr.id, { user_id: scope.userId });
    await recordAudit(tx, {
      actorUserId: scope.userId,
      hId: scope.hId,
      action: 'drop.send',
      targetId: appr.id,
      result: 'ok',
      requestId: envelope.request_id,
      // how many, never which: a reason can name an attachment
      meta: { outcome: 'needs_approval', reason_count: decision.reasons.length },
    });
    return result;
  }

  // 5. commit
  const result = await commitDrop(tx, scope, envelope, resolved, opts.originKind, requestHash);
  await tx
    .update(sendRequests)
    .set({ outcome: 'delivered', resultDropId: result.dropId, result, updatedAt: new Date() })
    .where(eq(sendRequests.id, requestRowId));
  return result;
}

/** Writes drop → deliveries/grants → mailbox revisions → outbox → audit. Used by send and by approval commit. */
export async function commitDrop(
  tx: Tx,
  scope: MailboxScope,
  envelope: SendEnvelope,
  resolved: ResolvedTargets,
  originKind: 'mcp' | 'web',
  requestHash: { hash: string; version: number },
): Promise<SendUseCaseResult> {
  const author = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, scope.userId) });
  const origin = await assertActiveOrigin(tx, scope);
  if (!author) throw new AgentDropError('UNAUTHORIZED');
  const expiresAt = await expiryOf(tx, envelope, resolved);

  // an approval stored before the switch went on carries a v1 hash; never store that beside ciphertext
  const hash =
    writesEncrypted() && requestHash.version === 1
      ? { hash: contentCipher().contentHmac(requestHash.hash), version: 2 }
      : requestHash;
  const dropId = newRowId();
  const [drop] = await tx
    .insert(drops)
    .values({
      id: dropId,
      authorUserId: scope.userId,
      originHId: scope.hId,
      originKind,
      payloadVersion: envelope.payload.payload_version,
      kind: envelope.payload.kind,
      ...sealDrop(dropId, {
        title: envelope.payload.title,
        body: envelope.payload.body,
        extensions: envelope.payload.extensions,
      }),
      bodyChars: envelope.payload.body.length,
      authorSnapshot: {
        user_id: author.id,
        handle: author.handle,
        display_name: author.displayName,
        public_name: origin.publicName,
      },
      targetSnapshot: {
        recipients: resolved.recipients,
        versions: resolved.versions,
        endpoint_count: resolved.endpoints.size,
        user_ids: resolved.snapshot.user_ids,
        group_ids: resolved.snapshot.group_ids,
        // my own space (ADR 0030): listed only in view `space`, never in the inbox or sent
        ...(resolved.snapshot.self ? { self: true } : {}),
        // who the author called on (@handle); read back for "mentioned you" in lists and notices
        ...(resolved.snapshot.mention_user_ids.length
          ? { mention_user_ids: resolved.snapshot.mention_user_ids }
          : {}),
      },
      contentHash: hash.hash,
      hashVersion: hash.version,
      expiresAt,
      replyToDropId: envelope.payload.reply_to ?? null,
      progress: envelope.payload.progress ?? null,
    })
    .returning();
  if (!drop) throw new AgentDropError('INTERNAL', 'drop insert failed');

  if (envelope.payload.attachment_ids.length > 0) {
    await tx.insert(dropAttachments).values(
      envelope.payload.attachment_ids.map((attachmentId, ordinal) => ({
        dropId: drop.id,
        attachmentId,
        ordinal,
      })),
    );
  }

  // My own copies of a group drop are read on arrival: nobody is told about what they sent themselves. A drop I
  // address to myself on purpose (a handoff to another agent of mine) stays unread, so that agent picks it up.
  // Something kept in my own space (ADR 0030) is read on arrival everywhere: it is not a message to anyone.
  const ownAgents = new Set(
    (
      await tx
        .select({ id: harnessEndpoints.id })
        .from(harnessEndpoints)
        .where(eq(harnessEndpoints.userId, scope.userId))
    ).map((h) => h.id),
  );
  const arrivedAt = new Date();
  const events = [];
  // One state per person (ADR 0007): an explicit handoff to any own agent keeps every own copy unread.
  const addressedSelf = [...resolved.endpoints].some(
    ([hId, grants]) => ownAgents.has(hId) && grants.some((g) => g.kind === 'direct'),
  );
  for (const [hId, grants] of [...resolved.endpoints.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const readOnArrival = resolved.snapshot.self === true || (ownAgents.has(hId) && !addressedSelf);
    const [delivery] = await tx
      .insert(deliveries)
      .values({ dropId: drop.id, hId, ...(readOnArrival ? { readAt: arrivedAt } : {}) })
      .returning({ id: deliveries.id });
    if (!delivery) throw new AgentDropError('INTERNAL');
    await tx.insert(deliveryGrants).values(
      grants.map((g) => ({
        deliveryId: delivery.id,
        kind: g.kind,
        routeId: g.routeId ?? null,
        groupId: g.groupId ?? null,
        membershipId: g.membershipId ?? null,
        bindingId: g.bindingId ?? null,
      })),
    );
    events.push({ hId, type: 'delivery.created' as const, dropId: drop.id, deliveryId: delivery.id });
  }
  // ADR 0016: answering a drop, or posting in a group, is the person catching up. Bumped together with the new
  // deliveries so mailbox heads are locked once, in order.
  const caughtUp = await dropsAnsweredBy(tx, scope.userId, envelope, resolved, drop);
  const stateEvents = await markReadForPerson(tx, scope.userId, caughtUp);
  // The author's own streams learn of the new drop too (ADR 0040), so a sent view open elsewhere (another agent's
  // send, a held send approved later) shows it at once: written to the sending agent, as for any receipt.
  const sent = { hId: scope.hId, type: 'sent.changed' as const, dropId: drop.id };
  await bumpMailboxes(tx, [...events, sent, ...stateEvents]);
  const recipientUserIds = [
    ...new Set(
      (
        await tx
          .select({ userId: harnessEndpoints.userId })
          .from(harnessEndpoints)
          .where(inArray(harnessEndpoints.id, [...resolved.endpoints.keys()]))
      ).map((r) => r.userId),
    ),
  ];
  await enqueueOutbox(tx, 'drop.delivered', drop.id, {
    endpoint_count: resolved.endpoints.size,
    user_ids: recipientUserIds,
    from_handle: author.handle,
    from_display_name: author.displayName,
    // Notices read the title from the drop. Kept only for plaintext rows so an older worker still shows it
    // after a rollback; encrypted rows never put content into the outbox.
    ...(writesEncrypted() ? {} : { title: envelope.payload.title }),
  });
  await recordAudit(tx, {
    actorUserId: scope.userId,
    hId: scope.hId,
    action: 'drop.send',
    targetId: drop.id,
    result: 'ok',
    requestId: envelope.request_id,
    meta: {
      outcome: 'delivered',
      endpoints: resolved.endpoints.size,
      body_chars: drop.bodyChars,
      ...(stateEvents.length
        ? {
            marked_read: new Set(stateEvents.filter((e) => e.type === 'delivery.state').map((e) => e.dropId))
              .size,
          }
        : {}),
    },
  });
  return {
    outcome: 'delivered',
    requestId: envelope.request_id,
    dropId: drop.id,
    recipients: resolved.recipients,
    approvalUrl: null,
    retryable: false,
    error: null,
  };
}

/**
 * `payload.reply_to` must name a drop the sender may read now, under the one authorization predicate (account-wide
 * reads included). Anything else, existing or not, is the same VALIDATION_FAILED: the answer never says which.
 */
export async function assertReplyTarget(tx: Tx, scope: MailboxScope, envelope: SendEnvelope): Promise<void> {
  const replyTo = envelope.payload.reply_to;
  // progress says where the answered drop's work stands (ADR 0038): it means nothing without the drop it answers
  if (envelope.payload.progress && !replyTo)
    throw new AgentDropError(
      'VALIDATION_FAILED',
      'progress needs reply_to: it says where an answered drop stands',
      {
        field: 'progress',
      },
    );
  if (!replyTo) return;
  try {
    await loadAuthorizedDrop(tx, scope, replyTo);
  } catch (err) {
    if (err instanceof AgentDropError && err.code === 'NOT_FOUND')
      throw new AgentDropError('VALIDATION_FAILED', 'reply_to must be a drop you can read', {
        field: 'reply_to',
      });
    throw err;
  }
}

/**
 * What a send answers for its author (ADR 0016): the drop named in `reply_to`, and for every group target each
 * earlier drop that reached the author through that group (a live group grant on a delivery of theirs), mentions
 * included. Only drops still unread somewhere are returned; the new drop itself never is.
 */
async function dropsAnsweredBy(
  tx: Tx,
  userId: string,
  envelope: SendEnvelope,
  resolved: ResolvedTargets,
  drop: typeof drops.$inferSelect,
): Promise<string[]> {
  const ids = new Set<string>();
  if (envelope.payload.reply_to) ids.add(envelope.payload.reply_to);
  if (resolved.snapshot.group_ids.length > 0) {
    const rows = await tx
      .selectDistinct({ id: deliveries.dropId })
      .from(deliveries)
      .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, deliveries.hId))
      .innerJoin(deliveryGrants, eq(deliveryGrants.deliveryId, deliveries.id))
      .innerJoin(drops, eq(drops.id, deliveries.dropId))
      .where(
        and(
          eq(harnessEndpoints.userId, userId),
          isNull(deliveries.readAt),
          eq(deliveryGrants.kind, 'group'),
          inArray(deliveryGrants.groupId, resolved.snapshot.group_ids),
          isNull(deliveryGrants.revokedAt),
          isNull(drops.revokedAt),
          // compared in the database: the new row's microsecond timestamp, not a millisecond JS copy of it
          sql`${drops.createdAt} < (select x.created_at from ${drops} x where x.id = ${drop.id})`,
        ),
      );
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

/**
 * The requested expiry, capped at SYSTEM_DROP_TTL_MS when every addressed person is the built-in assistant (no
 * group involved), so test drops do not stay in anyone's mailbox for good.
 */
async function expiryOf(tx: Tx, envelope: SendEnvelope, resolved: ResolvedTargets): Promise<Date | null> {
  const requested = envelope.payload.expires_at ? new Date(envelope.payload.expires_at) : null;
  const userIds = resolved.snapshot.user_ids;
  if (resolved.snapshot.group_ids.length > 0 || userIds.length === 0) return requested;
  const system = await tx
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(and(inArray(appUsers.id, userIds), eq(appUsers.isSystem, true)));
  if (system.length !== userIds.length) return requested;
  const cap = new Date(Date.now() + SYSTEM_DROP_TTL_MS);
  return requested && requested.getTime() < cap.getTime() ? requested : cap;
}

/**
 * Lock the sender before target resolution (endpoint revocation locks H before its routes).
 * Web history scopes may include revoked H, but must never authorize new sends or approval commits.
 */
export async function assertActiveOrigin(tx: Tx, scope: MailboxScope) {
  const [origin] = await tx
    .select()
    .from(harnessEndpoints)
    .where(eq(harnessEndpoints.id, scope.hId))
    .for('share');
  if (!origin || origin.userId !== scope.userId) throw new AgentDropError('UNAUTHORIZED');
  const device = await tx.query.devices.findFirst({ where: eq(devices.id, origin.deviceId) });
  if (!device || device.userId !== scope.userId) throw new AgentDropError('UNAUTHORIZED');
  // Device revocation first revokes its endpoints, so the held H lock also serializes that operation.
  if (origin.revokedAt || device.revokedAt) throw new AgentDropError('ENDPOINT_REVOKED');
  return origin;
}

/**
 * Turns client targets into destination endpoints under the sender's *current* authorization.
 *   user  → my remembered preference (must still be published) or the peer's default route
 *   route → a named route published to contacts by someone I may send to
 *   group → every active member's non-revoked bindings; a member without a usable binding aborts the send
 */
export async function resolveTargets(
  tx: Tx,
  scope: MailboxScope,
  envelope: SendEnvelope,
  maxGroupRecipients: number,
  assistantReplyToDropId?: string,
): Promise<ResolvedTargets> {
  const endpoints = new Map<string, GrantSpec[]>();
  const recipients: ResolvedRecipient[] = [];
  const versions: ResolvedTargets['versions'] = [];
  const snapshot = { user_ids: [] as string[], group_ids: [] as string[], mention_user_ids: [] as string[] };
  /** Active members of the targeted groups, for validating `payload.mentions`. */
  const groupMemberIds = new Set<string>();
  const addGrant = (hId: string, grant: GrantSpec) => {
    const list = endpoints.get(hId) ?? [];
    list.push(grant);
    endpoints.set(hId, list);
  };

  // Calling on people belongs to one group conversation: with another target beside it, the mentions would travel
  // to people outside the group too. Refused before anything is resolved, so nothing is sent.
  const distinctTargets = new Set(envelope.targets.map(targetKey));
  if (
    (envelope.payload.mentions ?? []).some((h) => normalizeHandle(h)) &&
    (distinctTargets.size !== 1 || envelope.targets[0]?.type !== 'group')
  )
    throw new AgentDropError('VALIDATION_FAILED', 'mentions need exactly one target, a group', {
      field: 'mentions',
    });
  // My own space (ADR 0030) stands alone: it reaches every agent of mine and nobody else, so another target beside
  // it would mix a note to myself with a message to someone.
  if (envelope.targets.some((t) => t.type === 'self')) {
    if (distinctTargets.size !== 1)
      throw new AgentDropError('VALIDATION_FAILED', 'a self target cannot be combined with other targets', {
        field: 'targets',
      });
    const me = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, scope.userId) });
    if (!me) throw new AgentDropError('UNAUTHORIZED');
    // every live agent of mine, each with its own direct grant: readable from each even with account-wide reads off
    const reached = await allAgentRoutes(tx, me.id);
    for (const route of reached) {
      versions.push({ kind: 'route', id: route.id, version: route.version });
      addGrant(route.destinationHId, { kind: 'direct', routeId: route.id });
    }
    snapshot.user_ids.push(me.id);
    // the owner's own attribution (ADR 0013): how many of my agents hold it is mine to know
    recipients.push({
      type: 'user',
      label: `@${me.handle}`,
      endpoint_count: reached.length,
      address: `@${me.handle}`,
      endpoint_label: null,
      harness_key: null,
    });
    return { endpoints, recipients, versions, snapshot: { ...snapshot, self: true } };
  }
  // Fixed lock order: groups sorted by id (and deduplicated) so concurrent [A,B] / [B,A] sends cannot deadlock.
  const orderedTargets = [...envelope.targets].sort((a, b) => targetKey(a).localeCompare(targetKey(b)));
  const seenTargets = new Set<string>();
  for (const target of orderedTargets) {
    const key = targetKey(target);
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    if (target.type === 'user') {
      const peer = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, target.user_id) });
      if (!peer) throw new AgentDropError('NOT_FOUND', 'recipient not found');
      const allowed = await canSendTo(tx, scope.userId, peer.id);
      if (!allowed.allowed) throw new AgentDropError(allowed.reason, undefined, { user_id: peer.id });
      if (!snapshot.user_ids.includes(peer.id)) snapshot.user_ids.push(peer.id);
      const preferred = await preferredRoute(tx, scope.userId, peer.id);
      if (!preferred && peer.directReceiveAll) {
        // ADR 0008: a plain send to a person reaches every agent of theirs, each with its own delivery.
        const reached = await allAgentRoutes(tx, peer.id);
        for (const route of reached) {
          versions.push({ kind: 'route', id: route.id, version: route.version });
          addGrant(route.destinationHId, { kind: 'direct', routeId: route.id });
        }
        recipients.push(
          peer.id === scope.userId
            ? {
                type: 'user',
                label: `@${peer.handle}`,
                endpoint_count: reached.length,
                address: `@${peer.handle}`,
                endpoint_label: null,
                harness_key: null,
              }
            : personRecipient('user', `@${peer.handle}`),
        );
      } else {
        const route = preferred ?? (await defaultUserRoute(tx, peer.id));
        versions.push({ kind: 'route', id: route.id, version: route.version });
        addGrant(route.destinationHId, { kind: 'direct', routeId: route.id });
        if (peer.id === scope.userId) {
          const where = await describeDestination(tx, peer.handle, route);
          recipients.push({
            type: 'user',
            label: route.alias ? `@${peer.handle}/${route.alias}` : (where.address ?? `@${peer.handle}`),
            endpoint_count: 1,
            ...where,
          });
        } else {
          // a remembered named entry is shown by its public name; the receiver's own default by the person only
          recipients.push(
            personRecipient(
              'user',
              preferred?.alias ? `@${peer.handle}/${preferred.alias}` : `@${peer.handle}`,
            ),
          );
        }
      }
    } else if (target.type === 'route') {
      const [route] = await tx
        .select()
        .from(recipientRoutes)
        .where(eq(recipientRoutes.id, target.route_id))
        .for('update');
      if (!route || route.revokedAt || route.isDefault) throw new AgentDropError('ROUTE_UNAVAILABLE');
      const owner = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, route.userId) });
      if (!owner) throw new AgentDropError('ROUTE_UNAVAILABLE');
      if (route.userId !== scope.userId) {
        // another person's automatic per-agent address is private (ADR 0013): only published entries are targets
        const internalReply =
          route.auto && assistantReplyToDropId
            ? await isAssistantReturnRoute(tx, scope, assistantReplyToDropId, route)
            : false;
        if (route.visibility !== 'contacts' || (route.auto && !internalReply))
          throw new AgentDropError('ROUTE_UNAVAILABLE');
        const allowed = await canSendTo(tx, scope.userId, route.userId);
        if (!allowed.allowed) throw new AgentDropError(allowed.reason);
      }
      await assertEndpointReceivable(tx, route.destinationHId);
      versions.push({ kind: 'route', id: route.id, version: route.version });
      if (!snapshot.user_ids.includes(route.userId)) snapshot.user_ids.push(route.userId);
      addGrant(route.destinationHId, { kind: 'direct', routeId: route.id });
      const label = `@${owner.handle}/${route.alias}`;
      recipients.push(
        route.userId === scope.userId
          ? {
              type: 'route',
              label,
              endpoint_count: 1,
              ...(await describeDestination(tx, owner.handle, route)),
            }
          : personRecipient('route', label),
      );
    } else if (target.type === 'group') {
      // group: lock the group row so membership changes and fan-out serialize
      const [group] = await tx.select().from(groups).where(eq(groups.id, target.group_id)).for('update');
      if (!group) throw new AgentDropError('NOT_FOUND', 'group not found');
      const me = await tx.query.groupMemberships.findFirst({
        where: and(
          eq(groupMemberships.groupId, group.id),
          eq(groupMemberships.userId, scope.userId),
          eq(groupMemberships.status, 'active'),
        ),
      });
      if (!me) throw new AgentDropError('NOT_FOUND', 'group not found');
      const members = await tx
        .select()
        .from(groupMemberships)
        .where(and(eq(groupMemberships.groupId, group.id), eq(groupMemberships.status, 'active')));
      for (const m of members) groupMemberIds.add(m.userId);
      for (const m of members) {
        const bindings = await tx
          .select({ b: groupBindings, hRevoked: harnessEndpoints.revokedAt })
          .from(groupBindings)
          .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, groupBindings.hId))
          .where(and(eq(groupBindings.membershipId, m.id), isNull(groupBindings.revokedAt)));
        const usable = bindings.filter((b) => b.hRevoked === null);
        if (usable.length === 0) {
          // who cannot receive is for owners/admins (and the member themselves) to repair, as on the group page
          const mayName = me.role === 'owner' || me.role === 'admin' || m.userId === scope.userId;
          const who = mayName
            ? await tx.query.appUsers.findFirst({ where: eq(appUsers.id, m.userId) })
            : undefined;
          throw new AgentDropError(
            'GROUP_RECIPIENT_UNAVAILABLE',
            'an active member has no receiving endpoint',
            {
              group_id: group.id,
              ...(mayName ? { member_handle: who?.handle ?? null } : {}),
            },
          );
        }
        for (const { b } of usable) {
          addGrant(b.hId, { kind: 'group', groupId: group.id, membershipId: m.id, bindingId: b.id });
        }
      }
      // Under the group lock taken above, in this transaction: race-free against other sends and removals (ADR 0029).
      await assertGroupStorageFits(tx, group.id, scope.hId, envelope.payload.attachment_ids);
      versions.push({ kind: 'group', id: group.id, version: group.version });
      if (!snapshot.group_ids.includes(group.id)) snapshot.group_ids.push(group.id);
      recipients.push({
        type: 'group',
        label: `#${group.slug}`,
        // people other than me, not agents: members' agent counts are private (ADR 0013)
        endpoint_count: members.filter((m) => m.userId !== scope.userId).length,
        address: null,
        endpoint_label: null,
        harness_key: null,
      });
    }
  }
  if (endpoints.size === 0) throw new AgentDropError('NO_DELIVERY_ROUTE');
  snapshot.mention_user_ids = await resolveMentions(
    tx,
    scope,
    envelope.payload.mentions ?? [],
    groupMemberIds,
  );
  // the limit applies to the aggregate set of distinct destination endpoints, not per group
  if (snapshot.group_ids.length > 0 && endpoints.size > maxGroupRecipients) {
    // the total would let a member work out how many agents the others have (ADR 0013); only the limit is told
    throw new AgentDropError('TOO_MANY_RECIPIENTS', undefined, { limit: maxGroupRecipients });
  }
  return { endpoints, recipients, versions, snapshot };
}

function targetKey(t: SendEnvelope['targets'][number]): string {
  // groups first (locked rows), then routes, then users
  if (t.type === 'self') return '3:self';
  return t.type === 'group' ? `0:${t.group_id}` : t.type === 'route' ? `1:${t.route_id}` : `2:${t.user_id}`;
}

/**
 * Private snapshot of the resolved destinations used to detect a stale approval: every destination endpoint with
 * its grant provenance. Never returned to clients (it would reveal other people's endpoints).
 */
export function endpointSnapshot(resolved: ResolvedTargets): Array<[string, GrantSpec[]]> {
  return [...resolved.endpoints.entries()]
    .map(
      ([hId, grants]) =>
        [hId, [...grants].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))] as [
          string,
          GrantSpec[],
        ],
    )
    .sort(([a], [b]) => a.localeCompare(b));
}

/** Names the concrete agent a route lands on: its automatic address, agent name and harness (never the device). */
/**
 * `payload.mentions` → user ids. Each handle must name an active member of the one targeted group (resolveTargets
 * refuses mentions beside any other target); a direct message already reaches the one person. The author is
 * dropped silently.
 */
async function resolveMentions(
  tx: Tx,
  scope: MailboxScope,
  rawHandles: string[],
  groupMemberIds: Set<string>,
): Promise<string[]> {
  const handles = [...new Set(rawHandles.map(normalizeHandle).filter(Boolean))];
  if (handles.length === 0) return [];
  if (groupMemberIds.size === 0)
    throw new AgentDropError('VALIDATION_FAILED', 'mentions need a group target', { field: 'mentions' });
  const ids: string[] = [];
  for (const handle of handles) {
    const user = await getUserByHandle(tx, handle);
    if (!user || !groupMemberIds.has(user.id))
      throw new AgentDropError(
        'VALIDATION_FAILED',
        'a mentioned handle is not an active member of the group',
        {
          field: 'mentions',
          handle,
        },
      );
    if (user.id !== scope.userId && !ids.includes(user.id)) ids.push(user.id);
  }
  return ids;
}

/**
 * How another person (or their published entry) appears in a send result: the person only. Which agents received
 * it, and how many, is theirs to know (ADR 0013); `endpoint_count` counts the one person.
 */
function personRecipient(type: 'user' | 'route', label: string): ResolvedRecipient {
  return { type, label, endpoint_count: 1, address: label, endpoint_label: null, harness_key: null };
}

async function isAssistantReturnRoute(
  tx: Tx,
  scope: MailboxScope,
  dropId: string,
  route: typeof recipientRoutes.$inferSelect,
): Promise<boolean> {
  const actor = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, scope.userId) });
  if (!actor?.isSystem || scope.via !== 'user_session') return false;
  const incoming = await tx.query.drops.findFirst({ where: eq(drops.id, dropId) });
  if (
    !incoming ||
    incoming.revokedAt ||
    incoming.authorUserId !== route.userId ||
    incoming.originHId !== route.destinationHId
  )
    return false;
  const received = await tx.query.deliveries.findFirst({
    where: and(eq(deliveries.dropId, dropId), eq(deliveries.hId, scope.hId)),
  });
  const snapshot = incoming.targetSnapshot as { user_ids?: string[] };
  return !!received && !!snapshot.user_ids?.includes(scope.userId);
}

async function describeDestination(
  tx: Tx,
  handle: string,
  route: typeof recipientRoutes.$inferSelect,
): Promise<Pick<ResolvedRecipient, 'address' | 'endpoint_label' | 'harness_key'>> {
  const h = await tx.query.harnessEndpoints.findFirst({
    where: eq(harnessEndpoints.id, route.destinationHId),
  });
  if (!h) return { address: null, endpoint_label: null, harness_key: null };
  const auto = route.auto
    ? route
    : await tx.query.recipientRoutes.findFirst({
        where: and(
          eq(recipientRoutes.destinationHId, h.id),
          eq(recipientRoutes.auto, true),
          isNull(recipientRoutes.revokedAt),
        ),
      });
  const alias = auto?.alias ?? route.alias;
  return {
    address: alias ? `@${handle}/${alias}` : `@${handle}`,
    endpoint_label: h.label,
    harness_key: h.harnessKey,
  };
}

/** The sender's remembered entry for this person, if any; it wins, and fails loudly once it is gone. */
async function preferredRoute(tx: Tx, senderUserId: string, peerUserId: string) {
  const pref = await tx.execute<{ preferred_route_id: string | null }>(sql`
    select preferred_route_id from contacts where owner_user_id = ${senderUserId} and peer_user_id = ${peerUserId}`);
  const preferredId = pref.rows[0]?.preferred_route_id ?? null;
  if (!preferredId) return null;
  const [route] = await tx
    .select()
    .from(recipientRoutes)
    .where(eq(recipientRoutes.id, preferredId))
    .for('update');
  // a remembered automatic address predates ADR 0013: it is no longer choosable, so the person decides again
  if (route?.auto && route.userId === peerUserId) return null;
  if (!route || route.revokedAt || route.userId !== peerUserId || route.visibility !== 'contacts') {
    throw new AgentDropError('PREFERRED_ROUTE_UNAVAILABLE', undefined, { user_id: peerUserId });
  }
  await assertEndpointReceivable(tx, route.destinationHId, 'PREFERRED_ROUTE_UNAVAILABLE');
  return route;
}

async function defaultUserRoute(tx: Tx, peerUserId: string) {
  const [route] = await tx
    .select()
    .from(recipientRoutes)
    .where(
      and(
        eq(recipientRoutes.userId, peerUserId),
        eq(recipientRoutes.isDefault, true),
        isNull(recipientRoutes.revokedAt),
      ),
    )
    .for('update');
  if (!route) throw new AgentDropError('NO_DELIVERY_ROUTE', undefined, { user_id: peerUserId });
  await assertEndpointReceivable(tx, route.destinationHId, 'NO_DELIVERY_ROUTE');
  return route;
}

/**
 * One route per live agent of the person, used as the provenance of each direct grant: the default route when it
 * points at that agent, else the agent's own automatic address. Pairing always creates the latter.
 */
async function allAgentRoutes(tx: Tx, peerUserId: string) {
  const live = await tx
    .select({ r: recipientRoutes })
    .from(recipientRoutes)
    .innerJoin(harnessEndpoints, eq(harnessEndpoints.id, recipientRoutes.destinationHId))
    .where(
      and(
        eq(recipientRoutes.userId, peerUserId),
        isNull(recipientRoutes.revokedAt),
        isNull(harnessEndpoints.revokedAt),
      ),
    )
    .orderBy(recipientRoutes.id)
    .for('update', { of: recipientRoutes });
  const byAgent = new Map<string, typeof recipientRoutes.$inferSelect>();
  for (const { r } of live) {
    const current = byAgent.get(r.destinationHId);
    if (!current || r.isDefault || (r.auto && !current.isDefault)) byAgent.set(r.destinationHId, r);
  }
  if (byAgent.size === 0) throw new AgentDropError('NO_DELIVERY_ROUTE', undefined, { user_id: peerUserId });
  return [...byAgent.values()];
}

async function assertEndpointReceivable(
  tx: Tx,
  hId: string,
  code: 'NO_DELIVERY_ROUTE' | 'ROUTE_UNAVAILABLE' | 'PREFERRED_ROUTE_UNAVAILABLE' = 'ROUTE_UNAVAILABLE',
): Promise<void> {
  const h = await tx.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, hId) });
  if (!h || h.revokedAt) throw new AgentDropError(code, 'destination endpoint is revoked');
}
