#!/usr/bin/env node
/**
 * Fails when a tracked file contains something docs/PUBLIC_REPOSITORY.md keeps out of the repository: secrets and
 * secrets with a default value, real server addresses and paths, personal paths and email addresses, deployment
 * records, and files .gitignore declares local-only that are still tracked.
 *
 *   pnpm hygiene            (also part of `pnpm verify` and CI)
 *
 * Two sources of rules:
 *   - generic patterns below, safe to publish;
 *   - an optional PRIVATE deny list, one literal string per line (`#` comments), from `$AGENTDROP_HYGIENE_DENY` or
 *     `$AGENTDROP_OPS_DIR/public-hygiene-deny.txt`. It holds the concrete names that must never appear (real hosts,
 *     people, internal platforms) and is never committed, because listing them here would publish them.
 * A line may opt out of one generic rule with a trailing `hygiene-allow: <rule> <reason>` comment; the private deny
 * list has no opt-out.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localSetting } from './lib/local-env.mjs';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/** Placeholder mail domains (RFC 2606, RFC 6761) and the no-reply addresses commits and tools use. */
const PLACEHOLDER_EMAIL_DOMAIN =
  /(^|\.)(example\.(com|org|net)|[a-z0-9-]+\.(test|example|invalid|localhost))$|^(users\.noreply\.github\.com|anthropic\.com)$/i;

function ipAllowed(ip) {
  const o = ip.split('.').map(Number);
  if (o.some((n) => n > 255)) return true; // a version number, not an address
  const [a, b, c] = o;
  if (a === 127 || a === 0 || a === 10) return true; // loopback, unspecified, private examples
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments (in blocklists)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking range (in blocklists)
  if (a === 255 || a >= 224) return true; // broadcast, multicast: not a host
  // well-known public resolvers and the classic placeholder: test data for "a public address", nobody's server
  return ['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1', '9.9.9.9', '1.2.3.4'].includes(ip);
}

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
/** Fixtures that tests of the sensitive-content scanners need: recognisable fakes, key headers without a body. */
const FAKE_SECRET = /^(AKIA(ABCDEFGHIJKLMNOP|[0-9A-Z]{9}EXAMPLE)|-----BEGIN [A-Z ]*PRIVATE KEY-----)$/;

const RULES = [
  {
    id: 'public-ip',
    why: 'a real public IP address; use 192.0.2.x / 198.51.100.x / 203.0.113.x in examples',
    find: (line) =>
      [...line.matchAll(/(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?![\w.])/g)]
        .map((m) => m[1])
        .filter((ip) => !ipAllowed(ip)),
  },
  {
    id: 'ip-hostname',
    why: 'an address-in-a-name host (sslip.io / nip.io) points at a real server',
    find: (line) =>
      [...line.matchAll(/\b[a-z0-9-]*\d+-\d+-\d+-\d+[a-z0-9.-]*\.(sslip|nip)\.io\b/gi)]
        .map((m) => m[0])
        .filter((h) => !/203-0-113-|198-51-100-|192-0-2-/.test(h)),
  },
  {
    id: 'home-path',
    why: 'a personal home directory; use /home/user, /Users/me or ~',
    find: (line) =>
      [...line.matchAll(/(?:\/Users|\/home)\/([A-Za-z0-9._-]+)/g)]
        .filter((m) => !['me', 'user', 'u', 'runner', 'you', 'alice', 'node', 'devuser'].includes(m[1]))
        .map((m) => m[0]),
  },
  {
    id: 'email',
    why: 'a real email address; use @example.com or a .test domain',
    find: (line) =>
      [...line.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g)]
        .filter((m) => /\.[a-z]{2,}$/i.test(m[1]) && !PLACEHOLDER_EMAIL_DOMAIN.test(m[1]))
        .filter((m) => !/^(git|noreply)$/i.test(m[0].split('@')[0]) || !/github\.com$/.test(m[1]))
        .map((m) => m[0]),
  },
  {
    id: 'secret',
    why: 'looks like a credential or private key',
    find: (line, file) =>
      [
        ...line.matchAll(
          /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bnpm_[A-Za-z0-9]{30,}\b|\bsk-[A-Za-z0-9_-]{30,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[bpas]-[A-Za-z0-9-]{20,}\b/g,
        ),
      ]
        .map((m) => m[0])
        .filter((hit) => !(TEST_FILE.test(file) && FAKE_SECRET.test(hit))),
  },
  {
    id: 'secret-default',
    why: 'a secret with a default value: anyone reading the repository knows it; fail closed (NAME:?message, a required variable)',
    find: (line, file) =>
      /(^|\/)(compose[^/]*\.ya?ml|[^/]*\.(sh|env|ya?ml)|Dockerfile[^/]*|\.env\.example)$/.test(file)
        ? [...line.matchAll(/\$\{[A-Z0-9_]*(SECRET|PASSWORD|TOKEN|PRIVATE_KEY|API_KEY)[A-Z0-9_]*:?-[^}]+\}/g)]
            .map((m) => m[0])
            // where a secret is kept (a file, a directory) is not the secret
            .filter((hit) => !/^\$\{[A-Z0-9_]*_(FILE|PATH|DIR)\b/.test(hit))
        : [],
  },
];

/** Generated or vendored files are not written by people; lockfiles carry registry URLs and hashes only. */
const SKIP = [
  /^pnpm-lock\.yaml$/,
  /(^|\/)generated\//,
  /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|tgz|zip|pdf)$/i,
  /^packages\/contracts\/json\//,
];

function denyList() {
  const ops = localSetting('AGENTDROP_OPS_DIR');
  const path = localSetting('AGENTDROP_HYGIENE_DENY') ?? (ops ? join(ops, 'public-hygiene-deny.txt') : null);
  if (!path || !existsSync(path)) return { path: null, terms: [] };
  const terms = readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return { path, terms };
}

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((f) => f && !SKIP.some((r) => r.test(f)));
const deny = denyList();
const problems = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue; // binary
  text.split('\n').forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    const allowed = /hygiene-allow:\s*([a-z-]+)/.exec(line)?.[1];
    for (const rule of RULES) {
      if (rule.id === allowed || rule.skip?.(file)) continue;
      for (const hit of rule.find(line, file)) problems.push(`${where}  [${rule.id}] ${hit}  (${rule.why})`);
    }
    const lower = line.toLowerCase();
    // the private list is matched but never printed: the report itself may end up in a CI log
    for (const term of deny.terms)
      if (lower.includes(term.toLowerCase()))
        problems.push(`${where}  [private-deny] a term from the private deny list`);
  });
}

// what .gitignore declares local-only must not stay tracked (it would still be published)
for (const file of execFileSync('git', ['ls-files', '-ci', '--exclude-standard', '-z'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean))
  problems.push(
    `${file}  [ignored-but-tracked] listed in .gitignore as local-only, yet tracked (git rm --cached)`,
  );

if (problems.length) {
  console.error(`Public-repository hygiene: ${problems.length} problem(s) (docs/PUBLIC_REPOSITORY.md):\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `Public-repository hygiene: ${files.length} files clean${deny.path ? `, private deny list applied (${deny.terms.length} terms)` : ' (no private deny list here; generic rules only)'}.`,
);
