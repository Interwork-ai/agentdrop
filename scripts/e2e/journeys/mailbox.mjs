/**
 * The mailbox journeys a person clicks through every day: search and the Unread filter, "Mark as unread", archiving
 * and unarchiving, forwarding to another contact, reading a long body part by part, sending and downloading an
 * attachment (which must never download or render on its own), one's own group post kept out of the inbox
 * (ADR 0033), and a drop that appears in an open inbox by itself through the event stream (ADR 0040).
 */
import { readFile } from 'node:fs/promises';
import { connect, group, sendDrop, signUp, toGroup, toPerson } from '../api.mjs';

export const name = 'mailbox';

const QUARTERLY = 'MB quarterly report';
const LUNCH = 'MB lunch plans';
const ARCHIVE_ME = 'MB archive me';
const LONG = 'MB long read';
const ATTACHED = 'MB notes with a file';
const OWN_POST = 'MB my own group post';
const LIVE = 'MB arrived while open';
const TEXT_FILE = { name: 'mb-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello attachment\n') };
const HTML_FILE = {
  name: 'mb-page.html',
  mimeType: 'text/html',
  buffer: Buffer.from('<script>alert("mb-ran")</script><h1>not rendered</h1>\n'),
};

/** A body longer than one 8192-character part, with a marker only the second part contains. */
function longBody() {
  let text = 'PART-ONE-START\n';
  for (let i = 0; text.length < 10_000; i += 1)
    text += `Line ${i} of the long read, padding the first part.\n`;
  text += 'PART-TWO-MARKER\n';
  for (let i = 0; text.length < 12_000; i += 1) text += `Tail line ${i}.\n`;
  return text;
}

