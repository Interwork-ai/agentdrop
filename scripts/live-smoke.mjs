#!/usr/bin/env node
/**
 * Post-deploy acceptance on a LIVE server, signed in as the fixed QA accounts (docs/QUALITY.md §5):
 *
 *   node scripts/live-smoke.mjs <target> [--expect-version X.Y.Z]
 *   pnpm smoke:live <target> --expect-version 0.5.2
 *
 * Runs after every deploy, before the deploy is reported done. Checks health, readiness, version, the event stream
 * (ADR 0040: its first frame must come through the server's proxy at once) and the hosted CLI tarball over HTTP,
 * then drives Chrome through the key journeys exactly as a person on that server would (plain http stays a
 * non-secure context, https a secure one). It only touches the QA accounts: A sends one drop to B,
 * B reads, stars and archives it. Credentials come from the private file described in
 * scripts/lib/qa-accounts.mjs; create them once with `node scripts/qa-provision.mjs <target>`.
 */
import { join, resolve } from 'node:path';
import { QA_GROUP_SLUG, qaTarget } from './lib/qa-accounts.mjs';
import {
  CONTACT_SEND_LABEL,
  composeAndSend,
  launchChrome,
  NEW_MESSAGE_TEXT,
  openSession,
  SEND_TEXT,
  summarize,
} from './lib/smoke-kit.mjs';

const args = process.argv.slice(2);
const name = args[0];
const expectIdx = args.indexOf('--expect-version');
const expectVersion = expectIdx >= 0 ? args[expectIdx + 1] : null;
if (!name || name.startsWith('-')) {
  console.error('usage: node scripts/live-smoke.mjs <target> [--expect-version X.Y.Z]');
  process.exit(2);
}
const target = qaTarget(name);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : target.base;
const OUT = join(resolve(import.meta.dirname, '..'), 'test-results', `live-${name}`);
const results = [];
const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const title = `[QA smoke] ${stamp}`;

