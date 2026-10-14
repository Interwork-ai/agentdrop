import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AUTORUN_DEFAULTS,
  type AutorunConfig,
  claimNewDrops,
  clearAutorunState,
  MAX_INSTRUCTIONS_CHARS,
  readAutorunConfig,
  writeAutorunConfig,
} from '../autorun.js';
import { readLanguage } from '../locale.js';
import type { Output } from '../output.js';
import { readProfile } from '../store.js';

/** Everything printed here is read by a person: English, or Chinese after `agentdrop settings --language zh`. */
type Tr = (en: string, zh: string) => string;
function translator(): Tr {
  const zh = readLanguage() === 'zh';
  return (en, zhText) => (zh ? zhText : en);
}

export interface AutorunOnOptions {
  profile: string;
  from?: string[];
  interval?: number;
  cooldown?: number;
  maxPerHour?: number;
  instructions?: string;
  thread?: string;
}

/** Where each harness picks the setting up; printed by `on` and `status`. */
export function autorunStartHint(harness: string, profile: string): string {
  const t = translator();
  switch (harness) {
    case 'claude-code':
      return t(
        'Restart the Claude Code session with: claude --dangerously-load-development-channels server:agentdrop (the first start asks once to confirm the development channel). A session started without it receives nothing and takes no messages.',
        '重启 Claude Code 会话并带上：claude --dangerously-load-development-channels server:agentdrop（首次会弹一次开发频道确认）。不带这个参数启动的会话不会收到，也不会占用消息。',
      );
    case 'codex':
      return t(
        'Restart the Codex session and send one message in it so the hook records the current thread; new messages are then queued into that thread with codex queue and start when it is idle.',
        '重启 Codex 会话，并在会话里发一条消息，让 hook 记下当前 thread；之后新消息会用 codex queue 排进这个 thread，空闲时自动开始。',
      );
    case 'opencode':
      return t(
        `Run agentdrop connect opencode --profile ${profile} to regenerate the plugin, then restart opencode; new messages are queued into the most recently active idle session.`,
        `运行 agentdrop connect opencode --profile ${profile} 重新生成插件，然后重启 opencode；新消息会排进最近活跃且空闲的会话。`,
      );
    default:
      return t(
        'This client does not support autorun (codex, claude-code and opencode do).',
        '这个 harness 不支持 autorun（支持 codex、claude-code、opencode）。',
      );
  }
}

export function autorunOnCommand(out: Output, opts: AutorunOnOptions): void {
  const profile = readProfile(opts.profile);
  if (!profile) throw new Error(`profile "${opts.profile}" not found (agentdrop endpoint list)`);
  if (!['codex', 'claude-code', 'opencode'].includes(profile.harness))
    throw new Error('autorun supports codex, claude-code and opencode profiles');
  if (opts.thread && profile.harness !== 'codex') throw new Error('--thread only applies to a codex profile');
  const previous = readAutorunConfig(opts.profile);
  const config: AutorunConfig = {
    enabled: true,
    from: opts.from ?? previous.from,
    interval_s: opts.interval ?? previous.interval_s,
    cooldown_s: opts.cooldown ?? previous.cooldown_s,
    max_per_hour: opts.maxPerHour ?? previous.max_per_hour,
    instructions: opts.instructions
      ? readFileSync(resolve(opts.instructions), 'utf8').trim().slice(0, MAX_INSTRUCTIONS_CHARS) || null
      : previous.instructions,
    thread: opts.thread ?? previous.thread,
  };
  writeAutorunConfig(opts.profile, config);
  // A fresh start: the first poll records what is already unread instead of delivering it.
  clearAutorunState(opts.profile);
  const t = translator();
  out.result({ profile: opts.profile, harness: profile.harness, ...config }, () =>
    [
      t(
        `autorun is on (${opts.profile}, ${profile.harness}).`,
        `autorun 已开启（${opts.profile}，${profile.harness}）。`,
      ),
      autorunStartHint(profile.harness, opts.profile),
    ].join('\n'),
  );
}

export function autorunOffCommand(out: Output, opts: { profile: string }): void {
  const config = { ...readAutorunConfig(opts.profile), enabled: false };
  writeAutorunConfig(opts.profile, config);
  const t = translator();
  out.result({ profile: opts.profile, ...config }, () =>
    t(`autorun is off (${opts.profile}).`, `autorun 已关闭（${opts.profile}）。`),
  );
}

export function autorunStatusCommand(out: Output, opts: { profile: string }): void {
  const profile = readProfile(opts.profile);
  const config = readAutorunConfig(opts.profile);
  const t = translator();
  out.result({ profile: opts.profile, harness: profile?.harness ?? null, ...config }, () =>
    [
      t(
        `autorun: ${config.enabled ? 'on' : 'off'} (${opts.profile}${profile ? `, ${profile.harness}` : ''})`,
        `autorun：${config.enabled ? '开启' : '关闭'}（${opts.profile}${profile ? `，${profile.harness}` : ''}）`,
      ),
      t(
        `Senders: ${config.from.length ? config.from.join(', ') : 'any accepted contact'}`,
        `发件人限制：${config.from.length ? config.from.join(', ') : '任何已接受的联系人'}`,
      ),
      t(
        `Checks every ${config.interval_s}s; at least ${config.cooldown_s}s between deliveries; at most ${config.max_per_hour} per hour`,
        `轮询 ${config.interval_s}s；两次投递至少间隔 ${config.cooldown_s}s；每小时最多 ${config.max_per_hour} 次`,
      ),
      t(
        `Custom instructions: ${config.instructions ? `${config.instructions.length} characters` : 'none'}`,
        `自定义说明：${config.instructions ? `${config.instructions.length} 字` : '无'}`,
      ),
      ...(config.thread
        ? [t(`Pinned Codex thread: ${config.thread}`, `固定 Codex thread：${config.thread}`)]
        : []),
      ...(config.enabled && profile ? [autorunStartHint(profile.harness, opts.profile)] : []),
    ].join('\n'),
  );
}

/**
 * For the opencode plugin, which delivers in-process. `--probe` only reports the config, so the plugin can stay
 * idle when autorun is off and never claims drops while it has no idle session to put them in. Always prints one
 * JSON line and never fails loudly.
 */
export async function autorunPollCommand(opts: { profile: string; probe: boolean }): Promise<void> {
  const config = readAutorunConfig(opts.profile);
  const base = { enabled: config.enabled, interval_s: config.interval_s ?? AUTORUN_DEFAULTS.interval_s };
  let prompt: string | null = null;
  if (config.enabled && !opts.probe) {
    try {
      prompt = (await claimNewDrops(opts.profile))?.prompt ?? null;
    } catch {
      prompt = null;
    }
  }
  process.stdout.write(`${JSON.stringify(prompt ? { ...base, prompt } : base)}\n`);
}
