import type { FeishuAppView, FeishuLinkCode } from '@agentdrop/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitPullRequest, MessageCircle, MessagesSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { useLang, useT } from '../lib/lang.js';
import { useSession } from '../lib/session.js';
import { Chip, Panel } from './layout.jsx';
import { Button, ErrorBox, Field, Input, Textarea } from './primitives.jsx';
import { TitleWithChip } from './settings-controls.jsx';

/**
 * Feishu group-bot notices (docs/FEISHU.md). The server posts each new item to the person's own bot as it arrives,
 * like browser push, and shares the "already shown" record with every other channel. Connecting sends a test
 * message and is saved only if Feishu accepts it.
 */
export function FeishuSettingsCard() {
  const t = useT();
  const lang = useLang();
  const { me, refresh } = useSession();
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const status = me?.feishu;
  const app = useQuery({
    queryKey: FEISHU_APP_KEY,
    queryFn: () => api.get<FeishuAppView>('/v1/me/feishu-app'),
  });
  const connect = useMutation({
    mutationFn: () =>
      api.put('/v1/me/feishu', {
        url: url.trim(),
        ...(secret.trim() ? { secret: secret.trim() } : {}),
        language: lang,
      }),
    onSuccess: async () => {
      setUrl('');
      setSecret('');
      await refresh();
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api.delete('/v1/me/feishu'),
    onSuccess: () => refresh(),
  });
  return (
    <Panel
      icon={<MessageCircle size={16} />}
      title={
        <TitleWithChip chip={status?.connected ? <Chip tone="ok">{t('Connected', '已连接')}</Chip> : null}>
          {t('Feishu notifications', '飞书通知')}
        </TitleWithChip>
      }
      description={t(
        'New items go to your own Feishu group bot as they arrive, even with your computer off; sender and title only.',
        '新消息、申请和邀请一到就发到你自己的飞书群机器人，电脑关着也能收到；只含发件人和标题。',
      )}
    >
      {status?.connected && app.data?.linked ? (
        <p className="text-sm text-muted">
          {t(
            'Your linked Feishu account gets the notices while it is linked, so this group bot is not used.',
            '你的飞书账号已绑定，提醒会发到账号里，这个群机器人暂时不再使用。',
          )}
        </p>
      ) : null}
      {status?.connected ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="min-w-0 break-all text-fg-2">
            {t(`Bot address ${status.url_hint}`, `机器人地址 ${status.url_hint}`)}
            {status.has_secret ? t(' · signed', ' · 已启用签名') : ''}
          </span>
          <Button variant="danger" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
            {t('Disconnect', '断开')}
          </Button>
        </div>
      ) : (
        <>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-fg-2 marker:text-dim">
            <li>
              {t(
                'In Feishu, open a group that only you are in (or ask your agent to create one with lark-cli).',
                '在飞书里打开一个只有你自己的群（也可以让 Agent 用 lark-cli 帮你建好）。',
              )}
            </li>
            <li>
              {t(
                'Group settings → Group bots → Add bot → Custom bot → Add, then copy its webhook address.',
                '群设置 → 群机器人 → 添加机器人 → 自定义机器人 → 添加，复制它的 webhook 地址。',
              )}
            </li>
            <li>
              {t(
                'Optional but recommended: in the bot’s security settings turn on signature verification and paste the secret below, or set the keyword "AgentDrop".',
                '可选但推荐：在机器人的安全设置里开启「签名校验」并把密钥填在下面，或设置自定义关键词「AgentDrop」。',
              )}
            </li>
            <li>
              {t(
                'Paste the address here and connect; a test message is sent to the group.',
                '把地址贴到这里并连接，会往群里发一条测试消息。',
              )}
            </li>
          </ol>
          <div className="grid gap-3 sm:grid-cols-[3fr_2fr]">
            <Field label={t('Webhook address', 'Webhook 地址')}>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
              />
            </Field>
            <Field label={t('Signature secret (optional)', '签名密钥（可选）')}>
              <Input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button disabled={!url.trim() || connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending
                ? t('Sending test message…', '正在发测试消息…')
                : t('Connect and send a test', '连接并发送测试')}
            </Button>
          </div>
        </>
      )}
      {connect.isError ? <ErrorBox error={connect.error} /> : null}
      {disconnect.isError ? <ErrorBox error={disconnect.error} /> : null}
    </Panel>
  );
}

