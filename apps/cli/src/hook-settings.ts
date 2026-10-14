import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ClientSettings, clientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from '@agentdrop/contracts';
import { z } from 'zod';
import { configDir } from './paths.js';
import { writePrivateFile } from './store.js';

const MAX_INTERVAL = 30 * 24 * 60 * 60 * 1000;
const notifications = clientSettingsSchema.shape.notifications;
const updates = clientSettingsSchema.shape.updates;
const notificationSchema = notifications.extend({
  enabled: notifications.shape.enabled.default(DEFAULT_CLIENT_SETTINGS.notifications.enabled),
  interval_ms: notifications.shape.interval_ms.default(DEFAULT_CLIENT_SETTINGS.notifications.interval_ms),
  detail: notifications.shape.detail.default(DEFAULT_CLIENT_SETTINGS.notifications.detail),
});
const updateSchema = updates.extend({
  mode: updates.shape.mode.default(DEFAULT_CLIENT_SETTINGS.updates.mode),
  interval_ms: updates.shape.interval_ms.default(DEFAULT_CLIENT_SETTINGS.updates.interval_ms),
});
export const hookSettingsSchema = z
  .object({
    notifications: notificationSchema.default(() => ({ ...DEFAULT_CLIENT_SETTINGS.notifications })),
    updates: updateSchema.default(() => ({ ...DEFAULT_CLIENT_SETTINGS.updates })),
  })
  .strict();
export type NotificationSettings = ClientSettings['notifications'];
export type UpdateSettings = ClientSettings['updates'];
export type HookSettings = ClientSettings;

export function hookSettingsPath(): string {
  return join(configDir(), 'settings.json');
}
export function readHookSettings(): HookSettings {
  if (!existsSync(hookSettingsPath())) return hookSettingsSchema.parse({});
  try {
    return hookSettingsSchema.parse(JSON.parse(readFileSync(hookSettingsPath(), 'utf8')));
  } catch {
    throw new Error('Invalid AgentDrop settings.json; fix the local settings file before continuing.');
  }
}
export function writeHookSettings(settings: HookSettings): void {
  const validated = hookSettingsSchema.parse(settings);
  writePrivateFile(hookSettingsPath(), `${JSON.stringify(validated, null, 2)}\n`);
}

/** Deliberately small syntax, with units; zero means every hook for notifications only. */
export function parseInterval(raw: string): number {
  if (raw === '0') return 0;
  const match = /^(\d+)(m|h|d)$/.exec(raw);
  if (!match) throw new Error('Use an interval such as 30m, 2h, 1d, or 0 (notifications only).');
  const scale = match[2] === 'd' ? 86_400_000 : match[2] === 'h' ? 3_600_000 : 60_000;
  const ms = Number(match[1]) * scale;
  if (!Number.isSafeInteger(ms) || ms > MAX_INTERVAL) throw new Error('Interval must be between 0 and 30d.');
  return ms;
}
export function formatInterval(ms: number): string {
  if (ms === 0) return '每次触发';
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} 天`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  return `${ms / 60_000} 分钟`;
}
