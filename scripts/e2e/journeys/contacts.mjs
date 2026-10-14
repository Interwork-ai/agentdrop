/**
 * Contacts, as a person clicks them: invite by @handle and decline, withdraw, accept, a private note that survives a
 * reload, block and unblock, remove, and invite links: a brand-new visitor signs up through one (no agent yet, so
 * the owner's request waits, ADR 0014, and their first pairing connects them, ADR 0034) and an existing person adds
 * the owner from one.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { emailOf, signUp, startPairing } from '../api.mjs';
import { OUT, PASSWORD } from '../server.mjs';

export const name = 'contacts';

export async function run(ctx) {
  const ann = await signUp('ct_ann'); // invites everyone and owns the invite link
  const ben = await signUp('ct_ben'); // declines, then is invited again and the invitation withdrawn
  const cat = await signUp('ct_cat'); // accepts; then a note, block/unblock and removal on Ann's side
  const dan = await signUp('ct_dan'); // an existing person with an agent who opens Ann's link

  const a = await ctx.session('ann', ann);
  const b = await ctx.session('ben', ben);
  const c = await ctx.session('cat', cat);

  const inviteByHandle = async (handle) => {
    await a.nav('Contacts');
    await a.page.getByLabel('Handle to invite').fill(handle);
    await a.page.getByRole('button', { name: 'Invite', exact: true }).click();
    await a.see('Invitations sent (1)');
    await a.see(`@${handle}`);
    await a.see('Waiting for them to accept');
  };

  // 1. invite by handle, the invitee declines, the inviter's list follows
  await a.step('invite @ct_ben by handle', () => inviteByHandle('ct_ben'));
  await b.step('the invitee sees the request', async () => {
    await b.nav('Contacts');
    await b.see('Requests received (1)');
    await b.see('@ct_ann');
  });
  await b.step('the invitee declines it', async () => {
    await b.page.getByRole('button', { name: 'Decline', exact: true }).click();
    await gone(b.page.getByText('Requests received'));
    await gone(b.page.getByText('@ct_ann'));
  });
  await a.step("the inviter's pending invitation goes away without a reload", async () => {
    // the contacts list polls every 10 s while the page is visible
    await gone(a.page.getByText('Waiting for them to accept'), 20_000);
    await gone(a.page.getByText('@ct_ben'));
  });

  // 2. invite again and withdraw it
  await a.step('invite @ct_ben again', () => inviteByHandle('ct_ben'));
  await a.step('withdraw the invitation', async () => {
    await a.page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await gone(a.page.getByText('Invitations sent'));
    await gone(a.page.getByText('@ct_ben'));
  });
  await b.step('the withdrawn request is gone for the invitee', async () => {
    await b.page.reload();
    await b.see('No people in your contacts yet');
    await gone(b.page.getByText('Requests received'));
    await gone(b.page.getByText('@ct_ann'));
  });

  // an unknown handle: the error names it and is tied to the field
  await a.step(
    'inviting an unknown handle names it next to the field',
    async () => {
      const field = a.page.getByLabel('Handle to invite');
      await field.fill('ct_nobody');
      await a.page.getByRole('button', { name: 'Invite', exact: true }).click();
      await a.see('Nobody on this server has the username @ct_nobody');
      if ((await field.getAttribute('aria-invalid')) !== 'true')
        throw new Error('the field is not marked invalid');
      const described = await field.getAttribute('aria-describedby');
      const said = described ? await a.page.locator(`[id="${described}"]`).innerText() : '';
      if (!said.includes('@ct_nobody'))
        throw new Error(`the field is not described by the error ("${said}")`);
      await field.fill('');
    },
    // the server's 404 for the unknown handle is the point of this step; the page explains it
    { allowConsole: [/status of 404/] },
  );

  // 3. accept in the UI
  await a.step('invite @ct_cat', () => inviteByHandle('ct_cat'));
  await c.step('accept the request', async () => {
    await c.nav('Contacts');
    await c.see('Requests received (1)');
    await c.page.getByRole('button', { name: 'Accept', exact: true }).click();
    await gone(c.page.getByText('Requests received'));
    await c.page.getByRole('link', { name: /Ann\s*@ct_ann/ }).click();
    await c.page.getByRole('button', { name: 'Send a message' }).waitFor();
  });
  await a.step('the inviter sees the new contact', async () => {
    await a.page.reload();
    await gone(a.page.getByText('Invitations sent'));
    await a.page.getByRole('link', { name: /Cat\s*@ct_cat/ }).click();
    await a.page.getByRole('button', { name: 'Send a message' }).waitFor();
  });
  await a.step('"Send a message" opens the composer addressed to the contact', async () => {
    await a.page.getByRole('button', { name: 'Send a message' }).click();
    await a.page.waitForURL(/\/app\/compose\?to=%40ct_cat$/);
    await a.page.goBack();
    await a.page.getByRole('button', { name: 'Send a message' }).waitFor();
  });

  // 4. a private note persists across a reload
  const note = 'Cat from the lab';
  await a.step('save a private note', async () => {
    await a.page.getByLabel('Private note').fill(note);
    await a.page.getByRole('button', { name: 'Save', exact: true }).click();
    await a.page.getByRole('heading', { name: note }).waitFor();
    await a.see('Public nickname: Cat');
  });
  await a.step('the private note is still there after a reload', async () => {
    await a.page.reload();
    await a.page.getByRole('heading', { name: note }).waitFor();
    const value = await a.page.getByLabel('Private note').inputValue();
    if (value !== note) throw new Error(`note field shows "${value}", expected "${note}"`);
    await a.page.getByRole('link', { name: new RegExp(`${note}\\s*@ct_cat`) }).waitFor();
  });

  // 5. block and unblock
  await a.step('block the contact', async () => {
    await a.page.getByRole('button', { name: 'Block', exact: true }).click();
    await a.page.getByRole('button', { name: 'Unblock', exact: true }).waitFor();
    await a.page.getByRole('link', { name: /@ct_cat.*Blocked/ }).waitFor();
    await gone(a.page.getByRole('button', { name: 'Send a message' }));
  });
  await a.step('unblock the contact', async () => {
    await a.page.getByRole('button', { name: 'Unblock', exact: true }).click();
    await a.page.getByRole('button', { name: 'Block', exact: true }).waitFor();
    await a.page.getByRole('button', { name: 'Send a message' }).waitFor();
    await gone(a.page.getByRole('link', { name: /@ct_cat.*Blocked/ }));
  });

  // 6. remove, after confirming the browser dialog
  await a.step('remove the contact', async () => {
    let asked = '';
    a.page.once('dialog', (d) => {
      asked = d.message();
      d.accept();
    });
    await a.page.getByRole('button', { name: 'Remove contact' }).click();
    await a.page.waitForURL(/\/app\/contacts$/);
    if (!asked.includes('Remove this contact?')) throw new Error(`confirmation said "${asked}"`);
    await gone(a.page.getByText('@ct_cat'));
    await a.page.reload();
    await a.see('No people in your contacts yet');
    await gone(a.page.getByText('@ct_cat'));
  });
  await c.step('the removed contact is gone for the other person too', async () => {
    await c.nav('Contacts');
    await c.page.reload();
    await c.see('No people in your contacts yet');
    await gone(c.page.getByText('@ct_ann'));
  });
  await b.context.close();
  await c.context.close();

  // 7. invite link: create it and read it from the page
  let url = '';
  await a.step('create an invite link and copy it', async () => {
    await a.nav('Contacts');
    await a.page.getByRole('button', { name: 'Create link' }).click();
    const text = await a.page
      .getByText(/\/invite\/[A-Za-z0-9_-]+/)
      .first()
      .innerText();
    url = text.trim();
    if (!url.startsWith(`${ctx.base}/invite/`))
      throw new Error(`link ${url} does not point at ${ctx.base}/invite/`);
    await a.page.getByRole('button', { name: 'Copy link' }).click();
    // http has no clipboard API; the fallback either copies or says to select the link by hand
    await a.page
      .getByText(/^Copied$|Copy failed/)
      .first()
      .waitFor();
    await a.see('used 0 times');
  });

  if (url) {
    await newcomerThroughLink(ctx, url, a);
    await existingPersonThroughLink(ctx, url, dan, a);
  }
  await a.context.close();
}

/** A visitor with no account opens the link, signs up from it, and is connected once they pair (ADR 0014, 0034). */
async function newcomerThroughLink(ctx, url, a) {
  const handle = 'ct_newbie';
  const n = await freshSession(ctx, 'newcomer');
  await n.step('open the invite link signed out', async () => {
    await n.page.goto(url);
    await n.see('invited you to be an AgentDrop contact');
    await n.see('@ct_ann');
  });
  await n.step('sign up through the link', async () => {
    await n.page.getByRole('button', { name: 'Sign up to accept' }).click();
    await n.page.waitForURL(/\/signup\?next=/);
    await n.page.getByLabel('Email').fill(emailOf(handle));
    await n.page.getByLabel('Password').fill(PASSWORD);
    await n.page.getByLabel('Username').fill(handle);
    await n.page.getByLabel('Display name').fill('Newbie');
    await n.page.getByRole('button', { name: 'Create account' }).click();
    await n.page.waitForURL(/\/invite\//);
    // no agent yet: the request is kept and completes when they pair, instead of making them contacts now
    await n.see("'s invitation is saved. You become contacts as soon as you pair an agent");
    await n.see('agentdrop setup --server');
  });
  await n.step('without an agent the request waits and cannot be accepted', async () => {
    await n.page.getByRole('link', { name: 'Go to Contacts →' }).click();
    await n.page.waitForURL(/\/app\/contacts/);
    await n.see('Pair an agent to start using AgentDrop');
    await n.see('Requests received (1)');
    await n.see('@ct_ann');
    await n.see('Pair an agent first: until then you cannot add contacts or accept requests');
    await n.see('From an invite link you opened: you become contacts as soon as you pair an agent.');
    if (await n.page.getByRole('button', { name: 'Accept', exact: true }).isEnabled())
      throw new Error('Accept is enabled without a paired agent');
  });
  await a.step("the link owner sees the newcomer's pending invitation", async () => {
    await a.page.reload();
    await a.see('Invitations sent (1)');
    await a.see(`@${handle}`);
    await a.see('Opened your invite link: connected as soon as they set up an agent');
    await a.see('used 1 time');
  });
  await n.step('pair an agent: the request is accepted without a click', async () => {
    const s = await startPairing(handle, 'codex');
    await n.page.goto(`${ctx.base}/pair?code=${encodeURIComponent(s.user_code)}`);
    await n.page.getByRole('button', { name: 'Approve' }).click();
    await n.see('View my agents');
    await n.page.goto(`${ctx.base}/app/contacts`);
    await gone(n.page.getByText('Requests received'));
    await n.page.getByRole('link', { name: /Ann\s*@ct_ann/ }).click();
    await n.page.getByRole('button', { name: 'Send a message' }).waitFor();
  });
  await a.step('the link owner and the newcomer are contacts', async () => {
    await a.page.reload();
    await gone(a.page.getByText('Invitations sent'));
    await a.page.getByRole('link', { name: new RegExp(`Newbie\\s*@${handle}`) }).waitFor();
  });
  await n.context.close();
}

/** Someone already signed in, with an agent, opens the link and adds the owner. */
async function existingPersonThroughLink(ctx, url, dan, a) {
  const d = await ctx.session('dan', dan);
  await d.step('open the invite link signed in', async () => {
    await d.page.goto(url);
    await d.see('invited you to be an AgentDrop contact. Once you accept');
  });
  await d.step('add the link owner as a contact', async () => {
    await d.page.getByRole('button', { name: 'Add as contact' }).click();
    await d.see('Added as a contact.');
    await d.see('Your agents can now send to @ct_ann');
    await d.page.getByRole('link', { name: 'View contact →' }).click();
    await d.page.getByRole('button', { name: 'Send a message' }).waitFor();
  });
  await a.step('the link owner sees the new contact and the link count', async () => {
    await a.page.reload();
    await a.page.getByRole('link', { name: /Dan\s*@ct_dan/ }).waitFor();
    await a.see('used 2 times');
  });
  await d.context.close();
}

/** Waits until a locator matches nothing (removed or hidden). */
async function gone(locator, timeout = 10_000) {
  await locator.first().waitFor({ state: 'hidden', timeout });
}

/**
 * A signed-out browser context with the same pass/fail rules as `ctx.session` (page errors, console errors, blank
 * page, error boundary), for a visitor who has no account yet.
 */
async function freshSession(ctx, label) {
  const context = await ctx.browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/fonts\.googleapis\.com|status of 401|status of 429/.test(m.text()))
      errors.push(`console: ${m.text()}`);
  });
  const step = async (stepName, fn) => {
    const full = `[${ctx.mode}] ${name}/${label}: ${stepName}`;
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
