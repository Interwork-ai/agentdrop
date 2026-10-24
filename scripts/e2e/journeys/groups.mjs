/**
 * Groups, as a person runs them from the dashboard: create with invitations, accept (choosing how to receive) and
 * decline, write to the group with an @mention, mute, rename and change the #slug, a member's invitation that waits
 * for approval, make an admin, and leave.
 *
 * People: olga (owner), mia (two agents; joins with one selected agent, gets mentioned, mutes), dan (declines),
 * lee (a plain member who asks to invite ray, then leaves), ray (invited through an approved request).
 */
import { call, connect, sendDrop, signUp, toGroup } from '../api.mjs';

export const name = 'groups';

const GROUP = 'Garden club';
const SLUG = 'gr-garden';
const RENAMED = 'Garden circle';
const NEW_SLUG = 'gr-circle';
const MENTION_TITLE = 'Seed list for spring';
const AFTER_MUTE_TITLE = 'Watering rota while muted';

export async function run(ctx) {
  const olga = await signUp('gr_olga');
  const mia = await signUp('gr_mia', ['codex', 'claude-code']);
  const dan = await signUp('gr_dan');
  const lee = await signUp('gr_lee');
  const ray = await signUp('gr_ray');
  await connect(olga, mia);
  await connect(olga, dan);

  const o = await ctx.session('olga', olga);
  const groupId = await createGroup(o);
  if (!groupId) {
    await o.context.close();
    return;
  }

  await answerInvitations(ctx, mia, dan, olga, groupId);
  await o.step('the owner sees who joined and who declined', async () => {
    await o.page.reload();
    await o.see('2 members');
    await o.page.getByRole('tab', { name: /^Members/ }).click();
    await o.see('@gr_mia');
    await o.page.getByText('@gr_dan', { exact: true }).waitFor({ state: 'detached' });
  });

  await writeWithMention(o);
  const m = await ctx.session('mia', mia);
  await mentionedMemberSees(m);
  await muteAsMember(m, olga, groupId);

  await renameAndReslug(o);

  // lee joins through the API: the join-request step needs a plain member, which is not the action under test
  await call(olga.jar, 'POST', `/v1/me/groups/${groupId}/invite`, { handles: [lee.handle] });
  await call(lee.jar, 'POST', `/v1/me/groups/${groupId}/accept`, {});
  await approveInviteRequest(ctx, o, lee, ray, groupId);

  await makeAdmin(o);
  await memberLeaves(ctx, o, lee, groupId);

  await m.context.close();
  await o.context.close();
}

