#!/usr/bin/env node
/**
 * Creates (or repairs) the two fixed QA accounts on a live server, so post-deploy checks can sign in there:
 *
 *   node scripts/qa-provision.mjs <target> [base-url]      (the base URL is needed the first time only)
 *
 * Idempotent. For each of qa_smoke_a / qa_smoke_b: sign up if the account does not exist yet (random password,
 * saved to the private accounts file, see scripts/lib/qa-accounts.mjs), pair one agent if it has none, and make the
 * two contacts of each other. They are contacts of nobody else, so the live smoke only ever sends between them.
 * Uses the public sign-up and pairing APIs; no database access. Never prints a password.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  QA_GROUP_SLUG,
  QA_HANDLES,
  qaAccountsPath,
  readQaAccounts,
  writeQaAccounts,
} from './lib/qa-accounts.mjs';

const name = process.argv[2];
// The server's URL is given once and then kept with the accounts in the private file.
const base = (process.argv[3] ?? readQaAccounts().targets[name]?.base)?.replace(/\/+$/, '');
if (!name || !base) {
  console.error(
    'usage: node scripts/qa-provision.mjs <target> <base-url>   (the base URL may be omitted once saved)',
  );
  process.exit(2);
}

async function call(jar, method, path, body, attempt = 0) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', origin: base, cookie: jar.cookie ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const set = res.headers.getSetCookie();
  if (set.length) jar.cookie = set.map((c) => c.split(';')[0]).join('; ');
  // Sign-in is rate limited (3 per 10 s per address): wait it out instead of failing.
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 11) * 1000));
    return call(jar, method, path, body, attempt + 1);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status} ${json?.code ?? ''}`);
    err.code = json?.code;
    err.status = res.status;
    throw err;
  }
  return json;
}

const data = readQaAccounts();
data.targets[name] ??= { base, accounts: {} };
data.targets[name].base = base;
const accounts = data.targets[name].accounts;

const sessions = {};
for (const key of ['a', 'b']) {
  const handle = QA_HANDLES[key];
  accounts[key] ??= {
    handle,
    email: `${handle.replace(/_/g, '-')}@example.com`,
    password: randomBytes(18).toString('base64url'),
  };
  const acct = accounts[key];
  const jar = {};
  try {
    await call(jar, 'POST', '/api/auth/sign-in/email', { email: acct.email, password: acct.password });
    console.log(`${handle}: exists, signed in`);
  } catch (err) {
    if (err.status !== 401 && err.status !== 400 && err.status !== 403) throw err;
    await call(jar, 'POST', '/v1/auth/sign-up', {
      email: acct.email,
      password: acct.password,
      handle,
      display_name: key === 'a' ? 'QA Smoke A' : 'QA Smoke B',
    });
    if (!jar.cookie)
      await call(jar, 'POST', '/api/auth/sign-in/email', { email: acct.email, password: acct.password });
    console.log(`${handle}: created`);
  }
  // Save right after creation: a later failure must not lose a password the server already has.
  writeQaAccounts(data);
  let me = await call(jar, 'GET', '/v1/me');
  if (!me.endpoints.some((e) => !e.revoked_at)) {
    const start = await call({}, 'POST', '/v1/pairing/start', {
      installation_id: randomUUID(),
      device_label: 'QA smoke',
      harness_key: 'other',
      profile_key: 'qa',
      endpoint_label: `QA smoke ${key.toUpperCase()}`,
      bridge_version: 'qa',
      platform: 'qa',
    });
    await call(jar, 'POST', '/v1/me/pairing/decide', {
      user_code: start.user_code,
      decision: 'approve',
      make_default: true,
    });
    me = await call(jar, 'GET', '/v1/me');
    console.log(`${handle}: paired an agent`);
  }
  sessions[key] = { jar, me };
}

try {
  await call(sessions.a.jar, 'POST', '/v1/me/contacts/invite', { handle: QA_HANDLES.b });
} catch (err) {
  console.log(`contact request: ${err.code ?? err.message} (already connected?)`);
}
try {
  await call(sessions.b.jar, 'POST', `/v1/me/contacts/${sessions.a.me.user_id}/accept`, {});
  console.log('qa_smoke_a and qa_smoke_b are contacts');
} catch (err) {
  console.log(`accept: ${err.code ?? err.message} (already contacts?)`);
}
const groups = await call(sessions.a.jar, 'GET', '/v1/me/groups');
const list = groups.groups ?? groups.items ?? groups;
let group = Array.isArray(list) ? list.find((g) => g.slug === QA_GROUP_SLUG) : null;
if (!group) {
  group = await call(sessions.a.jar, 'POST', '/v1/me/groups', {
    slug: QA_GROUP_SLUG,
    display_name: 'QA smoke group',
    invite_handles: [QA_HANDLES.b],
  });
  const id = group.group_id ?? group.group?.group_id ?? group.id;
  await call(sessions.b.jar, 'POST', `/v1/me/groups/${id}/accept`, {});
  console.log(`group #${QA_GROUP_SLUG}: created with both accounts`);
} else console.log(`group #${QA_GROUP_SLUG}: exists`);
writeQaAccounts(data);
console.log(`saved to ${qaAccountsPath()}`);
