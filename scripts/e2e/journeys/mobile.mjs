/**
 * The dashboard on a phone (390×844): the list/detail switch of the inbox, the bottom tab bar and the drawer, sending
 * from the phone, nothing cut off at the right edge, and the light theme staying readable.
 */
import { connect, group, sendDrop, signUp, toGroup, toPerson } from '../api.mjs';

export const name = 'mobile';

const PHONE = { width: 390, height: 844 };
const TITLE = 'Phone test from Bob';
const BODY = 'Checked on a phone: the results are in the shared folder.';
// a long unbroken link is ordinary content that must wrap instead of widening the page
const LINK =
  'https://example.org/lab/results/2026/phone-check/very-long-path-segment-without-spaces-0123456789abcdef';

export async function run(ctx) {
  const alice = await signUp('mo_alice');
  const bob = await signUp('mo_bob');
  await connect(alice, bob);
  const team = await group(alice, { slug: 'mo-team', name: 'MO team', members: [bob] });
  await sendDrop(bob, [toPerson(alice)], TITLE, `${BODY}\n\n${LINK}`);
  await sendDrop(bob, [toGroup(team)], 'MO group note', 'A note to the whole group from a phone test.');

  await onPhone(ctx, alice);
  await inLightTheme(ctx, alice);
}

/**
 * Text a person can see. The phone hides the list behind an open drop and keeps the sidebar in a closed drawer, so
 * the same words often also exist in hidden elements; only the visible one counts.
 */
function visibleText(page) {
  const shown = (text, exact = false) => page.getByText(text, { exact }).filter({ visible: true }).first();
  return { shown, see: (text) => shown(text).waitFor() };
}

/** Helpers bound to one page: the phone's own navigation and the "nothing is cut off" checks. */
function phoneKit(page) {
  const tabBar = () => page.getByRole('navigation', { name: 'Mobile navigation' });
  const drawer = () => page.getByRole('navigation', { name: 'Main navigation' });
  const menuButton = () => page.getByRole('button', { name: 'Open navigation menu' });
  const tab = (label) =>
    tabBar()
      .getByRole('link', { name: new RegExp(`${label}$`) })
      .click();
  const openDrawer = async () => {
    await menuButton().click();
    await drawer().waitFor({ state: 'visible' });
  };
  // links carry unread badges ("Approvals 1"), so match the start of the name
  const drawerLink = async (label) => {
    await openDrawer();
    await drawer()
      .getByRole('link', { name: new RegExp(`^${label}`) })
      .first()
      .click();
  };
  const heading = (label, level = 1) => page.getByRole('heading', { name: label, level }).first();

  /** The page itself does not scroll sideways. */
  const noHorizontalOverflow = async (where) => {
    const m = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    if (m.scroll > m.inner + 1)
      throw new Error(
        `${where}: page is ${m.scroll}px wide in a ${m.inner}px viewport (horizontal overflow)`,
      );
  };

  /**
   * A button or link a person must reach: after scrolling to it, it lies inside the viewport horizontally and
   * vertically, and it is the element a tap at its centre lands on (not covered by the tab bar or a header).
   */
  const reachable = async (locator, what) => {
    await locator.waitFor({ state: 'visible' });
    await locator.scrollIntoViewIfNeeded();
    const r = await locator.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return {
        left: b.left,
        right: b.right,
        top: b.top,
        bottom: b.bottom,
        w: window.innerWidth,
        h: window.innerHeight,
        onTop: !!hit && (el === hit || el.contains(hit)),
        hit: hit
          ? `${hit.tagName.toLowerCase()} "${(hit.textContent ?? '').trim().slice(0, 40)}"`
          : 'nothing',
      };
    });
    if (r.left < -1 || r.right > r.w + 1)
      throw new Error(
        `${what} is cut off horizontally: spans ${Math.round(r.left)}..${Math.round(r.right)}px of ${r.w}px`,
      );
    if (r.top < -1 || r.bottom > r.h + 1)
      throw new Error(
        `${what} cannot be scrolled into view: spans ${Math.round(r.top)}..${Math.round(r.bottom)}px of ${r.h}px`,
      );
    if (!r.onTop) throw new Error(`${what} is covered: a tap at its centre lands on ${r.hit}`);
  };

  return {
    tabBar,
    drawer,
    menuButton,
    tab,
    openDrawer,
    drawerLink,
    heading,
    noHorizontalOverflow,
    reachable,
  };
}

