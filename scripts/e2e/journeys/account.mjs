/**
 * Account journeys: managing one's agents (rename, receiving, deleting per ADR 0015), settings that persist
 * (nickname, public email, theme, language), an administrator's password-reset link used by the person it is for,
 * and the auth pages themselves (sign-up, a wrong password, forgot password).
 */
import { makeAdmin, signUp } from '../api.mjs';
import { PASSWORD } from '../server.mjs';
import { openSignedOut } from '../signed-out.mjs';

export const name = 'account';

/** The sentence the "Delete agent" confirmation adds only when it is the person's last agent (ADR 0015). */
const LAST_AGENT = 'This is your last agent: you will also leave all of your groups';

export async function run(ctx) {
  const ann = await signUp('ac_ann', ['codex', 'claude-code']);
  const root = await signUp('ac_root');
  const bea = await signUp('ac_bea');
  const pi = await signUp('ac_pi', ['omp']);
  const wb = await signUp('ac_wb', ['workbuddy']);
  makeAdmin('ac_root');

  await agents(ctx, ann);
  await ompAgent(ctx, pi);
  await workbuddyAgent(ctx, wb);
  await settings(ctx, ann);
  await admin(ctx, root, bea);
  await authPages(ctx, ann);
}

/** Accepts the next confirm() and returns its text. */
const nextDialog = (page, action = 'accept') =>
  new Promise((resolve) => {
    page.once('dialog', async (d) => {
      const message = d.message();
      await (action === 'accept' ? d.accept() : d.dismiss());
      resolve(message);
    });
  });

