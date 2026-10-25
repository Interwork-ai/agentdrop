/**
 * Replies (ADR 0016): "Reply" on a received drop opens the composer addressed to its sender with "Re: …" and the
 * reference to the drop it answers; the recipient sees "Reply to “…”" linking to the original; the sender of the
 * original sees who replied and where they say the work stands (ADR 0038); and sending the reply marks the original
 * read for the replier. Posting in a group
 * marks the group's earlier drops read for the poster, and for nobody else.
 *
 * People: alice (replies, posts in the group), bob (asks; is answered), carol (writes in the group).
 */
import { call, connect, group, sendDrop, signUp, toGroup, toPerson } from '../api.mjs';

export const name = 'reply';

const QUESTION = 'RP which venue for the offsite';
const ANSWER_BODY = 'The lakeside one, it has the bigger room.';
const GROUP_ONE = 'RP agenda draft';
const GROUP_TWO = 'RP travel budget';
const GROUP_POST = 'RP all caught up';

/** Titles of the person's unread drops, straight from the API (the dashboard is not the thing measured here). */
async function unreadTitles(person) {
  const res = await call(person.jar, 'GET', `/v1/me/endpoints/${person.h}/drops?view=inbox&unread_only=true`);
  return res.drops.map((d) => d.title);
}

export async function run(ctx) {
  const alice = await signUp('rp_alice');
  const bob = await signUp('rp_bob');
  const carol = await signUp('rp_carol');
  await connect(alice, bob);
  const groupId = await group(alice, { slug: 'rp-crew', name: 'Offsite crew', members: [bob, carol] });
  await sendDrop(bob, [toPerson(alice)], QUESTION, 'Lakeside or the city hall?');
  await sendDrop(carol, [toGroup(groupId)], GROUP_ONE, 'First draft of the agenda.');
  await sendDrop(bob, [toGroup(groupId)], GROUP_TWO, 'Flights are cheaper on Thursday.');

  await asAlice(ctx, alice, carol);
  await asBob(ctx, bob);
}

async function asAlice(ctx, alice, carol) {
  const { page, context, step, see, nav } = await ctx.session('alice', alice);
  const list = page.getByRole('region', { name: 'Message list' });
  const titleField = page.getByPlaceholder('What does the other side need to know?');

  await step('"Reply" on a received drop opens the composer as a reply to its sender', async () => {
    await list.getByText(QUESTION, { exact: true }).first().click();
    await page.getByRole('heading', { name: QUESTION, level: 2 }).waitFor();
    // opening marks it read; make it unread again so the reply itself is what marks it read
    await page.getByRole('button', { name: 'Mark as unread' }).click();
    await page.getByRole('button', { name: 'Mark as read' }).waitFor();
    if (!(await unreadTitles(alice)).includes(QUESTION)) throw new Error('the question is not unread');
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await page.waitForURL(/\/app\/compose\?to=.*&reply=/);
    await see(`Replying to “${QUESTION}”`);
    await page.getByRole('button', { name: 'Remove Bob' }).waitFor();
    const want = `Re: ${QUESTION}`;
    for (let i = 0; i < 50 && (await titleField.inputValue()) !== want; i += 1)
      await page.waitForTimeout(100);
    if ((await titleField.inputValue()) !== want)
      throw new Error(`title is "${await titleField.inputValue()}"`);
  });
  await step('sending the reply marks the question read for the replier', async () => {
    await page.getByPlaceholder(/Write down the confirmed context/).fill(ANSWER_BODY);
    // the reply says the asked-for work is done
    await page.getByLabel('Where it stands').selectOption('done');
    await page.getByRole('button', { name: 'Send message' }).click();
    await see('Delivered');
    if ((await unreadTitles(alice)).includes(QUESTION)) throw new Error('the question is still unread');
  });

  await step('posting in the group marks its earlier drops read for the poster only', async () => {
    const before = await unreadTitles(alice);
    for (const title of [GROUP_ONE, GROUP_TWO])
      if (!before.includes(title)) throw new Error(`"${title}" was not unread before posting`);
    await page.goto(`${ctx.base}/app/compose?to=${encodeURIComponent('#rp-crew')}`);
    await page.getByRole('button', { name: 'Remove Offsite crew' }).waitFor();
    await titleField.fill(GROUP_POST);
    await page.getByRole('button', { name: 'Send message' }).click();
    await see('Delivered');
    const after = await unreadTitles(alice);
    for (const title of [GROUP_ONE, GROUP_TWO])
      if (after.includes(title)) throw new Error(`"${title}" is still unread after posting`);
    // carol's own state is hers: bob's group drop stays unread for her
    if (!(await unreadTitles(carol)).includes(GROUP_TWO)) throw new Error("carol's unread state changed");
  });
  await step('the inbox no longer lists the answered drops under Unread', async () => {
    await nav('Inbox');
    await page
      .getByRole('group', { name: 'Filter messages' })
      .getByRole('button', { name: /^Unread/ })
      .click();
    await list.getByText(GROUP_ONE, { exact: true }).waitFor({ state: 'detached' });
    for (const title of [QUESTION, GROUP_ONE, GROUP_TWO])
      if (await list.getByText(title, { exact: true }).count())
        throw new Error(`"${title}" is listed as unread`);
  });
  await context.close();
}

async function asBob(ctx, bob) {
  const { page, context, step, see, nav } = await ctx.session('bob', bob);
  const list = page.getByRole('region', { name: 'Message list' });

  await step('the reply says which drop it answers', async () => {
    await list.getByText(`Re: ${QUESTION}`, { exact: true }).first().click();
    await see(ANSWER_BODY);
    await page.getByRole('link', { name: `Reply to “${QUESTION}”` }).waitFor();
    await page.getByRole('main').getByText('Done', { exact: true }).first().waitFor();
  });
  await step('"Reply to" opens the original', async () => {
    await page.getByRole('link', { name: `Reply to “${QUESTION}”` }).click();
    await page.getByRole('heading', { name: QUESTION, level: 2 }).waitFor();
    await see('1 reply from Alice @rp_alice (Done)');
  });
  await step('the sent list shows that the question has a reply', async () => {
    await nav('Sent');
    const row = list.getByRole('button').filter({ hasText: QUESTION }).first();
    await row.locator('[title="1 reply from Alice @rp_alice (Done)"]').waitFor();
  });
  await context.close();
}
