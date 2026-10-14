import { Bell, Check, FileSpreadsheet, FileText, Inbox, Paperclip, Terminal } from 'lucide-react';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { useT } from '../lib/lang.js';
import { Avatar, Chip, listRowClass } from '../ui/layout.jsx';

/*
 * The landing page's product visuals, drawn with the dashboard's own row, avatar and chip components and fictional
 * data only (people Wang @wang and Mia @mia, the viewer's agents "Design agent" and "Dev agent", group #research).
 * Only the miniature inbox is interactive (its rows open their message); the rest are illustrations. People-facing
 * text says "message", never "drop".
 */

/** Staggered entrance, only when the person has not asked for reduced motion (keyframes in index.css). */
export const RISE = 'motion-safe:animate-[ad-rise_520ms_cubic-bezier(0.23,1,0.32,1)_both]';
/** The entrance's start offset: a style, because class names built at runtime are invisible to Tailwind. */
export const after = (ms: number) => ({ animationDelay: `${ms}ms` });

interface DemoDrop {
  id: string;
  who: string;
  handle: string;
  seed: string;
  title: string;
  preview: string;
  body: string;
  time: string;
  when: string;
  group?: string;
  mention?: boolean;
  files: { name: string; size: string; sheet?: boolean }[];
  to: string;
  delivered: string;
  reply: string;
}

function useDemoDrops(): DemoDrop[] {
  const t = useT();
  return [
    {
      id: 'run-14',
      who: 'Wang',
      handle: '@wang',
      seed: 'wang',
      group: '#research',
      mention: true,
      title: t('Ablation results, run 14', '消融实验结果：第 14 轮'),
      preview: t('Run 14 beats the baseline on three…', '第 14 轮在四个划分里有三个…'),
      body: t(
        'Run 14 beats the baseline on three of four splits. The numbers are in results.csv and the method is in notes.md. Can you check split C before Friday?',
        '第 14 轮在四个划分里有三个超过基线。数据在 results.csv，方法写在 notes.md。周五前能帮忙看一下划分 C 吗？',
      ),
      time: '10:42',
      when: t('Today, 10:42', '今天 10:42'),
      files: [
        { name: 'results.csv', size: '18 KB', sheet: true },
        { name: 'notes.md', size: '4 KB' },
      ],
      to: t('To Dev agent', '收件：Dev agent'),
      delivered: t('Delivered to your Dev agent', '已投递到你的 Dev agent'),
      reply: t('“send Wang the split C numbers”', '“把划分 C 的数据发给 Wang”'),
    },
    {
      id: 'tokens',
      who: 'Mia',
      handle: '@mia',
      seed: 'mia',
      title: t('Settings page: design tokens', '设置页：设计变量'),
      preview: t('Final colours and spacing for the…', '设置页最终的颜色和间距…'),
      body: t(
        'Final colours and spacing for the settings page are in tokens.json. The dark theme uses the same names, so nothing else has to change.',
        '设置页最终的颜色和间距在 tokens.json 里。深色主题用的是同一套名称，别的地方都不用改。',
      ),
      time: '09:15',
      when: t('Today, 09:15', '今天 09:15'),
      files: [{ name: 'tokens.json', size: '3 KB' }],
      to: t('To Design agent', '收件：Design agent'),
      delivered: t('Delivered to your Design agent', '已投递到你的 Design agent'),
      reply: t('“apply Mia’s tokens to the settings page”', '“把 Mia 的设计变量用到设置页”'),
    },
    {
      id: 'split-v2',
      who: 'Wang',
      handle: '@wang',
      seed: 'wang',
      group: '#research',
      title: t('Dataset split, v2', '数据集划分 v2'),
      preview: t('Moved 200 samples from train to…', '从训练集挪了 200 条到…'),
      body: t(
        'Moved 200 samples from train to validation so that split C is balanced. No files this time: the new split is already in the shared repository.',
        '从训练集挪了 200 条到验证集，让划分 C 更均衡。这次没有附件：新的划分已经在共享仓库里了。',
      ),
      time: t('Mon', '周一'),
      when: t('Monday, 16:20', '周一 16:20'),
      files: [],
      to: t('To Dev agent', '收件：Dev agent'),
      delivered: t('Delivered to your Dev agent', '已投递到你的 Dev agent'),
      reply: t('“tell Wang the new split looks good”', '“告诉 Wang 新的划分没问题”'),
    },
  ];
}

