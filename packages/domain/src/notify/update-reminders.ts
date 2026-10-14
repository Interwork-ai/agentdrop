import { appUsers, connections, devices, harnessEndpoints, type Tx } from '@agentdrop/db';
import { eq, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import { getSystemAssistant } from '../identity/system-assistant.js';
import { SYSTEM_DROP_TTL_MS, sendDrop } from '../mailbox/send.js';

/** `0.5.1` → [0, 5, 1]; anything else (a test build, a missing value) is not compared. */
export function parseRelease(value: string | null | undefined): [number, number, number] | null {
  const m = typeof value === 'string' ? /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isOlderRelease(version: string | null | undefined, latest: string): boolean {
  const a = parseRelease(version);
  const b = parseRelease(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

export interface UpdateReminderOptions {
  /** The CLI release this server recommends (the one it ships). */
  latest: string;
  /**
   * Waits between reminders for the same release, in order; the last one repeats. [1, 3, 7] days: a reminder when
   * the gap is first seen, the next a day later, then three days later, then every seven days.
   */
  scheduleMs: number[];
  /** Only agents that connected within this window count: a machine nobody uses is not worth a reminder. */
  activeWithinMs: number;
  now?: Date;
}

/**
 * Tells people whose agents run an older CLI, with a drop from the built-in @agentdrop assistant: it reaches the
 * dashboard inbox, end-of-turn notices, browser push and Feishu like any direct message, on every harness. One
 * reminder when the gap is first seen, then after each wait in `scheduleMs` while an active agent is still behind;
 * nothing once all are current; a newer release starts the schedule over. Devices whose update checks were turned off in the dashboard are left alone.
 */
export async function sendUpdateReminders(tx: Tx, opts: UpdateReminderOptions): Promise<number> {
  if (!parseRelease(opts.latest) || opts.scheduleMs.length === 0) return 0;
  const now = opts.now ?? new Date();
  const assistant = await getSystemAssistant(tx);
  if (!assistant) return 0;
  const since = new Date(now.getTime() - opts.activeWithinMs);
  // the newest version each live agent reported through its MCP bridge within the window
  const rows = await tx.execute<{
    user_id: string;
    h_label: string;
    harness_key: string;
    device_label: string;
    update_mode: string | null;
    version: string;
  }>(sql`
    select distinct on (h.id) h.user_id, h.label as h_label, h.harness_key, d.label as device_label,
           d.client_preferences #>> '{settings,updates,mode}' as update_mode, c.bridge_version as version
    from ${connections} c
    join ${harnessEndpoints} h on h.id = c.h_id and h.revoked_at is null
    join ${devices} d on d.id = h.device_id and d.revoked_at is null
    join ${appUsers} u on u.id = h.user_id
    where c.last_seen_at >= ${since} and u.is_system = false and u.deleted_at is null and u.suspended_at is null
    order by h.id, c.last_seen_at desc`);
  const behind = new Map<string, Array<{ label: string; where: string; version: string }>>();
  for (const r of rows.rows) {
    if (r.update_mode === 'off' || !isOlderRelease(r.version, opts.latest)) continue;
    const list = behind.get(r.user_id) ?? [];
    list.push({ label: r.h_label, where: `${r.device_label} · ${r.harness_key}`, version: r.version });
    behind.set(r.user_id, list);
  }
  let sent = 0;
  for (const [userId, agents] of [...behind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [user] = await tx.select().from(appUsers).where(eq(appUsers.id, userId)).for('update');
    const last = user?.updateReminder;
    // how many reminders this release has had (records from before the count existed count as one)
    const count = last && last.version === opts.latest ? (last.count ?? 1) : 0;
    const wait = opts.scheduleMs[Math.min(Math.max(count - 1, 0), opts.scheduleMs.length - 1)] ?? 0;
    if (last && count > 0 && now.getTime() - new Date(last.sent_at).getTime() < wait) continue;
    const lines = agents
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((a) => `- ${a.label}（${a.where}）：${a.version}`);
    const linesEn = agents.map((a) => `- ${a.label} (${a.where}): ${a.version}`);
    const days = opts.scheduleMs.map((ms) => Math.round(ms / 86_400_000));
    const repeatZh =
      days.length > 1
        ? `会在 ${days.slice(0, -1).join('、')} 天后再提醒，之后每 ${days.at(-1)} 天一次`
        : `每 ${days[0]} 天提醒一次`;
    const repeatEn =
      days.length > 1
        ? `again after ${days.slice(0, -1).join(', ')} day(s), then every ${days.at(-1)} days`
        : `every ${days[0]} days`;
    const body = [
      `你有 Agent 用的 AgentDrop CLI 不是最新版（最新 ${opts.latest}）：`,
      ...lines,
      '',
      '在那台电脑的终端运行：npm install -g agentdrop-cli@latest',
      '然后重启对应的 Codex / Claude Code / opencode / Cursor。',
      `全部升级后不会再提醒；还没升级的，${repeatZh}。不想收到：在网页「设置 → Agent 客户端」把那台设备的更新方式设为「关闭更新检查」。`,
      '',
      `Some of your agents run an older AgentDrop CLI (latest ${opts.latest}):`,
      ...linesEn,
      '',
      'On that computer run: npm install -g agentdrop-cli@latest, then restart the client.',
      `No more reminders once all are current; otherwise ${repeatEn}. To stop them, set that device's updates to "off" in Settings → Agent clients.`,
    ].join('\n');
    const sentAt = now.toISOString();
    try {
      // savepoint: a person who removed or blocked the assistant simply gets no reminder
      await tx.transaction((sp) =>
        sendDrop(
          sp,
          { userId: assistant.userId, hId: assistant.hId, via: 'user_session' },
          {
            request_id: `update:${opts.latest}:${userId}:${sentAt.slice(0, 10)}`,
            targets: [{ type: 'user', user_id: userId }],
            payload: {
              payload_version: 1,
              kind: 'text',
              title: `AgentDrop CLI 可升级到 ${opts.latest} · update available`,
              body,
              attachment_ids: [],
              extensions: {},
              expires_at: new Date(now.getTime() + SYSTEM_DROP_TTL_MS).toISOString(),
            },
          },
          { originKind: 'web', maxGroupRecipients: 1 },
        ),
      );
      sent += 1;
    } catch {
      /* not a contact of the assistant any more: recorded below so it is not retried every sweep */
    }
    await tx
      .update(appUsers)
      .set({ updateReminder: { version: opts.latest, sent_at: sentAt, count: count + 1 } })
      .where(eq(appUsers.id, userId));
    await recordAudit(tx, {
      actorUserId: assistant.userId,
      action: 'cli.update_reminder',
      targetId: userId,
      result: 'ok',
      meta: { latest: opts.latest, agents: agents.length },
    });
  }
  return sent;
}
