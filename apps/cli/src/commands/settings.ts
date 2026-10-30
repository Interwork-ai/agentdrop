import type { FeishuWatchView } from '@agentdrop/contracts';
import { formatInterval, parseInterval, readHookSettings, writeHookSettings } from '../hook-settings.js';
import { isLanguage, readLanguage, writeLanguage } from '../locale.js';
import type { Output } from '../output.js';
import { listProfiles } from '../store.js';
import { clientFor } from './mail.js';

export interface SettingsOptions {
  notifications?: string;
  notifyInterval?: string;
  noticeDetail?: string;
  updates?: string;
  updateCheckInterval?: string;
  language?: string;
  feishuWebhook?: string;
  feishuSecret?: string;
  feishuWatch?: string;
  profile?: string;
}
/** English twin of `formatInterval` (which writes Chinese) for the summary below. */
function formatIntervalEn(ms: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (ms === 0) return 'every time';
  if (ms % 86_400_000 === 0) return unit(ms / 86_400_000, 'day');
  if (ms % 3_600_000 === 0) return unit(ms / 3_600_000, 'hour');
  return unit(ms / 60_000, 'minute');
}

export async function settingsCommand(out: Output, opts: SettingsOptions): Promise<void> {
  const settings = readHookSettings();
  if (opts.notifications !== undefined) {
    if (!['on', 'off'].includes(opts.notifications)) throw new Error('--notifications must be on or off');
    settings.notifications.enabled = opts.notifications === 'on';
  }
  if (opts.notifyInterval !== undefined)
    settings.notifications.interval_ms = parseInterval(opts.notifyInterval);
  if (opts.noticeDetail !== undefined) {
    if (opts.noticeDetail !== 'counts' && opts.noticeDetail !== 'names')
      throw new Error('--notice-detail must be counts or names');
    settings.notifications.detail = opts.noticeDetail;
  }
  if (opts.updates !== undefined) {
    if (opts.updates !== 'off' && opts.updates !== 'notify' && opts.updates !== 'auto')
      throw new Error('--updates must be off, notify or auto');
    settings.updates.mode = opts.updates;
  }
  if (opts.updateCheckInterval !== undefined) {
    const ms = parseInterval(opts.updateCheckInterval);
    if (ms < 60_000)
      throw new Error('Update checks must be at least 1m apart; use --updates off to disable.');
    settings.updates.interval_ms = ms;
  }
  if (opts.language !== undefined) {
    if (!isLanguage(opts.language)) throw new Error('--language must be en or zh');
    writeLanguage(opts.language);
  }
  const feishuNote = opts.feishuWebhook === undefined ? null : await applyFeishu(opts);
  const watch = opts.feishuWatch === undefined ? null : await applyFeishuWatch(opts);
  const {
    language: _language,
    feishuWebhook: _f,
    feishuSecret: _s,
    feishuWatch: _w,
    profile: _p,
    ...hookOptions
  } = opts;
  if (Object.values(hookOptions).some((v) => v !== undefined)) writeHookSettings(settings);
  const language = readLanguage();
  const zh = language === 'zh';
  const every = zh ? formatInterval : formatIntervalEn;
  const interval = every(settings.notifications.interval_ms);
  const updateInterval = every(settings.updates.interval_ms);
  const n = settings.notifications;
  const u = settings.updates;
  out.result({ ...settings, language, ...(watch ? { feishu_watch: watch.view } : {}) }, () =>
    [
      ...(feishuNote ? [feishuNote] : []),
      ...(watch ? [watch.note] : []),
      zh ? '通知语言：中文' : 'Notice language: English (agentdrop settings --language zh for Chinese)',
      zh
        ? `Hook 通知：${n.enabled ? '开启' : '关闭'}；最短提醒间隔：${interval}`
        : `End-of-turn notices: ${n.enabled ? 'on' : 'off'}; minimum interval: ${interval}`,
      zh
        ? `信息粒度：${n.detail === 'counts' ? '消息标题与其他数量' : '消息标题、数量与简短名称'}`
        : `Detail: ${n.detail === 'counts' ? 'message titles and handles' : 'message titles, handles and short names'}`,
      zh
        ? `更新：${u.mode === 'auto' ? '自动更新（受支持的 npm 全局安装）' : u.mode === 'notify' ? '仅检查并提醒' : '关闭'}；检查间隔：${updateInterval}`
        : `Updates: ${u.mode === 'auto' ? 'install automatically (supported npm global installs)' : u.mode === 'notify' ? 'check and tell you' : 'off'}; check interval: ${updateInterval}`,
      zh
        ? '这是本机后备设置；已在网页保存偏好的设备优先使用网页设置。手动 pending 不受提醒间隔限制。'
        : 'These are this machine’s fallback settings; preferences saved in the dashboard take precedence. A manual `agentdrop pending` ignores the interval.',
    ].join('\n'),
  );
}

