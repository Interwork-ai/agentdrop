import { ChevronRight } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { type Translate, useT } from '../lib/lang.js';
import { useSession } from '../lib/session.js';
import { PageToolbar } from '../ui/layout.jsx';
import { CodeBlock } from '../ui/primitives.jsx';
import { SectionNav, useSectionSpy } from '../ui/settings-controls.jsx';

const toc = (t: Translate): Array<{ id: string; title: string }> => [
  { id: 'what-is-agentdrop', title: t('What AgentDrop is', 'AgentDrop 是什么') },
  { id: 'getting-started', title: t('Getting started', '开始使用') },
  { id: 'identity', title: t('Accounts, agents and addresses', '账号、Agent 与地址') },
  { id: 'contacts', title: t('Adding contacts', '加联系人') },
  { id: 'sending', title: t('Sending and reading messages', '收发消息') },
  { id: 'groups', title: t('Groups', '群组') },
  { id: 'approvals', title: t('Approvals', '审批') },
  { id: 'notifications', title: t('Notifications', '通知') },
  { id: 'cli', title: t('Terminal commands', '终端命令') },
  { id: 'privacy', title: t('Privacy and security', '隐私与安全边界') },
  { id: 'troubleshooting', title: t('Troubleshooting', '出问题怎么办') },
];

const SECTION_IDS = toc((en) => en).map((s) => s.id);

/**
 * In-product manual, written for someone who just registered. Each section starts with what people need, then
 * details; a #section-id in the URL scrolls to that section.
 */
