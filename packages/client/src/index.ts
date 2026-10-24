import {
  AgentDropError,
  type ApiError,
  apiErrorSchema,
  type ContactRemoveResult,
  type contactRequestInputSchema,
  type contactRespondInputSchema,
  type contactResultSchema,
  type DirectoryLookupInput,
  type DirectoryLookupResult,
  type ErrorCode,
  type EventsInput,
  type EventsResult,
  type ExportInput,
  type groupCreateInputSchema,
  type groupInviteInputSchema,
  type groupLeaveInputSchema,
  type groupRespondInputSchema,
  type groupResultSchema,
  type Identity,
  type ListDropsInput,
  type ListDropsResult,
  type MarkAllReadInput,
  type markAllReadResultSchema,
  type NoticeState,
  type PairingPollResult,
  type PairingStartInput,
  type PairingStartResult,
  type pendingRequestsResultSchema,
  type ReadDropInput,
  type ReadDropResult,
  type SendDropInput,
  type SendResult,
  type SetDropStateInput,
  type SetDropStateResult,
  type SpaceDeleteResult,
  type Viewer,
} from '@agentdrop/contracts';
import type { z } from 'zod';
import { applyProxyBypass } from './proxy.js';

type BodyInit = NonNullable<RequestInit['body']>;

export interface FeishuStatus {
  connected: boolean;
  url_hint: string | null;
  has_secret: boolean;
  language: 'en' | 'zh' | null;
}

/** An export is minutes of rows, not a JSON call; the default request deadline would truncate it. */
export const EXPORT_TIMEOUT_MS = 10 * 60 * 1000;

export type PendingRequestsResult = z.infer<typeof pendingRequestsResultSchema>;
export type ContactRequestInput = z.infer<typeof contactRequestInputSchema>;
export type ContactRespondInput = z.infer<typeof contactRespondInputSchema>;
export type ContactResult = z.infer<typeof contactResultSchema>;
export type GroupCreateInput = z.infer<typeof groupCreateInputSchema>;
export type GroupInviteInput = z.infer<typeof groupInviteInputSchema>;
export type GroupRespondInput = z.infer<typeof groupRespondInputSchema>;
export type GroupLeaveInput = z.infer<typeof groupLeaveInputSchema>;
export type GroupResult = z.infer<typeof groupResultSchema>;

export interface ApprovalSummary {
  approval_id: string;
  request_id: string;
  origin_h_id: string;
  status: string;
  title: string;
  body_preview: string;
  attachment_ids: string[];
  recipients: Array<{ type: string; label: string; endpoint_count: number }>;
  reasons: string[];
  created_at: string;
  expires_at: string;
}

export interface ApiClientOptions {
  baseUrl: string;
  credential?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  headers?: Record<string, string>;
  rawBody?: BodyInit;
  /** Required by fetch when streaming a request body. */
  duplex?: 'half';
  /** Ends the request early, e.g. a long-poll whose owner is shutting down. */
  signal?: AbortSignal;
}

/**
 * The system error code under a failed fetch (`ECONNREFUSED`, `ENOTFOUND`, `ERR_SSL_WRONG_VERSION_NUMBER`,
 * `UND_ERR_CONNECT_TIMEOUT`…), so a caller can tell a person what went wrong; `TIMEOUT` for our own deadline. Only
 * the code word is kept: never a message, which may hold an address.
 */
function causeCode(err: unknown, aborted: boolean): { cause_code?: string } {
  if (aborted) return { cause_code: 'TIMEOUT' };
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(code)) return { cause_code: code };
    current = (current as { cause?: unknown }).cause;
  }
  return {};
}

/**
 * Typed HTTPS client used by the bridge and the CLI. Errors are surfaced as AgentDropError with the server's
 * stable code; transport failures become NETWORK_ERROR (result unknown) or UPSTREAM_UNAVAILABLE.
 */
