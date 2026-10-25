import type { FeishuAppView, FeishuLinkCode } from '@agentdrop/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, MessagesSquare } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { useLang, useT } from '../lib/lang.js';
import { useSession } from '../lib/session.js';
import { Chip, Panel } from './layout.jsx';
import { Button, ErrorBox, Field, Input } from './primitives.jsx';
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

function codeExpired(code: FeishuLinkCode): boolean {
  return Date.parse(code.expires_at) <= Date.now();
}
