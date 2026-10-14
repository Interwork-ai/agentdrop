import type {
  ApiError,
  DirectoryLookupResult,
  DropDetail,
  DropSummary,
  HarnessKey,
  SendResult,
  SendTarget,
  Viewer,
} from '@agentdrop/contracts';
import { t as tNow } from './lang.js';

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
    /** True when the dashboard wrote `body` itself (a non-JSON answer); its message is then already for people. */
    readonly local = false,
  ) {
    super(body.message);
  }
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown,
  raw?: BodyInit,
  headers?: Record<string, string>,
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers: { accept: 'application/json', ...headers },
  };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.headers = { ...(init.headers as Record<string, string>), 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (res.ok) return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  throw await failureOf(res);
}

/** Turns a non-2xx response into the error every page renders through ErrorBox, `details` included. */
async function failureOf(res: Response): Promise<ApiFailure> {
  let local = true;
  // Written for people, in their language: this is shown as-is (see `local` in humanError).
  let parsed: ApiError = {
    code: 'INTERNAL',
    message: tNow(
      `The server sent an unexpected response (HTTP ${res.status}). The address or a proxy usually changed: refresh the page, and if it persists, sign in again at the https address.`,
      `服务器返回了非预期的响应（HTTP ${res.status}）。通常是网址或代理配置变了：刷新页面；如果仍然出现，用 https 地址重新登录。`,
    ),
    next_action: '',
    retryable: false,
  };
  try {
    const j = await res.json();
    if (j && typeof j.code === 'string') {
      parsed = j as ApiError;
      local = false;
    }
  } catch {
    /* non-json */
  }
  return new ApiFailure(res.status, parsed, local);
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  delete: <T>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, file: File) =>
    request<T>('POST', url, undefined, file, {
      'content-type': 'application/octet-stream',
      'x-agentdrop-filename': encodeURIComponent(file.name),
      'x-agentdrop-content-type': file.type || 'application/octet-stream',
    }),
};

