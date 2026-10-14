import { readLanguage } from '../locale.js';
import type { Output } from '../output.js';
import { readProfile } from '../store.js';
import { clientFor, personAtTerminal } from './mail.js';
import { askTerminal } from './setup.js';

/**
 * `agentdrop account recover`: back into the web account from a computer with a paired agent (ADR 0036). The
 * agent's credential proves the account; the person proves they are at the keyboard. It runs only when typed at an
 * interactive terminal outside an agent's shell and only after the person types their own handle, so an agent that
 * can run commands cannot use it to take the account. There is no MCP tool for it.
 */
export async function accountRecoverCommand(
  out: Output,
  opts: { profile: string },
  deps: {
    terminal?: boolean;
    ask?: (question: string) => Promise<string | null>;
  } = {},
): Promise<void> {
  const zh = readLanguage() === 'zh';
  const t = (en: string, cn: string) => (zh ? cn : en);
  const terminal = deps.terminal ?? personAtTerminal();
  if (!terminal)
    throw new Error(
      t(
        'agentdrop account recover only runs when you type it yourself in a terminal; an agent cannot run it for you.',
        'agentdrop account recover 只能由你自己在终端里输入运行，Agent 不能替你运行。',
      ),
    );
  const profile = readProfile(opts.profile);
  const { client } = clientFor(opts.profile);
  const handle = profile?.handle ?? '';
  const server = profile?.server_url ?? '';
  const ask = deps.ask ?? askTerminal;
  const answer = await ask(
    t(
      `This makes a one-time link that sets a new web password for @${handle} on ${server}.\nType your handle to continue: `,
      `这会生成一个一次性链接，用来为 ${server} 上的 @${handle} 设置新的网页密码。\n输入你的 handle 继续：`,
    ),
  );
  const typed = (answer ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!handle || typed !== handle.toLowerCase())
    throw new Error(
      t('That is not your handle; nothing was changed.', '这不是你的 handle，没有做任何改动。'),
    );
  const link = await client.accountRecoveryLink();
  out.result(link, () =>
    [
      t('Open this link in your browser to set a new password:', '在浏览器里打开这个链接设置新密码：'),
      `  ${link.url}`,
      t(
        'It works once, within 1 hour. Saving the new password signs out web sessions on all devices; your agents keep working.',
        '链接 1 小时内有效、只能用一次。保存新密码后，所有设备上的网页登录都会退出，Agent 不受影响。',
      ),
      t(
        'If you did not ask for this, ignore the link: the password stays as it is.',
        '如果不是你自己要的，不用理会这个链接，密码不会改变。',
      ),
    ].join('\n'),
  );
}