export async function run(ctx) {
  const alice = await signUp('mb_alice');
  const bob = await signUp('mb_bob');
  const carol = await signUp('mb_carol');
  await connect(alice, bob);
  await connect(alice, carol);
  await sendDrop(bob, [toPerson(alice)], QUARTERLY, 'The zebra numbers are in the second table.');
  await sendDrop(bob, [toPerson(alice)], LUNCH, 'Pizza on Friday at noon.');
  await sendDrop(bob, [toPerson(alice)], ARCHIVE_ME, 'Keep this for later.');
  await sendDrop(bob, [toPerson(alice)], LONG, longBody());
  const notes = await group(alice, { slug: 'mb-notes', name: 'MB notes' });
  await sendDrop(alice, [toGroup(notes)], OWN_POST, 'Posted to my own group.');

  await asAlice(ctx);
  await asCarol(ctx, carol, alice);
  await asBob(ctx, bob);

  async function asAlice(ctx) {
    const { page, context, step, see, nav } = await ctx.session('alice', alice);
    const list = page.getByRole('region', { name: 'Message list' });
    const inList = (title) => list.getByText(title, { exact: true }).first();
    const open = async (title) => {
      await inList(title).click();
      await page.getByRole('heading', { name: title, level: 2 }).waitFor();
    };
    const search = page.getByRole('searchbox', { name: 'Search' });
    const unreadFilter = page
      .getByRole('group', { name: 'Filter messages' })
      .getByRole('button', { name: /^Unread/ });
    const allFilter = page.getByRole('button', { name: 'All', exact: true });

    await step('inbox lists the seeded drops', async () => {
      for (const title of [QUARTERLY, LUNCH, ARCHIVE_ME, LONG]) await inList(title).waitFor();
    });
    await step('my own group post is not in my inbox, but in Sent and in the group', async () => {
      if (await inList(OWN_POST).count()) throw new Error('my own group post is listed in my inbox');
      await nav('Sent');
      await inList(OWN_POST).waitFor();
      await page.goto(`${ctx.base}/app/inbox?group=${notes}`);
      await inList(OWN_POST).waitFor();
      await page.goto(`${ctx.base}/app/inbox`);
      await inList(QUARTERLY).waitFor();
      if (await inList(OWN_POST).count()) throw new Error('my own group post is listed in my inbox');
    });
    await step('a row tells a screen reader its state, sender and title', async () => {
      // "Unread, from Bob @mb_bob, MB quarterly report, 3 min ago": state first, then who and what
      await list
        .getByRole('button', { name: new RegExp(`^Unread, from Bob @mb_bob, ${QUARTERLY}, `) })
        .waitFor();
      await list.getByRole('list').waitFor();
    });
    await step('search finds a drop by a word in its body', async () => {
      await search.fill('zebra');
      await inList(LUNCH).waitFor({ state: 'detached' });
      await inList(QUARTERLY).waitFor();
      if ((await list.getByRole('button').count()) !== 1) throw new Error('search shows more than the match');
    });
    await step('search finds a drop by a word in its title', async () => {
      await search.fill('lunch');
      await inList(QUARTERLY).waitFor({ state: 'detached' });
      await inList(LUNCH).waitFor();
      if ((await list.getByRole('button').count()) !== 1) throw new Error('search shows more than the match');
      await search.fill('');
      await inList(QUARTERLY).waitFor();
    });
    await step('opening a drop marks it read', async () => {
      await open(LUNCH);
      await see('Pizza on Friday at noon.');
      await page.getByRole('button', { name: 'Mark as unread' }).waitFor();
    });
    await step('the Unread filter shows only unread drops', async () => {
      await unreadFilter.click();
      await inList(LUNCH).waitFor({ state: 'detached' });
      for (const title of [QUARTERLY, ARCHIVE_ME, LONG]) await inList(title).waitFor();
      // the filtered list has loaded: the read drop must not be in it
      if (await inList(LUNCH).count()) throw new Error('a read drop is listed under Unread');
      await unreadFilter.filter({ hasText: '(3)' }).waitFor();
      await allFilter.click();
      await inList(LUNCH).waitFor();
    });
    await step('"Mark as unread" makes an opened drop unread again', async () => {
      await open(LUNCH);
      await page.getByRole('button', { name: 'Mark as unread' }).click();
      await page.getByRole('button', { name: 'Mark as unread' }).waitFor({ state: 'detached' });
      await unreadFilter.click();
      await inList(LUNCH).waitFor();
      await unreadFilter.filter({ hasText: '(4)' }).waitFor();
      await allFilter.click();
    });
    await step('archive a drop: it leaves the inbox', async () => {
      await open(ARCHIVE_ME);
      await page.getByRole('button', { name: 'Archive', exact: true }).click();
      await page.getByRole('button', { name: 'Unarchive' }).waitFor();
      await inList(ARCHIVE_ME).waitFor({ state: 'detached' });
    });
    await step('the archived drop is in Archived and "Unarchive" brings it back', async () => {
      await nav('Archived');
      await open(ARCHIVE_ME);
      await page.getByRole('button', { name: 'Unarchive' }).click();
      await page.getByRole('button', { name: 'Archive', exact: true }).waitFor();
      await inList(ARCHIVE_ME).waitFor({ state: 'detached' });
      await nav('Inbox');
      await inList(ARCHIVE_ME).waitFor();
    });
    await step('a long body shows "Next part" and the next part reads on', async () => {
      await open(LONG);
      await see('PART-ONE-START');
      if (await page.getByText('PART-TWO-MARKER').count())
        throw new Error('the second part is shown at once');
      await page.getByRole('button', { name: 'Next part' }).click();
      await see('PART-TWO-MARKER');
      await page.getByRole('button', { name: 'Previous part' }).click();
      await see('PART-ONE-START');
    });
    await step('keyboard: j and the arrows move through the list only while it has focus', async () => {
      await nav('Inbox');
      await open(LONG);
      // clicking the row left focus on it: j selects the next message and focus follows
      await page.keyboard.press('j');
      await page.getByRole('heading', { name: ARCHIVE_ME, level: 2 }).waitFor();
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-current'));
      if (focused !== 'true') throw new Error('focus did not follow the selected row');
      // in the reading pane the arrow keys scroll the message; the selection stays
      await page.getByRole('region', { name: 'Message', exact: true }).focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('j');
      await page.waitForTimeout(300);
      if (!(await page.getByRole('heading', { name: ARCHIVE_ME, level: 2 }).count()))
        throw new Error('the arrow keys changed the message while the reading pane had focus');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('k');
      await page.waitForTimeout(300);
      if (!(await page.getByRole('heading', { name: ARCHIVE_ME, level: 2 }).count()))
        throw new Error('k changed the message while the reading pane had focus');
    });
    await step('"Forward" opens the composer prefilled with the drop', async () => {
      await open(QUARTERLY);
      await page.getByRole('button', { name: 'Forward' }).click();
      await page.waitForURL(/\/app\/compose\?forward=/);
      await see('Forwarding');
      const title = page.getByPlaceholder('What does the other side need to know?');
      // the quote is filled in once the original has loaded
      const want = `Fwd: ${QUARTERLY}`;
      for (let i = 0; i < 50 && (await title.inputValue()) !== want; i += 1) await page.waitForTimeout(100);
      if ((await title.inputValue()) !== want) throw new Error(`title is "${await title.inputValue()}"`);
      const body = await page.getByPlaceholder(/Write down the confirmed context/).inputValue();
      if (!body.includes('The zebra numbers are in the second table.'))
        throw new Error('body does not quote the drop');
    });
    await step('the forward sends to another contact', async () => {
      await page.getByRole('combobox', { name: 'Search recipients' }).fill('mb_carol');
      await page
        .getByRole('option', { name: /Carol\s*@mb_carol/ })
        .first()
        .click();
      await page.getByRole('button', { name: 'Send message' }).click();
      await see('Delivered');
    });
    await step('attach files in the composer and send', async () => {
      await page.getByRole('button', { name: 'Send another' }).click();
      await see('Send message');
      await pickWithKeyboard(page, 'mb_', /Bob\s*@mb_bob/);
      await page.getByRole('button', { name: 'Remove Bob' }).waitFor();
      await page.getByPlaceholder('What does the other side need to know?').fill(ATTACHED);
      await page.getByPlaceholder(/Write down the confirmed context/).fill('Two files for you.');
      await page.getByLabel('Choose attachments').setInputFiles([TEXT_FILE, HTML_FILE]);
      await see(`${TEXT_FILE.buffer.length} B`);
      await see(HTML_FILE.name);
      await page.getByRole('button', { name: 'Send message' }).click();
      await see('Delivered');
    });
    await context.close();
  }
}

