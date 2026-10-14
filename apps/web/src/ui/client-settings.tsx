import type {
  ClientSettings as Settings,
  DeviceClientSettings as SettingsResponse,
} from '@agentdrop/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Monitor, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ApiFailure, api } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { useT } from '../lib/lang.js';
import { useSession } from '../lib/session.js';
import { Chip, Panel } from './layout.jsx';
import { Button, ErrorBox, Field, Input, Loading } from './primitives.jsx';
import { SettingsSwitch, settingsSelectClass, TitleWithChip } from './settings-controls.jsx';

export function ClientSettings() {
  const { me, currentH } = useSession();
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const devices = [
    ...new Map(
      (me?.endpoints ?? [])
        .filter((e) => !e.revoked_at && !e.device.revoked)
        .map((e) => [e.device.device_id, e.device]),
    ).values(),
  ];
  // when two devices share a name, the time the first agent there was paired tells them apart
  const pairedAt = (deviceId: string) =>
    (me?.endpoints ?? [])
      .filter((e) => e.device.device_id === deviceId)
      .map((e) => e.created_at)
      .sort()[0];
  const sameName = (label: string) => devices.filter((d) => d.label === label).length > 1;
  const preferred = selected ?? currentH?.device.device_id;
  const device = devices.find((d) => d.device_id === preferred) ?? devices[0];
  return (
    <Panel
      id="client-settings"
      icon={<Monitor size={16} />}
      title={
        <TitleWithChip chip={<Chip tone="ok">{t('Reminders on by default', '提醒默认开启')}</Chip>}>
          {t('Reminders and updates', '提醒与更新')}
        </TitleWithChip>
      }
      description={t(
        'End-of-turn reminders and CLI updates, per device; all agents on a device share them.',
        '按设备设置回合结束提醒和 CLI 更新；同一设备上的 Agent 共用。',
      )}
    >
      {!device ? (
        <div className="rounded-lg border border-dashed border-line-strong px-4 py-3 text-sm text-muted">
          {t(
            'Pair an agent first, then set up the device it runs on.',
            '先配对一个 Agent，再设置运行它的设备。',
          )}
          <Link
            to="/app/agents"
            className="ml-1 text-accent-fg underline underline-offset-2 hover:decoration-2"
          >
            {t('Pair an agent', '去配对 Agent')}
          </Link>
        </div>
      ) : (
        <>
          <Field label={t('Device running the agent', '运行 Agent 的设备')}>
            <select
              className={settingsSelectClass}
              value={device.device_id}
              onChange={(e) => setSelected(e.target.value)}
            >
              {devices.map((d) => (
                <option key={d.device_id} value={d.device_id}>
                  {d.label}
                  {platformName(d.platform) ? ` · ${platformName(d.platform)}` : ''}
                  {sameName(d.label) && pairedAt(d.device_id)
                    ? ` · ${formatDateTime(pairedAt(d.device_id) ?? '')}`
                    : ''}
                </option>
              ))}
            </select>
          </Field>
          <DeviceSettings key={device.device_id} deviceId={device.device_id} />
        </>
      )}
    </Panel>
  );
}

function IntervalControl({
  value,
  onChange,
  notification,
}: {
  value: number;
  onChange: (value: number) => void;
  notification?: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const t = useT();
  const presets: Array<[number, string]> = notification
    ? [
        [0, t('Every time (default)', '每次触发（默认）')],
        [30, t('30 minutes', '30 分钟')],
        [60, t('1 hour', '1 小时')],
        [360, t('6 hours', '6 小时')],
        [1440, t('24 hours', '24 小时')],
      ]
    : [
        [120, t('2 hours', '2 小时')],
        [360, t('6 hours', '6 小时')],
        [1440, t('24 hours', '24 小时')],
        [2880, t('2 days (default)', '2 天（默认）')],
      ];
  const isCustom = custom || !presets.some(([minutes]) => minutes * 60000 === value);
  return (
    <div className="space-y-2">
      <select
        aria-label={
          notification ? t('Reminder interval', '提醒间隔') : t('Update check interval', '更新检查间隔')
        }
        className={settingsSelectClass}
        value={isCustom ? 'custom' : value / 60000}
        onChange={(e) => {
          setCustom(e.target.value === 'custom');
          if (e.target.value !== 'custom') onChange(Number(e.target.value) * 60000);
        }}
      >
        {presets.map(([minutes, label]) => (
          <option key={minutes} value={minutes}>
            {label}
          </option>
        ))}
        <option value="custom">{t('Custom minutes', '自定义分钟数')}</option>
      </select>
      {isCustom ? (
        <Input
          aria-label={
            notification
              ? t('Custom reminder minutes', '自定义提醒分钟数')
              : t('Custom update check minutes', '自定义更新检查分钟数')
          }
          type="number"
          min={notification ? 0 : 1}
          step={1}
          value={Number.isFinite(value) ? value / 60000 : ''}
          onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value) * 60000)}
        />
      ) : null}
    </div>
  );
}

