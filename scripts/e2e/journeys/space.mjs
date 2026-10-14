/**
 * My space (ADR 0030) and the group file space (ADR 0029), as a person uses them from the dashboard.
 *
 * - kim puts a file and a note into My space from the dashboard, sees it listed (also from her other agent, and not
 *   in her inbox), downloads it, and deletes it, which says how much space it freed.
 * - olga (owner) sees her group's file space and removes a file someone sent; pia (a member) sees the bar but no
 *   Remove, and the message she received shows the file as removed.
 * - ada, a server admin, changes the group file space in Admin → Server settings and puts it back.
 */
import { readFile } from 'node:fs/promises';
import { call, group, makeAdmin, sendDrop, signUp, toGroup, uploadFile } from '../api.mjs';

export const name = 'space';

const KEPT_FILE = {
  name: 'sp-ablation-run.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from('step,loss\n1,0.9\n'),
};
const KEPT_NOTE = 'SP results of the ablation run, for the GPU server';
const GROUP = 'Space garden';
const SLUG = 'sp-garden';
const GROUP_FILE = {
  name: 'sp-bed-plan.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('north bed: beans\n'),
};
const GROUP_TITLE = 'SP bed plan for spring';

export async function run(ctx) {
  await mySpace(ctx);
  await groupFileSpace(ctx);
  await adminQuota(ctx);
}

async function mySpace(ctx) {
  const kim = await signUp('sp_kim', ['codex', 'claude-code']);
  const { page, context, step, see, nav } = await ctx.session('kim', kim);
  const items = page.getByRole('region', { name: 'Items in my space' });
  const item = () => items.getByRole('listitem').filter({ hasText: KEPT_FILE.name });

  await step('My space opens from the navigation and says what it is for', async () => {
    await nav('My space');
    await page.waitForURL(/\/app\/space$/);
    await see('pick them up on any of your agents');
    await see('Nothing here yet');
  });
  await step('put a file and a note into My space', async () => {
    await page.getByLabel('Choose files').setInputFiles([KEPT_FILE]);
    await see(`${KEPT_FILE.buffer.length} B`);
    await page.getByLabel('Note (optional)').fill(KEPT_NOTE);
    // the title is derived from the file, nobody has to type one
    await see(`Kept as “${KEPT_FILE.name}”`);
    await page.getByRole('button', { name: 'Put in', exact: true }).click();
    await see('Kept in My space');
  });
  await step('the item is listed with its note, its file and the agent that put it in', async () => {
    await item().waitFor();
    await item().getByText(KEPT_NOTE).waitFor();
    await item().getByRole('link', { name: 'Download' }).waitFor();
    await item()
      .getByText(/from sp_kim /)
      .waitFor();
  });
  await step('its file downloads with its name and content', async () => {
    const pending = page.waitForEvent('download');
    await item().getByRole('link', { name: 'Download' }).click();
    const download = await pending;
    if (download.suggestedFilename() !== KEPT_FILE.name)
      throw new Error(`downloaded as ${download.suggestedFilename()}`);
    if ((await readFile(await download.path(), 'utf8')) !== KEPT_FILE.buffer.toString())
      throw new Error('downloaded content differs');
  });
  await step('another agent of hers sees the same item', async () => {
    const other = kim.me.endpoints.find((e) => e.harness_key === 'claude-code').h_id;
    await page.getByRole('combobox', { name: 'Current agent' }).selectOption(other);
    await item().waitFor();
  });
  await step('it is not a message in the inbox', async () => {
    await nav('Inbox');
    const list = page.getByRole('region', { name: 'Message list' });
    await list.waitFor();
    await page.waitForTimeout(500);
    if (await list.getByText(KEPT_FILE.name).count()) throw new Error('a My space item shows in the inbox');
  });
  await step('deleting the item asks first, then says how much it freed', async () => {
    await nav('My space');
    await item().waitFor();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: `Delete ${KEPT_FILE.name}` }).click();
    await see('Deleted · freed');
    await item().waitFor({ state: 'detached' });
    await see('Nothing here yet');
  });
  await context.close();
}