/**
 * The recipient combobox from the keyboard alone: type, ↓ until the wanted match is highlighted (announced through
 * aria-activedescendant), Enter. The field is a combobox that says it is expanded and empties after the pick.
 */
async function pickWithKeyboard(page, text, match) {
  const field = page.getByRole('combobox', { name: 'Search recipients' });
  await field.focus();
  await page.keyboard.type(text);
  await page.getByRole('option', { name: match }).first().waitFor();
  if ((await field.getAttribute('aria-expanded')) !== 'true') throw new Error('the combobox is not expanded');
  const listId = await field.getAttribute('aria-controls');
  if (!listId || !(await page.locator(`[id="${listId}"][role="listbox"]`).count()))
    throw new Error('aria-controls does not point at the listbox');
  const active = async () => {
    const id = await field.getAttribute('aria-activedescendant');
    return id ? ((await page.locator(`[id="${id}"]`).textContent()) ?? '') : '';
  };
  for (let i = 0; i < 10 && !match.test(await active()); i += 1) await page.keyboard.press('ArrowDown');
  if (!match.test(await active())) throw new Error(`the arrows never highlighted ${match}`);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 30 && (await field.inputValue()) !== ''; i += 1) await page.waitForTimeout(100);
  if ((await field.inputValue()) !== '') throw new Error('the field kept the typed text after the pick');
  if (!(await field.evaluate((el) => el === document.activeElement)))
    throw new Error('focus left the recipient field after the pick');
}

