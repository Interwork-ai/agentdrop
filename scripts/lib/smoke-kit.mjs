/**
 * Shared browser helpers for the dashboard smoke tests: `scripts/e2e/run.mjs` (CI, seeded local server) and
 * `scripts/live-smoke.mjs` (post-deploy, fixed QA accounts on a live server). One definition of what "a step passed"
 * means: the action completed, the page is not blank, no error boundary is shown, and no uncaught page error or
 * console error appeared while it ran.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

/**
 * Console noise that is not a failure: the CSP-blocked web font, the session probe before signing in, and the
 * sign-in rate limit that the sign-in step waits out.
 */
const IGNORED_CONSOLE = [/fonts\.googleapis\.com/, /status of 401/, /status of 429/];

export async function launchChrome(extraArgs = []) {
  return chromium.launch({
    headless: process.env.SMOKE_HEADED !== '1',
    // Never route the test through the developer's system proxy: the servers are reached directly. Chrome honours
    // --no-proxy-server; Playwright's headless shell (E2E_CHROME, which never takes focus on macOS) only honours
    // an explicit direct "proxy".
    args: ['--no-proxy-server', '--proxy-server=direct://', ...extraArgs],
    ...(process.env.E2E_CHROME ? { executablePath: process.env.E2E_CHROME } : { channel: 'chrome' }),
  });
}

/**
 * Opens a signed-in browser context. `results` collects `{ label, ok, error }`; failures also get a screenshot in
 * `outDir`. Returns helpers bound to that page.
 */
export async function openSession(
  browser,
  {
    base,
    label,
    email,
    password,
    results,
    outDir,
    cookie,
    viewport = { width: 1360, height: 900 },
    colorScheme,
    /** Per action; a live server across the internet needs more than a local one. Navigation gets three times it. */
    timeout = 10_000,
  },
) {
  const context = await browser.newContext({ viewport, ...(colorScheme ? { colorScheme } : {}) });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout * 3);
  // E2E_CPU_THROTTLE=4 slows the page's CPU like a busy CI runner, to reproduce timing that a fast laptop hides.
  const throttle = Number(process.env.E2E_CPU_THROTTLE ?? 1);
  if (throttle > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORED_CONSOLE.some((r) => r.test(m.text())))
      errors.push(`console: ${m.text()}`);
  });

  /**
   * One checked step. `allowConsole` lists console errors this step provokes on purpose (a refused request the page
   * explains, such as a 404 for an unknown handle); any other console error still fails it.
   */
  const step = async (name, fn, { allowConsole = [] } = {}) => {
    const full = `${label}: ${name}`;
    const before = errors.length;
    const fresh = () => errors.slice(before).filter((e) => !allowConsole.some((r) => r.test(e)));
    try {
      await fn();
      await page.waitForTimeout(300);
      // A slow machine may still be rendering; a crashed page stays blank, so waiting a few seconds loses nothing.
      await page
        .waitForFunction(() => document.body.innerText.trim().length >= 40, null, { timeout: 5_000 })
        .catch(() => {});
      const text = await page.locator('body').innerText();
      if (text.trim().length < 40) throw new Error('page is blank');
      if (/This page could not be shown|这个页面没能显示出来/.test(text))
        throw new Error('error boundary shown');
      if (fresh().length) throw new Error(fresh().join(' | '));
      results.push({ label: full, ok: true });
      console.log(`  ok   ${full}`);
    } catch (err) {
      let message = err instanceof Error ? err.message.split('\n')[0] : String(err);
      // a crash usually surfaces as a timeout; name the page error that caused it
      if (fresh().length) message = `${fresh().join(' | ')} (then: ${message})`;
      results.push({ label: full, ok: false, error: message });
      console.log(`  FAIL ${full}: ${message}`);
      mkdirSync(outDir, { recursive: true });
      await page
        .screenshot({ path: join(outDir, `${full.replace(/[^a-z0-9]+/gi, '-').slice(0, 120)}.png`) })
        .catch(() => {});
    }
  };
  // the visible match: the phone top bar and the drawer repeat some words (the agent's name) while hidden
  const see = (text, wait = timeout) =>
    page.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor({ timeout: wait });
  // sidebar links carry unread badges ("Contacts 1"), so match the start of the name
  const nav = (name) =>
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: new RegExp(`^${name}`) })
      .first()
      .click();

  /** Reaching an /app/ URL is not enough: the shell must render its navigation and stay off the login page. */
  const signedInShell = async () => {
    // the desktop sidebar or, on a phone, the bottom navigation
    await page
      .getByRole('navigation', { name: /^(Main navigation|Mobile navigation)$/ })
      .first()
      .waitFor({ state: 'attached' });
    await page.waitForTimeout(500);
    if (new URL(page.url()).pathname.startsWith('/login')) throw new Error('sent back to the login page');
  };

  if (cookie) {
    // Reuse a session made through the API (Playwright's "reuse authentication state"): only the journeys that test
    // signing in pay for the UI login and its rate limit of 3 per 10 s.
    const host = new URL(base).hostname;
    await context.addCookies(
      cookie.split('; ').map((pair) => {
        const i = pair.indexOf('=');
        return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: host, path: '/' };
      }),
    );
    await step('open signed in', async () => {
      await page.goto(`${base}/app/inbox`);
      await page.waitForURL(/\/app\//);
      await signedInShell();
    });
  } else {
    await step('sign in', async () => {
      await page.goto(`${base}/login`);
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      try {
        await page.waitForURL(/\/app\//, { timeout: Math.max(8_000, timeout) });
      } catch {
        // sign-in allows 3 attempts per 10 s per address; back-to-back sessions can hit it, so wait and retry once
        await page.waitForTimeout(11_000);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.waitForURL(/\/app\//, { timeout: Math.max(20_000, timeout * 2) });
      }
      await signedInShell();
    });
  }
  return { page, context, step, see, nav };
}

/*
 * The composer's names, current and before 0.5.15 (live smoke may meet either version during a rollout): the send
 * button, the recipient field (an ARIA combobox now, a placeholder before) and its matches (options, buttons before).
 */
export const SEND_LABEL = /^(Send message|Send handoff)$/;
export const SEND_TEXT = /Send message|Send handoff/;
export const NEW_MESSAGE_TEXT = /^(New message|New handoff)$/;
export const CONTACT_SEND_LABEL = /^(Send a message|Send a drop)$/;
export const recipientField = (page) =>
  page.getByRole('combobox', { name: 'Search recipients' }).or(page.getByPlaceholder(/Dr\. Wang/));
export const recipientMatch = (page, name) =>
  page.getByRole('option', { name }).or(page.getByRole('button', { name }));

/** Composes and sends one message from the composer that is open on `page`; waits for "Delivered". */
export async function composeAndSend(page, see, { recipient, recipientLabel, title, body }) {
  await see(SEND_TEXT);
  await recipientField(page).fill(recipient);
  await recipientMatch(page, recipientLabel).first().click();
  await page.getByPlaceholder('What does the other side need to know?').fill(title);
  await page.getByPlaceholder(/Write down the confirmed context/).fill(body);
  await page.getByRole('button', { name: SEND_LABEL }).click();
  await see('Delivered');
}

export function summarize(results, outDir) {
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(
      `\n${failed.length} of ${results.length} step(s) failed:\n- ${failed.map((f) => `${f.label}: ${f.error}`).join('\n- ')}\nScreenshots: ${outDir}`,
    );
    return 1;
  }
  console.log(`\nAll ${results.length} steps passed.`);
  return 0;
}