function DemoInboxRow({
  drop,
  selected,
  unread,
  arriving,
  onSelect,
}: {
  drop: DemoDrop;
  selected: boolean;
  unread: boolean;
  arriving: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`${listRowClass(selected)} flex gap-3 ${selected ? 'shadow-[inset_2px_0_0_var(--color-accent)]' : ''} ${
        arriving ? 'ad-arrive' : ''
      }`}
    >
      {unread ? (
        <span aria-hidden="true" className="absolute left-1.5 top-6 h-1.5 w-1.5 rounded-full bg-accent" />
      ) : null}
      <Avatar name={drop.who} seed={drop.seed} size={32} />
      <span className="block min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span
            className={`min-w-0 truncate text-sm ${unread ? 'font-semibold text-fg' : 'font-medium text-fg-2'}`}
          >
            {drop.who}
          </span>
          {drop.group ? <Chip>{drop.group}</Chip> : null}
          {drop.mention ? <Chip tone="accent">{t('@you', '@你')}</Chip> : null}
          <span
            className={`ml-auto shrink-0 pl-1 text-xs tabular-nums ${unread ? 'font-medium text-accent-fg' : 'text-dim'}`}
          >
            {drop.time}
          </span>
        </span>
        <span className={`mt-0.5 block truncate text-sm ${unread ? 'text-fg' : 'text-fg-2'}`}>
          {drop.title}
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-dim">
          <span className="min-w-0 truncate">{drop.preview}</span>
          {drop.files.length ? (
            <span className="inline-flex shrink-0 items-center gap-0.5">
              <Paperclip aria-hidden="true" size={12} />
              {drop.files.length}
            </span>
          ) : null}
        </span>
        <span className="mt-1 block truncate text-xs text-dim">{drop.to}</span>
      </span>
    </button>
  );
}

function AttachmentTile({ icon, name, size }: { icon: ReactNode; name: string; size: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent-fg">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-mono text-xs text-fg">{name}</span>
        <span className="block text-xs text-dim">{size}</span>
      </span>
    </div>
  );
}

/** The open drop on the right of the miniature inbox (and alone on a phone). */
function DemoDropView({ drop }: { drop: DemoDrop }) {
  const t = useT();
  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg">
      {/* keyed by drop: a new selection fades in instead of the text jumping */}
      <div key={drop.id} className="ad-swap space-y-4 px-5 py-5 sm:px-6">
        <div className="flex items-center gap-3">
          <Avatar name={drop.who} seed={drop.seed} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold text-fg">{drop.who}</span>
              <span className="text-sm text-dim">{drop.handle}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {drop.group ? <Chip>{drop.group}</Chip> : null}
              {drop.mention ? <Chip tone="accent">{t('@you', '@你')}</Chip> : null}
              <span className="text-xs text-dim">{drop.when}</span>
            </div>
          </div>
        </div>
        {/* not a heading: the example sits under the page's h1 and must not break the page outline */}
        <p data-demo-title className="text-lg font-semibold tracking-tight text-fg">
          {drop.title}
        </p>
        <p className="max-w-xl text-base text-fg-2">{drop.body}</p>
        {drop.files.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {drop.files.map((f) => (
              <AttachmentTile
                key={f.name}
                icon={f.sheet ? <FileSpreadsheet size={16} /> : <FileText size={16} />}
                name={f.name}
                size={f.size}
              />
            ))}
          </div>
        ) : null}
        <div className="hidden rounded-lg border border-dashed border-line-strong px-3.5 py-3 text-sm text-muted lg:block">
          {t('To answer, tell your agent:', '要回复，就对 Agent 说：')}{' '}
          <span className="text-fg-2">{drop.reply}</span>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-5 py-3 text-xs text-dim sm:px-6">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-ok" />
          {drop.delivered}
        </span>
        <span>{t('Nothing is downloaded or run on its own', '不会自动下载，也不会被执行')}</span>
      </div>
    </div>
  );
}

/**
 * The hero's composed visual: a miniature inbox with one drop open. The rows can be clicked like the real inbox:
 * the drop opens on the right and loses its unread dot.
 */
export function InboxDemo() {
  const t = useT();
  const drops = useDemoDrops();
  const [selectedId, setSelectedId] = useState(drops[0]?.id ?? '');
  const [read, setRead] = useState<Set<string>>(() => new Set());
  const [touched, setTouched] = useState(false);
  const selected = drops.find((d) => d.id === selectedId) ?? drops[0];
  if (!selected) return null;
  // the first drop has just arrived: it counts as read once the visitor has looked at it and moved on
  const unread = (d: DemoDrop) => d.id === 'run-14' && !read.has(d.id);
  const select = (id: string) => {
    setTouched(true);
    setRead((prev) => new Set(prev).add(selectedId));
    setSelectedId(id);
  };
  return (
    <div className="card message-surface overflow-hidden rounded-2xl border border-line-strong">
      <div className="flex h-11 items-center gap-2 border-b border-line bg-surface px-4">
        <Inbox aria-hidden="true" size={15} className="text-muted" />
        <span className="text-sm font-semibold text-fg">{t('Inbox', '收件箱')}</span>
        <span className="rounded-md bg-hover px-1.5 text-xs font-medium tabular-nums text-muted">
          {drops.length}
        </span>
        <span className="ml-auto hidden text-xs text-dim sm:inline xl:hidden">
          {t('All your agents', '你的所有 Agent')}
        </span>
      </div>
      <div className="flex lg:min-h-[26rem]">
        <div className="hidden w-[20rem] shrink-0 border-r border-line bg-surface md:block">
          {drops.map((d) => (
            <DemoInboxRow
              key={d.id}
              drop={d}
              selected={d.id === selected.id}
              unread={unread(d)}
              arriving={!touched && d.id === selected.id}
              onSelect={() => select(d.id)}
            />
          ))}
        </div>
        <DemoDropView drop={selected} />
      </div>
    </div>
  );
}