async function onPhone(ctx, alice) {
  const { page, context, step } = await ctx.session('phone', alice, { viewport: PHONE });
  const { shown, see } = visibleText(page);
  const k = phoneKit(page);

  await step('inbox shows the list on a phone', async () => {
    await k.heading('Inbox').waitFor();
    await see(TITLE);
    // the desktop sidebar stays closed until the menu is opened
    if (await k.drawer().isVisible()) throw new Error('the sidebar is open without opening the menu');
    await k.tabBar().waitFor({ state: 'visible' });
  });
  await step('inbox: nothing cut off', async () => {
    await k.noHorizontalOverflow('inbox');
    await k.reachable(page.getByRole('button', { name: 'Write', exact: true }), '"Write" button');
    await k.reachable(page.getByRole('button', { name: 'Open navigation menu' }), 'menu button');
    await k.reachable(shown(TITLE), 'the drop in the list');
    for (const label of ['Inbox', 'Contacts', 'Groups', 'Agent', 'Settings'])
      await k.reachable(k.tabBar().getByRole('link', { name: new RegExp(`${label}$`) }), `tab "${label}"`);
  });
  await step('open a drop: its body replaces the list', async () => {
    await shown(TITLE).click();
    await page.waitForURL(/\/app\/inbox\/[^/]+$/);
    await k.heading(TITLE, 2).waitFor();
    await see(BODY);
    if (await k.heading('Inbox').isVisible()) throw new Error('the list is still shown next to the drop');
  });
  await step('a drop: nothing cut off', async () => {
    await see(LINK);
    await k.noHorizontalOverflow('a drop with a long link');
    for (const label of ['Back', 'Reply', 'Star', 'Archive', 'Forward'])
      await k.reachable(page.getByRole('button', { name: label, exact: true }).first(), `"${label}" button`);
    await k.reachable(shown(LINK), 'the long link in the body');
  });
  await step('"Back" returns to the list', async () => {
    await page.getByRole('button', { name: 'Back', exact: true }).first().click();
    await page.waitForURL(/\/app\/inbox$/);
    await k.heading('Inbox').waitFor();
    await see(TITLE);
  });

  await step('tab bar: Contacts', async () => {
    await k.tab('Contacts');
    await page.waitForURL(/\/app\/contacts$/);
    await k.heading('Contacts').waitFor();
    await see('Bob');
  });
  await step('contacts: nothing cut off', async () => {
    await k.noHorizontalOverflow('contacts');
    await k.reachable(page.getByRole('button', { name: 'Invite', exact: true }), '"Invite" button');
    await k.reachable(page.getByRole('button', { name: 'Create link' }), '"Create link" button');
  });
  await step('contacts: open a contact and go back', async () => {
    await shown('Bob', true).click();
    await page.waitForURL(/\/app\/contacts\/[^/]+$/);
    await see('Send a message');
    await k.noHorizontalOverflow('a contact');
    await k.reachable(page.getByRole('button', { name: 'Send a message' }), '"Send a message" button');
    await page.getByRole('button', { name: 'Back to contacts' }).click();
    await page.waitForURL(/\/app\/contacts$/);
    await k.heading('Contacts').waitFor();
  });
  await step('tab bar: Groups', async () => {
    await k.tab('Groups');
    await page.waitForURL(/\/app\/groups$/);
    await k.heading('Groups').waitFor();
    await see('MO team');
    await k.noHorizontalOverflow('groups');
  });
  await step('tab bar: Agent', async () => {
    await k.tab('Agent');
    await page.waitForURL(/\/app\/agents$/);
    await k.heading('My agents').waitFor();
    await see('Messages sent to @mo_alice reach');
    await k.noHorizontalOverflow('my agents');
  });
  await step('tab bar: Settings', async () => {
    await k.tab('Settings');
    await page.waitForURL(/\/app\/settings$/);
    await k.heading('Settings').waitFor();
    await see('Language');
    await k.noHorizontalOverflow('settings');
  });
  await step('tab bar: Inbox', async () => {
    await k.tab('Inbox');
    await page.waitForURL(/\/app\/inbox$/);
    await k.heading('Inbox').waitFor();
  });

  await step('menu drawer opens and closes', async () => {
    await k.openDrawer();
    if ((await k.menuButton().getAttribute('aria-expanded')) !== 'true')
      throw new Error('menu button does not say it is expanded');
    await k.reachable(k.drawer().getByRole('link', { name: /^Sent/ }), 'drawer link "Sent"');
    // the backdrop sits under the 224px drawer; tap the part of it that is still visible
    await page.getByRole('button', { name: 'Close navigation' }).click({ position: { x: 340, y: 400 } });
    await k.drawer().waitFor({ state: 'hidden' });
    if ((await k.menuButton().getAttribute('aria-expanded')) !== 'false')
      throw new Error('menu button still says it is expanded');
  });
  await step(
    'menu drawer by keyboard: focus moves in, stays in, Escape closes and returns focus',
    async () => {
      const inDrawer = () => page.evaluate(() => !!document.activeElement?.closest('#workspace-navigation'));
      await k.menuButton().focus();
      await page.keyboard.press('Enter');
      await k.drawer().waitFor({ state: 'visible' });
      if (!(await inDrawer())) throw new Error('focus did not move into the opened drawer');
      if ((await page.locator('#workspace-navigation').getAttribute('aria-modal')) !== 'true')
        throw new Error('the open drawer is not a modal dialog');
      // more Tab presses than the drawer has stops: focus must wrap inside it, both ways
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press('Tab');
        if (!(await inDrawer())) throw new Error(`Tab #${i + 1} left the open drawer`);
      }
      for (let i = 0; i < 5; i += 1) {
        await page.keyboard.press('Shift+Tab');
        if (!(await inDrawer())) throw new Error('Shift+Tab left the open drawer');
      }
      await page.keyboard.press('Escape');
      await k.drawer().waitFor({ state: 'hidden' });
      const back = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
      if (back !== 'Open navigation menu')
        throw new Error(`focus returned to "${back}", not the menu button`);
      // the drawer follows the menu button in reading order
      const order = await page.evaluate(() => {
        const button = document.querySelector('[aria-controls="workspace-navigation"]');
        const drawer = document.getElementById('workspace-navigation');
        return (
          !!button &&
          !!drawer &&
          !!(button.compareDocumentPosition(drawer) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      });
      if (!order) throw new Error('the drawer comes before its menu button in the DOM');
    },
  );
  await step('skip link leads past the navigation', async () => {
    const first = page.getByRole('link', { name: 'Skip to content' });
    await page.goto(page.url());
    await k.heading('Inbox').waitFor();
    await page.keyboard.press('Tab');
    if (!(await first.evaluate((el) => el === document.activeElement)))
      throw new Error('the first Tab stop is not "Skip to content"');
    await page.keyboard.press('Enter');
    const inMain = await page.evaluate(() => !!document.activeElement?.closest('#main-content'));
    if (!inMain) throw new Error('"Skip to content" did not move focus to the page');
  });
  for (const [label, url, check] of [
    ['Sent', /\/app\/sent$/, () => k.heading('Sent').waitFor()],
    ['Starred', /\/app\/starred$/, () => k.heading('Starred').waitFor()],
    ['Archived', /\/app\/archived$/, () => k.heading('Archived').waitFor()],
    ['My space', /\/app\/space$/, () => k.heading('My space').waitFor()],
    ['MO team', /\/app\/groups\/[^/]+$/, () => see('MO group note')],
    ['Approvals', /\/app\/approvals$/, () => k.heading('Approvals').waitFor()],
    ['Help', /\/app\/help$/, () => k.heading('Help').waitFor()],
  ])
    await step(`menu drawer: ${label}`, async () => {
      await k.drawerLink(label);
      await page.waitForURL(url);
      await check();
      // following a link closes the drawer
      await k.drawer().waitFor({ state: 'hidden' });
      await k.noHorizontalOverflow(label);
    });

  await step('compose on the phone: open it from the header, nothing cut off', async () => {
    await k.tab('Inbox');
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.waitForURL(/\/app\/compose/);
    await k.heading('New message').waitFor();
    await k.noHorizontalOverflow('composer');
    await k.reachable(page.getByRole('button', { name: 'Cancel', exact: true }), '"Cancel" button');
    await k.reachable(page.getByRole('combobox', { name: 'Search recipients' }), 'the recipient field');
    await k.reachable(page.getByPlaceholder(/Write down the confirmed context/), 'the body field');
  });
  await step('compose on the phone: pick a recipient, write, send, "Delivered"', async () => {
    // the same steps as composeAndSend, with a look at the send button once it is enabled
    await page.getByRole('combobox', { name: 'Search recipients' }).fill('mo_bob');
    await page
      .getByRole('option', { name: /Bob\s*@mo_bob/ })
      .first()
      .click();
    await page.getByPlaceholder('What does the other side need to know?').fill('Sent from a phone');
    await page
      .getByPlaceholder(/Write down the confirmed context/)
      .fill('Written and sent on a 390px screen.');
    await k.noHorizontalOverflow('composer with a recipient');
    const send = page.getByRole('button', { name: 'Send message' });
    await k.reachable(send, '"Send message" button');
    await send.click();
    await see('Delivered');
    await k.noHorizontalOverflow('"Delivered"');
    await k.reachable(page.getByRole('button', { name: 'Send another' }), '"Send another" button');
  });
  await context.close();
}

/**
 * The colour a person actually sees: text colour and the first opaque background behind it, both composited through
 * every translucent layer, as a WCAG contrast ratio. Colours go through a canvas so oklch() and friends resolve too.
 */
async function contrast(locator) {
  return locator.evaluate((el) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const rgba = (css) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let bg = [255, 255, 255, 1];
    for (const layer of layers.reverse()) bg = over(layer, bg);
    const fg = over(rgba(getComputedStyle(el).color), bg);
    const lum = (c) => {
      const [r, g, b] = c.slice(0, 3).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    const hex = (c) => `rgb(${c.slice(0, 3).map(Math.round).join(',')})`;
    return { ratio: (hi + 0.05) / (lo + 0.05), fg: hex(fg), bg: hex(bg) };
  });
}

async function readable(locator, what) {
  await locator.waitFor({ state: 'visible' });
  const c = await contrast(locator);
  // 3:1 is WCAG's floor for large text; below it text is effectively invisible on a phone in daylight
  if (c.ratio < 3)
    throw new Error(`${what} is hard to read: ${c.fg} on ${c.bg}, contrast ${c.ratio.toFixed(2)}:1`);
}

async function inLightTheme(ctx, alice) {
  const { page, context, step } = await ctx.session('light', alice, {
    viewport: PHONE,
    colorScheme: 'light',
  });
  const { shown, see } = visibleText(page);
  const k = phoneKit(page);

  await step('switch to the light theme from the menu', async () => {
    await k.openDrawer();
    await page.getByRole('button', { name: 'Switch to light mode' }).click();
    await page.getByRole('button', { name: 'Switch to dark mode' }).waitFor();
    await page.getByRole('button', { name: 'Close navigation' }).click({ position: { x: 340, y: 400 } });
    await k.drawer().waitFor({ state: 'hidden' });
  });
  await step('light: inbox is readable', async () => {
    await readable(k.heading('Inbox'), 'inbox heading');
    await readable(shown(TITLE, true), 'drop title in the list');
    await k.noHorizontalOverflow('inbox (light)');
  });
  await step('light: a drop is readable', async () => {
    await shown(TITLE, true).click();
    await readable(k.heading(TITLE, 2), 'drop title');
    await readable(shown(BODY), 'drop body');
    await readable(page.getByRole('button', { name: 'Reply', exact: true }).first(), '"Reply" button');
  });
  await step('light: composer is readable', async () => {
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await see('Send message');
    await readable(k.heading('New message'), 'composer heading');
    await readable(page.getByRole('button', { name: 'Send message' }), '"Send message" button');
  });
  await step('light: contacts are readable', async () => {
    await k.tab('Contacts');
    await readable(k.heading('Contacts'), 'contacts heading');
    await readable(shown('Bob', true), 'contact name');
  });
  await step('light: groups are readable', async () => {
    await k.tab('Groups');
    await readable(k.heading('Groups'), 'groups heading');
    await readable(shown('MO team', true), 'group name');
  });
  await step('light: my agents is readable', async () => {
    await k.tab('Agent');
    await readable(k.heading('My agents'), 'my agents heading');
    await readable(shown('Messages sent to @mo_alice reach'), 'agents explanation');
  });
  await step('light: settings is readable', async () => {
    await k.tab('Settings');
    await readable(k.heading('Settings'), 'settings heading');
    await readable(shown('Language', true), 'settings section');
  });
  await step('light: help is readable', async () => {
    await k.drawerLink('Help');
    await readable(k.heading('Help'), 'help heading');
    await readable(shown('Getting started'), 'help section');
  });
  await step('light: theme persists across a reload', async () => {
    await page.reload();
    await k.heading('Help').waitFor();
    await k.openDrawer();
    await page.getByRole('button', { name: 'Switch to dark mode' }).waitFor();
  });
  await context.close();
}