/* ------------------------------------------------------------------ types used by pages */
export interface Session {
  user: { id: string; email: string; name: string };
}
export interface Me {
  user_id: string;
  handle: string;
  display_name: string;
  /** Published to contacts and group co-members (ADR 0012); absent on older servers. */
  public_email?: string | null;
  /** My sign-in address, so Settings can offer to publish it; absent on older servers. */
  sign_in_email?: string | null;
  directory_revision: number;
  is_admin: boolean;
  cross_h_mailbox_enabled: boolean;
  /** Feishu group-bot notices; absent on older servers. The address itself is never returned. */
  /** Content encryption at rest on this server; absent on older servers. */
  content_encryption?: 'off' | 'on';
  feishu?: { connected: boolean; url_hint: string | null; has_secret: boolean; language: 'en' | 'zh' | null };
  /** Plain sends to me reach all of my agents (ADR 0008). Absent on older servers. */
  direct_receive_all?: boolean;
  notification_webhook_url: string | null;
  endpoints: Endpoint[];
}
export interface Endpoint {
  h_id: string;
  label: string;
  public_name: string | null;
  name_version: number;
  harness_key: HarnessKey;
  profile_key: string;
  device: { device_id: string; label: string; platform: string | null; revoked: boolean };
  is_default_receiver: boolean;
  created_at: string;
  revoked_at: string | null;
  /** The agent that took this one over (ADR 0011); absent on older servers. */
  taken_over_by?: string | null;
}
export interface Contact {
  contact_id: string | null;
  user_id: string;
  handle: string;
  display_name: string;
  /** Published email of an accepted contact (ADR 0012); absent on older servers. */
  public_email?: string | null;
  remark: string | null;
  status: 'accepted' | 'invited' | 'requested' | 'blocked' | 'group_only';
  preferred_route_id: string | null;
  auto_approve: boolean;
  version: number;
  updated_at: string | null;
  /** The built-in @agentdrop assistant (answers every direct drop with a receipt). */
  is_system?: boolean;
  /** A pending request an invite link left: it completes when the invitee pairs an agent (ADR 0034). */
  from_invite_link?: boolean;
}
export interface InviteLink {
  link_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  use_count: number;
  status: 'active' | 'expired' | 'revoked';
}
/** Only the create response carries the plain link; afterwards it can be revoked but not shown again. */
export interface CreatedInviteLink extends InviteLink {
  token: string;
  url: string;
}
export interface InviteLinkPreview {
  valid: boolean;
  reason: 'expired' | 'revoked' | null;
  inviter: { handle: string; display_name: string };
  expires_at: string;
}
export interface AcceptInviteResult {
  contact: Contact;
  created: boolean;
  /** No agent paired yet: the inviter's contact request waits on the Contacts page (ADR 0014). */
  pending?: boolean;
}
export interface RouteView {
  route_id: string;
  alias: string | null;
  label: string;
  is_default: boolean;
  visibility: 'private' | 'contacts';
  destination_h_id: string;
  harness_key: string;
  auto: boolean;
  version: number;
}
export interface GroupSummary {
  group_id: string;
  slug: string;
  display_name: string;
  role: 'owner' | 'admin' | 'member' | null;
  status: 'invited' | 'active';
  my_nickname: string | null;
  muted: boolean;
  active_member_count: number;
  current_h_receives: boolean | null;
}
/** Who may bring people in: 'open' lets any member invite directly, 'admin_approval' turns that into a request. */
export type InvitePolicy = 'open' | 'admin_approval';
/** What one invite call did to one handle. */
export interface InviteOutcome {
  handle: string;
  outcome: 'invited' | 'requested' | 'already_member';
}
/** A member's invitation waiting for an owner/admin to decide. Only a human decides these, in the dashboard. */
export interface JoinRequestView {
  group_id: string;
  slug: string;
  display_name: string;
  invitee_user_id: string;
  invitee_handle: string;
  invitee_display_name: string;
  invited_by_handle: string;
  created_at: string;
}
export interface GroupDetail {
  group_id: string;
  slug: string;
  display_name: string;
  description: string | null;
  owner_user_id: string;
  version: number;
  created_at: string;
  invite_policy: InvitePolicy;
  /**
   * Every active member can read the whole group history, including messages from before they joined (ADR 0022).
   * Only the owner changes it. Absent on older servers.
   */
  history_visible?: boolean;
  /** Active members + outstanding invitations, against the per-group people limit. */
  member_slots_used: number;
  member_limit: number;
  /** Deprecated compatibility sentinel, not a real receiving-agent count (ADR 0013). */
  endpoint_total: number;
  endpoint_limit: number;
  /** Absent on older servers. */
  endpoints_over_limit?: boolean;
  /** Who invited me; non-null only while my own status is `invited`. */
  invited_by_handle: string | null;
  /** Admin-only; an empty array for everyone else. */
  join_requests: JoinRequestView[];
  /** The group's file space (ADR 0029), shown to every member. Absent on older servers. */
  storage?: { used_bytes: number; limit_bytes: number };
  /** Present on the responses of calls that invited somebody, so the caller can report what happened. */
  invites?: InviteOutcome[];
  my_membership: {
    membership_id: string;
    role: 'owner' | 'admin' | 'member';
    status: 'invited' | 'active';
    nickname: string | null;
    muted: boolean;
    /** When my current membership began; null while invited. Absent on older servers. */
    joined_at?: string | null;
    /** Every agent of the account receives, including agents paired later. Absent on older servers. */
    receive_all?: boolean;
    binding_h_ids: string[];
  } | null;
  current_h_receives: boolean | null;
  /** Empty while my own status is `invited`: somebody who has not accepted is not shown the roster. */
  members: Array<{
    membership_id: string;
    user_id: string;
    handle: string;
    display_label: string;
    display_name: string;
    /** Active members' published email, visible to active members only; absent on older servers. */
    public_email?: string | null;
    nickname: string | null;
    role: 'owner' | 'admin' | 'member';
    status: 'invited' | 'active' | 'left' | 'removed';
    joined_at: string | null;
    needs_repair: boolean;
  }>;
  active_member_count: number;
  members_needing_repair: number;
}
export interface Connection {
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
  status: 'live' | 'stale' | 'closed';
}
export interface Approval {
  approval_id: string;
  request_id: string;
  origin_h_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
  content_hash: string;
  title: string;
  body_preview: string;
  attachment_ids: string[];
  recipients: Array<{
    type: string;
    label: string;
    endpoint_count: number;
    address?: string | null;
    endpoint_label?: string | null;
    harness_key?: string | null;
  }>;
  reasons: string[];
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}
export interface PairingLookup {
  user_code: string;
  device_label: string;
  harness_key: string;
  profile_key: string;
  endpoint_label: string;
  platform: string;
  bridge_version: string;
  expires_at: string;
  existing_endpoint: boolean;
  has_default_receiver: boolean;
}
export type ListDrops = {
  drops: DropSummary[];
  next_cursor: string | null;
  unread_count: number;
  viewer: Viewer;
};
export type { DirectoryLookupResult, DropDetail, DropSummary, SendResult, SendTarget, Viewer };