const FEISHU_APP_KEY = ['feishu-app'];

/**
 * Linking a Feishu account to the server's own Feishu app (ADR 0039, docs/FEISHU.md): the person gets a one-time
 * code, opens the bot in Feishu and sends it the code; from then on notices arrive there as cards that can be marked
 * read or starred. Shown only when the server has an app configured.
 */
export function FeishuAppCard() {
  const t = useT();
  const lang = useLang();
  const qc = useQueryClient();
  const [code, setCode] = useState<FeishuLinkCode | null>(null);
  const view = useQuery({
    queryKey: FEISHU_APP_KEY,
    queryFn: () => api.get<FeishuAppView>('/v1/me/feishu-app'),
    // while a code is waiting to be sent, notice the link as soon as the bot has it
    refetchInterval: code && !codeExpired(code) ? 3000 : false,
  });
  const linked = view.data?.linked === true;
  const getCode = useMutation({
    mutationFn: () => api.post<FeishuLinkCode>('/v1/me/feishu-app/code', { language: lang }),
    onSuccess: (c) => setCode(c),
  });
  const unlink = useMutation({
    mutationFn: () => api.delete<FeishuAppView>('/v1/me/feishu-app'),
    onSuccess: (v) => {
      setCode(null);
      qc.setQueryData(FEISHU_APP_KEY, v);
    },
  });
  if (!view.data?.available) return null;
  return (
    <div id="feishu">
      <Panel
        icon={<MessagesSquare size={16} />}
        title={
          <TitleWithChip chip={linked ? <Chip tone="ok">{t('Linked', '已绑定')}</Chip> : null}>
            {t('Feishu account', '飞书账号')}
          </TitleWithChip>
        }
        description={t(
          'Notices arrive as cards in a chat with this server’s AgentDrop bot, each once; mark them read or star them right there. Sender and title only.',
          '提醒以卡片发到你和本服务器 AgentDrop 机器人的单聊里，每条一次，可以直接在飞书里标为已读或收藏。只含发件人和标题。',
        )}
      >
        {linked ? (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className="text-fg-2">
              {view.data?.linked_at
                ? t(
                    `Linked ${formatDateTime(view.data.linked_at, lang)}`,
                    `绑定于 ${formatDateTime(view.data.linked_at, lang)}`,
                  )
                : t('Linked', '已绑定')}
            </span>
            <Button variant="danger" disabled={unlink.isPending} onClick={() => unlink.mutate()}>
              {t('Disconnect', '解绑')}
            </Button>
          </div>
        ) : (
          <>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-fg-2 marker:text-dim">
              <li>
                {t(
                  'Get a one-time code below (valid for 10 minutes).',
                  '在下面获取一个一次性代码（10 分钟内有效）。',
                )}
              </li>
              <li>
                {t(
                  'Open the AgentDrop bot in Feishu and send it the code.',
                  '在飞书里打开 AgentDrop 机器人，把代码发给它。',
                )}
              </li>
              <li>
                {t(
                  'The bot answers “Connected”; this page updates by itself.',
                  '机器人回复「已连接」，这个页面会自动更新。',
                )}
              </li>
            </ol>
            {code && !codeExpired(code) ? (
              <div className="flex flex-wrap items-center gap-3">
                <output
                  aria-label={t('Code to send to the bot', '发给机器人的代码')}
                  className="rounded-lg border border-line-strong bg-surface-2 px-3 py-1.5 font-mono text-lg tracking-widest text-fg"
                >
                  {code.code}
                </output>
                <a
                  href={code.bot_link}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface-2 px-3 text-sm font-medium text-fg hover:border-accent/40"
                >
                  {t('Open the bot in Feishu', '在飞书里打开机器人')}
                </a>
              </div>
            ) : (
              <div className="flex justify-end">
                <Button disabled={getCode.isPending} onClick={() => getCode.mutate()}>
                  {code ? t('Get a new code', '重新获取代码') : t('Get a code', '获取代码')}
                </Button>
              </div>
            )}
          </>
        )}
        {getCode.isError ? <ErrorBox error={getCode.error} /> : null}
        {unlink.isError ? <ErrorBox error={unlink.error} /> : null}
      </Panel>
    </div>
  );
}

