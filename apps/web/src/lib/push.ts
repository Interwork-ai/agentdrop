import type { PushSettings, PushSubscriptionInput, PushSubscriptionView } from '@agentdrop/contracts';
import { api } from './api.js';
import { LocalError } from './error-text.js';
import { t as tNow } from './lang.js';

export type PushPermissionState = 'unavailable' | 'default' | 'granted' | 'denied' | 'needs-ios-install';

export interface BrowserPushState {
  permission: PushPermissionState;
  subscription: PushSubscription | null;
  serverSubscriptionId: string | null;
}

const SERVICE_WORKER_URL = '/sw.js';
const SUBSCRIPTION_ID_KEY = 'agentdrop.pushSubscriptionId';

function subscriptionIdKey(userId: string): string {
  return `${SUBSCRIPTION_ID_KEY}:${userId}`;
}

export function isIosBrowser(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function isStandaloneApp(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

export function pushFeatureState(): PushPermissionState {
  if (isIosBrowser() && !isStandaloneApp()) return 'needs-ios-install';
  if (
    !window.isSecureContext ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    return 'unavailable';
  }
  return Notification.permission;
}

export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (pushFeatureState() === 'unavailable' || pushFeatureState() === 'needs-ios-install') {
    throw new LocalError({
      en: 'This browser cannot register for notifications.',
      zh: '当前浏览器不能注册即时通知',
    });
  }
  return navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' });
}

export async function getBrowserPushState(userId: string): Promise<BrowserPushState> {
  const permission = pushFeatureState();
  if (permission === 'unavailable' || permission === 'needs-ios-install') {
    return { permission, subscription: null, serverSubscriptionId: null };
  }
  const registration = await registerPushServiceWorker();
  const subscription = await registration.pushManager.getSubscription();
  return {
    permission,
    subscription,
    serverSubscriptionId: localStorage.getItem(subscriptionIdKey(userId)),
  };
}

export function base64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function currentDeviceLabel(): string {
  const platform = navigator.platform?.trim();
  return tNow(`${platform || 'This device'} browser`, `${platform || '当前设备'} 浏览器`).slice(0, 80);
}

function subscriptionInput(subscription: PushSubscription): PushSubscriptionInput {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new LocalError({
      en: 'The browser returned an incomplete notification subscription. Please try again.',
      zh: '浏览器返回的通知订阅不完整，请重试',
    });
  }
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    device_label: currentDeviceLabel(),
  };
}

/** Must only be called from an explicit user gesture. This is the only function that requests permission. */
export async function enableBrowserPush(
  vapidPublicKey: string,
  userId: string,
): Promise<PushSubscriptionView> {
  const feature = pushFeatureState();
  if (feature === 'needs-ios-install') {
    throw new LocalError({
      en: 'Add AgentDrop to your home screen first, then open it from there and turn on notifications.',
      zh: '请先将 AgentDrop 添加到主屏幕，再从主屏幕打开并开启通知',
    });
  }
  if (feature === 'unavailable')
    throw new LocalError({
      en: 'This browser or way of opening the site does not support notifications.',
      zh: '当前浏览器或访问方式不支持即时通知',
    });
  if (feature === 'denied')
    throw new LocalError({
      en: 'The browser blocked notifications. Allow them again in the site settings.',
      zh: '通知已被浏览器阻止，请在浏览器的网站设置中重新允许',
    });

  const permission = feature === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted')
    throw new LocalError({
      en: 'Notification permission is off; you can allow it later in the site settings.',
      zh: '通知权限未开启；可稍后在浏览器的网站设置中允许',
    });

  const registration = await registerPushServiceWorker();
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(vapidPublicKey),
    }));

  try {
    const saved = await api.post<PushSubscriptionView>(
      '/v1/me/push/subscriptions',
      subscriptionInput(subscription),
    );
    localStorage.setItem(subscriptionIdKey(userId), saved.id);
    return saved;
  } catch (error) {
    if (!existing) await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}

export async function disableBrowserPush(userId: string): Promise<{ serverCleaned: boolean }> {
  const key = subscriptionIdKey(userId);
  const serverId = localStorage.getItem(key);
  const serverCleanup = serverId
    ? api
        .delete(`/v1/me/push/subscriptions/${encodeURIComponent(serverId)}`)
        .then(() => true)
        .catch(() => false)
    : Promise.resolve(true);

  try {
    const permission = pushFeatureState();
    if (permission !== 'unavailable' && permission !== 'needs-ios-install') {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
    }
  } finally {
    localStorage.removeItem(key);
  }
  // A broken notification endpoint must never make explicit sign-out hang. The in-flight request remains safely
  // handled; if the server did not receive it, a later push gets 404/410 after the local unsubscribe and revokes it.
  const serverCleaned = await Promise.race([
    serverCleanup,
    new Promise<false>((resolve) => window.setTimeout(() => resolve(false), 1500)),
  ]);
  return { serverCleaned };
}

export async function cleanupBrowserPushBeforeSignOut(userId: string | undefined): Promise<void> {
  try {
    if (userId) await disableBrowserPush(userId);
  } catch {
    // Signing out must never be blocked by notification cleanup.
  }
}

export function isCurrentBrowserEnabled(state: BrowserPushState, settings: PushSettings): boolean {
  return Boolean(
    state.subscription &&
      state.serverSubscriptionId &&
      settings.subscriptions.some((subscription) => subscription.id === state.serverSubscriptionId),
  );
}