export function mailboxUrl(hId: string, path: string): string {
  return `/v1/me/endpoints/${encodeURIComponent(hId)}${path}`;
}

/* ------------------------------------------------------------------ export */

/**
 * `GET /v1/me/endpoints/:h_id/export` answers with NDJSON behind `Content-Disposition: attachment`, so it never
 * goes through `request()` — that helper only ever parses JSON. `downloadExport` fetches it with the session
 * cookie instead, so a refusal (too many drops, rate limit, expired session) reaches the page as an ApiFailure.
 *
 * Mirrors `exportInputSchema` in @agentdrop/contracts. Note that `include_group_history` is refused for an H
 * credential and only honoured for an owner/admin on a browser session.
 */
export interface ExportQuery {
  scope: 'peer' | 'group';
  /** Required for `scope: 'peer'`. */
  peer_user_id?: string;
  /** Required for `scope: 'group'`. */
  group_id?: string;
  since: string;
  until: string;
  include_body?: boolean;
  include_group_history?: boolean;
  /** Omitted means "whatever the account's cross-agent setting says", which is the right default here. */
  endpoint_scope?: 'account' | 'current';
}

export function exportUrl(hId: string, query: ExportQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  return mailboxUrl(hId, `/export?${params.toString()}`);
}

/** The name the server put in `Content-Disposition`, preferring the RFC 5987 `filename*` form it sends. */
function attachmentName(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*utf-8''([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(header);
  return plain?.[1]?.trim() || null;
}

/**
 * Fetches an export and saves it through a blob URL under the server's filename. A plain `<a download>` would
 * save the server's refusal to disk as a broken file; this throws it as an ApiFailure for ErrorBox instead.
 */
export async function downloadExport(hId: string, query: ExportQuery): Promise<void> {
  const res = await fetch(exportUrl(hId, query), {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/x-ndjson, application/json' },
  });
  if (!res.ok) throw await failureOf(res);
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = attachmentName(res.headers.get('content-disposition')) ?? 'agentdrop-export.jsonl';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously can cancel the save in some browsers; the blob is released shortly after.
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/** Days one export may span. Mirrors `LIMITS.EXPORT_MAX_DAYS`; the web bundle keeps @agentdrop/contracts type-only. */
export const EXPORT_MAX_DAYS = 366;

/** `YYYY-MM-DD` in the viewer's own timezone, which is the only thing `<input type="date">` accepts. */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The range the export controls open on: the last 30 days, ending today. */
export function defaultExportRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 29);
  return { from: localDay(from), to: localDay(to) };
}

/**
 * Turns the two date inputs into the `[since, until)` pair the server wants.
 *
 * `<input type="date">` yields a local calendar day while the range is half-open against UTC timestamps, so the
 * end day the user picked would otherwise be silently excluded. Both ends are presented as inclusive days and
 * `until` becomes midnight of the following local day. Returns null for a pair the server would reject anyway —
 * an empty field, a backwards range, or one longer than the server's ceiling — which disables the download
 * control, so the obvious mistakes are explained next to the date fields before a request is made.
 */
export function exportDayRange(from: string, to: string): { since: string; until: string } | null {
  if (!from || !to) return null;
  const since = new Date(`${from}T00:00:00`);
  const until = new Date(`${to}T00:00:00`);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) return null;
  until.setDate(until.getDate() + 1);
  if (until <= since) return null;
  if (until.getTime() - since.getTime() > EXPORT_MAX_DAYS * 86_400_000) return null;
  return { since: since.toISOString(), until: until.toISOString() };
}

export function harnessLabel(k: string): string {
  return (
    (
      {
        codex: 'Codex',
        'claude-code': 'Claude Code',
        opencode: 'opencode',
        cursor: 'Cursor',
        omp: 'oh-my-pi',
      } as Record<string, string>
    )[k] ?? k
  );
}

/**
 * `crypto.randomUUID` exists only in secure contexts (https, localhost); a server on plain http such as
 * an internal `http://10.0.0.5:3300` does not have it, and calling it there crashed the compose page into a blank screen.
 * `getRandomValues` is available everywhere, so build the same v4 UUID from it.
 */
export function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return `web-${crypto.randomUUID()}`;
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `web-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
