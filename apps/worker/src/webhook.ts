import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { appUsers, type DrizzleDb, loggableErrorText } from '@agentdrop/db';
import { isPublicUnicastAddress } from '@agentdrop/domain';
import { inArray } from 'drizzle-orm';
import type { DeliveryProgress } from './outbox.js';

export class WebhookAddressError extends Error {
  constructor() {
    super('WEBHOOK_ADDRESS_FORBIDDEN');
    this.name = 'WebhookAddressError';
  }
}

export type Resolver = (hostname: string, family: number) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname, family) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, family }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });

/**
 * DNS lookup for the webhook socket. Every address the name resolves to must be public (unless private networks
 * are explicitly allowed), and the socket connects to exactly the addresses checked here, so a second answer from a
 * rebinding DNS server is never consulted.
 */
export function pinnedLookup(
  allowPrivateNetwork: boolean,
  resolver: Resolver = systemResolver,
): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname, options.family === 4 || options.family === 6 ? options.family : 0).then(
      (addresses) => {
        if (
          addresses.length === 0 ||
          (!allowPrivateNetwork && addresses.some((a) => !isPublicUnicastAddress(a.address)))
        ) {
          callback(new WebhookAddressError(), '', 0);
          return;
        }
        if (options.all) (callback as (err: null, addresses: LookupAddress[]) => void)(null, addresses);
        else callback(null, addresses[0]?.address ?? '', addresses[0]?.family ?? 4);
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 0),
    );
  };
}

export interface WebhookOptions {
  allowPrivateNetwork: boolean;
  timeoutMs?: number;
  resolver?: Resolver;
  /** Called with the user id (never the URL) when a webhook is refused for pointing at a non-public address. */
  onForbidden?: (userId: string) => void;
}

/**
 * POSTs one JSON event and returns the HTTP status. https only, redirects are not followed (a 3xx is returned as a
 * status, never chased to an internal Location), and the response body is never read.
 */
export function postWebhook(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  options: WebhookOptions,
): Promise<number> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    return Promise.reject(new WebhookAddressError());
  }
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  // Literal IPs never reach the lookup function, so they are checked here.
  if (isIP(literal) !== 0 && !options.allowPrivateNetwork && !isPublicUnicastAddress(literal)) {
    return Promise.reject(new WebhookAddressError());
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        lookup: pinnedLookup(options.allowPrivateNetwork, options.resolver),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      },
      (res) => {
        // Only the status matters; do not let a receiver hold the handler open by trickling a body.
        resolve(res.statusCode ?? 0);
        res.destroy();
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

export interface NotifyContext {
  eventId: string;
  signal: AbortSignal;
  progress?: DeliveryProgress;
}

/**
 * Per-user webhook: POST a small JSON event (type, who, title/group name) to the URL the user configured in the
 * dashboard. Bodies and attachments are never included. Each user that got the event is recorded in the event's
 * progress, so a retry (caused by another user's endpoint) is not sent to them again. Failures are retried by the
 * outbox with backoff.
 */
export async function notifyUsers(
  db: DrizzleDb,
  userIds: string[],
  event: Record<string, unknown>,
  context: NotifyContext,
  options: WebhookOptions,
  post: typeof postWebhook = postWebhook,
): Promise<void> {
  if (userIds.length === 0) return;
  const rows = await db
    .select({ id: appUsers.id, url: appUsers.notificationWebhookUrl, handle: appUsers.handle })
    .from(appUsers)
    .where(inArray(appUsers.id, userIds));
  const failures: string[] = [];
  for (const u of rows) {
    if (context.signal.aborted) throw new Error('LEASE_LOST');
    const progressKey = `webhook:${u.id}`;
    if (!u.url || context.progress?.done(progressKey)) continue;
    try {
      const status = await post(
        u.url,
        JSON.stringify({
          ...event,
          event_id: context.eventId,
          to_handle: u.handle,
          at: new Date().toISOString(),
        }),
        {
          'content-type': 'application/json',
          'user-agent': 'agentdrop-worker',
          'idempotency-key': context.eventId,
        },
        context.signal,
        options,
      );
      if (status >= 200 && status < 300) await context.progress?.markDone(progressKey);
      else failures.push(`${u.id}: HTTP ${status}`);
    } catch (err) {
      if (context.signal.aborted) throw new Error('LEASE_LOST');
      // A forbidden address will not become allowed on retry: settle it instead of failing the event.
      if (err instanceof WebhookAddressError) {
        options.onForbidden?.(u.id);
        await context.progress?.markDone(progressKey);
        continue;
      }
      failures.push(`${u.id}: ${loggableErrorText(err)}`);
    }
  }
  if (failures.length) throw new Error(`webhook delivery failed: ${failures.join('; ')}`);
}
