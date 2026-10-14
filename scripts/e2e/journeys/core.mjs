/**
 * The core journeys: a person with contacts, a group and mail (alice), accepting a contact (carol), and a person
 * without an agent who pairs one (dave).
 */
import { composeAndSend } from '../../lib/smoke-kit.mjs';
import {
  call,
  connect,
  group,
  makeAdmin,
  sendDrop,
  signUp,
  startPairing,
  toGroup,
  toPerson,
} from '../api.mjs';

export const name = 'core';

export async function run(ctx) {
  const alice = await signUp('alice', ['codex', 'claude-code']);
  const bob = await signUp('bob');
  const carol = await signUp('carol');
  const dave = await signUp('dave', []); // no agent: the pairing banner and /pair approval
  makeAdmin('alice');
  await connect(alice, bob);
  // carol gets a request she accepts in the browser
  await call(alice.jar, 'POST', '/v1/me/contacts/invite', { handle: carol.handle });
  const team = await group(alice, { slug: 'e2e-team', name: 'E2E team', members: [bob] });
  await sendDrop(bob, [toPerson(alice)], 'E2E hello from Bob', 'Body from Bob for the e2e test.');
  await sendDrop(bob, [toGroup(team)], 'E2E group note', 'A note to the whole group.');

  await asAlice(ctx, alice);
  await asCarol(ctx, carol);
  await asDave(ctx, dave);
}

async function asAlice(ctx, alice) {
  const { page, context, step, see, nav } = await ctx.session('alice', alice, { uiSignIn: true });
  await step('inbox lists the drop', () => see('E2E hello from Bob'));
  await step('open a drop and star it at once, on a slow network', async () => {
    // Hold back the automatic mark-as-read so Star is clicked while it is still in flight, as on a distant server.
    let held = false;
    await page.route('**/drops/*/state', async (route) => {
      if (!held) {
        held = true;
        await new Promise((r) => setTimeout(r, 1500));
      }
      await route.continue();
    });
    await page.getByText('E2E hello from Bob').first().click();
    await see('Body from Bob for the e2e test.');
    await page.getByRole('button', { name: 'Star', exact: true }).first().click();
    await page.getByRole('button', { name: 'Starred', exact: true }).first().waitFor();
    await page.unroute('**/drops/*/state');
    await nav('Starred');
    await see('E2E hello from Bob');
  });
  await step('reply from a drop opens the composer as a reply', async () => {
    await nav('Inbox');
    await page.getByText('E2E hello from Bob').first().click();
    await page.getByRole('button', { name: 'Reply', exact: true }).first().click();
    await page.waitForURL(/\/app\/compose/);
    await see('Send message');
    await see('Replying to');
  });
  await step('sent list', () => nav('Sent'));
  await step('archived list', () => nav('Archived'));
  await step('compose from the navigation and send', async () => {
    await page.getByText('New message', { exact: true }).first().click();
    await composeAndSend(page, see, {
      recipient: 'bob',
      recipientLabel: /Bob\s*@bob/,
      title: 'E2E sent from the dashboard',
      body: 'Sent by the e2e smoke test.',
    });
  });
  await step('send another resets the form', async () => {
    await page.getByRole('button', { name: 'Send another' }).click();
    await see('Send message');
  });
  await step('sent list shows the new drop', async () => {
    await nav('Sent');
    await see('E2E sent from the dashboard');
    await page.getByText('E2E sent from the dashboard', { exact: true }).first().click();
    await see('reading through the API or CLI alone does not');
  });
  await step('contacts: open a contact', async () => {
    await nav('Contacts');
    await page.getByText('Bob', { exact: true }).first().click();
    await see('Send a message');
  });
  await step('contacts: "Send a message" opens the composer', async () => {
    await page.getByRole('button', { name: 'Send a message' }).click();
    await page.waitForURL(/\/app\/compose/);
    await see('Send message');
  });
  await step('contacts: create an invite link', async () => {
    await nav('Contacts');
    await page.getByRole('button', { name: 'Create link' }).click();
    await see('Copy link');
  });
  await step('groups: open a group timeline', async () => {
    await nav('All groups');
    await page.getByText('E2E team').first().click();
    await see('E2E group note');
  });
  await step('my agents', async () => {
    await nav('My agents');
    await see('Messages sent to @alice reach');
  });
  await step('approvals', () => nav('Approvals'));
  await step('settings', async () => {
    await nav('Settings');
    await see('Language');
  });
  await step('help', async () => {
    await nav('Help');
    await see('Getting started');
  });
  await step('admin', async () => {
    await page.goto(`${ctx.base}/app/admin`);
    await see('alice');
  });
  await step('switch language to Chinese and back', async () => {
    await page.getByRole('button', { name: 'Switch to Chinese' }).first().click();
    await see('收件箱');
    await page
      .getByRole('button', { name: /Switch to English|切换到英文|English/ })
      .first()
      .click();
    await see('Inbox');
  });
  await step('sign out', async () => {
    await page.getByRole('button', { name: 'Sign out' }).first().click();
    await page.waitForURL(/\/login/, { timeout: 10000 });
  });
  await context.close();
}

async function asCarol(ctx, carol) {
  const { page, context, step, see, nav } = await ctx.session('carol', carol);
  await step('accept a contact request', async () => {
    await nav('Contacts');
    await page.getByText('Alice', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Accept', exact: true }).first().click();
    // the request row is replaced by the contact row; click the new one, not the one being removed
    await page.getByRole('button', { name: 'Accept', exact: true }).first().waitFor({ state: 'detached' });
    await page.getByText('Alice', { exact: true }).first().click();
    await see('Send a message');
  });
  await context.close();
}

async function asDave(ctx, dave) {
  const { page, context, step, see } = await ctx.session('dave', dave);
  await step('pairing banner without an agent', () => see('Pair an agent to start using AgentDrop'));
  await step('composer explains why it cannot send', async () => {
    await page.goto(`${ctx.base}/app/compose`);
    await see('Pair an agent first');
  });
  await step('approve a device on /pair', async () => {
    const s = await startPairing('dave', 'codex');
    await page.goto(`${ctx.base}/pair?code=${encodeURIComponent(s.user_code)}`);
    await see('can read messages sent or received by any of your agents');
    await page.getByRole('button', { name: 'Approve' }).click();
    await see('View my agents');
  });
  await step('pairing explains the restricted mailbox policy too', async () => {
    await call(dave.jar, 'PATCH', '/v1/me/mailbox-settings', { cross_h_mailbox_enabled: false });
    const s = await startPairing('dave', 'claude-code');
    await page.goto(`${ctx.base}/pair?code=${encodeURIComponent(s.user_code)}`);
    await see('can read its mailbox and change read, starred and archived state shared across your agents');
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await see('The terminal will not receive any credentials.');
  });
  await context.close();
}
