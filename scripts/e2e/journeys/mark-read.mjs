/**
 * "Mark all as read" (ADR 0018): in one group's view it marks that group only; in the inbox, everything; the unread
 * count follows and the button goes away once nothing is left.
 */
import { call, connect, group, sendDrop, signUp, toGroup, toPerson } from '../api.mjs';

export const name = 'mark-read';

export async function run(ctx) {
  const dora = await signUp('mr_dora');
  const bob = await signUp('mr_bob');
  await connect(bob, dora);
  const team = await group(bob, { slug: 'mr-team', name: 'MR team', members: [dora] });
  await sendDrop(bob, [toPerson(dora)], 'MR direct one', 'First direct message.');
  await sendDrop(bob, [toPerson(dora)], 'MR direct two', 'Second direct message.');
  await sendDrop(bob, [toGroup(team)], 'MR group one', 'First group message.');
  await sendDrop(bob, [toGroup(team)], 'MR group two', 'Second group message.');

  const { page, context, step, see, nav } = await ctx.session('dora', dora);
  const unreadFilter = (n) =>
    page.getByRole('radio', { name: `Unread (${n})` }).or(page.getByText(`Unread (${n})`));

  await step('the inbox counts four unread', async () => {
    await nav('Inbox');
    await see('MR group two');
    await unreadFilter(4).first().waitFor();
  });
  await step('search results never offer to mark the whole inbox read', async () => {
    const search = page.getByRole('searchbox', { name: 'Search', exact: true });
    await search.fill('no-such-message');
    await see('No matching messages');
    if (await page.getByRole('button', { name: 'Mark all as read', exact: true }).count())
      throw new Error('an empty search offers an unbounded mark-all action');
    await sendDrop(bob, [toPerson(dora)], 'MR arrived during search', 'Keep this unread.');
    const inbox = await call(dora.jar, 'GET', `/v1/me/endpoints/${dora.h}/drops?view=inbox`);
    if (inbox.unread_count !== 5) throw new Error('search changed unread state');
    await search.fill('MR direct');
    await see('MR direct one');
    if (await page.getByRole('button', { name: 'Mark all as read', exact: true }).count())
      throw new Error('a matching search offers to mark unrelated messages read');
    await search.fill('');
    await see('MR arrived during search');
  });
  await step("in one group's view, the button marks that group only", async () => {
    await page.goto(`${ctx.base}/app/inbox?group=${team}`);
    await see('MR group one');
    await page.getByRole('button', { name: 'Mark this group read' }).click();
    await see('Marked 2 messages as read.');
    await page.getByRole('button', { name: 'Group filter' }).click();
    await unreadFilter(3).first().waitFor();
  });
  await step('in the inbox, the button marks everything left', async () => {
    await page.getByRole('button', { name: 'Mark all as read' }).click();
    await see('Marked 3 messages as read.');
    await unreadFilter(0).first().waitFor();
    await page.getByRole('button', { name: 'Mark all as read' }).waitFor({ state: 'detached' });
  });
  await context.close();
}
