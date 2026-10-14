/**
 * Getting back into an account without email or an administrator (ADR 0036), as a person does it in the browser.
 *
 * - rae makes recovery codes in Settings (a wrong current password is refused), keeps one, and is told they are
 *   shown only once.
 * - Signed out, she uses a code with her sign-in email on "Forgot password": a mistyped code is refused in words,
 *   the right one opens "Set a new password", and she signs in with the new password.
 * - Back in Settings, one code is used up.
 */
import { signUp } from '../api.mjs';
import { PASSWORD } from '../server.mjs';
import { openSignedOut } from '../signed-out.mjs';

export const name = 'recovery';

const NEW_PASSWORD = 'rc-a-new-password-2026';

export async function run(ctx) {
  const rae = await signUp('rc_rae', ['codex']);
  const code = await makeCodes(ctx, rae);
  if (!code) return;
  await useCode(ctx, rae, code);
}

async function makeCodes(ctx, rae) {
  const { page, context, step } = await ctx.session('rae settings', rae);
  const card = page.getByRole('region', { name: 'If you forget your password' });
  let first = null;
  await step('Settings shows how to get back in, with no codes yet', async () => {
    await page.goto(`${ctx.base}/app/settings`);
    await card.getByText('No recovery codes yet.').waitFor();
    await card.getByText('agentdrop account recover').waitFor();
  });
  await step(
    'a wrong current password makes no codes',
    async () => {
      await card.getByRole('button', { name: 'Generate recovery codes' }).click();
      const field = card.getByLabel('Your current password');
      // focus moves into the field the panel just opened
      await page.waitForFunction(() => document.activeElement?.getAttribute('type') === 'password');
      await field.fill('not-my-password-000');
      await card.getByRole('button', { name: 'Generate codes' }).click();
      await card.getByText('That is not your current password.').waitFor();
    },
    { allowConsole: [/status of 400/] },
  );
  await step('the right password shows ten codes once', async () => {
    await card.getByLabel('Your current password').fill(PASSWORD);
    await card.getByRole('button', { name: 'Generate codes' }).click();
    const list = card.getByRole('list', { name: 'Recovery codes' });
    await list.waitFor();
    const codes = await list.getByRole('listitem').allInnerTexts();
    if (codes.length !== 10) throw new Error(`expected 10 codes, got ${codes.length}`);
    for (const c of codes)
      if (!/^[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/.test(c.trim())) throw new Error(`odd code: ${c}`);
    first = codes[0]?.trim() ?? null;
    await card.getByText('Shown only now.').waitFor();
    await card.getByRole('link', { name: 'Download as text' }).waitFor();
    await card.getByRole('button', { name: 'I saved them' }).click();
    await card.getByText('10 of 10 codes left').waitFor();
    // gone from the page once saved
    if (first && (await page.getByText(first).count())) throw new Error('codes still on the page');
  });
  await context.close();
  return first;
}

async function useCode(ctx, rae, code) {
  const out = await openSignedOut(ctx, 'recovery/rae signed out', { allowConsole: [/status of 400/] });
  const { page, step } = out;
  const form = page.getByRole('form', { name: 'With a recovery code' });
  await step('"Forgot password" offers a recovery code and the computer command', async () => {
    await page.goto(`${ctx.base}/login`);
    await page.getByRole('link', { name: 'Forgot password' }).click();
    await page.waitForURL(/\/forgot-password/);
    await form.waitFor();
    await page.getByText('agentdrop account recover').waitFor();
  });
  await step('a mistyped code is refused in words', async () => {
    await form.getByLabel('Sign-in email').fill(rae.email);
    await form.getByLabel('Recovery code').fill('zzzz-zzzz-zzzz');
    await form.getByRole('button', { name: 'Continue' }).click();
    await form.getByText('That email and recovery code do not match an unused code.').waitFor();
  });
  await step('the right code opens "Set a new password", and the new password signs in', async () => {
    // typed the way people do: capitals, no dashes
    await form.getByLabel('Recovery code').fill(code.replace(/-/g, '').toUpperCase());
    await form.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(/\/reset-password/);
    await page.getByRole('heading', { name: 'Set a new password' }).waitFor();
    await page.getByLabel(/^New password/).fill(NEW_PASSWORD);
    await page.getByLabel('Enter it again').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Save new password' }).click();
    await page.waitForURL(/\/login/);
    // a sign-in address of its own (the e2e server trusts the proxy header): the account journey's "wrong
    // password" step runs at the same time and would share the per-address sign-in limit (3 in 10 s)
    await page.setExtraHTTPHeaders({ 'x-forwarded-for': '10.77.0.1' });
    await page.getByLabel('Email').fill(rae.email);
    await page.getByLabel('Password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/app\//);
  });
  await step('back in Settings, one code is used up', async () => {
    await page.goto(`${ctx.base}/app/settings`);
    await page
      .getByRole('region', { name: 'If you forget your password' })
      .getByText('9 of 10 codes left')
      .waitFor();
  });
  await out.context.close();
}
