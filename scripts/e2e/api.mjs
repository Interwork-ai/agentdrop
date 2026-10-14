/**
 * Seeding through the public API, the way a real client would. Every journey creates its own people with a
 * journey-specific handle prefix, so journeys never depend on each other's data or order.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { currentServer, PASSWORD } from './server.mjs';

export async function call(jar, method, path, body) {
  const { direct, base } = currentServer();
  const res = await fetch(direct + path, {
    method,
    headers: { 'content-type': 'application/json', origin: base, cookie: jar.cookie ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const set = res.headers.getSetCookie();
  if (set.length) jar.cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export const emailOf = (handle) => `${handle}@e2e.test`;
/** "mb_alice" → "Alice": the name people see, without the journey prefix. */
export const displayNameOf = (handle) => {
  const bare = handle.replace(/^[a-z0-9]+_/, '');
  return bare[0].toUpperCase() + bare.slice(1);
};

/** Signs a person up (and in), pairs the given agents (harness keys), and returns their session and profile. */
export async function signUp(handle, agents = ['codex'], { displayName } = {}) {
  const jar = {};
  await call(jar, 'POST', '/v1/auth/sign-up', {
    email: emailOf(handle),
    password: PASSWORD,
    handle,
    display_name: displayName ?? displayNameOf(handle),
  });
  if (!jar.cookie)
    await call(jar, 'POST', '/api/auth/sign-in/email', { email: emailOf(handle), password: PASSWORD });
  for (const harness of agents) await pairAgent(jar, handle, harness, true);
  const me = await call(jar, 'GET', '/v1/me');
  return { handle, jar, me, h: me.endpoints[0]?.h_id, email: emailOf(handle), password: PASSWORD };
}

export async function startPairing(handle, harness) {
  return call({}, 'POST', '/v1/pairing/start', {
    installation_id: randomUUID(),
    device_label: `${handle}-laptop`,
    harness_key: harness,
    profile_key: harness,
    endpoint_label: `${handle} ${harness}`,
    bridge_version: '0.5.3',
    platform: 'linux',
  });
}

export async function pairAgent(jar, handle, harness, makeDefault) {
  const s = await startPairing(handle, harness);
  await call(jar, 'POST', '/v1/me/pairing/decide', {
    user_code: s.user_code,
    decision: 'approve',
    make_default: makeDefault,
  });
}

/** A accepted contact pair: `a` invites, `b` accepts. */
export async function connect(a, b) {
  await call(a.jar, 'POST', '/v1/me/contacts/invite', { handle: b.handle });
  await call(b.jar, 'POST', `/v1/me/contacts/${a.me.user_id}/accept`, {});
}

/** A group owned by `owner` whose `members` have all accepted. Returns the group id. */
export async function group(owner, { slug, name, members = [] }) {
  const g = await call(owner.jar, 'POST', '/v1/me/groups', {
    slug,
    display_name: name,
    invite_handles: members.map((m) => m.handle),
  });
  const id = g.group_id ?? g.group?.group_id ?? g.id;
  for (const m of members) await call(m.jar, 'POST', `/v1/me/groups/${id}/accept`, {});
  return id;
}

export async function sendDrop(from, targets, title, body, extra = {}) {
  return call(from.jar, 'POST', `/v1/me/endpoints/${from.h}/drops`, {
    request_id: `e2e-${randomUUID()}`,
    targets,
    payload: { payload_version: 1, kind: 'text', title, body, attachment_ids: [], extensions: {}, ...extra },
  });
}

export const toPerson = (p) => ({ type: 'user', user_id: p.me.user_id });
export const toGroup = (id) => ({ type: 'group', group_id: id });

export function makeAdmin(handle) {
  execFileSync('psql', [
    currentServer().db,
    '-q',
    '-c',
    `update app_users set is_admin = true where handle = '${handle.replace(/'/g, '')}'`,
  ]);
}

/** Uploads one file as `person`'s first agent (the composer's upload route) and returns its attachment metadata. */
export async function uploadFile(
  person,
  { name, mimeType = 'application/octet-stream', buffer },
  h = person.h,
) {
  const { direct, base } = currentServer();
  const path = `/v1/me/endpoints/${h}/attachments`;
  const res = await fetch(direct + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-agentdrop-filename': encodeURIComponent(name),
      'x-agentdrop-content-type': mimeType,
      origin: base,
      cookie: person.jar.cookie ?? '',
    },
    body: buffer,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
