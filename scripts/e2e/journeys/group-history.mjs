/**
 * Earlier messages for members who join later (ADR 0022): by default a late member's group timeline starts when
 * they joined; the owner switches "New members can see earlier messages" on in the group's Settings, and the late
 * member then finds the earlier message in the group timeline and opens it, read-only. A member sees the setting
 * but cannot change it. Only what predates the member's joining is labelled "Before you joined": a message sent
 * after it, which reached an agent that no longer receives the group, comes back as history without that label.
 *
 * People: olga (owner), pia (member from the start), ned (joins after the first message).
 */
import { call, group, sendDrop, signUp, toGroup } from '../api.mjs';

export const name = 'group-history';

const GROUP = 'History club';
const SLUG = 'gh-history';
const EARLY = 'GH seed order from spring';
const EARLY_BODY = 'Tomatoes from the north bed, beans from the south.';
const LATER = 'GH watering rota for summer';

export async function run(ctx) {
  const olga = await signUp('gh_olga');
  const pia = await signUp('gh_pia');
  // ned has two agents and first receives the group with the second one only (not the one his dashboard shows)
  const ned = await signUp('gh_ned', ['codex', 'claude-code']);
  const nedAgent = (harness) => ned.me.endpoints.find((e) => e.harness_key === harness).h_id;
  const groupId = await group(olga, { slug: SLUG, name: GROUP, members: [pia] });
  await sendDrop(olga, [toGroup(groupId)], EARLY, EARLY_BODY);
  await call(olga.jar, 'POST', `/v1/me/groups/${groupId}/invite`, { handles: [ned.handle] });
  await call(ned.jar, 'POST', `/v1/me/groups/${groupId}/accept`, { h_ids: [nedAgent('claude-code')] });
  // sent after he joined, to the agent he then stops receiving the group with: it leaves his mailbox
  await sendDrop(olga, [toGroup(groupId)], LATER, 'Mornings: pia. Evenings: ned.');
  await call(ned.jar, 'PUT', `/v1/me/groups/${groupId}/bindings`, { h_ids: [nedAgent('codex')] });

  const n = await ctx.session('ned', ned);
  await n.step('a member who joined later does not see earlier messages by default', async () => {
    await n.page.goto(`${ctx.base}/app/groups/${groupId}`);
    await n.see('New members see only messages after they join');
    await n.see('No messages yet. Messages from before you joined are not shown.');
    if ((await n.page.getByText(EARLY).count()) > 0) throw new Error('the earlier message already shows');
    if ((await n.page.getByText(LATER).count()) > 0)
      throw new Error('a message that went to an agent no longer receiving the group still shows');
  });
  await n.step('a member sees the setting but cannot change it', async () => {
    await n.page.getByRole('tab', { name: 'Settings' }).click();
    await n.see('Only the owner can change this.');
    if ((await n.page.getByRole('radiogroup', { name: 'Earlier messages' }).count()) > 0)
      throw new Error('a plain member is offered the owner-only control');
  });

  const o = await ctx.session('olga', olga);
  await o.step('the owner lets new members see earlier messages', async () => {
    await o.page.goto(`${ctx.base}/app/groups/${groupId}?tab=settings`);
    await o.see('Applies to everyone who joins later');
    const on = o.page.getByRole('radio', { name: 'New members can see earlier messages' });
    const off = o.page.getByRole('radio', { name: 'New members see only messages after they join' });
    if ((await off.getAttribute('aria-checked')) !== 'true')
      throw new Error('the setting is not off by default');
    await on.click();
    await until(async () => (await on.getAttribute('aria-checked')) === 'true', 'the setting is on');
    // the group header tells every member what applies
    await o.page
      .locator('header')
      .getByText('New members can see earlier messages', { exact: true })
      .waitFor();
  });
  await o.context.close();

  await n.step('the member who joined later now sees the earlier message in the group timeline', async () => {
    await n.page.goto(`${ctx.base}/app/groups/${groupId}`);
    await n.see('New members can see earlier messages');
    const item = n.page.getByRole('link', { name: new RegExp(EARLY) });
    await item.waitFor();
    await item.getByText('Before you joined', { exact: true }).waitFor();
  });
  await n.step(
    'a message sent after joining is not labelled as earlier, though it only shows as history',
    async () => {
      const later = n.page.getByRole('link', { name: new RegExp(LATER) });
      await later.waitFor();
      if ((await later.getByText('Before you joined', { exact: true }).count()) > 0)
        throw new Error('a message sent after joining is labelled "Before you joined"');
    },
  );
  await n.step('opening it shows the message read-only', async () => {
    await n.page.getByRole('link', { name: new RegExp(EARLY) }).click();
    await n.page.getByRole('heading', { name: EARLY, level: 2 }).waitFor();
    await n.see(EARLY_BODY);
    await n.see('Earlier group message · read-only');
    if ((await n.page.getByRole('button', { name: 'Mark as read' }).count()) > 0)
      throw new Error('a message that was never delivered offers read state');
  });
  await n.step('account-wide reading includes a group not bound to the selected agent', async () => {
    await n.page.goto(`${ctx.base}/app/groups/${groupId}`);
    await n.page.getByRole('combobox', { name: 'Current agent' }).selectOption(nedAgent('claude-code'));
    await n.page.getByRole('link', { name: new RegExp(EARLY) }).waitFor();
    await n.page.getByRole('link', { name: new RegExp(LATER) }).waitFor();
  });
  await n.step('current-agent-only reading still requires a bound agent', async () => {
    await call(ned.jar, 'PATCH', '/v1/me/mailbox-settings', { cross_h_mailbox_enabled: false });
    await n.page.reload();
    await n.see('The current agent does not receive this group.');
    if (await n.page.getByRole('link', { name: new RegExp(EARLY) }).count())
      throw new Error('history is shown through an unbound agent with cross-agent reading off');
    await n.page.getByRole('combobox', { name: 'Current agent' }).selectOption(nedAgent('codex'));
    await n.page.getByRole('link', { name: new RegExp(EARLY) }).waitFor();
  });
  await n.context.close();
}

/** Waits for a condition a person would see settle, failing with what was expected. */
async function until(check, what, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting until ${what}`);
}