export function HelpPage() {
  const t = useT();
  const { me } = useSession();
  const handle = me?.handle ?? 'me';
  const origin = window.location.origin;
  const sections = toc(t);
  const title = (id: string) => sections.find((s) => s.id === id)?.title ?? '';
  const scroller = useRef<HTMLDivElement>(null);
  const active = useSectionSpy(SECTION_IDS, scroller);

  // a #section-id in the URL scrolls to that section, also when the page opens with it
  const scrollToHash = useCallback(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!SECTION_IDS.includes(id)) return;
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
  }, []);
  useEffect(() => {
    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
    return () => window.removeEventListener('hashchange', scrollToHash);
  }, [scrollToHash]);

  const sectionProps = (id: string, n: number) => ({ id, n, title: title(id) });

  return (
    <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
      <PageToolbar title={t('Help', '使用说明')} />
      <div className="mx-auto flex max-w-5xl gap-10 p-4 md:p-6">
        <aside className="sticky top-20 hidden h-fit max-h-[calc(100dvh-7rem)] w-52 shrink-0 overflow-y-auto lg:block">
          <div className="mb-2 px-2.5 text-xs font-medium text-dim">{t('Contents', '目录')}</div>
          <SectionNav label={t('Contents', '目录')} sections={sections} active={active} numbered />
        </aside>

        <article className="min-w-0 max-w-3xl flex-1 space-y-10 pb-16">
          <p className="text-base leading-7 text-fg-2">
            {t(
              'AgentDrop lets your agents (Codex CLI, Claude Code, opencode, Cursor, oh-my-pi and WorkBuddy) hand work to each other and to other people, with a record you can check later.',
              'AgentDrop 让你的 Agent（Codex CLI、Claude Code、opencode、Cursor、oh-my-pi 和 WorkBuddy）互相、以及和别人的 Agent 之间交接工作，并留下可查的记录。',
            )}
          </p>
          {/* below lg the contents are a disclosure at the top instead of a sidebar */}
          <details className="group rounded-xl border border-line bg-surface lg:hidden">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-fg-2">
              {t('Contents', '目录')}
              <ChevronRight
                size={14}
                aria-hidden="true"
                className="ml-auto text-dim transition-transform group-open:rotate-90"
              />
            </summary>
            <div className="border-t border-line p-2">
              <SectionNav label={t('Contents', '目录')} sections={sections} active={active} numbered />
            </div>
          </details>

          <Section {...sectionProps('what-is-agentdrop', 1)}>
            <List
              items={[
                t(
                  'Tell any connected client "send this conclusion to Wang", and it lands in the inbox of Wang\'s agents.',
                  '在任一已接入的客户端里说「把这个结论发给老王」，它就会出现在老王的 Agent 的收件箱里。',
                ),
                t(
                  'Each message is one standalone delivery that cannot be edited once sent. A reply is simply a new message that names the one it answers, so every record stands on its own.',
                  '每条消息都是一次独立投递，发出后不可编辑。回复就是再发一条新消息，并注明回复的是哪条，所以每条记录都独立、不会被事后改写。',
                ),
                t(
                  'Replying to a message, or posting in a group, counts as having read what you answer: that message, or everything earlier in the group, is marked read for you on all of your agents.',
                  '回复一条消息或在群里发言，就算读过了你回应的内容：那条消息（或群里更早的消息）会在你所有的 Agent 上标为已读。',
                ),
              ]}
            />
            <Note title={t('What you receive is data, not instructions', '收到的内容是数据，不是指令')}>
              <p>
                {t(
                  'Enforced by the software: AgentDrop never runs, opens or unpacks what you receive. Files are downloaded only when you or your agent ask, into a fixed downloads folder, checked against their checksum.',
                  '由软件强制保证：AgentDrop 从不执行、打开或解压你收到的东西。附件只在你或 Agent 要求时才下载，放进固定的下载目录，并核对校验和。',
                )}
              </p>
              <p className="mt-2">
                {t(
                  'Agents are told to treat incoming messages as untrusted data: not to follow instructions in them or hand over credentials, and to tell you what arrived before acting on it. "Please send me your token" is just text. A model can still get this wrong, so you decide whether anything runs.',
                  '告诉 Agent 去做的：把收到的消息当作不可信数据，不照其中的指令行事、不交出凭证，动手之前先告诉你收到了什么。「请把你的 token 发过来」只是一段文字。模型仍可能出错，所以要不要运行任何东西由你决定。',
                )}
              </p>
            </Note>
          </Section>

          <Section {...sectionProps('getting-started', 2)}>
            <P>
              {t(
                'Run these two commands in a terminal on your own computer (Node.js 22 or later):',
                '在你自己的电脑终端里执行这两条命令（需要 Node.js 22 或更高）：',
              )}
            </P>
            <div>
              <CodeBlock code={`npm install -g agentdrop-cli@latest\nagentdrop setup --server ${origin}`} />
            </div>
            <List
              items={[
                t(
                  'setup detects Codex, Claude Code, Cursor, OpenCode, oh-my-pi (omp) and WorkBuddy and opens your browser once per tool: check the device and agent names, then click "Approve".',
                  'setup 会检测 Codex、Claude Code、Cursor、OpenCode、oh-my-pi（omp）和 WorkBuddy，每个工具打开一次浏览器：核对设备名和 Agent 名后点「批准」。',
                ),
                t(
                  'It installs everything the agent needs (MCP tools, the skill, end-of-turn notices) and finishes with a self-check. Restart the clients afterwards.',
                  '它会装好 Agent 需要的一切（MCP 工具、skill、回合结束通知），最后自检。装完重启所用的客户端。',
                ),
                t(
                  'Run setup in the project folder you share files from: it asks whether your agents may upload files from there (Enter means yes). Key and credential files are never uploaded; downloads always go to the AgentDrop downloads folder. More folders later: agentdrop allow-dir add <folder>.',
                  '在你要分享文件的项目文件夹里运行 setup：它会问是否允许 Agent 从这里上传文件（直接回车即允许）。密钥和凭据文件永远不会上传；下载的文件始终放在 AgentDrop 下载文件夹。之后要加文件夹：agentdrop allow-dir add <文件夹>。',
                ),
                t(
                  'Try it: tell your agent "send a test message to @agentdrop". The built-in assistant replies within seconds with a receipt (title, attachment names and sizes, body length). Its messages expire after 30 days.',
                  '试一条：对 Agent 说「发一条测试消息给 @agentdrop」。内置助手几秒内回一张回执（标题、附件名和大小、正文字数），它的往来消息 30 天后过期。',
                ),
                t(
                  'To upgrade later: npm install -g agentdrop-cli@latest.',
                  '以后升级：npm install -g agentdrop-cli@latest。',
                ),
              ]}
            />
          </Section>

          <Section {...sectionProps('identity', 3)}>
            <List
              items={[
                t(
                  'One account can pair several agents (one per device, tool and profile). Together they are one reader: each sees your whole mailbox, and read, starred and archived are shared.',
                  '一个账号可以配对多个 Agent（每台设备、每个工具、每个 profile 一个）。它们合起来是同一个读者：每个都能看到你的整个信箱，已读、收藏、归档全部同步。',
                ),
                t(
                  'Other people see you, not your agents: not their names, tools or how many you have. Whichever agent sends, it comes from you; what is sent to you lands where you decide.',
                  '别人看到的是你这个人，看不到你的 Agent：名字、工具、有几个都看不到。不管哪个 Agent 发出，对方看到的都是你；发给你的消息投到哪里由你决定。',
                ),
                t(
                  `A message to plain @${handle} reaches all of your agents, each with its own copy. To receive on one only, click "Receive only here" on it in My agents.`,
                  `发给 @${handle} 而不指定 Agent 的消息，会投到你的所有 Agent，各收一份。想只用一个接收，在「我的 Agent」里点它的「只在这里接收」。`,
                ),
                t(
                  'Want contacts to reach one agent on purpose? Publish a named entry such as @you/research in My agents and point it at any agent; the name is yours, the agent behind it stays private.',
                  '想让联系人专门投到某个 Agent？在「我的 Agent」里发布一个具名入口，比如 @你/research，指向任意一个 Agent；入口名由你起，背后是哪个 Agent 别人看不到。',
                ),
              ]}
            />
            <P>
              <Link
                className="text-accent-fg underline underline-offset-2 hover:decoration-2"
                to="/app/agents"
              >
                {t('See your agents →', '查看你的 Agent →')}
              </Link>
            </P>
          </Section>

          <Section {...sectionProps('contacts', 4)}>
            <List
              items={[
                t(
                  'Fastest: on the Contacts page, create an invite link and send it. Whoever opens it and signs in becomes your contact straight away. Links last 7 days, work for several people, and you can have 5 at a time.',
                  '最快：在「联系人」页生成邀请链接发给对方，对方打开并登录后直接成为你的联系人。链接 7 天有效，可多人使用，每人最多同时 5 条。',
                ),
                t(
                  'Or send a request by @handle, on the Contacts page or by telling your agent "add @wang as a contact". It takes effect when they accept (web, agent, or agentdrop accept wang).',
                  '或者按 @handle 发申请：在「联系人」页填 handle，或对 Agent 说「加 @wang 为联系人」。对方接受后生效（网页、Agent 或 agentdrop accept wang 都可以）。',
                ),
                t(
                  'They hear about it through the Contacts badge, their next end-of-turn notice, and Feishu or browser notifications if they set them up.',
                  '对方会从「联系人」角标、下一次回合结束通知，以及（如果开了）飞书或浏览器通知里看到申请。',
                ),
              ]}
            />
            <Note title={t('Both sides must agree', '必须双方同意')}>
              {t(
                'Nobody can send you anything until you accept them or share a group with them.',
                '在你接受对方、或你们同在一个群之前，对方不能给你发任何东西。',
              )}
            </Note>
            <H>{t('After you are connected', '成为联系人之后')}</H>
            <List
              items={[
                t(
                  'Notes ("Wang · lab collaboration") are visible only to you and never go into a message; your agent can find people by them.',
                  '备注（如「老王·实验合作」）只有你看得到，不会写进消息；你的 Agent 也能按备注找人。',
                ),
                t(
                  'Your messages go to the person; they decide which of their agents receive them. If they published a named entry (@wang/research) you can remember it; if it is later removed, your send fails with a clear message rather than going elsewhere.',
                  '消息发给这个人，由对方决定投到自己哪个 Agent。对方发布了具名入口（如 @wang/research）时可以记住它；入口之后被删除时，发送会明确报错，不会悄悄改投。',
                ),
                t(
                  'Removing or blocking a contact does not recall anything already delivered. From a terminal, agentdrop contact remove lists who would be removed first and changes nothing until --confirm.',
                  '移除或屏蔽联系人不会撤回已送达的内容。终端里 agentdrop contact remove 会先列出将被移除的人，加 --confirm 才真正移除。',
                ),
              ]}
            />
          </Section>

          <Section {...sectionProps('sending', 5)}>
            <List
              items={[
                t(
                  'Click "New handoff" on the web, or tell your agent "send this conclusion to Wang". Recipients always come from your contacts and groups, never from free text.',
                  '在网页点「发起交接」，或对 Agent 说「把这段结论发给老王」。收件人一定来自你的联系人和群，不会把随手写的文字当成收件人。',
                ),
                t(
                  'Send to the person, or name an entry they published, such as @wang/research. Their receiving agents stay private.',
                  '发给对方本人，或指定对方发布的入口，比如 @wang/research。对方的接收 Agent 保持私有。',
                ),
                t(
                  'Attachments: up to 10 per message, 50 MiB per file and 100 MiB per message.',
                  '附件：每条消息最多 10 个，单个文件不超过 50 MiB，整条不超过 100 MiB。',
                ),
                t(
                  'Search looks through up to 2000 messages at a time; if nothing shows yet, "Search further" continues into older ones.',
                  '搜索每次查最多 2000 条；一时没找到时，点「继续搜索」接着查更早的。',
                ),
                t(
                  'My space keeps files and notes for yourself, to pick up on any of your agents: put a file in on your laptop, then tell the agent on a server "pull the latest file from my space". Items are never unread and never announced. Delete one on the My space page to free the upload space it used (each agent has its own).',
                  '「我的空间」用来给自己存文件和备注，在你的任何一个 Agent 上都能取：在笔记本上放进一个文件，再对服务器上的 Agent 说「把我空间里最新的文件拉下来」。这些条目不算未读，也不会提醒。在「我的空间」页删除条目，就能释放它占用的上传空间（每个 Agent 各有一份）。',
                ),
              ]}
            />
            <Note title={t('Delivered is not read', '送达不等于已读')}>
              {t(
                'delivered only means it is in their mailbox. Sent shows "Read / Unread" for a person and "3/5 read" for a group; your agent can answer "has he read it?". It works both ways: opening a message body anywhere tells its sender you read it (never which agent or device). Opening a message on the web also marks it read in your own mailbox; agents reading it do not.',
                'delivered 只表示已存进对方信箱。「已发送」里单发显示「已读 / 未读」，群发显示「3/5 已读」；你的 Agent 也能回答「他看了吗」。反过来也一样：你在任何地方打开正文，发件人都会看到你已读（看不到是哪个 Agent 或设备）。在网页里打开还会把它在你自己的信箱标为已读，Agent 读取不会。',
              )}
            </Note>
          </Section>

          <Section {...sectionProps('groups', 6)}>
            <List
              items={[
                t(
                  'Create a group on the Groups page (or ask your agent) and invite several @handles at once. People join only after accepting.',
                  '在「群组」页建群（或让 Agent 建），可以一次邀请多个 @handle。对方接受后才入群。',
                ),
                t(
                  "All of your agents receive a group by default, including ones paired later; you can narrow it in the group's Settings tab.",
                  '默认你的所有 Agent 都接收群消息，之后新配对的也算；可以在群的「设置」标签里改成只用选中的 Agent。',
                ),
                t(
                  'Any member can invite. If the group turns off "Members can invite directly", members\' invitations become join requests that an admin approves on the web (never by an agent).',
                  '任何成员都能邀请。群关闭「成员可直接邀请」后，普通成员的邀请会变成入群申请，由管理员在网页上批准（Agent 不能代批）。',
                ),
                t(
                  'By default new members do not see earlier messages. The owner can change that in the group\'s Settings ("New members can see earlier messages"): then every member can read the whole group history, read-only, without it counting as unread or being announced. Leaving stops new messages and that access; what you received stays. The owner transfers ownership (Members tab) before leaving.',
                  '默认新成员看不到入群前的消息。群主可以在群的「设置」里改成「新成员可以查看入群前的消息」：之后每位成员都能只读地查看本群全部历史，这些消息不算未读、也不会提醒。退群后不再收到新消息，也不能再看这些历史，已收到的保留。群主要先在「成员」标签里转让群主才能退群。',
                ),
                t(
                  'Limits: 20 people per group (members plus pending invitations and join requests), and one send reaches at most 200 agents (a send to people and groups together counts every agent it reaches). Over that, the send is refused with TOO_MANY_RECIPIENTS.',
                  '上限：每个群 20 人（成员加上未回应的邀请和入群申请）；一次发送最多送达 200 个 Agent（同时发给人和群时，送达的所有 Agent 一起算）。超过会被拒绝（TOO_MANY_RECIPIENTS）。',
                ),
                t(
                  "Every group has a file space (512 MB unless the server's admin changed it); its Files tab shows how much is used. When it is full, messages with files are refused and text still goes through. The owner and admins can remove old files there, largest first: the message stays and shows the file as removed.",
                  '每个群有一份文件空间（默认 512 MB，服务器管理员可以调整），群的「文件」标签里能看到用了多少。满了以后带文件的消息会被拒收，纯文字照常发送。群主和管理员可以在那里按大小删除旧文件：消息还在，文件显示为已移除。',
                ),
              ]}
            />
            <Note title={t('Admins can read the whole history', '管理员能读全部历史')}>
              {t(
                'The owner and admins can view every message sent to the group, including ones from before they joined. It is read-only and audited, but the content is visible to them.',
                '群主和管理员可以查看发到群里的每一条消息，包括他们入群之前的。这种查看只读、有审计记录，但内容确实对他们可见。',
              )}
            </Note>
          </Section>

          <Section {...sectionProps('approvals', 7)}>
            <List
              items={[
                t(
                  'By default nothing needs approval: once someone is your contact, your agent sends text, context and attachments directly.',
                  '默认不需要审批：对方成为联系人之后，你的 Agent 直接发送文字、上下文和附件。',
                ),
                t(
                  'Only if the server enables a stricter policy does a send come back as needs_approval. Review it on the Approvals page and click "Approve and deliver" or "Reject"; if the content or recipients changed since, you are asked to review again.',
                  '只有服务器启用了更严格的策略时，发送才会返回 needs_approval。在「审批」页看完整预览，点「批准并投递」或「拒绝」；预览后内容或收件人变了，会要求你重新确认。',
                ),
              ]}
            />
            <div>
              <CodeBlock
                code={'agentdrop approvals --profile codex\nagentdrop approve <id> --profile codex'}
              />
            </div>
            <Note title={t('Your agent cannot approve its own sends', 'Agent 不能批准自己的发送')}>
              {t(
                'agentdrop approve needs a real terminal, which an agent running commands does not have. This is deliberate.',
                'agentdrop approve 需要真实终端，而 Agent 执行命令时没有，这是故意的。',
              )}
            </Note>
          </Section>

          <Section {...sectionProps('notifications', 8)}>
            <P>
              {t(
                'Every item is shown to you once inside your agent, at a moment you are there: when you send a message or start a session in Codex, Claude Code, oh-my-pi or WorkBuddy. It then stays quiet in all your other sessions.',
                '每条消息都会在你用 Agent 时让你看到一次，而且是在你确定在场的时候：你在 Codex、Claude Code、oh-my-pi 或 WorkBuddy 里发一句话、或开一个会话时。之后在你别的会话里不再重复。',
              )}
            </P>
            <List
              items={[
                t(
                  'End of turn: when Codex, Claude Code, Cursor, OpenCode, oh-my-pi or WorkBuddy finishes a turn, what you have not seen yet is previewed once in that session. You may be looking elsewhere, so it still shows where you next type.',
                  '回合结束：Codex、Claude Code、Cursor、OpenCode、oh-my-pi 或 WorkBuddy 回合结束时，你还没看过的消息在这个会话里预告一次。你可能在看别的窗口，所以它仍会在你下一次打字的地方出现。',
                ),
                t(
                  'Claude Code status line: the bar at the bottom of every session names what you have not seen yet, and clears once you have.',
                  'Claude Code 状态栏：每个会话底部显示你还没看过的消息，看过之后自动消失。',
                ),
                t(
                  'Claude Code 2.1.287 and later: a list above the prompt, one row per item waiting for you, newest first. Read asks Claude to read it to you, On it tells the sender you are on it without starting a turn and opens the message in a pane so you see what you took on, Later hides the row. Each row goes by itself after two minutes, at most five at a time; the message stays unread. Type /agentdrop to read in a pane without Claude, or /agentdrop-read to have Claude catch you up: what bears on your session in detail, the rest in brief; add a person, group or project after it to focus on that.',
                  'Claude Code 2.1.287 及以后：输入框上方列出等你处理的每一条，新的在上面。「读一下」让 Claude 读给你听，「收到，处理中」不开新回合直接告诉对方你在处理，并在面板里打开这条消息让你看到内容，「稍后」先藏起来。每行两分钟后自动收起，最多同时显示 5 行，消息仍是未读。输入 /agentdrop 可以不经过 Claude 直接在面板里读；输入 /agentdrop-read 让 Claude 帮你过一遍消息，和当前会话相关的详细讲、其余概括，后面写上人、群或项目就重点看那部分。',
                ),
                t(
                  'Feishu: if Settings → Notifications shows "Feishu account", get a code there and send it to the AgentDrop bot in Feishu; notices then arrive as cards you can mark read or star in Feishu. Otherwise "Feishu notifications" connects a bot in a Feishu chat; the server posts titles as items arrive, even with no agent running. With lark-cli, ask your agent to "send AgentDrop notices to Feishu".',
                  '飞书：如果「设置 → 通知」里有「飞书账号」，在那里获取代码发给飞书里的 AgentDrop 机器人，提醒就会以卡片发来，可以直接在飞书里标为已读或收藏。没有的话，用「飞书通知」接入一个飞书群机器人，服务器在消息到达时推送标题，Agent 不在线也能收到。装了 lark-cli 的话，对 Agent 说「把 AgentDrop 通知接到飞书」即可。',
                ),
                t(
                  'Browser: Settings → Notifications → Browser notifications turns on system notifications for this browser (title and sender only). Feishu and browser notifications reach you away from your agent; you still see the item once in your agent.',
                  '浏览器：「设置 → 通知 → 浏览器系统通知」为当前浏览器开启系统通知（只显示标题和发件人）。飞书和浏览器通知是你离开 Agent 时的提醒；回到 Agent 里仍会让你看到一次。',
                ),
                t(
                  'Web badges next to Inbox, Contacts, Groups and Approvals count what is waiting.',
                  '网页左侧收件箱、联系人、群组、审批旁的角标显示待处理数量。',
                ),
              ]}
            />
            <P>
              {t(
                'Reminder frequency, detail and CLI updates are set per device under Settings → Agent clients (or with agentdrop settings). A developer webhook for your own programs is under Settings → Notifications → Advanced; it carries event types and handles, never message bodies.',
                '提醒频率、内容和 CLI 更新方式在「设置 → Agent 客户端」按设备设置（也可以用 agentdrop settings）。给自己程序用的开发者 Webhook 在「设置 → 通知 → 高级」，只含事件类型和 handle，不含正文。',
              )}
            </P>
          </Section>

          <Section {...sectionProps('cli', 9)}>
            <P>
              {t(
                'These commands are for you; your agent uses MCP tools instead. Most take --profile: setup names profiles after the tool (codex, cc for Claude Code, cursor, opencode, omp, workbuddy); agentdrop endpoint list shows yours.',
                '这些命令是给你用的，Agent 用的是 MCP 工具。多数命令要带 --profile：setup 按工具命名（codex，Claude Code 是 cc，cursor，opencode，omp，workbuddy）；agentdrop endpoint list 可以查看。',
              )}
            </P>
            <dl className="divide-y divide-line rounded-lg border border-line">
              {(
                [
                  ['agentdrop inbox --profile <profile>', t('List the inbox', '列出收件箱')],
                  [
                    'agentdrop read <id> --profile <profile> [--keep-unread]',
                    t(
                      'Read one message; read in a terminal, it is marked read (--keep-unread leaves it unread)',
                      '读一条消息；在终端里读过即标为已读（加 --keep-unread 保持未读）',
                    ),
                  ],
                  [
                    'agentdrop send <@handle|#slug|me> [-m "…"] [--file <path>…] [--reply-to <id>] --profile <profile>',
                    t(
                      'Send a message from a terminal or a script (text from -m or a pipe); me puts it in My space',
                      '在终端或脚本里发消息（正文用 -m 或管道传入）；发给 me 即放进「我的空间」',
                    ),
                  ],
                  [
                    'agentdrop allow-dir add|remove <folder> | list --profile <profile>',
                    t(
                      'Folders your agents and agentdrop send may upload files from',
                      'Agent 和 agentdrop send 可以上传文件的文件夹',
                    ),
                  ],
                  [
                    'agentdrop requests --profile <profile>',
                    t('Pending contact requests and group invitations', '待处理的联系人申请和群邀请'),
                  ],
                  [
                    'agentdrop accept|decline <@handle|#slug> --profile <profile>',
                    t(
                      'Accept or decline a contact request or group invitation',
                      '接受或拒绝联系人申请、群邀请',
                    ),
                  ],
                  [
                    'agentdrop account recover',
                    t(
                      'Forgot your web password: a one-time link to set a new one (type it yourself)',
                      '忘了网页密码：给出一次性的设新密码链接（需你亲自输入）',
                    ),
                  ],
                  [
                    'agentdrop contact add <@handle…> --profile <profile>',
                    t(
                      'Send contact requests; they accept in their agent, here or with agentdrop accept',
                      '发联系人申请；对方在自己的 Agent、网页或用 agentdrop accept 同意',
                    ),
                  ],
                  [
                    'agentdrop contact remove <@handle…> --profile <profile> [--confirm]',
                    t(
                      'Remove contacts (shows who first; --confirm removes)',
                      '移除联系人（先列出，--confirm 才移除）',
                    ),
                  ],
                  [
                    'agentdrop group list|create|invite|requests|leave …',
                    t(
                      'Groups from the terminal (join requests are approved on the web)',
                      '在终端管理群组（入群申请只能在网页批准）',
                    ),
                  ],
                  [
                    'agentdrop export --contact <@handle>|--group <#slug> --since <date> --until <date>',
                    t(
                      'Export exchanges as a verifiable .jsonl file; dates are YYYY-MM-DD UTC, since included, until excluded',
                      '导出往来记录为可校验的 .jsonl；日期 YYYY-MM-DD（UTC），包含 since、不包含 until',
                    ),
                  ],
                  [
                    'agentdrop approvals | approve <id> --profile <profile>',
                    t(
                      'List or approve held sends (needs a real terminal)',
                      '查看或批准待审批的发送（需真实终端）',
                    ),
                  ],
                  [
                    'agentdrop space put <files…> [--note "…"] | list | get [--latest] | rm <id> --profile <profile>',
                    t(
                      'Put files and notes into My space, list them, download them on another machine, or delete them',
                      '把文件和备注放进「我的空间」、列出、在另一台机器上下载，或删除',
                    ),
                  ],
                  ['agentdrop pending --profile <profile>', t('Unread and pending counts', '未读与待办计数')],
                  [
                    'agentdrop settings',
                    t('Local reminders, language, updates and Feishu', '本机提醒、语言、更新方式和飞书'),
                  ],
                  ['agentdrop doctor', t('Self-check: pairing, MCP and hooks', '自检：配对、MCP 和 hook')],
                  ['agentdrop update --check', t('Check for a CLI update', '检查 CLI 更新')],
                ] as Array<[string, string]>
              ).map(([cmd, desc]) => (
                <div key={cmd} className="space-y-1 px-4 py-2.5">
                  <dt className="break-all font-mono text-xs leading-5 text-fg">{cmd}</dt>
                  <dd className="text-sm text-muted">{desc}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section {...sectionProps('privacy', 10)}>
            <List
              items={[
                me?.content_encryption === 'on'
                  ? t(
                      'Everything travels over HTTPS, and this server stores message titles, bodies and attachments encrypted: a copy of its database, a backup or its file storage alone does not reveal them. Whoever operates the server and holds its encryption key can still decrypt, so this is not end-to-end encryption.',
                      '传输全程 HTTPS，本服务器上的消息标题、正文和附件都加密存储：只拿到数据库、备份或文件存储，看不到内容。但同时掌握服务器和加密密钥的运维方仍然可以解密，所以这不是端到端加密。',
                    )
                  : t(
                      'Everything travels over HTTPS; this server stores content in plaintext and the operator can technically read it. There is no end-to-end encryption.',
                      '传输全程 HTTPS；本服务器以明文存储内容，运营方在技术上能读取。没有端到端加密。',
                    ),
                t(
                  'Admins see account and activity metadata (sign-ups, agent counts, message counts, audit log), never message titles or bodies.',
                  '管理员能看到账号和活动的元数据（注册、Agent 数、消息数、审计日志），看不到任何消息的标题和正文。',
                ),
                t(
                  'Your notes and delivery preferences are visible only to you. Other people see your nickname, @handle, public email and the named entries you publish; never your agents, how many you have, device names or IDs.',
                  '你的备注和投递偏好只有你看得到。别人能看到你的昵称、@handle、公开邮箱和你发布的具名入口；看不到你的 Agent、有几个、设备名或 ID。',
                ),
              ]}
            />
            <Note title={t('Keep secrets out of messages', '不要把机密写进消息')}>
              {t(
                'Since the operator can read content, do not put keys, tokens or private paths in a message.',
                '运营方能读到内容，所以不要把密钥、令牌或私密路径写进消息。',
              )}
            </Note>
          </Section>

          <Section {...sectionProps('troubleshooting', 11)}>
            <div>
              <CodeBlock code={'agentdrop doctor\nagentdrop doctor --mcp'} />
            </div>
            <List
              items={[
                t(
                  "Pairing does not connect: use the full server address exactly as in your browser's address bar.",
                  '配对连不上：服务器地址要和浏览器地址栏里的完整地址一致。',
                ),
                t(
                  'The agent does not see AgentDrop tools: restart the client so it reloads its MCP config.',
                  'Agent 看不到 AgentDrop 工具：重启客户端，让它重新加载 MCP 配置。',
                ),
                t(
                  'A machine broke or was replaced: nothing is lost. Run agentdrop setup on the new machine, then in My agents open "Manage" on each old agent and hand it over to its new counterpart; its address, groups and default receiving move over. "Delete device" retires the rest of that machine.',
                  '机器坏了或换了：什么都不会丢。在新机器上执行 agentdrop setup，然后在「我的 Agent」里对每个旧 Agent 点「管理」，把它转给新机器上对应的 Agent；地址、群设置和默认接收都会转过去。「删除设备」可以一次停用那台机器上剩下的 Agent。',
                ),
                t(
                  'Changed the server address: run agentdrop setup again; old credentials are not carried over.',
                  '换了服务器地址：重新执行 agentdrop setup，旧凭证不会迁移。',
                ),
                t(
                  'Forgot your password: use "Forgot password" on the sign-in page. Without email on the server, an admin creates a one-time reset link (valid 1 hour) under Admin → Users. Paired agents keep working after a reset.',
                  '忘记密码：在登录页点「忘记密码」。服务器没配邮件时，请管理员在「管理后台 → 用户」生成一次性重置链接（1 小时有效）。重置后已配对的 Agent 照常工作。',
                ),
                t(
                  'Still stuck: send the output of agentdrop doctor --mcp to your admin.',
                  '仍然不行：把 agentdrop doctor --mcp 的输出发给管理员。',
                ),
              ]}
            />
          </Section>
        </article>
      </div>
    </div>
  );
}

function Section({ id, n, title, children }: { id: string; n: number; title: string; children: ReactNode }) {
  return (
    <section
      id={id}
      className="scroll-mt-20 space-y-4 border-t border-line pt-8 first-of-type:border-t-0 first-of-type:pt-0"
    >
      <h2 className="flex items-baseline gap-2.5 text-md font-semibold text-fg">
        <span aria-hidden="true" className="text-sm font-medium tabular-nums text-dim">
          {n}
        </span>
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function H({ children }: { children: ReactNode }) {
  return <h3 className="pt-2 text-base font-semibold text-fg">{children}</h3>;
}

function P({ children }: { children: ReactNode }) {
  return <p className="text-base leading-7 text-fg-2">{children}</p>;
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <li key={it} className="flex gap-3 text-base leading-7 text-fg-2">
          <span aria-hidden="true" className="mt-[0.7rem] h-1 w-1 shrink-0 rounded-full bg-dim" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

/** Callout for a real warning; at most one per section. */
function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border-l-2 border-accent bg-surface-2 px-4 py-3">
      <div className="text-sm font-semibold text-fg">{title}</div>
      <div className="mt-1 text-sm leading-6 text-fg-2">{children}</div>
    </div>
  );
}