/** Polls until `read()` returns `want`; says what it saw last when it gives up. */
async function until(what, read, want, timeout = 10_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (last === want) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(last)}`);
}

/** An oh-my-pi agent is listed with its tool's name, like every other harness. */
async function ompAgent(ctx, pi) {
  const { page, step, nav } = await ctx.session('pi agents', pi);
  await step('my agents names an oh-my-pi agent by its tool', async () => {
    await nav('My agents');
    const row = page.getByRole('listitem').filter({ has: page.getByText('ac_pi omp', { exact: true }) });
    await row.first().waitFor();
    await row.first().getByText('oh-my-pi', { exact: true }).first().waitFor();
  });
}

/** A WorkBuddy agent, the newest harness, is named by its tool the same way. */
async function workbuddyAgent(ctx, wb) {
  const { page, step, nav } = await ctx.session('workbuddy agents', wb);
  await step('my agents names a WorkBuddy agent by its tool', async () => {
    await nav('My agents');
    const row = page
      .getByRole('listitem')
      .filter({ has: page.getByText('ac_wb workbuddy', { exact: true }) });
    await row.first().waitFor();
    await row.first().getByText('WorkBuddy', { exact: true }).first().waitFor();
  });
}

async function agents(ctx, ann) {
  const { page, context, step, see, nav } = await ctx.session('ann agents', ann);
  // by the agent's own name: a row's hand-over list also names the other agents
  const row = (label) => page.getByRole('listitem').filter({ has: page.getByText(label, { exact: true }) });
  const receiving = page.getByRole('radiogroup').first();
  const checked = (name) => receiving.getByRole('radio', { name, exact: true }).getAttribute('aria-checked');

  await step('my agents lists both agents', async () => {
    await nav('My agents');
    await see('Messages sent to @ac_ann reach');
    await row('ac_ann codex').first().waitFor();
    await row('ac_ann claude-code').first().waitFor();
    await until('"All my agents" is the default', () => checked('All my agents'), 'true');
  });
  await step('rename an agent under Manage', async () => {
    const codex = row('ac_ann codex').first();
    await codex.getByRole('button', { name: 'Manage' }).click();
    await codex.getByRole('menuitem', { name: 'Rename' }).click();
    await codex.getByLabel('Agent name').fill('Research laptop');
    await codex.getByRole('button', { name: 'Save' }).click();
    await row('Research laptop').first().waitFor();
    await row('ac_ann codex').first().waitFor({ state: 'detached' });
  });
  await step('"Receive only here" switches to one agent', async () => {
    const claude = row('ac_ann claude-code').first();
    const dialog = nextDialog(page);
    await claude.getByRole('button', { name: 'Receive only here' }).click();
    const message = await dialog;
    if (!message.includes('Only this agent will receive messages sent to you directly'))
      throw new Error(`unexpected confirmation: ${message}`);
    await until('"One agent" after the switch', () => checked('One agent'), 'true');
    await claude.getByText('Default receiver', { exact: true }).waitFor();
  });
  await step('back to "All my agents"', async () => {
    await receiving.getByRole('radio', { name: 'All my agents' }).click();
    await until('"All my agents" after switching back', () => checked('All my agents'), 'true');
    await row('ac_ann claude-code').first().getByText('Receives', { exact: true }).waitFor();
  });
  await step('delete the agent that receives alone; receiving returns to all agents (ADR 0015)', async () => {
    const claude = row('ac_ann claude-code').first();
    const pick = nextDialog(page);
    await claude.getByRole('button', { name: 'Receive only here' }).click();
    await pick;
    await until('"One agent" before deleting', () => checked('One agent'), 'true');
    await claude.getByRole('button', { name: 'Manage' }).click();
    const dialog = nextDialog(page);
    await claude.getByRole('menuitem', { name: 'Delete agent' }).click();
    const message = await dialog;
    if (!message.startsWith('Delete "ac_ann claude-code"?'))
      throw new Error(`unexpected confirmation: ${message}`);
    if (message.includes(LAST_AGENT))
      throw new Error('the confirmation warns about the last agent although another one remains');
    await row('ac_ann claude-code').first().waitFor({ state: 'detached' });
    await see('Show deleted (1)');
    await until('"All my agents" after deleting the chosen agent', () => checked('All my agents'), 'true');
  });
  await step('deleting the last agent warns about leaving groups (dismissed)', async () => {
    const last = row('Research laptop').first();
    await last.getByRole('button', { name: 'Manage' }).click();
    const dialog = nextDialog(page, 'dismiss');
    await last.getByRole('menuitem', { name: 'Delete agent' }).click();
    const message = await dialog;
    if (!message.includes(LAST_AGENT)) throw new Error(`no last-agent warning in: ${message}`);
    await page.waitForTimeout(500);
    await last.waitFor();
  });
  await context.close();
}

async function settings(ctx, ann) {
  const { page, context, step, see, nav } = await ctx.session('ann settings', ann);
  const nickname = () => page.getByLabel('Public nickname');
  const email = () => page.getByLabel('Public email');
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const radio = (group, name) =>
    page.getByRole('radiogroup', { name: group }).getByRole('radio', { name, exact: true });

  await step('save a public nickname', async () => {
    await nav('Settings');
    await nickname().fill('Ann Research');
    await page.getByRole('button', { name: 'Save nickname' }).click();
    await until(
      'Save nickname disabled after saving',
      async () => page.getByRole('button', { name: 'Save nickname' }).isDisabled(),
      true,
    );
  });
  await step('save a public email', async () => {
    await email().fill('ann.public@example.com');
    await page.getByRole('button', { name: 'Save email' }).click();
    await until(
      'Save email disabled after saving',
      async () => page.getByRole('button', { name: 'Save email' }).isDisabled(),
      true,
    );
  });
  await step('nickname and email persist after a reload', async () => {
    await page.reload();
    await see('Language & theme');
    await until('nickname after reload', () => nickname().inputValue(), 'Ann Research');
    await until('public email after reload', () => email().inputValue(), 'ann.public@example.com');
  });
  await step('switch to the light theme and Chinese', async () => {
    await radio('Theme', 'Light').click();
    await until('theme', theme, 'light');
    await radio('Language', '中文').click();
    await see('语言与主题');
  });
  await step('theme and language persist after a reload', async () => {
    await page.reload();
    await see('语言与主题');
    await until('theme after reload', theme, 'light');
    await until('中文 selected', () => radio('语言', '中文').getAttribute('aria-checked'), 'true');
    await until('浅色 selected', () => radio('主题', '浅色').getAttribute('aria-checked'), 'true');
  });
  await step('switch back to dark and English', async () => {
    await radio('主题', '深色').click();
    await until('theme', theme, 'dark');
    await radio('语言', 'English').click();
    await see('Language & theme');
    await page.reload();
    await see('Language & theme');
    await until('theme after reload', theme, 'dark');
  });
  // Reported: jumping to the last sections moved the whole dashboard up, because a hidden checkbox made the
  // document taller than the screen and the browser scrolled it too.
  const sectionsNav = () => page.getByRole('navigation', { name: 'Settings sections' });
  const current = () => sectionsNav().locator('a[aria-current]').innerText();
  const shellMoved = () =>
    page.evaluate(() =>
      window.scrollY !== 0 || document.documentElement.scrollHeight > window.innerHeight + 1
        ? `window scrolled ${window.scrollY}px, document ${document.documentElement.scrollHeight}px of ${window.innerHeight}px`
        : '',
    );
  await step('settings sections jump without moving the dashboard', async () => {
    for (const name of ['Agent clients', 'Privacy']) {
      await sectionsNav().getByRole('link', { name, exact: true }).click();
      await until(`${name} marked as current`, current, name);
      await until(`dashboard in place after ${name}`, shellMoved, '');
    }
  });
  await step('a link to a settings section opens at that section', async () => {
    await page.goto(`${ctx.base}/app/settings#clients`);
    await see('Language & theme');
    await until('Agent clients marked as current', current, 'Agent clients');
    await until(
      'clients heading at the top',
      () =>
        page.evaluate(() => {
          const top = document.getElementById('clients')?.getBoundingClientRect().top ?? -1;
          return top > 40 && top < 140 ? 'yes' : `heading at ${Math.round(top)}px`;
        }),
      'yes',
    );
    await until('dashboard in place', shellMoved, '');
  });
  await context.close();
}

