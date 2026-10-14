import type { PushSettings, PushSubscriptionView } from '@agentdrop/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, ChevronRight, Smartphone, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { LocalError } from '../lib/error-text.js';
import { formatDate, formatDateTime } from '../lib/format.js';
import { t as tNow, useT } from '../lib/lang.js';
import {
  type BrowserPushState,
  disableBrowserPush,
  enableBrowserPush,
  getBrowserPushState,
  isCurrentBrowserEnabled,
} from '../lib/push.js';
import { useSession } from '../lib/session.js';
import { Chip, Panel } from './layout.jsx';
import { Button, ErrorBox, Loading } from './primitives.jsx';
import { TitleWithChip } from './settings-controls.jsx';

const PUSH_QUERY_KEY = ['push-settings'] as const;
const SNOOZE_KEY = 'agentdrop.pushBannerSnoozedUntil';
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function useBrowserPush() {
  const { me } = useSession();
  const userId = me?.user_id ?? '';
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: PUSH_QUERY_KEY,
    queryFn: () => api.get<PushSettings>('/v1/me/push'),
    retry: false,
  });
  const [browser, setBrowser] = useState<BrowserPushState | null>(null);
  const [browserError, setBrowserError] = useState<unknown>(null);
  const [browserChecked, setBrowserChecked] = useState(false);

  const refreshBrowser = useCallback(async () => {
    try {
      setBrowserError(null);
      if (userId) setBrowser(await getBrowserPushState(userId));
    } catch (error) {
      setBrowserError(error);
    } finally {
      setBrowserChecked(true);
    }
  }, [userId]);

  useEffect(() => {
    void refreshBrowser();
  }, [refreshBrowser]);

  const enable = useMutation({
    mutationFn: (attempt: Promise<PushSubscriptionView>) => attempt,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: PUSH_QUERY_KEY });
      await refreshBrowser();
    },
    onError: refreshBrowser,
  });
  const disable = useMutation({
    mutationFn: () => {
      if (!userId)
        throw new LocalError({
          en: 'Your session has expired. Refresh and try again.',
          zh: '登录状态已失效，请刷新后重试',
        });
      return disableBrowserPush(userId);
    },
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: PUSH_QUERY_KEY });
      await refreshBrowser();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/me/push/subscriptions/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: PUSH_QUERY_KEY }),
  });

  // Create the permission promise directly inside the click event before handing it to React Query. Safari and
  // other browsers may reject Notification.requestPermission() after user activation has crossed an async boundary.
  const startEnable = (afterSuccess?: () => void) => {
    let attempt: Promise<PushSubscriptionView>;
    const key = settings.data?.vapid_public_key;
    if (!key)
      attempt = Promise.reject(
        new Error(
          tNow(
            "Push notifications aren't set up on the server yet. Try again later.",
            '即时通知服务暂未配置，请稍后再试',
          ),
        ),
      );
    else if (!userId)
      attempt = Promise.reject(
        new Error(tNow('Your session has expired. Refresh and try again.', '登录状态已失效，请刷新后重试')),
      );
    else attempt = enableBrowserPush(key, userId);
    enable.mutate(attempt, { ...(afterSuccess ? { onSuccess: afterSuccess } : {}) });
  };

  const enabled = Boolean(browser && settings.data && isCurrentBrowserEnabled(browser, settings.data));
  return { settings, browser, browserError, browserChecked, enable, startEnable, disable, revoke, enabled };
}