/** Waits for a condition a person would see settle (a switch state), failing with what was expected. */
async function until(check, what, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting until ${what}`);
}

/** 1. Groups → New → name, slug and two contacts invited at once. Returns the new group's id. */
async function createGroup({ page, step, see, nav }) {
  let groupId = null;
  await step('"New" moves focus into the form; Escape closes it and returns focus', async () => {
    await nav('All groups');
    const newButton = page.getByRole('button', { name: 'New', exact: true });
    await newButton.click();
    const name = page.getByLabel('Group name (optional)');
    await until(() => name.evaluate((el) => el === document.activeElement), 'the group name field has focus');
    await page.keyboard.press('Escape');
    await name.waitFor({ state: 'detached' });
    await until(() => newButton.evaluate((el) => el === document.activeElement), '"New" has focus again');
  });
  await step('create a group and invite two contacts at once', async () => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByLabel('Group name (optional)').fill(GROUP);
    await page.getByLabel('Slug (optional, unique)').fill(SLUG);
    await page.getByLabel('Invite at the same time (optional)').fill('@gr_mia, gr_dan');
    // the field turns the text into one chip per person
    await page.getByRole('button', { name: 'Remove gr_mia' }).waitFor();
    await page.getByRole('button', { name: 'Remove gr_dan' }).waitFor();
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/app\/groups\/[^/?]+/);
    groupId = new URL(page.url()).pathname.split('/').pop();
    await see('Invitations sent with the new group');
    await page.getByRole('heading', { name: new RegExp(`${GROUP}.*${SLUG}`) }).waitFor();
    const outcome = 'Invitation sent; waiting for them to pick a receiving agent';
    await page.getByText(outcome).nth(1).waitFor();
    await see('1 member');
  });
  await step('invitees show as invited in Members', async () => {
    await page.getByRole('tab', { name: 'Members' }).click();
    const invited = page.getByRole('listitem').filter({ hasText: 'Invited' });
    await invited.filter({ hasText: '@gr_mia' }).waitFor();
    await invited.filter({ hasText: '@gr_dan' }).waitFor();
  });
  await step(
    'inviting an unknown username names it next to the field',
    async () => {
      const field = page.getByLabel('Invite new members');
      await field.fill('gr_nobody');
      await page.getByRole('button', { name: 'Invite', exact: true }).click();
      await see('Nobody on this server has the username @gr_nobody');
      if ((await field.getAttribute('aria-invalid')) !== 'true')
        throw new Error('the field is not marked invalid');
      const described = await field.getAttribute('aria-describedby');
      const said = described ? await page.locator(`[id="${described}"]`).innerText() : '';
      if (!said.includes('@gr_nobody'))
        throw new Error(`the field is not described by the error ("${said}")`);
      await field.fill('');
    },
    // the server's 404 for the unknown handle is the point of this step; the page explains it
    { allowConsole: [/status of 404/] },
  );
  return groupId;
}

/** 2. Mia joins with one selected agent; Dan declines, is invited again, and declines once more. */
async function answerInvitations(ctx, mia, dan, olga, groupId) {
  const m = await ctx.session('mia-invite', mia);
  await m.step('an invitation shows on the groups page', async () => {
    await m.nav('All groups');
    await m.page.getByRole('link', { name: new RegExp(`${GROUP}.*Invitation`) }).click();
    await m.see('@gr_olga invited you to this group.');
  });
  await m.step('accept, receiving with one selected agent', async () => {
    await m.page.getByRole('radio', { name: /^Only selected agents/ }).check();
    const boxes = m.page.getByRole('checkbox');
    await boxes.first().waitFor();
    // keep exactly one agent: the one already chosen (the default receiver), clear any other
    const checked = [];
    for (const box of await boxes.all()) if (await box.isChecked()) checked.push(box);
    if (checked.length !== 1) throw new Error(`expected one agent preselected, found ${checked.length}`);
    await m.page.getByRole('button', { name: 'Join', exact: true }).click();
    await m.page.getByRole('button', { name: 'Write to the group' }).waitFor();
    await m.see('2 members');
  });
  await m.step('settings show the selected agent, not all', async () => {
    await m.page.getByRole('tab', { name: 'Settings' }).click();
    if (!(await m.page.getByRole('radio', { name: /^Only selected agents/ }).isChecked()))
      throw new Error('"Only selected agents" is not the saved choice');
    let on = 0;
    for (const box of await m.page.getByRole('checkbox', { name: /gr_mia/ }).all())
      if (await box.isChecked()) on++;
    if (on !== 1) throw new Error(`expected one receiving agent, found ${on}`);
  });
  await m.context.close();

  const d = await ctx.session('dan', dan);
  await d.step('decline an invitation', async () => {
    await d.nav('All groups');
    await d.page.getByRole('link', { name: new RegExp(`${GROUP}.*Invitation`) }).click();
    await d.page.getByRole('button', { name: 'Decline', exact: true }).click();
    await d.page.waitForURL(/\/app\/groups$/);
    await d.page.getByText(GROUP).first().waitFor({ state: 'detached' });
  });
  // the same page, still open: a group declined earlier is asked for again once it is opened again (the invitation
  // arrives through the event stream, else the 30 s refresh of the groups list)
  await call(olga.jar, 'POST', `/v1/me/groups/${groupId}/invite`, { handles: [dan.handle] });
  await d.step('a new invitation to a group declined earlier opens as usual', async () => {
    await d.page.getByRole('link', { name: new RegExp(`${GROUP}.*Invitation`) }).click({ timeout: 40_000 });
    await d.see('@gr_olga invited you to this group.');
    await d.page.getByRole('button', { name: 'Decline', exact: true }).click();
    await d.page.waitForURL(/\/app\/groups$/);
  });
  await d.context.close();
}

/** 3. "Write to the group" → composer with the group → @mention Mia → send. */
async function writeWithMention({ page, step, see }) {
  const groupChip = page.getByRole('button', { name: `Remove ${GROUP}` });
  await step('"Write to the group" opens the composer addressed to the group', async () => {
    await page.getByRole('button', { name: 'Write to the group' }).click();
    await page.waitForURL(/\/app\/compose\?to=/);
    await see('Send message');
    await groupChip.waitFor({ timeout: 5_000 }).catch(() => {
      throw new Error(
        'the group is not chosen as recipient: only its #slug is typed into the search box, so the person must pick it again',
      );
    });
  });
  await step('mention a member and send to the group', async () => {
    // continue as a person would if the group was not chosen for them
    if (!(await groupChip.isVisible()))
      await page.getByRole('option', { name: new RegExp(`${GROUP}.*#${SLUG}`) }).click();
    await groupChip.waitFor();
    await see('Mention (optional):');
    const mention = page.getByRole('button', { name: '@Mia', exact: true });
    await mention.click();
    if ((await mention.getAttribute('aria-pressed')) !== 'true') throw new Error('mention is not selected');
    await page.getByPlaceholder('What does the other side need to know?').fill(MENTION_TITLE);
    await page.getByPlaceholder(/Write down the confirmed context/).fill('Tomatoes, basil and beans.');
    await page.getByRole('button', { name: 'Send message' }).click();
    await see('Delivered');
  });
}

