import { useMutation } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api.js';
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
