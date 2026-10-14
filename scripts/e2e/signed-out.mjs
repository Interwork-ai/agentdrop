/**
 * A signed-out browser context for journeys that use the auth pages (sign-in, sign-up, forgot password).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { OUT } from './server.mjs';

/**
 * A signed-out browser context with the same pass rule as ctx.session's steps: the action completed, the page is
 * not blank, no error boundary, no uncaught page error or unexpected console error.
 */
export async function openSignedOut(ctx, label, { allowConsole = [] } = {}) {
  const context = await ctx.browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
  page.on('console', (m) => {
    // the session probe while signed out, a rejected sign-in and the sign-in rate limit are expected
    if (
      m.type() === 'error' &&
      !/fonts\.googleapis\.com|status of 401|status of 429/.test(m.text()) &&
      !allowConsole.some((re) => re.test(m.text()))
    )
      errors.push(`console: ${m.text()}`);
  });
  const prefix = `[${ctx.mode}] ${label}`;
  const step = async (stepName, fn) => {
    const full = `${prefix}: ${stepName}`;
    const before = errors.length;
    try {
      await fn();
      await page.waitForTimeout(300);
      const text = await page.locator('body').innerText();
      if (text.trim().length < 40) throw new Error('page is blank');
      if (/This page could not be shown|这个页面没能显示出来/.test(text))
        throw new Error('error boundary shown');
      if (errors.length > before) throw new Error(errors.slice(before).join(' | '));
      ctx.results.push({ label: full, ok: true });
      console.log(`  ok   ${full}`);
    } catch (err) {
      let message = err instanceof Error ? err.message.split('\n')[0] : String(err);
      if (errors.length > before) message = `${errors.slice(before).join(' | ')} (then: ${message})`;
      ctx.results.push({ label: full, ok: false, error: message });
      console.log(`  FAIL ${full}: ${message}`);
      mkdirSync(OUT, { recursive: true });
      await page
        .screenshot({ path: join(OUT, `${full.replace(/[^a-z0-9]+/gi, '-').slice(0, 120)}.png`) })
        .catch(() => {});
    }
  };
  const see = (text, timeout = 10_000) => page.getByText(text, { exact: false }).first().waitFor({ timeout });
  return { page, context, step, see };
}