/** 3 (cont.). The mentioned member sees it in the group timeline and, marked, in the inbox. */
async function mentionedMemberSees({ page, step, see, nav }) {
  await step('the mentioned member sees the drop in the group timeline', async () => {
    await nav('All groups');
    await page.getByRole('link', { name: new RegExp(`^#\\s*${GROUP}`) }).click();
    await page.getByRole('link', { name: new RegExp(MENTION_TITLE) }).waitFor();
  });
  await step('the inbox marks the drop as mentioning them', async () => {
    await nav('Inbox');
    const item = page.getByRole('button').filter({ hasText: MENTION_TITLE }).first();
    await item.getByText('@you', { exact: true }).waitFor();
    await item.click();
    await see('Tomatoes, basil and beans.');
    await see('Mentions: Mia @gr_mia');
    await see('including you');
  });
}

/** 4. Mute as a member: the switch, the "Muted" badge, and messages still arriving. */
async function muteAsMember({ page, step, see, nav }, olga, groupId) {
  await step('mute the group as a member', async () => {
    await nav('All groups');
    await page.getByRole('link', { name: new RegExp(`^#\\s*${GROUP}`) }).click();
    await page.getByRole('tab', { name: 'Settings' }).click();
    await see('No notices for this group; messages still arrive.');
    await page.getByText('Mute', { exact: true }).click();
    await page.getByRole('link', { name: new RegExp(`${GROUP}.*Muted`) }).waitFor();
    await until(() => page.getByRole('checkbox', { name: /^Mute/ }).isChecked(), 'the Mute switch is on');
  });
  await step('muted state survives a reload', async () => {
    await page.reload();
    await page.getByRole('link', { name: new RegExp(`${GROUP}.*Muted`) }).waitFor();
    if (!(await page.getByRole('checkbox', { name: /^Mute/ }).isChecked()))
      throw new Error('the Mute switch is off after a reload');
  });
  await step('messages still arrive while muted', async () => {
    await sendDrop(olga, [toGroup(groupId)], AFTER_MUTE_TITLE, 'Mia waters on Tuesdays.');
    await page.getByRole('tab', { name: 'Messages' }).click();
    await page.reload();
    await page.getByRole('link', { name: new RegExp(AFTER_MUTE_TITLE) }).waitFor();
    await nav('Inbox');
    await see(AFTER_MUTE_TITLE);
  });
}

/** 5. The owner renames the group and changes its #slug. */
async function renameAndReslug({ page, step, nav }) {
  await step('owner changes the group name and #slug', async () => {
    await nav('All groups');
    await page
      .getByRole('link', { name: new RegExp(`^#\\s*${GROUP}`) })
      .first()
      .click();
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByLabel('Group name').fill(RENAMED);
    await page.getByLabel(/^Slug/).fill(NEW_SLUG);
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await page.getByRole('heading', { name: new RegExp(`${RENAMED}.*${NEW_SLUG}`) }).waitFor();
    await page.getByRole('link', { name: new RegExp(`${RENAMED}.*${NEW_SLUG}`) }).waitFor();
  });
  await step('the new #slug finds the group in the composer', async () => {
    await page.getByRole('button', { name: 'Write to the group' }).click();
    // the group page addresses it as `#slug`, so the renamed group is chosen, not a person with that handle
    await page.waitForURL(new RegExp(`/app/compose\\?to=%23${NEW_SLUG}`));
    await page.getByRole('button', { name: `Remove ${RENAMED}` }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: new RegExp(RENAMED) }).waitFor();
  });
}

