const DEFAULT_PATH = '/app/inbox';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function safeAppPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return DEFAULT_PATH;
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin || !url.pathname.startsWith('/app/')) return DEFAULT_PATH;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_PATH;
  }
}

function safeHandle(value) {
  if (typeof value !== 'string') return null;
  const handle = value.trim().slice(0, 64);
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(handle) ? handle : null;
}

function safeTitle(value) {
  if (typeof value !== 'string') return null;
  const withoutControls = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const blocked =
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0x200b && codePoint <= 0x200f) ||
        (codePoint >= 0x2028 && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069) ||
        codePoint === 0x061c ||
        codePoint === 0xfeff;
      return blocked ? ' ' : character;
    })
    .join('');
  const title = withoutControls.replace(/\s+/g, ' ').trim();
  return title ? [...title].slice(0, 160).join('') : null;
}

// The dashboard writes its language here (src/lib/lang.ts); English unless the person chose Chinese.
async function notificationLang() {
  try {
    const cache = await caches.open('agentdrop-prefs');
    const saved = await cache.match('/__agentdrop/lang');
    return saved && (await saved.text()) === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

function safeName(value) {
  const name = safeTitle(value);
  return name ? [...name].slice(0, 40).join('') : null;
}

function safeSlug(value) {
  if (typeof value !== 'string') return null;
  const slug = value.trim().slice(0, 32);
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(slug) ? slug : null;
}

// The same words as the Feishu notice (packages/domain/src/notify/feishu.ts): what kind of item, which group, who.
function person(zh, name, handle) {
  if (!handle) return name ?? null;
  if (!name) return `@${handle}`;
  return zh ? `${name}（@${handle}）` : `${name} (@${handle})`;
}

function groupLabel(zh, name, slug) {
  const parts = [name ? (zh ? `「${name}」` : `“${name}”`) : null, slug ? `#${slug}` : null].filter(Boolean);
  return parts.join(zh ? '' : ' ');
}

/** Title and body for one pushed item, in the person's language. Every input is already sanitized. */
function notificationText(lang, data) {
  const zh = lang === 'zh';
  const from = person(zh, safeName(data.from_display_name), safeHandle(data.from_handle));
  const group = groupLabel(zh, safeName(data.group_name), safeSlug(data.group_slug));
  switch (data.kind) {
    case 'contact':
      return {
        title: zh ? '联系人申请' : 'Contact request',
        body: from
          ? zh
            ? `${from}想加你为联系人`
            : `${from} wants to add you as a contact`
          : zh
            ? '有人想加你为联系人'
            : 'Someone wants to add you as a contact',
      };
    case 'invitation':
      return {
        title: zh ? '群邀请' : 'Group invitation',
        body: zh ? `你被邀请加入${group || '一个群'}` : `You are invited to ${group || 'a group'}`,
      };
    case 'join': {
      const invitee = safeHandle(data.invitee_handle);
      const by = safeHandle(data.invited_by_handle);
      const who = invitee ? `@${invitee}` : zh ? '有人' : 'Someone';
      return {
        title: zh ? '入群申请' : 'Join request',
        body: zh
          ? `${who} 想加入${group || '你管理的群'}${by ? `（@${by} 邀请）` : ''}，只能在网页上决定`
          : `${who} wants to join ${group || 'a group you manage'}${by ? ` (invited by @${by})` : ''}; only you can decide, in the dashboard`,
      };
    }
    default: {
      // A drop (payloads from before `kind` existed are drops too).
      const title = safeTitle(data.title) ?? (zh ? 'AgentDrop 新消息' : 'New AgentDrop message');
      const mention = data.mentioned === true ? (zh ? ' @了你' : ' mentioned you') : '';
      // set by the server only when this person may read the drop it answers (ADR 0016); same words as Feishu
      const original = safeTitle(data.reply_to_title);
      const mine = data.reply_to_mine === true;
      const reply = original
        ? zh
          ? `${mention ? '，并' : ' '}回复了${mine ? '你的' : ''}「${original}」`
          : `${mention ? ' and' : ''} replied to ${mine ? 'your ' : ''}“${original}”`
        : '';
      if (group) {
        const where = zh
          ? `群消息 ·${group.startsWith('「') ? '' : ' '}${group}`
          : `Group message · ${group}`;
        return { title, body: from ? `${where}${zh ? '：' : ': '}${from}${mention}${reply}` : where };
      }
      if (!from) return { title, body: zh ? '来自 AgentDrop' : 'From AgentDrop' };
      return { title, body: zh ? `私信：${from}${reply}` : `Direct message: ${from}${reply}` };
    }
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = {};
  }
  if (!data || typeof data !== 'object') data = {};
  const eventId = typeof data.event_id === 'string' ? data.event_id.slice(0, 160) : undefined;
  // One event can carry several join requests (one per invitee): each keeps its own notification.
  const invitee = data.kind === 'join' ? safeHandle(data.invitee_handle) : null;
  const tag = eventId ? `agentdrop:${eventId}${invitee ? `:${invitee}` : ''}` : undefined;
  const path = safeAppPath(data.path ?? data.url);
  event.waitUntil(
    notificationLang().then((lang) => {
      const { title, body } = notificationText(lang, data);
      return self.registration.showNotification(title, {
        body,
        icon: '/icons/agentdrop-192.png',
        badge: '/icons/agentdrop-192.png',
        tag,
        renotify: false,
        data: { path },
      });
    }),
  );
});

/** Asks an open dashboard tab to route itself to `path`; true when it confirmed within 1.5 s. */
function askPageToOpen(client, path) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 1500);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
    client.postMessage({ type: 'agentdrop:open', path }, [channel.port2]);
  });
}

/**
 * Brings the dashboard to `path` (already made safe). A message reaches every open tab, including one this worker
 * does not control (after a hard reload, or opened before the worker was installed), where `navigate()` throws; it
 * also routes inside the app without reloading it. Pages from before this worker do not answer the message, so
 * `navigate()` and then a new window remain as fallbacks.
 */
async function openAppPath(path) {
  const clients = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(
    (client) => new URL(client.url).origin === self.location.origin,
  );
  const client = clients.find((c) => c.focused) ?? clients[0];
  if (!client) return self.clients.openWindow(path);
  // Focus first, while the click still allows it; a refused focus must not stop the navigation.
  await client.focus().catch(() => {});
  if (await askPageToOpen(client, path)) return;
  try {
    if (await client.navigate(path)) return;
  } catch {
    /* not controlled by this worker */
  }
  return self.clients.openWindow(path);
}
/** What a click on a notice does with the path it carries; exposed so the e2e journey runs the same code. */
function openNotificationTarget(rawPath) {
  return openAppPath(safeAppPath(rawPath));
}
self.openNotificationTarget = openNotificationTarget;

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openNotificationTarget(event.notification.data?.path));
});