async function groupFileSpace(ctx) {
  const olga = await signUp('sp_olga');
  const pia = await signUp('sp_pia');
  const groupId = await group(olga, { slug: SLUG, name: GROUP, members: [pia] });
  const meta = await uploadFile(pia, GROUP_FILE);
  await sendDrop(pia, [toGroup(groupId)], GROUP_TITLE, 'The plan for the beds.', {
    kind: 'file',
    attachment_ids: [meta.attachment_id],
  });

  const o = await ctx.session('olga', olga);
  const fileRow = () =>
    o.page.getByRole('listitem').filter({ has: o.page.getByText(GROUP_FILE.name, { exact: true }) });
  await o.step('the owner sees how much of the group file space is used', async () => {
    await o.page.goto(`${ctx.base}/app/groups/${groupId}`);
    await o.page.getByRole('tab', { name: 'Files' }).click();
    await o.see('Files: ');
    await o.page.getByRole('progressbar', { name: 'Group file space used' }).waitFor();
  });
  await o.step('the owner sees the stored file, its size and who sent it', async () => {
    await fileRow().waitFor();
    await fileRow().getByText(/Pia/).waitFor();
  });
  await o.step('removing a file asks first, then frees the space', async () => {
    let asked = '';
    o.page.once('dialog', (d) => {
      asked = d.message();
      void d.accept();
    });
    await o.page.getByRole('button', { name: `Remove ${GROUP_FILE.name}` }).click();
    await o.see('Removed · freed');
    if (!asked.includes('The message stays')) throw new Error(`unexpected confirmation: ${asked}`);
    await fileRow().waitFor({ state: 'detached' });
    await o.see('No files are stored for this group.');
  });
  await o.context.close();

  const p = await ctx.session('pia', pia);
  await p.step('a member sees the file space but cannot remove files', async () => {
    await p.page.goto(`${ctx.base}/app/groups/${groupId}?tab=files`);
    await p.page.getByRole('progressbar', { name: 'Group file space used' }).waitFor();
    await p.see('Only the owner and admins can remove files.');
    if (await p.page.getByRole('button', { name: /^Remove / }).count())
      throw new Error('a plain member is offered Remove');
  });
  await p.step('the message stays and shows its file as removed', async () => {
    await p.page.getByRole('tab', { name: 'Messages' }).click();
    await p.page.getByRole('link', { name: new RegExp(GROUP_TITLE) }).click();
    await p.page.getByRole('heading', { name: GROUP_TITLE, level: 2 }).waitFor();
    await p.see(GROUP_FILE.name);
    await p.see('Removed by a group admin');
    if (await p.page.getByRole('link', { name: 'Download' }).count())
      throw new Error('a removed file still offers Download');
  });
  await p.context.close();
}

async function adminQuota(ctx) {
  const ada = await signUp('sp_ada');
  makeAdmin(ada.handle);
  const before = (await call(ada.jar, 'GET', '/v1/admin/settings')).group_storage_quota_bytes;
  const beforeMb = String(Math.round(before / 1024 / 1024));
  // larger than any default, so the journeys running beside this one are never refused a file
  const raised = String(Number(beforeMb) * 2);
  const a = await ctx.session('ada', ada);
  const field = a.page.getByLabel('Per group (MB)');
  await a.step('an admin finds the group file space beside sign-up', async () => {
    await a.page.goto(`${ctx.base}/app/admin/settings`);
    await a.see('Group file space');
    await a.see('Open sign-up');
    if ((await field.inputValue()) !== beforeMb) throw new Error(`shows ${await field.inputValue()} MB`);
  });
  await a.step('an admin changes the group file space in MB', async () => {
    await field.fill(raised);
    await a.page.getByRole('button', { name: 'Save', exact: true }).click();
    await a.see('Each group can keep up to');
    await until(async () => (await field.inputValue()) === raised, 'the new value is shown');
  });
  await a.step('the change is saved and can be put back', async () => {
    const saved = (await call(ada.jar, 'GET', '/v1/admin/settings')).group_storage_quota_bytes;
    if (saved !== Number(raised) * 1024 * 1024) throw new Error(`saved ${saved} bytes`);
    await field.fill(beforeMb);
    await a.page.getByRole('button', { name: 'Save', exact: true }).click();
    await until(
      async () => (await call(ada.jar, 'GET', '/v1/admin/settings')).group_storage_quota_bytes === before,
      'the original value is back',
    );
  });
  await a.context.close();
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