/** 8. Members' invitations need approval: lee asks to invite ray, olga approves, ray is invited. */
async function approveInviteRequest(ctx, o, lee, ray, groupId) {
  await o.step('owner turns off direct invitations by members', async () => {
    await o.page.getByRole('tab', { name: 'Settings' }).click();
    const policy = o.page.getByRole('checkbox', { name: /^Members can invite directly/ });
    if (!(await policy.isChecked())) throw new Error('direct invitations are already off');
    await o.page.getByText('Members can invite directly', { exact: true }).click();
    await until(async () => !(await policy.isChecked()), 'direct invitations are off');
  });

  const l = await ctx.session('lee-request', lee);
  await l.step('a member asks to invite someone', async () => {
    await l.page.goto(`${ctx.base}/app/groups/${groupId}?tab=members`);
    const field = l.page.getByLabel('Request to invite new members');
    await field.fill('gr_ray');
    await l.page.getByRole('button', { name: 'Submit invite request' }).click();
    await l.see('Request submitted; waiting for admin approval');
    await l.see('Waiting for an admin to approve.');
  });
  await l.context.close();

  await o.step('owner approves the request', async () => {
    await o.page.reload();
    await o.page.getByRole('link', { name: /^All groups.*1 to approve/ }).waitFor();
    await o.page.getByRole('tab', { name: /^Members/ }).click();
    await o.see('Join requests awaiting approval (1)');
    await o.see('Requested by @gr_lee');
    await o.page.getByRole('button', { name: 'Approve', exact: true }).click();
    await o.page.getByText(/Join requests awaiting approval/).waitFor({ state: 'detached' });
    await o.page
      .getByRole('listitem')
      .filter({ hasText: '@gr_ray' })
      .filter({ hasText: 'Invited' })
      .waitFor();
  });

  const r = await ctx.session('ray', ray);
  await r.step('the approved person receives the invitation', async () => {
    await r.nav('All groups');
    await r.page.getByRole('link', { name: new RegExp(`${RENAMED}.*Invitation`) }).click();
    await r.see('invited you to this group.');
  });
  await r.context.close();
}

/** 6. Members tab: the owner makes Mia an admin. */
async function makeAdmin({ page, step }) {
  await step('owner makes a member admin', async () => {
    await page.getByRole('tab', { name: /^Members/ }).click();
    const row = page.getByRole('listitem').filter({ hasText: '@gr_mia' });
    await row.getByRole('button', { name: 'Make admin' }).click();
    await row.getByText('Admin', { exact: true }).waitFor();
    await row.getByRole('button', { name: 'Remove admin' }).waitFor();
  });
}

/** 7. Lee leaves; the group is gone for them and the owner's member count drops. */
async function memberLeaves(ctx, o, lee, groupId) {
  await o.step('owner sees three members before anyone leaves', async () => {
    await o.page.reload();
    await o.see('3 members');
  });
  const l = await ctx.session('lee-leave', lee);
  await l.step('a member leaves the group', async () => {
    await l.page.goto(`${ctx.base}/app/groups/${groupId}?tab=settings`);
    l.page.once('dialog', (d) => d.accept());
    await l.page.getByRole('button', { name: 'Leave group' }).click();
    await l.page.waitForURL(/\/app\/groups$/);
  });
  await l.step('the group is gone for the member who left', async () => {
    await l.page.reload();
    await l.see('No groups yet');
    if ((await l.page.getByText(RENAMED).count()) > 0) throw new Error('the group still shows');
  });
  await l.context.close();
  await o.step('the owner sees the member count drop', async () => {
    await o.page.reload();
    await o.see('2 members');
    await o.page.getByRole('tab', { name: /^Members/ }).click();
    await o.see('@gr_mia');
    await o.page.getByText('@gr_lee', { exact: true }).waitFor({ state: 'detached' });
  });
}