export function InboxPushBanner({ detailOpen }: { detailOpen: boolean }) {
  const t = useT();
  const { me } = useSession();
  const push = useBrowserPush();
  const snoozeKey = `${SNOOZE_KEY}:${me?.user_id ?? 'anonymous'}`;
  const [snoozed, setSnoozed] = useState(() => Number(localStorage.getItem(snoozeKey) ?? 0) > Date.now());
  const [completed, setCompleted] = useState(false);

  if (snoozed || push.enabled || push.settings.data?.available === false) return null;
  if (!push.settings.data || !push.browser) return null;
  if (push.browser.permission === 'unavailable' || push.browser.permission === 'denied') return null;

  const isIosGuide = push.browser.permission === 'needs-ios-install';
  const error = push.enable.error ?? push.browserError;

  return (
    <aside
      className={`mx-3 mt-3 mb-1 shrink-0 rounded-lg border border-accent/25 bg-accent/8 px-3 py-2 sm:mx-4 ${detailOpen ? 'hidden lg:flex' : 'flex'} flex-wrap items-center gap-x-3 gap-y-1.5`}
      aria-label={t('Push notifications', '即时通知')}
      aria-live="polite"
    >
      <span className="inline-flex shrink-0 text-accent-fg" aria-hidden="true">
        {isIosGuide ? <Smartphone size={16} /> : <Bell size={16} />}
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 className="text-sm font-medium text-fg">
            {completed
              ? t('Push notifications are on', '即时通知已开启')
              : isIosGuide
                ? t('Add to your home screen first', '先添加到主屏幕')
                : t('Get alerted when new messages arrive', '新消息也能及时提醒')}
          </h2>
          <p className="hidden text-xs text-muted sm:block">
            {completed
              ? t(
                  'This device will be alerted to new AgentDrop messages',
                  '这台设备会收到 AgentDrop 新消息提醒',
                )
              : isIosGuide
                ? t(
                    'On iPhone / iPad, open from the home screen, then allow',
                    'iPhone / iPad 需从主屏幕打开后授权',
                  )
                : t(
                    "Works even when Codex or Claude isn't running; message text is hidden by default",
                    'Codex 或 Claude 不运行也能收到；默认不显示正文',
                  )}
          </p>
        </div>
        {error ? (
          <p className="text-xs text-danger" role="alert">
            {error instanceof Error
              ? error.message
              : t("Couldn't turn on notifications. Try again later.", '开启通知失败，请稍后重试')}
          </p>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {!completed && !isIosGuide ? (
          <Button
            variant="primary"
            disabled={push.enable.isPending}
            onClick={() =>
              push.startEnable(() => {
                setCompleted(true);
                window.setTimeout(() => setSnoozed(true), 1800);
              })
            }
          >
            {push.enable.isPending ? t('Turning on…', '正在开启…') : t('Turn on notifications', '开启通知')}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          className="text-muted"
          onClick={() => {
            localStorage.setItem(snoozeKey, String(Date.now() + SNOOZE_MS));
            setSnoozed(true);
          }}
        >
          {t('Later', '稍后')} <X size={12} aria-hidden="true" />
        </Button>
      </div>
    </aside>
  );
}

export function PushSettingsCard() {
  const t = useT();
  const push = useBrowserPush();
  const data = push.settings.data;
  const browser = push.browser;
  const error = push.enable.error ?? push.disable.error ?? push.browserError;

  const stateLabel = push.enabled
    ? t('On in this browser', '当前浏览器已开启')
    : browser?.permission === 'denied'
      ? t('Blocked by the browser', '已被浏览器阻止')
      : browser?.permission === 'needs-ios-install'
        ? t('Add to home screen first', '需要添加到主屏幕')
        : browser?.permission === 'unavailable'
          ? t('Not supported here', '当前环境不支持')
          : data?.available === false
            ? t('Not set up on the server', '服务端暂未配置')
            : t('Off in this browser', '当前浏览器未开启');

  return (
    <Panel
      icon={push.enabled ? <Bell size={16} /> : <BellOff size={16} />}
      title={
        <TitleWithChip chip={<Chip tone={push.enabled ? 'ok' : 'neutral'}>{stateLabel}</Chip>}>
          {t('Browser notifications', '浏览器系统通知')}
        </TitleWithChip>
      }
      description={t(
        'Alerts on this device even when no agent runs; title and sender only.',
        '没有 Agent 在运行时也能在这台设备上收到提醒；只显示标题和发件人。',
      )}
    >
      {push.settings.isLoading || !push.browserChecked ? (
        <Loading label={t('Checking this browser…', '正在检查这台浏览器…')} />
      ) : null}
      {push.settings.isError ? (
        <ErrorBox error={push.settings.error} retry={() => push.settings.refetch()} />
      ) : null}
      {browser?.permission === 'needs-ios-install' ? (
        <div
          className="rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-sm leading-6 text-warn"
          role="status"
        >
          {t(
            'In Safari\'s Share menu, choose "Add to Home Screen", then open AgentDrop from the home screen to turn on notifications.',
            '在 Safari 的分享菜单中选择“添加到主屏幕”，再从主屏幕打开 AgentDrop，之后即可开启通知。',
          )}
        </div>
      ) : null}
      {browser?.permission === 'denied' ? (
        <div
          className="rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-sm leading-6 text-warn"
          role="status"
        >
          {t(
            'The browser has blocked notifications. Open this site\'s permission settings, set "Notifications" to Allow, then refresh this page.',
            '浏览器已阻止通知。请打开当前网站的权限设置，将“通知”改为允许，然后刷新此页。',
          )}
        </div>
      ) : null}
      {browser?.permission === 'unavailable' ? (
        <div className="text-sm leading-6 text-muted">
          {t(
            "This browser or connection doesn't support Web Push. Use a modern browser that supports notifications, over HTTPS.",
            '当前浏览器或访问方式不支持 Web Push。请使用支持通知的现代浏览器，并通过 HTTPS 访问。',
          )}
        </div>
      ) : null}
      {error ? <ErrorBox error={error} /> : null}

      {data && browser ? (
        <div className="flex flex-wrap items-center gap-3">
          {push.enabled ? (
            <Button disabled={push.disable.isPending} onClick={() => push.disable.mutate()}>
              <BellOff size={14} />
              {push.disable.isPending
                ? t('Turning off…', '正在关闭…')
                : t('Turn off notifications in this browser', '关闭此浏览器通知')}
            </Button>
          ) : (
            <Button
              disabled={
                push.enable.isPending ||
                !data.available ||
                !data.vapid_public_key ||
                browser.permission === 'unavailable' ||
                browser.permission === 'denied' ||
                browser.permission === 'needs-ios-install'
              }
              onClick={() => push.startEnable()}
            >
              <Bell size={14} />
              {push.enable.isPending
                ? t('Turning on…', '正在开启…')
                : t('Turn on notifications in this browser', '开启此浏览器通知')}
            </Button>
          )}
          <span className="text-xs text-dim">
            {t('Devices registered for notifications: ', '账号已登记 ')}
            {data.subscriptions.length}
            {t('', ' 个通知设备')}
          </span>
        </div>
      ) : null}
      {data && data.subscriptions.length > 0 ? (
        <details className="group border-t border-line pt-3 text-sm">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted hover:text-fg">
            <ChevronRight
              size={14}
              className="transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            {t('Manage notification devices', '管理通知设备')}
          </summary>
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
            {data.subscriptions.map((subscription) => {
              const current = subscription.id === browser?.serverSubscriptionId;
              return (
                <li key={subscription.id} className="flex items-center gap-3 px-3 py-2">
                  <Smartphone size={14} className="shrink-0 text-dim" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-fg-2">
                      {subscription.device_label}{' '}
                      {current ? <span className="text-accent-fg">· {t('this device', '当前')}</span> : null}
                    </div>
                    <div className="text-xs text-dim">
                      {subscription.last_success_at
                        ? `${t('Last delivered', '最近送达')} ${formatDateTime(subscription.last_success_at)}`
                        : `${t('Added', '添加于')} ${formatDate(subscription.created_at)}`}
                    </div>
                  </div>
                  {!current ? (
                    <Button
                      variant="ghost"
                      className="text-muted hover:text-danger"
                      disabled={push.revoke.isPending}
                      onClick={() => push.revoke.mutate(subscription.id)}
                    >
                      {t('Remove', '移除')}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </Panel>
  );
}