export class ApiClient {
  readonly baseUrl: string;
  private readonly credential: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.credential = opts.credential;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.userAgent = opts.userAgent ?? 'agentdrop-client';
    // Decided here because this is the one place that always knows the server URL, and it must happen before
    // the first request: an AgentDrop server on a private address is unreachable through a forward proxy.
    if (opts.fetch === undefined) applyProxyBypass(this.baseUrl);
  }

  withCredential(credential: string): ApiClient {
    return new ApiClient({
      baseUrl: this.baseUrl,
      credential,
      fetch: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      userAgent: this.userAgent,
    });
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.userAgent,
      ...opts.headers,
    };
    if (this.credential) headers.authorization = `Bearer ${this.credential}`;
    let body: BodyInit | undefined;
    if (opts.rawBody !== undefined) body = opts.rawBody;
    else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);
    // The caller's signal may outlive many requests (a bridge's lifetime): the listener goes when this one ends.
    const onAbort = () => controller.abort();
    if (opts.signal?.aborted) controller.abort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    let res: Response;
    try {
      const init: RequestInit = { method, headers, signal: controller.signal, redirect: 'manual' };
      if (body !== undefined) init.body = body;
      res = await this.fetchImpl(url, init);
    } catch (err) {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new AgentDropError('NETWORK_ERROR', aborted ? 'request timed out' : 'network error', {
        cause: err instanceof Error ? err.message : String(err),
        ...causeCode(err, aborted),
      });
    }
    try {
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        try {
          return (await res.json()) as T;
        } catch (err) {
          // the server may have committed: callers (send_drop) must treat this as an unknown outcome
          throw new AgentDropError(
            'NETWORK_ERROR',
            controller.signal.aborted ? 'request timed out' : 'malformed response body',
            {
              cause: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
      let parsed: ApiError | undefined;
      /** A code this client does not know yet: a newer server. Never guess that it is retryable. */
      let unknownCode: string | undefined;
      try {
        const json = await res.json();
        const p = apiErrorSchema.safeParse(json);
        if (p.success) parsed = p.data;
        else if (json && typeof json === 'object' && typeof (json as { code?: unknown }).code === 'string')
          unknownCode = (json as { code: string; message?: string }).code;
      } catch {
        if (controller.signal.aborted) throw new AgentDropError('NETWORK_ERROR', 'request timed out');
        parsed = undefined;
      }
      if (parsed) throw new AgentDropError(parsed.code as ErrorCode, parsed.message, parsed.details);
      if (res.status >= 500)
        throw new AgentDropError('UPSTREAM_UNAVAILABLE', `server responded ${res.status}`);
      if (res.status === 429) throw new AgentDropError('RATE_LIMITED');
      if (res.status === 401) throw new AgentDropError('UNAUTHORIZED');
      if (res.status === 403) throw new AgentDropError('FORBIDDEN');
      if (res.status === 404) throw new AgentDropError('NOT_FOUND');
      // A refusal this client cannot name is still a refusal: report it as-is instead of as a retryable fault.
      if (unknownCode)
        throw new AgentDropError('VALIDATION_FAILED', `server refused the request (${unknownCode})`, {
          server_code: unknownCode,
        });
      throw new AgentDropError('INTERNAL', `unexpected response ${res.status}`, { status: res.status });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Streams a raw response (attachment download, export). Caller must consume or cancel the body. */
  async requestRaw(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { 'user-agent': this.userAgent, ...opts.headers };
    if (this.credential) headers.authorization = `Bearer ${this.credential}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);
    let res: Response;
    try {
      const init: RequestInit & { duplex?: 'half' } = {
        method,
        headers,
        signal: controller.signal,
        redirect: 'manual',
      };
      if (opts.rawBody !== undefined) init.body = opts.rawBody;
      if (opts.duplex) init.duplex = opts.duplex;
      res = await this.fetchImpl(url, init);
    } catch (err) {
      clearTimeout(timer);
      throw new AgentDropError('NETWORK_ERROR', 'network error', {
        cause: err instanceof Error ? err.message : String(err),
        ...causeCode(err, false),
      });
    }
    if (!res.ok) {
      let parsed: ApiError | undefined;
      try {
        const p = apiErrorSchema.safeParse(await res.json());
        if (p.success) parsed = p.data;
      } catch {
        if (controller.signal.aborted) throw new AgentDropError('NETWORK_ERROR', 'request timed out');
        parsed = undefined;
      } finally {
        clearTimeout(timer);
      }
      if (parsed) throw new AgentDropError(parsed.code as ErrorCode, parsed.message, parsed.details);
      throw new AgentDropError(
        res.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'INTERNAL',
        `unexpected response ${res.status}`,
      );
    }
    // the timer is not cleared here on purpose: streaming must also finish within the timeout
    // A consumed/cancelled response must not keep a Node process alive until that deadline.
    timer.unref?.();
    return res;
  }

  /* ---------------------------------------------------------------- public */
  healthLive(): Promise<{ status: 'ok'; version: string }> {
    return this.request('GET', '/health/live');
  }
  healthReady(): Promise<{ status: 'ready' | 'not_ready'; checks: Record<string, 'ok' | 'fail'> }> {
    return this.request('GET', '/health/ready');
  }
  pairingStart(input: PairingStartInput): Promise<PairingStartResult> {
    return this.request('POST', '/v1/pairing/start', { body: input });
  }
  pairingPoll(deviceCode: string): Promise<PairingPollResult> {
    return this.request('POST', '/v1/pairing/poll', { body: { device_code: deviceCode } });
  }

  /* ---------------------------------------------------------------- H credential */
  identity(): Promise<Identity> {
    return this.request('GET', '/v1/h/identity');
  }
  /** What end-of-turn notices already showed this account, shared by all of its agents. */
  noticeState(): Promise<{ state: NoticeState | null }> {
    return this.request('GET', '/v1/h/notice-state');
  }
  putNoticeState(state: NoticeState): Promise<{ state: NoticeState }> {
    return this.request('PUT', '/v1/h/notice-state', { body: state });
  }
  /** Record what is pending now as shown, atomically, and get the record from before. */
  claimNoticeState(current: NoticeState): Promise<{ previous: NoticeState | null }> {
    return this.request('POST', '/v1/h/notice-state/claim', { body: current });
  }
  /**
   * What this account has already seen inside an agent session, shared by all of its agents. Separate from
   * noticeState: browser push and Feishu never write it. An older server answers NOT_FOUND.
   */
  seenNoticeState(): Promise<{ state: NoticeState | null }> {
    return this.request('GET', '/v1/h/notice-state/seen');
  }
  /**
   * Record what is pending now as seen in an agent, atomically, and get the seen record from before; the server
   * also records it as shown (noticeState). An older server answers NOT_FOUND.
   */
  claimSeenNoticeState(current: NoticeState): Promise<{ previous: NoticeState | null }> {
    return this.request('POST', '/v1/h/notice-state/seen/claim', { body: current });
  }
  connectionOpen(input: {
    client_name: string | null;
    client_version: string | null;
    capabilities: Record<string, unknown>;
    bridge_version: string;
    toolset: 'core' | 'standard';
  }): Promise<{ connection_id: string; heartbeat_interval_s: number; viewer: Viewer }> {
    return this.request('POST', '/v1/h/connections', { body: input });
  }
  connectionHeartbeat(connectionId: string, lastTool?: string | null): Promise<{ ok: true }> {
    return this.request('POST', '/v1/h/connections/heartbeat', {
      body: { connection_id: connectionId, last_tool: lastTool ?? null },
    });
  }
  connectionClose(connectionId: string): Promise<{ ok: true }> {
    return this.request('POST', '/v1/h/connections/close', { body: { connection_id: connectionId } });
  }
  directoryLookup(input: DirectoryLookupInput): Promise<DirectoryLookupResult> {
    return this.request('GET', '/v1/h/directory', { query: { ...input } });
  }
  listDrops(input: ListDropsInput): Promise<ListDropsResult> {
    return this.request('GET', '/v1/h/drops', { query: { ...input } });
  }
  /** The person's event stream, long-poll form (ADR 0040). The deadline covers the server-side wait. */
  events(input: EventsInput, signal?: AbortSignal): Promise<EventsResult> {
    return this.request('GET', '/v1/h/events', {
      query: { ...input },
      timeoutMs: ((input.wait ?? 0) + 15) * 1000,
      ...(signal ? { signal } : {}),
    });
  }
  readDrop(input: ReadDropInput, connectionId?: string | null): Promise<ReadDropResult> {
    const { drop_id, ...rest } = input;
    return this.request('GET', `/v1/h/drops/${encodeURIComponent(drop_id)}`, {
      query: { ...rest },
      ...(connectionId ? { headers: { 'x-connection-id': connectionId } } : {}),
    });
  }
  /** Marks the person's unread drops read: all, or one group's, up to `up_to` (ADR 0018). */
  markAllRead(input: MarkAllReadInput): Promise<z.infer<typeof markAllReadResultSchema>> {
    return this.request('POST', '/v1/h/drops/mark-read', { body: input });
  }
  sendDrop(input: SendDropInput, timeoutMs?: number): Promise<SendResult> {
    return this.request('POST', '/v1/h/drops', { body: input, ...(timeoutMs ? { timeoutMs } : {}) });
  }
  /**
   * Date-ranged NDJSON export, streamed like an attachment download and with the same long deadline: the timer
   * covers the whole body, and the 30s default would silently cut a real export into a file that still parses.
   * The caller must verify the trailer; a truncated NDJSON stream is indistinguishable from a complete one.
   */
  exportTimeline(input: ExportInput, timeoutMs: number = EXPORT_TIMEOUT_MS): Promise<Response> {
    return this.requestRaw('GET', '/v1/h/export', {
      query: { ...input },
      timeoutMs,
      headers: { accept: 'application/x-ndjson' },
    });
  }
  setDropState(input: SetDropStateInput): Promise<SetDropStateResult> {
    const { drop_id, ...rest } = input;
    return this.request('PATCH', `/v1/h/drops/${encodeURIComponent(drop_id)}/state`, { body: rest });
  }
  /**
   * Deletes one item of the account's own space (ADR 0030): the drop is revoked and its files freed. Listing the
   * space is `listDrops({ view: 'space' })`; putting something in is `sendDrop` with the single target `self`.
   */
  deleteSpaceItem(dropId: string): Promise<SpaceDeleteResult> {
    return this.request('DELETE', `/v1/h/space/${encodeURIComponent(dropId)}`);
  }
  /* ---------------------------------------------------------------- manage (H credential with manage scope) */
  pendingRequests(): Promise<PendingRequestsResult> {
    return this.request('GET', '/v1/h/requests');
  }
  /** Connects a Feishu group-bot webhook for notices; the server sends a test message first. */
  connectFeishu(input: {
    url: string;
    secret?: string | null;
    language?: 'en' | 'zh';
  }): Promise<FeishuStatus> {
    return this.request('PUT', '/v1/h/feishu', { body: input });
  }
  disconnectFeishu(): Promise<FeishuStatus> {
    return this.request('DELETE', '/v1/h/feishu');
  }
  /** Without `confirm` this only describes the contacts; with it, they are removed. */
  contactRemove(input: { handles: string[]; confirm: boolean }): Promise<ContactRemoveResult> {
    return this.request('POST', '/v1/h/contacts/remove', { body: input });
  }
  /** A one-time reset link for the account's web password (ADR 0036); only `agentdrop account recover` calls it. */
  accountRecoveryLink(): Promise<{ url: string; expires_at: string }> {
    return this.request('POST', '/v1/h/account/recovery-link', { body: {} });
  }
  contactRequest(input: ContactRequestInput): Promise<ContactResult> {
    return this.request('POST', '/v1/h/contacts/request', { body: input });
  }
  contactRespond(input: ContactRespondInput): Promise<ContactResult> {
    return this.request('POST', '/v1/h/contacts/respond', { body: input });
  }
  groupCreate(input: GroupCreateInput): Promise<GroupResult> {
    return this.request('POST', '/v1/h/groups', { body: input });
  }
  groupInvite(input: GroupInviteInput): Promise<GroupResult> {
    return this.request('POST', '/v1/h/groups/invite', { body: input });
  }
  groupRespond(input: GroupRespondInput): Promise<GroupResult> {
    return this.request('POST', '/v1/h/groups/respond', { body: input });
  }
  groupLeave(input: GroupLeaveInput): Promise<GroupResult> {
    return this.request('POST', '/v1/h/groups/leave', { body: input });
  }
  approvalsPending(): Promise<{ approvals: ApprovalSummary[] }> {
    return this.request('GET', '/v1/h/approvals');
  }
  approvalDecide(
    id: string,
    decision: 'approve' | 'reject',
  ): Promise<{ status: string; drop_id: string | null; recipients?: unknown }> {
    return this.request('POST', `/v1/h/approvals/${encodeURIComponent(id)}/decide`, { body: { decision } });
  }
  sendRequestStatus(requestId: string): Promise<{
    request_id: string;
    outcome: 'delivered' | 'needs_approval' | 'not_sent' | null;
    drop_id: string | null;
    approval_url: string | null;
  }> {
    return this.request('GET', `/v1/h/send-requests/${encodeURIComponent(requestId)}`);
  }
}

export {
  applyProxyBypass,
  isPrivateHost,
  matchedByNoProxyCidr,
  type ProxyDecision,
  type ProxyMode,
} from './proxy.js';
export { AgentDropError };
