import { Bot } from 'lucide-react';
import { NavLink } from 'react-router';
import { useT } from '../lib/lang.js';
import { CodeBlock } from './primitives.jsx';

/** The two setup commands for this server, the same everywhere the dashboard shows them. */
export function setupCommands(): string {
  return `npm install -g agentdrop-cli@latest\nagentdrop setup --server ${window.location.origin}`;
}

/**
 * Shown at the top of every page until the first agent is paired. Without one nobody can reach the person and
 * they cannot send, join a group or mention anyone, so it says that first and then gives the one step to take.
 */
export function PairAgentBanner() {
  const t = useT();
  return (
    <section
      aria-label={t('Pair an agent', '配对 Agent')}
      className="shrink-0 border-b border-accent/25 bg-accent/8 px-4 py-3 md:px-6"
    >
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:gap-6">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <Bot aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-accent-fg" />
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-semibold text-fg">
              {t('Pair an agent to start using AgentDrop', '先配对一个 Agent，才能开始使用 AgentDrop')}
            </p>
            <p className="text-xs leading-5 text-fg-2">
              {t(
                'Until then nobody can send to you, and you cannot send, join a group or mention anyone. Run this in a terminal on your computer (Node.js 22+), then confirm in the page it opens; it takes about a minute.',
                '配对之前，别人发不到你这里，你也不能发消息、加入群或 @ 别人。在你电脑的终端里运行下面的命令（需要 Node.js 22+），再在它打开的网页里确认即可，大约一分钟。',
              )}{' '}
              <NavLink
                to="/app/agents"
                className="font-medium text-accent-fg underline underline-offset-2 hover:decoration-2"
              >
                {t('Step-by-step guide →', '详细步骤 →')}
              </NavLink>
            </p>
          </div>
        </div>
        <div className="min-w-0 xl:w-[440px] xl:shrink-0">
          <CodeBlock code={setupCommands()} />
        </div>
      </div>
    </section>
  );
}

/**
 * Next to an action that needs an agent (join, create, send): why this action is unavailable and where to fix it,
 * instead of a button that silently does nothing. The page's top banner (`PairAgentBanner`) already gives the setup
 * command and the general consequences, so this note names only what this one action needs, in one line.
 */
export function NeedsAgentNote({ what }: { what: 'join' | 'create' | 'send' | 'contacts' }) {
  const t = useT();
  const reason =
    what === 'contacts'
      ? t(
          'Pair an agent first: until then you cannot add contacts or accept requests, because nothing could be delivered to you.',
          '请先配对一个 Agent：配对之前不能加联系人或接受申请，因为消息无处投递给你。',
        )
      : what === 'join'
        ? t(
            'Pair an agent first to join: the invitation stays open until then.',
            '先配对一个 Agent 才能加入：邀请会一直保留。',
          )
        : what === 'create'
          ? t(
              'Pair an agent first to create a group: its messages need somewhere to reach you.',
              '先配对一个 Agent 才能建群：群消息需要有地方送到你这里。',
            )
          : t(
              'Pair an agent first to send: messages go out from one of your agents.',
              '先配对一个 Agent 才能发送：消息要从你的某个 Agent 发出。',
            );
  return (
    <p
      className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs leading-5 text-fg-2"
      role="note"
    >
      {reason}{' '}
      <NavLink
        to="/app/agents"
        className="font-medium text-accent-fg underline underline-offset-2 hover:decoration-2"
      >
        {t('Setup steps →', '配对步骤 →')}
      </NavLink>
    </p>
  );
}
