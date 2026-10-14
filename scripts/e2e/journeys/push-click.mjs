/**
 * Clicking a browser notification opens the drop it announces (public/sw.js `notificationclick`).
 *
 * The service worker is registered as the dashboard does when push is switched on, a real notification is shown,
 * and the click event is dispatched inside the worker. A script-dispatched click carries no user activation, so the
 * browser refuses `focus()` and `openWindow()` for it: the "no dashboard tab open" case stays in the manual
 * acceptance list (docs/QUALITY.md §6); navigating an existing tab is what is proven here, for a tab the worker
 * controls and for one it does not (after a hard reload). Service workers need a secure context, so the plain-http
 * run only checks that the dashboard copes without one.
 */
import { connect, sendDrop, signUp, toPerson } from '../api.mjs';

export const name = 'push-click';

export async function run(ctx) {
  const alice = await signUp('pc_alice');
  const bob = await signUp('pc_bob');
  await connect(alice, bob);
  const sent = await sendDrop(bob, [toPerson(alice)], 'PC notice target', 'Opened from a notification.');
  const dropId = sent.drop_id;
  const path = `/app/inbox/${dropId}?h=${alice.h}`;

  const { page, context, step, see, nav } = await ctx.session('alice', alice);

  if (ctx.mode !== 'secure') {
    await step('without a service worker the dashboard still works', async () => {
      if (await page.evaluate(() => 'serviceWorker' in navigator && window.isSecureContext))
        throw new Error('expected no service worker on plain http');
      await nav('Settings');
      await see('Notifications');
    });
    await context.close();
    return;
  }

  let worker = null;
  await step('the dashboard registers its service worker and it takes control', async () => {
    await context.grantPermissions(['notifications'], { origin: ctx.base });
    // listen before registering (the event may fire at once); unused when the worker is already there
    const registered = context.waitForEvent('serviceworker').catch(() => null);
    await page.evaluate(() => navigator.serviceWorker.register('/sw.js', { scope: '/' }));
    worker = context.serviceWorkers().find((w) => w.url().endsWith('/sw.js')) ?? (await registered);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  });

  /**
   * What the worker's `notificationclick` does with the notice's path. Headless Chrome shows no notifications to
   * click, so the step runs the click handler's own function (sw.js `openNotificationTarget`) in the worker. Not
   * awaited there: a script-started click may not open windows, which must not hide whether the tab navigated.
   */
  const clickNotification = (target) =>
    worker.evaluate((p) => {
      self.openNotificationTarget(p).catch(() => {});
    }, target);

  await step('clicking the notice in a controlled tab opens the drop', async () => {
    await nav('Contacts');
    await page.waitForURL(/\/app\/contacts/);
    await clickNotification(path);
    await page.waitForURL(new RegExp(`/app/inbox/${dropId}`));
    await see('Opened from a notification.');
  });

  await step('clicking the notice in a tab the worker does not control opens the drop', async () => {
    await nav('Contacts');
    await page.waitForURL(/\/app\/contacts/);
    // A hard reload (Shift+Reload) leaves the page uncontrolled by any service worker.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.reload', { ignoreCache: true });
    await page.waitForLoadState('load');
    await see('Contacts');
    if (await page.evaluate(() => navigator.serviceWorker.controller !== null))
      throw new Error('the page is still controlled; the uncontrolled case was not reached');
    await clickNotification(path);
    await page.waitForURL(new RegExp(`/app/inbox/${dropId}`));
    await see('Opened from a notification.');
  });

  await step('a notice pointing outside the dashboard opens the inbox instead', async () => {
    await nav('Contacts');
    await page.waitForURL(/\/app\/contacts/);
    await clickNotification('https://evil.example/phish');
    await page.waitForURL(/\/app\/inbox(\?|$)/);
    if (!page.url().startsWith(ctx.base)) throw new Error(`left the dashboard: ${page.url()}`);
  });

  await step('the page ignores a message that points outside the dashboard', async () => {
    await nav('Contacts');
    await page.waitForURL(/\/app\/contacts/);
    const answered = await worker.evaluate(async () => {
      const [client] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const channel = new MessageChannel();
      const reply = new Promise((resolve) => {
        channel.port1.onmessage = () => resolve(true);
        setTimeout(() => resolve(false), 1000);
      });
      client.postMessage({ type: 'agentdrop:open', path: 'https://evil.example/app/x' }, [channel.port2]);
      return reply;
    });
    if (answered) throw new Error('the page accepted a path outside the dashboard');
    if (!/\/app\/contacts/.test(page.url())) throw new Error(`moved to ${page.url()}`);
  });

  await context.close();
}