async function httpCheck(label, fn) {
  try {
    await fn();
    results.push({ label: `http: ${label}`, ok: true });
    console.log(`  ok   http: ${label}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ label: `http: ${label}`, ok: false, error: message });
    console.log(`  FAIL http: ${label}: ${message}`);
  }
}

console.log(`Live smoke on ${name} (${base}) at ${stamp}`);
await httpCheck('health/live', async () => {
  const live = await (await fetch(`${base}/health/live`)).json();
  if (live.status !== 'ok') throw new Error(JSON.stringify(live));
  if (expectVersion && live.version !== expectVersion)
    throw new Error(`version ${live.version}, expected ${expectVersion}`);
  console.log(`       version ${live.version}`);
});
await httpCheck('health/ready (database, storage)', async () => {
  const ready = await (await fetch(`${base}/health/ready`)).json();
  if (ready.status !== 'ready') throw new Error(JSON.stringify(ready));
});
await httpCheck('/.well-known/agentdrop lists the event stream', async () => {
  const known = await (await fetch(`${base}/.well-known/agentdrop`)).json();
  if (!Array.isArray(known.capabilities) || !known.capabilities.includes('events'))
    throw new Error(JSON.stringify(known));
});
if (!args.includes('--no-tarball'))
  await httpCheck('hosted CLI tarball', async () => {
    const res = await fetch(`${base}/install/agentdrop.tgz`, { method: 'HEAD' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

const browser = await launchChrome();
try {
  const a = await openSession(browser, {
    base,
    label: 'qa_smoke_a',
    email: target.accounts.a.email,
    password: target.accounts.a.password,
    results,
    outDir: OUT,
    // across the internet: pages take seconds on a bad link, which is not what this check is about
    timeout: 20_000,
  });
  console.log(`       secure context: ${await a.page.evaluate(() => window.isSecureContext)}`);
  await a.step('inbox', () => a.nav('Inbox'));
  await a.step('compose from the navigation and send to B', async () => {
    await a.page.getByText(NEW_MESSAGE_TEXT).first().click();
    await composeAndSend(a.page, a.see, {
      recipient: 'qa_smoke_b',
      recipientLabel: /QA Smoke B/,
      title,
      body: 'Automated post-deploy check. Safe to ignore.',
    });
  });
  await a.step('send another resets the form', async () => {
    await a.page.getByRole('button', { name: 'Send another' }).click();
    await a.see(SEND_TEXT);
  });
  await a.step('sent list shows it', async () => {
    await a.nav('Sent');
    await a.see(title);
  });
  await a.step('contacts: "Send a message" opens the composer', async () => {
    await a.nav('Contacts');
    await a.page.getByText('QA Smoke B', { exact: true }).first().click();
    await a.page.getByRole('button', { name: CONTACT_SEND_LABEL }).click();
    await a.page.waitForURL(/\/app\/compose/);
    await a.see(SEND_TEXT);
  });
  await a.step('group page and members', async () => {
    await a.nav('All groups');
    await a.page.getByText('QA smoke group').first().click();
    await a.see(QA_GROUP_SLUG);
    await a.page
      .getByRole('tab', { name: /^Members/ })
      .first()
      .click();
    await a.see('QA Smoke B');
  });
  await a.step('"Write to the group" opens the composer', async () => {
    await a.page.getByRole('button', { name: 'Write to the group' }).first().click();
    await a.page.waitForURL(/\/app\/compose/);
    await a.see(SEND_TEXT);
  });
  await a.step('my agents', async () => {
    await a.nav('My agents');
    await a.see('Messages sent to @qa_smoke_a reach');
  });
  await a.step('approvals', () => a.nav('Approvals'));
  await a.step('settings', async () => {
    await a.nav('Settings');
    await a.see('Language');
  });
  await a.step('help', async () => {
    await a.nav('Help');
    await a.see('Getting started');
  });
  await a.step('switch language to Chinese and back', async () => {
    await a.page.getByRole('button', { name: 'Switch to Chinese' }).first().click();
    await a.see('收件箱');
    await a.page
      .getByRole('button', { name: /Switch to English|切换到英文|English/ })
      .first()
      .click();
    await a.see('Inbox');
  });
  await a.step('sign out', async () => {
    await a.page.getByRole('button', { name: 'Sign out' }).first().click();
    await a.page.waitForURL(/\/login/);
  });
  await a.context.close();

  const b = await openSession(browser, {
    base,
    label: 'qa_smoke_b',
    email: target.accounts.b.email,
    password: target.accounts.b.password,
    results,
    outDir: OUT,
    // across the internet: pages take seconds on a bad link, which is not what this check is about
    timeout: 20_000,
  });
  await b.step('inbox shows the drop from A', () => b.see(title, 20_000));
  // The server writes a stream's first frame at once: a proxy that buffers the body never delivers it.
  await b.step('the event stream comes through the proxy', async () => {
    const frame = await b.page.evaluate(async () => {
      const me = await (await fetch('/v1/me')).json();
      const hId = me.endpoints?.find((e) => !e.revoked_at)?.h_id;
      if (!hId) return 'no agent';
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), 10_000);
      try {
        const res = await fetch(`/v1/me/endpoints/${hId}/events`, {
          headers: { accept: 'text/event-stream' },
          signal: stop.signal,
        });
        const reader = res.body.getReader();
        let text = '';
        while (!text.includes('\n\n')) {
          const { value, done } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
        }
        stop.abort();
        return text;
      } catch {
        return 'no frame within 10 s';
      } finally {
        clearTimeout(timer);
      }
    });
    if (!frame.includes('event: events')) throw new Error(frame.slice(0, 200));
  });
  await b.step('open it', async () => {
    await b.page.getByText(title).first().click();
    await b.see('Automated post-deploy check. Safe to ignore.');
  });
  await b.step('star it', async () => {
    await b.page.getByRole('button', { name: 'Star', exact: true }).first().click();
    await b.page.getByRole('button', { name: 'Starred', exact: true }).first().waitFor();
  });
  await b.step('reply opens the composer', async () => {
    // "Continue" before the reply reference (ADR 0016), "Reply" since
    await b.page
      .getByRole('button', { name: /^(Reply|Continue)$/ })
      .first()
      .click();
    await b.page.waitForURL(/\/app\/compose/);
    await b.see(SEND_TEXT);
  });
  if (await b.page.evaluate(() => window.isSecureContext && 'serviceWorker' in navigator)) {
    await b.step('a notification click opens the drop (service worker)', async () => {
      await b.nav('Inbox');
      await b.page.getByText(title).first().click();
      const dropPath = new URL(b.page.url()).pathname;
      await b.context.grantPermissions(['notifications'], { origin: base });
      const registered = b.context.waitForEvent('serviceworker').catch(() => null);
      await b.page.evaluate(() => navigator.serviceWorker.register('/sw.js', { scope: '/' }));
      const worker = b.context.serviceWorkers().find((w) => w.url().endsWith('/sw.js')) ?? (await registered);
      await b.page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      await b.nav('Contacts');
      await b.page.waitForURL(/\/app\/contacts/);
      // the click handler's own function (headless Chrome has no notification to click; see push-click journey)
      await worker.evaluate((p) => {
        self.openNotificationTarget(p).catch(() => {});
      }, dropPath);
      await b.page.waitForURL(new RegExp(dropPath));
      await b.see('Automated post-deploy check. Safe to ignore.');
    });
  }
  await b.step('archive it (keeps the QA inbox clean)', async () => {
    await b.nav('Starred');
    await b.page.getByText(title).first().click();
    await b.page.getByRole('button', { name: 'Archive', exact: true }).first().click();
    await b.nav('Archived');
    await b.see(title);
  });
  await b.context.close();
} finally {
  await browser.close();
}
process.exit(summarize(results, OUT));