async function asCarol(ctx, carol, alice) {
  const { page, context, step, see, nav } = await ctx.session('carol', carol);
  const list = page.getByRole('region', { name: 'Message list' });
  // Every frame of the page's event stream, as the browser received it (EventSource hides them from the page).
  const frames = [];
  const cdp = await context.newCDPSession(page);
  cdp.on('Network.eventSourceMessageReceived', (m) => {
    if (m.eventName === 'events') frames.push(m.data);
  });
  await cdp.send('Network.enable');
  // Mailbox list requests still running.
  const listing = new Set();
  page.on('request', (r) => {
    if (r.url().includes('/drops?')) listing.add(r);
  });
  for (const done of ['requestfinished', 'requestfailed']) page.on(done, (r) => listing.delete(r));
  const until = async (check, what, ms = 10_000) => {
    for (const end = Date.now() + ms; !check(); await page.waitForTimeout(50))
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  };

  await step('the forwarded drop arrives', async () => {
    await list.getByText(`Fwd: ${QUARTERLY}`, { exact: true }).click();
    await see('The zebra numbers are in the second table.');
  });
  await step('a drop sent now appears in the open inbox by itself (event stream, ADR 0040)', async () => {
    // Settle first. Opening the drop marked it read: that answer and the stream event it causes both refetch the
    // list, and a send racing them could appear through those refetches without the stream announcing it.
    const opened = new URL(page.url()).pathname.split('/').pop();
    await page.getByRole('button', { name: 'Mark as unread' }).waitFor();
    await until(
      () => frames.some((data) => data.includes('"delivery.state"') && data.includes(opened)),
      'the stream to announce the read',
    );
    await nav('Inbox');
    await page.waitForURL(/\/app\/inbox$/);
    await see('Select a message');
    // no list request for 600 ms: the read's own refetches are done
    let quietSince = Date.now();
    await until(() => {
      if (listing.size) quietSince = Date.now();
      return Date.now() - quietSince >= 600;
    }, 'the inbox to stop refetching');

    const sent = await sendDrop(alice, [toPerson(carol)], LIVE, 'Arrived while the inbox was open.');
    // The inbox also polls every 10 s; only the stream brings the drop in well under that.
    await list.getByText(LIVE, { exact: true }).waitFor({ timeout: 5_000 });
    if (!frames.some((data) => data.includes('"delivery.created"') && data.includes(sent.drop_id)))
      throw new Error('no event stream frame announced the new drop');
  });
  await context.close();
}

async function asBob(ctx, bob) {
  const { page, context, step, see } = await ctx.session('bob', bob);
  const downloads = [];
  const dialogs = [];
  page.on('download', (d) => downloads.push(d));
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  const row = (fileName) =>
    page.getByText(fileName, { exact: true }).locator('xpath=ancestor::div[.//a[@download]][1]');

  await step('opening a drop with attachments shows names and sizes, downloads nothing', async () => {
    await page.getByRole('region', { name: 'Message list' }).getByText(ATTACHED, { exact: true }).click();
    await see('Two files for you.');
    await see("Attachments · downloads don't open automatically");
    await see(TEXT_FILE.name);
    await row(TEXT_FILE.name).getByText(`· ${TEXT_FILE.buffer.length} B`).waitFor();
    await see(HTML_FILE.name);
    await page.waitForTimeout(500);
    if (downloads.length)
      throw new Error(`downloaded on open: ${downloads.map((d) => d.suggestedFilename())}`);
    // an HTML or script file is never rendered in the page
    if (await page.locator('iframe, object, embed').count()) throw new Error('an attachment is embedded');
    if (await page.getByRole('img', { name: HTML_FILE.name }).count())
      throw new Error('the HTML file is shown inline');
  });
  await step('Download saves the file with its name and content', async () => {
    const pending = page.waitForEvent('download');
    await row(TEXT_FILE.name).getByRole('link', { name: 'Download' }).click();
    const download = await pending;
    if (download.suggestedFilename() !== TEXT_FILE.name)
      throw new Error(`downloaded as ${download.suggestedFilename()}`);
    const saved = await readFile(await download.path(), 'utf8');
    if (saved !== TEXT_FILE.buffer.toString()) throw new Error('downloaded content differs');
  });
  await step('an HTML attachment downloads instead of opening', async () => {
    const before = page.url();
    const pending = page.waitForEvent('download');
    await row(HTML_FILE.name).getByRole('link', { name: 'Download' }).click();
    const download = await pending;
    if (download.suggestedFilename() !== HTML_FILE.name)
      throw new Error(`downloaded as ${download.suggestedFilename()}`);
    if (page.url() !== before) throw new Error(`the page navigated to ${page.url()}`);
    if (dialogs.length) throw new Error(`a script ran: ${dialogs.join(', ')}`);
    await see('Two files for you.');
  });
  await context.close();
}