function DeviceSettings({ deviceId }: { deviceId: string }) {
  const qc = useQueryClient();
  const t = useT();
  const queryKey = ['client-settings', deviceId];
  const url = `/v1/me/devices/${encodeURIComponent(deviceId)}/client-settings`;
  const query = useQuery({ queryKey, queryFn: () => api.get<SettingsResponse>(url), refetchInterval: 15000 });
  const [draft, setDraft] = useState<{ settings: Settings; version: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const save = useMutation({
    mutationFn: (value: { settings: Settings; version: number }) =>
      api.put<SettingsResponse>(url, { expected_version: value.version, settings: value.settings }),
    onSuccess: (response) => {
      qc.setQueryData(queryKey, response);
      setDraft(null);
    },
  });
  const data = query.data;
  if (!data)
    return query.isError ? <ErrorBox error={query.error} retry={() => query.refetch()} /> : <Loading />;
  const settings = draft?.settings ?? data.settings;
  const edit = (next: Settings) => setDraft({ settings: next, version: draft?.version ?? data.version });
  const intervalValid = (n: number, minimum: number) =>
    Number.isSafeInteger(n) && n >= minimum && n <= 2592000000;
  const valid =
    intervalValid(settings.notifications.interval_ms, 0) &&
    intervalValid(settings.updates.interval_ms, 60000);
  const conflict = save.error instanceof ApiFailure && save.error.status === 409;
  const applied = data.applied;
  const appliedError = applied?.version === data.version ? applied.error : null;
  const appliedCurrent = applied?.version === data.version && !appliedError && data.version > 0;
  const status =
    data.version === 0
      ? t(
          'Using the defaults; saving starts syncing them to this device.',
          '正在使用默认设置；保存后开始同步到这台设备。',
        )
      : appliedError === 'SKILL_SYNC_FAILED'
        ? t(
            'The client could not sync the skill: check the local directory permissions and run the CLI again.',
            '客户端未能同步 Skill：请检查本机目录权限后再运行 CLI。',
          )
        : appliedError === 'LOCAL_OVERRIDE'
          ? t(
              'This device is using local override flags; remove them and sync again.',
              '这台设备在用本机参数覆盖；移除后再同步。',
            )
          : appliedCurrent
            ? t('Applied by the client on this device.', '这台设备上的客户端已应用。')
            : t(
                'Saved; applied the next time an agent on this device runs.',
                '已保存；这台设备上的 Agent 下次运行时应用。',
              );
  const reported = applied
    ? `${t('Reported version', '回报版本')} ${applied.version} · CLI ${applied.installed_cli_version ?? applied.cli_version} · Skill ${applied.skill_version ?? '-'} · ${formatDateTime(applied.synced_at)}`
    : undefined;
  return (
    <div className="space-y-4">
      <p className={`text-xs ${appliedError ? 'text-warn' : 'text-dim'}`} title={reported} aria-live="polite">
        {status}
      </p>
      <fieldset disabled={save.isPending || refreshing} className="space-y-5 disabled:opacity-60">
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Bell size={14} className="text-muted" aria-hidden="true" />{' '}
            {t('End-of-turn reminders', '回合结束提醒')}
          </div>
          <SettingsSwitch
            checked={settings.notifications.enabled}
            onChange={(enabled) =>
              edit({ ...settings, notifications: { ...settings.notifications, enabled } })
            }
            title={t('Remind me at the end of a turn', '回合结束时提醒')}
            description={t(
              'Codex / Claude Code mention new messages and requests when a turn ends.',
              'Codex / Claude Code 在回合结束时提一下新消息和申请。',
            )}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('Reminder interval', '提醒间隔')}
              hint={t('A longer interval batches notices.', '间隔设长会把提醒攒到一起。')}
            >
              <IntervalControl
                notification
                value={settings.notifications.interval_ms}
                onChange={(interval_ms) =>
                  edit({ ...settings, notifications: { ...settings.notifications, interval_ms } })
                }
              />
            </Field>
            <Field label={t('Reminder content', '提醒内容')}>
              <select
                className={settingsSelectClass}
                value={settings.notifications.detail}
                onChange={(e) =>
                  edit({
                    ...settings,
                    notifications: {
                      ...settings.notifications,
                      detail: e.target.value as Settings['notifications']['detail'],
                    },
                  })
                }
              >
                <option value="counts">
                  {t('Message titles and other counts (default)', '消息标题与其他数量（默认）')}
                </option>
                <option value="names">
                  {t('Message titles, counts and related names', '消息标题、数量与相关名称')}
                </option>
              </select>
            </Field>
          </div>
        </div>
        <div className="space-y-3 border-t border-line pt-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <RefreshCw size={14} className="text-muted" aria-hidden="true" /> {t('Updates', '更新')}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('Update mode', '更新方式')}
              hint={t('Automatic install needs a global npm install.', '自动安装需要 npm 全局安装。')}
            >
              <select
                className={settingsSelectClass}
                value={settings.updates.mode}
                onChange={(e) =>
                  edit({
                    ...settings,
                    updates: { ...settings.updates, mode: e.target.value as Settings['updates']['mode'] },
                  })
                }
              >
                <option value="off">{t('No update checks', '关闭更新检查')}</option>
                <option value="notify">{t('Check and notify', '检查并提醒')}</option>
                <option value="auto">
                  {t('Check and install automatically (default)', '检查并自动安装（默认）')}
                </option>
              </select>
            </Field>
            <Field label={t('Update check interval', '更新检查间隔')}>
              <IntervalControl
                value={settings.updates.interval_ms}
                onChange={(interval_ms) =>
                  edit({ ...settings, updates: { ...settings.updates, interval_ms } })
                }
              />
            </Field>
          </div>
        </div>
        {!valid ? (
          <p role="alert" className="text-xs text-warn">
            {t(
              'Enter a valid number of minutes: the reminder interval can be 0, the update check interval must be at least 1 minute, and neither can exceed 30 days.',
              '请输入有效分钟数；提醒间隔可为 0，更新检查间隔至少 1 分钟，均不能超过 30 天。',
            )}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
          <span className="text-xs text-dim">
            {draft
              ? t('Unsaved changes', '有未保存的修改')
              : t('Applies to every agent on this device.', '对这台设备上的所有 Agent 生效。')}
          </span>
          <Button
            variant={draft ? 'primary' : 'default'}
            disabled={(!draft && data.version > 0) || !valid || save.isPending || conflict}
            onClick={() => save.mutate(draft ?? { settings, version: data.version })}
          >
            {save.isPending ? t('Saving…', '正在保存…') : t('Save', '保存')}
          </Button>
        </div>
      </fieldset>
      {conflict ? (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn"
        >
          <p>
            {t(
              'Another client updated these settings. Your changes are still here; review them before loading the latest settings, which discards your changes.',
              '其他客户端已更新这份设置。你的修改仍保留，请先核对，再加载最新配置；加载将放弃当前修改。',
            )}
          </p>
          <Button
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              const result = await query.refetch();
              if (!result.isError) {
                setDraft(null);
                save.reset();
              }
              setRefreshing(false);
            }}
          >
            {t('Discard changes and load latest', '放弃修改并加载最新配置')}
          </Button>
        </div>
      ) : save.isError ? (
        <ErrorBox error={save.error} />
      ) : null}
      {query.isError && data ? <ErrorBox error={query.error} retry={() => query.refetch()} /> : null}
    </div>
  );
}

/** Friendly name of a device platform as the CLI reports it; unknown values are not shown. */
export function platformName(platform: string | null): string | null {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  if (platform === 'win32') return 'Windows';
  return null;
}