/** A signed-out browser for this journey (scripts/e2e/signed-out.mjs). */
const signedOut = (ctx, label) => openSignedOut(ctx, `account/${label}`);

async function admin(ctx, root, bea) {
  const { page, context, step, see, nav } = await ctx.session('root admin', root);
  let link = '';
  await step('admin overview shows product health from counts only', async () => {
    await nav('Admin');
    await page.getByRole('heading', { name: 'Product health', exact: true }).waitFor();
    await see('Answered within 72 hours, last 7 days');
    await see('Paired an agent in their first week');
    // metadata only: the overview names nobody
    const text = await page.locator('main').innerText();
    if (text.includes('@ac_ann') || text.includes('@ac_bea')) throw new Error('the overview names a person');
  });
  await step('admin users list shows people', async () => {
    await nav('Admin');
    await page.getByRole('link', { name: 'Users', exact: true }).click();
    await page.waitForURL(/\/app\/admin\/users/);
    await see('@ac_ann');
    await see('@ac_bea');
  });
  await step('open a user', async () => {
    await page.getByRole('button', { name: /@ac_bea/ }).click();
    await page.getByRole('heading', { name: 'Bea', exact: true }).waitFor();
    await see('Reset password');
  });
  await step('generate a password-reset link', async () => {
    await page.getByRole('button', { name: 'Generate reset link' }).click();
    await see('The link is shown only this once');
    link = (
      await page
        .getByText(/\/reset-password\?token=/)
        .first()
        .innerText()
    ).trim();
    if (!link.startsWith(`${ctx.base}/reset-password?token=`))
      throw new Error(`reset link is not on this server's origin: ${link.replace(/token=.*/, 'token=…')}`);
  });
  await context.close();

  const fresh = await signedOut(ctx, 'bea reset');
  const NEW_PASSWORD = 'e2e-new-password-456';
  await fresh.step('open the reset link and set a new password', async () => {
    if (!link) throw new Error('no reset link was generated');
    await fresh.page.goto(link);
    await fresh.see('Set a new password');
    await fresh.page.getByLabel(/^New password/).fill(NEW_PASSWORD);
    await fresh.page.getByLabel('Enter it again').fill(NEW_PASSWORD);
    await fresh.page.getByRole('button', { name: 'Save new password' }).click();
    await fresh.page.waitForURL(/\/login\?reset=done/);
    await fresh.see('Password reset. Sign in with your new password.');
  });
  await fresh.step('sign in with the new password on the login form', async () => {
    await fresh.page.getByLabel('Email').fill(bea.email);
    await fresh.page.getByLabel('Password').fill(NEW_PASSWORD);
    await fresh.page.getByRole('button', { name: 'Sign in' }).click();
    await fresh.page.waitForURL(/\/app\//);
    await fresh.see('Inbox');
  });
  await fresh.context.close();
}

async function authPages(ctx, ann) {
  const signup = await signedOut(ctx, 'sign-up');
  await signup.step('sign up through the form lands in the app with the pairing banner', async () => {
    await signup.page.goto(`${ctx.base}/signup`);
    await signup.page.getByLabel('Email').fill('ac_new@e2e.test');
    await signup.page.getByLabel('Password').fill(PASSWORD);
    await signup.page.getByLabel('Username').fill('ac_new');
    await signup.page.getByLabel('Display name').fill('New Person');
    await signup.page.getByRole('button', { name: 'Create account' }).click();
    await signup.page.waitForURL(/\/app\/agents/);
    // My agents shows the setup steps itself, so the banner is replaced there by a link in the top bar
    await signup.see('No paired agents yet');
    await signup.page.getByRole('link', { name: 'No agent paired yet · see setup steps' }).waitFor();
    await signup.page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: /^Inbox/ })
      .click();
    await signup.page.getByRole('region', { name: 'Pair an agent' }).waitFor();
    await signup.see('Pair an agent to start using AgentDrop');
  });
  await signup.context.close();

  const login = await signedOut(ctx, 'login');
  await login.step('a wrong password shows an error on the login form', async () => {
    await login.page.goto(`${ctx.base}/login`);
    await login.page.getByLabel('Email').fill(ann.email);
    await login.page.getByLabel('Password').fill('not-the-password-000');
    await login.page.getByRole('button', { name: 'Sign in' }).click();
    await login.page.getByRole('alert').getByText('Wrong email or password.').waitFor();
    if (!/\/login/.test(login.page.url())) throw new Error(`left the login page: ${login.page.url()}`);
  });
  await login.step('a rate-limited sign-in says so, not "wrong password"', async () => {
    // What the server answers after 3 attempts in 10 s from one address (a shared office or lab network).
    await login.page.route('**/api/auth/sign-in/email', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: '{"message":"Too many requests"}',
      }),
    );
    await login.page.getByLabel('Password').fill(ann.password);
    await login.page.getByRole('button', { name: 'Sign in' }).click();
    await login.page.getByRole('alert').getByText('Too many sign-in attempts from this network').waitFor();
    await login.page.unroute('**/api/auth/sign-in/email');
  });
  await login.step('"Forgot password" page renders', async () => {
    await login.page.getByRole('link', { name: 'Forgot password' }).click();
    await login.page.waitForURL(/\/forgot-password/);
    await login.page.getByRole('heading', { name: 'Forgot password' }).waitFor();
    // no SMTP on the test server: no email form; a recovery code, the device command, an administrator last
    await login.page.getByRole('heading', { name: 'With a recovery code' }).waitFor();
    await login.see('agentdrop account recover');
    await login.see('An administrator of this server can make a reset link for you');
    if (await login.page.getByRole('heading', { name: 'By email' }).count())
      throw new Error('an email form without SMTP');
    await login.page.getByRole('link', { name: 'Back to sign in' }).waitFor();
  });
  await login.context.close();
}