/** Terms as the person typed them: one per line or separated by commas; empty pieces dropped. */
export function splitWatchTerms(text: string): string[] {
  return text
    .split(/[\n,，、]/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

/**
 * Watch terms (ADR 0041): when a bot posts in a Feishu group the person is in and the AgentDrop bot was added to,
 * a message containing one of these words reaches them at once as a direct message from the AgentDrop assistant.
 * Shown only when the server has a Feishu app; the terms are kept while Feishu is not linked.
 */
export function FeishuWatchCard() {
  const t = useT();
  const qc = useQueryClient();
  const view = useQuery({
    queryKey: FEISHU_APP_KEY,
    queryFn: () => api.get<FeishuAppView>('/v1/me/feishu-app'),
  });
  const saved = (view.data?.watch_terms ?? []).join('\n');
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  const save = useMutation({
    mutationFn: () => api.put<FeishuAppView>('/v1/me/feishu-app/watch', { terms: splitWatchTerms(text) }),
    onSuccess: (v) => qc.setQueryData(FEISHU_APP_KEY, v),
  });
  if (!view.data?.available) return null;
  const count = view.data.watch_terms.length;
  const changed = splitWatchTerms(text).join('\n') !== saved;
  return (
    <div id="feishu-watch">
      <Panel
        icon={<GitPullRequest size={16} />}
        title={
          <TitleWithChip
            chip={count > 0 ? <Chip tone="ok">{t(`${count} watched`, `关注 ${count} 个`)}</Chip> : null}
          >
            {t('Updates from Feishu groups', '飞书群动态')}
          </TitleWithChip>
        }
        description={t(
          'When a bot posts in one of your Feishu groups (pull requests, CI, releases) and the message contains one of your watch terms, it reaches you at once as a message from the AgentDrop assistant. Add the AgentDrop bot to those groups first.',
          '你所在的飞书群里，机器人发的消息（PR、CI、发版等）只要包含下面任一关注词，就会立刻以 AgentDrop 助手的消息推给你。先把 AgentDrop 机器人拉进这些群。',
        )}
      >
        {!view.data.linked ? (
          <p className="text-sm text-muted">
            {t(
              'Link your Feishu account above first; until then nothing is matched.',
              '先在上面绑定飞书账号，绑定之前不会匹配任何消息。',
            )}
          </p>
        ) : null}
        <Field
          label={t(
            'Watch terms: one per line or separated by commas (repository, directory, ticket prefix, your name)',
            '关注词：每行一个或用逗号分隔（仓库名、目录、单号前缀、你的名字）',
          )}
        >
          <Textarea
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'agentdrop\napps/worker\nPAPER-'}
          />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted">
            {t(
              'Matching ignores case. Up to 30 terms, 2–64 characters each; at most 30 updates an hour.',
              '不区分大小写。最多 30 个，每个 2–64 个字符；每小时最多推 30 条。',
            )}
          </span>
          <Button disabled={!changed || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('Saving…', '正在保存…') : t('Save watch terms', '保存关注词')}
          </Button>
        </div>
        {save.isError ? <ErrorBox error={save.error} /> : null}
      </Panel>
    </div>
  );
}

function codeExpired(code: FeishuLinkCode): boolean {
  return Date.parse(code.expires_at) <= Date.now();
}