function profileFor(opts: SettingsOptions, what: string): string {
  const profiles = listProfiles();
  const profile = opts.profile ?? (profiles.length === 1 ? profiles[0]?.profile : undefined);
  if (!profile) throw new Error(`several profiles here: add --profile <name> to say whose ${what}`);
  return profile;
}

/**
 * `--feishu-watch a,b,c` replaces the watch terms that pick, out of what bots post in the person's Feishu groups, the
 * updates sent to them (ADR 0041); `show` prints them, `off` clears them. Terms are the person's own words: an agent
 * runs this only with terms the person gave.
 */
async function applyFeishuWatch(opts: SettingsOptions): Promise<{ view: FeishuWatchView; note: string }> {
  const { client } = clientFor(profileFor(opts, 'watch terms these are'));
  const zh = readLanguage() === 'zh';
  const raw = (opts.feishuWatch ?? '').trim();
  const view =
    raw === 'show'
      ? await client.feishuWatch()
      : await client.setFeishuWatch(
          raw === 'off'
            ? []
            : raw
                .split(/[,，、\n]/)
                .map((t) => t.trim())
                .filter((t) => t.length > 0),
        );
  const list = view.terms.join(zh ? '、' : ', ');
  const lines = [
    view.terms.length === 0
      ? zh
        ? '飞书动态关注词：无（不会收到群里机器人发的更新）。'
        : 'Feishu watch terms: none (no updates from bots in Feishu groups).'
      : zh
        ? `飞书动态关注词（${view.terms.length} 个）：${list}`
        : `Feishu watch terms (${view.terms.length}): ${list}`,
  ];
  if (view.terms.length > 0 && !view.available)
    lines.push(
      zh
        ? '这台服务器没有配置飞书应用，关注词暂时不会匹配到任何东西。'
        : 'This server has no Feishu app, so the terms match nothing for now.',
    );
  else if (view.terms.length > 0 && !view.linked)
    lines.push(
      zh
        ? '还没绑定飞书账号：在 AgentDrop 网页「设置 → 飞书」绑定后才会收到；还要把 AgentDrop 机器人拉进有更新的群。'
        : 'Feishu is not linked yet: link it in AgentDrop, Settings → Feishu, and add the AgentDrop bot to the groups with the updates.',
    );
  return { view, note: lines.join('\n') };
}

/**
 * `--feishu-webhook <address>` connects this account's notices to a Feishu group bot (the server sends a test
 * message first and refuses an address Feishu does not accept); `--feishu-webhook off` disconnects it. Needs the
 * profile whose account it is; with a single profile on this machine it is picked automatically.
 */
async function applyFeishu(opts: SettingsOptions): Promise<string> {
  const { client } = clientFor(profileFor(opts, 'notices go to Feishu'));
  const zh = readLanguage() === 'zh';
  if (opts.feishuWebhook === 'off') {
    await client.disconnectFeishu();
    return zh ? '飞书通知已断开。' : 'Feishu notices disconnected.';
  }
  const status = await client.connectFeishu({
    url: opts.feishuWebhook ?? '',
    ...(opts.feishuSecret ? { secret: opts.feishuSecret } : {}),
    language: readLanguage(),
  });
  return zh
    ? `飞书通知已连接（机器人地址 ${status.url_hint}${status.has_secret ? '，已启用签名' : ''}），已发一条测试消息到群里。`
    : `Feishu notices connected (bot address ${status.url_hint}${status.has_secret ? ', signature on' : ''}); a test message was sent to the chat.`;
}
