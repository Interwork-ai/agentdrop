/**
 * The public product page at `/`: signed out it explains AgentDrop and leads to sign-up; signed in it leads back to
 * the inbox. Nothing is cut off on a phone.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { signUp } from '../api.mjs';
import { OUT } from '../server.mjs';

export const name = 'landing';

const HEADLINE = 'Tell your agent who it’s for. It’s waiting in theirs.';

export async function run(ctx) {
  const visitor = await signedOut(ctx, 'visitor', { width: 1360, height: 900 });
  await visitor.step('the product page explains AgentDrop to a visitor', async () => {
    await visitor.page.goto(`${ctx.base}/`);
    await visitor.page.getByRole('heading', { level: 1, name: HEADLINE }).waitFor();
    await visitor.page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Sign in' })
      .waitFor();
    for (const section of ['How it works', 'Features', 'Privacy', 'Self-hosting'])
      await visitor.page.getByRole('link', { name: section, exact: true }).first().waitFor();
  });
  await visitor.step('"See how it works" scrolls to the steps', async () => {
    await visitor.page.getByRole('link', { name: 'See how it works' }).click();
    await visitor.page.waitForFunction(() => {
      const el = document.getElementById('how-it-works');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    });
  });
  await visitor.step('the example inbox opens the drop that is clicked', async () => {
    await visitor.page.getByRole('button', { name: /Settings page: design tokens/ }).click();
    await visitor.page
      .locator('[data-demo-title]')
      .filter({ hasText: /^Settings page: design tokens$/ })
      .waitFor();
  });
  await visitor.step('privacy keeps what is enforced apart from what agents are told', async () => {
    await visitor.page.getByRole('heading', { level: 3, name: 'Enforced by the software' }).waitFor();
    await visitor.page.getByRole('heading', { level: 3, name: 'Agents are told to' }).waitFor();
    await visitor.page.getByRole('heading', { level: 3, name: 'What the server operator can see' }).waitFor();
  });
  await visitor.step('an FAQ answer opens', async () => {
    await visitor.page.getByText('Is it a chat app?').click();
    await visitor.page.getByText('Each message is a single delivery').waitFor();
  });
  await visitor.step('"Create your account" leads to sign-up', async () => {
    await visitor.page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Create your account' })
      .click();
    await visitor.page.waitForURL(/\/signup/);
  });
  await visitor.close();

  const phone = await signedOut(ctx, 'phone', { width: 390, height: 844 });
  await phone.step('nothing is cut off on a phone', async () => {
    await phone.page.goto(`${ctx.base}/`);
    await phone.page.getByRole('heading', { level: 1, name: HEADLINE }).waitFor();
    const overflow = await phone.page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (overflow > 1) throw new Error(`the page is ${overflow}px wider than the screen`);
  });
  await phone.step('the setup command never wraps in the middle of a line', async () => {
    const wrapped = await phone.page.evaluate(() =>
      [...document.querySelectorAll('pre > div')]
        .filter((line) => line.getBoundingClientRect().height > 24)
        .map((line) => line.textContent),
    );
    if (wrapped.length) throw new Error(`wrapped: ${wrapped.join(' | ')}`);
  });
  await phone.step('the menu on a phone leads to a section', async () => {
    await phone.page.getByRole('button', { name: 'Open menu' }).click();
    await phone.page.locator('#landing-menu').getByRole('link', { name: 'Privacy' }).click();
    await phone.page.getByRole('button', { name: 'Open menu' }).waitFor();
    await phone.page.waitForFunction(() => {
      const r = document.getElementById('privacy')?.getBoundingClientRect();
      return r !== undefined && r.top < window.innerHeight && r.bottom > 0;
    });
  });
  await phone.close();

  const chinese = await signedOut(ctx, 'chinese', { width: 1360, height: 900 }, 'zh');
  await chinese.step('in Chinese, the page and its title are Chinese', async () => {
    await chinese.page.goto(`${ctx.base}/`);
    await chinese.page
      .getByRole('heading', { level: 1, name: /^告诉 Agent 发给谁，\s?它就在对方的 Agent 里等着。$/ })
      .waitFor();
    await chinese.page.waitForFunction(() => document.title.includes('共享收件箱'));
    const description = await chinese.page.getAttribute('meta[name="description"]', 'content');
    if (!description?.includes('oh-my-pi') || !/[一-鿿]/.test(description))
      throw new Error(`description is not the Chinese one: ${description}`);
    await chinese.page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: '注册账号' })
      .waitFor();
  });
  await chinese.close();

  const member = await signUp('lp_member');
  const { page, context, step } = await ctx.session('member', member);
  await step('signed in, the product page leads back to the inbox', async () => {
    await page.goto(`${ctx.base}/`);
    await page.getByRole('heading', { level: 1, name: HEADLINE }).waitFor();
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Open inbox' }).click();
    await page.waitForURL(/\/app\/inbox/);
  });
  await context.close();
}

/** A signed-out browser context whose steps fail on a blank page, an uncaught error or an unexpected console error. */
async function signedOut(ctx, label, viewport, lang = 'en') {
  const context = await ctx.browser.newContext({ viewport });
  if (lang !== 'en')
    await context.addInitScript((l) => window.localStorage.setItem('agentdrop.lang', l), lang);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
  page.on('console', (m) => {
    // the signed-out session probe answers 401 by design
    if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  const prefix = `[${ctx.mode}] landing/${label}`;
  const step = async (stepName, fn) => {
    const full = `${prefix}: ${stepName}`;
    const before = errors.length;
    try {
      await fn();
      await page.waitForTimeout(300);
      const text = await page.locator('body').innerText();
      if (text.trim().length < 40) throw new Error('page is blank');
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
  return { page, step, close: () => context.close() };
}