/** A browser notification the way it pops up on the person's screen: the title, then where it came from and who. */
export function NoticeDemo() {
  const t = useT();
  return (
    <div className="card message-surface flex w-72 items-start gap-3 rounded-xl border border-line-strong px-3.5 py-3">
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent-fg">
        <Bell size={15} />
      </span>
      <div className="min-w-0 text-sm">
        <div className="font-semibold text-fg">{t('Ablation results, run 14', '消融实验结果：第 14 轮')}</div>
        <div className="mt-0.5 text-xs leading-5 text-muted">
          {t('Group message · #research: Wang mentioned you', '群消息 · #research：Wang @了你')}
        </div>
      </div>
    </div>
  );
}

function Bubble({ from, children, delay }: { from: 'you' | 'agent'; children: ReactNode; delay: number }) {
  const t = useT();
  // revealed when the conversation scrolls into view, so the question comes first and the answer after it
  return (
    <div className="ad-reveal flex gap-2.5" style={{ '--ad-delay': `${delay}ms` } as CSSProperties}>
      <span
        className={`mt-0.5 inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-xs font-medium ${
          from === 'you' ? 'bg-hover text-fg-2' : 'bg-accent/12 text-accent-fg'
        }`}
      >
        {from === 'you' ? t('You', '你') : t('Agent', 'Agent')}
      </span>
      <div className="min-w-0 pt-0.5 text-sm leading-6 text-fg">{children}</div>
    </div>
  );
}

/**
 * A conversation with an agent in a terminal. `send`: the person asks for a handoff and the agent confirms it.
 * `read`: the person asks what arrived and the agent summarises it and asks before downloading anything.
 */
export function AgentChatDemo({ variant, className = '' }: { variant: 'send' | 'read'; className?: string }) {
  const t = useT();
  const send = variant === 'send';
  return (
    <div className={`card message-surface overflow-hidden rounded-xl border border-line-strong ${className}`}>
      <div className="flex h-9 items-center gap-2 border-b border-line bg-surface-2 px-3.5">
        <Terminal aria-hidden="true" size={13} className="text-muted" />
        <span className="text-xs font-medium text-fg-2">{send ? 'Design agent' : 'Dev agent'}</span>
        <span className="text-xs text-dim">· {send ? 'Codex CLI' : 'Claude Code'}</span>
      </div>
      <div className="space-y-3 bg-bg px-3.5 py-3.5">
        {send ? (
          <>
            <Bubble from="you" delay={100}>
              {t('send the results to @wang', '把结果发给 @wang')}
            </Bubble>
            <Bubble from="agent" delay={550}>
              <span className="inline-flex flex-wrap items-center gap-x-1.5">
                <Check aria-hidden="true" size={14} className="text-ok" />
                <span>{t('Delivered to @wang · 2 files', '已投递给 @wang · 2 个文件')}</span>
              </span>
              <span className="mt-1.5 flex flex-wrap gap-1.5">
                <Chip>results.csv</Chip>
                <Chip>notes.md</Chip>
              </span>
            </Bubble>
          </>
        ) : (
          <>
            <Bubble from="you" delay={450}>
              {t('anything new from Wang?', 'Wang 发来什么了吗？')}
            </Bubble>
            <Bubble from="agent" delay={950}>
              {t(
                'Wang sent “Ablation results, run 14” to #research, with results.csv and notes.md. Nothing is downloaded yet. Fetch them?',
                'Wang 在 #research 发来“消融实验结果：第 14 轮”，附 results.csv 和 notes.md。还没有下载任何文件，要下载吗？',
              )}
            </Bubble>
          </>
        )}
      </div>
    </div>
  );
}

/** Step two of "How it works": a colleague accepted, so the two of you can reach each other. */
export function ContactDemo() {
  const t = useT();
  return (
    <div className="card overflow-hidden rounded-xl border border-line-strong">
      <div className="flex items-center gap-3 border-b border-line px-3.5 py-3">
        <Avatar name="Wang" seed="wang" size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-fg">Wang</div>
          <div className="truncate text-xs text-dim">@wang</div>
        </div>
        <Chip tone="ok">{t('Contact', '联系人')}</Chip>
      </div>
      <div className="flex items-center gap-3 px-3.5 py-3">
        <Avatar name="Mia" seed="mia" size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-fg">Mia</div>
          <div className="truncate text-xs text-dim">@mia</div>
        </div>
        <Chip tone="warn">{t('Invited', '已邀请')}</Chip>
      </div>
    </div>
  );
}
