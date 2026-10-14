/**
 * The first minutes after pairing: My agents shows a "Get started" checklist (restart the client, write to the
 * built-in assistant, invite a colleague), an agent that never connected says it is waiting for its first
 * connection instead of "Offline", the checklist's link opens the composer with the assistant already chosen, and
 * hiding the checklist sticks across a reload.
 */
import { call, sendDrop, signUp } from '../api.mjs';

export const name = 'onboarding';

export async function run(ctx) {
  const ivy = await signUp('ob_ivy');
  const { page, context, step, see, nav } = await ctx.session('ivy', ivy);
  const card = () => page.locator('#getting-started');

  await step('a freshly paired account sees the "Get started" checklist on My agents', async () => {
    await nav('My agents');
    await page.waitForURL(/\/app\/agents$/);
    await page.getByRole('heading', { name: 'Get started' }).waitFor();
    await card().getByText('0 of 3 done').waitFor();
    await card().getByText('Restart your agent’s client').waitFor();
    await card().getByText('Invite a colleague').waitFor();
  });
  await step('an agent that never connected waits for its first connection', async () => {
    await see('Waiting for first connection — restart your client');
    if (await page.getByText('Offline', { exact: true }).count())
      throw new Error('a never-connected agent is shown as Offline');
  });
  await step('"Write to the assistant" opens the composer with the assistant chosen', async () => {
    await card().getByRole('link', { name: 'Write to the assistant' }).click();
    await page.waitForURL(/\/app\/compose\?to=/);
    // a chosen recipient is a chip with its own Remove button; search results have none
    await page
      .getByRole('button', { name: /^Remove / })
      .first()
      .waitFor();
  });
  await step('after a first message to the assistant that step is ticked off', async () => {
    const found = await call(ivy.jar, 'GET', `/v1/me/endpoints/${ivy.h}/directory?query=agentdrop&limit=5`);
    const assistant = found.entries.find((e) => e.kind === 'person' && e.handle === 'agentdrop');
    if (!assistant) throw new Error('the built-in assistant is not in the directory');
    await sendDrop(ivy, [assistant.default_target], 'OB first test', 'Hello, assistant.');
    await nav('My agents');
    await card().getByText('1 of 3 done').waitFor();
    if (await card().getByRole('link', { name: 'Write to the assistant' }).count())
      throw new Error('the finished step still offers its link');
  });
  await step('hiding the checklist sticks across a reload', async () => {
    await card().getByRole('button', { name: 'Hide these steps' }).click();
    await card().waitFor({ state: 'detached' });
    await page.reload();
    await see('Messages sent to @ob_ivy reach');
    if (await card().count()) throw new Error('the checklist came back after a reload');
  });
  await context.close();
}
