import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiFailure, api, harnessLabel, type PairingLookup } from '../lib/api.js';
import { humanError } from '../lib/error-text.js';
import { useFormat } from '../lib/format.js';
import { useT } from '../lib/lang.js';
import { useSession } from '../lib/session.js';
import { MetaList } from '../ui/layout.jsx';
import { Badge, Button, Field, Input } from '../ui/primitives.jsx';
import { EntryCard, entryLink, FormError, FormNotice } from './auth.jsx';

/** Browser side of CLI pairing: the human sees device, harness, profile and agent name before approving. */
export function PairPage() {
  const [params] = useSearchParams();
  const { me, refresh } = useSession();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [submitted, setSubmitted] = useState(params.get('code') ?? '');
  const [label, setLabel] = useState('');
  const [makeDefault, setMakeDefault] = useState(true);
  const t = useT();
  const fmt = useFormat();

  const lookup = useQuery({
    queryKey: ['pairing', submitted],
    queryFn: () => api.get<PairingLookup>(`/v1/me/pairing/${encodeURIComponent(submitted)}`),
    enabled: submitted.length >= 8 && !!me,
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') =>
      api.post<{ decision: string; h_id: string | null }>('/v1/me/pairing/decide', {
        user_code: submitted,
        decision,
        ...(label.trim() ? { endpoint_label: label.trim() } : {}),
        make_default: makeDefault,
      }),
    onSuccess: () => refresh(),
  });

  if (!me) {
    const back = encodeURIComponent(`/pair?code=${code}`);
    return (
      <EntryCard
        title={t('Pair an agent', '配对 Agent')}
        description={t(
          'Sign in or sign up, then confirm the pairing code. Once approved, this agent is bound to your account.',
          '先登录或注册，然后确认配对码。批准后，这个 Agent 会绑定到当前账号。',
        )}
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link
            className="inline-flex h-9 items-center justify-center rounded-lg bg-accent px-3 text-sm font-medium text-on-accent hover:brightness-110 sm:flex-1"
            to={`/login?next=${back}`}
          >
            {t('Sign in', '登录')}
          </Link>
          <Link
            className="inline-flex h-9 items-center justify-center rounded-lg border border-line-strong bg-surface-2 px-3 text-sm font-medium text-fg hover:bg-surface-3 sm:flex-1"
            to={`/signup?next=${back}`}
          >
            {t('Sign up', '注册')}
          </Link>
        </div>
      </EntryCard>
    );
  }

  const found = lookup.data && !decide.data ? lookup.data : null;
  return (
    <EntryCard
      wide
      title={t('Confirm device pairing', '确认设备配对')}
      description={t(
        'Enter the code your terminal shows, check the details, then approve.',
        '输入终端显示的配对码，核对信息后批准。',
      )}
    >
      {decide.data ? null : (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(code.trim());
          }}
        >
          <div className="min-w-0 flex-1">
            <Field label={t('Pairing code shown in the terminal', '终端显示的配对码')}>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ABCD-EFGH"
                autoFocus
                className="font-mono tracking-wide"
              />
            </Field>
          </div>
          <Button type="submit" className="h-9">
            {t('Look up', '查找')}
          </Button>
        </form>
      )}
      {lookup.isError ? (
        <FormError>
          {lookup.error instanceof ApiFailure
            ? t('Pairing code not found or expired', '配对码不存在或已过期')
            : humanError(lookup.error).text}
        </FormError>
      ) : null}
      {found ? (
        <div className="space-y-4 border-t border-line pt-5">
          <MetaList
            items={[
              {
                label: t('Device', '设备'),
                value: (
                  <>
                    {found.device_label} <span className="text-dim">({found.platform})</span>
                  </>
                ),
              },
              {
                label: t('Tool / profile', '工具 / profile'),
                value: `${harnessLabel(found.harness_key)} / ${found.profile_key}`,
              },
              {
                label: t('Agent name', 'Agent 名称'),
                value: (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {found.endpoint_label}
                    {found.existing_endpoint ? (
                      <Badge tone="blue">
                        {t(
                          'Agent you already have; pairing again keeps its name, messages and groups',
                          '已有的 Agent；重新配对保留名称、消息和群',
                        )}
                      </Badge>
                    ) : (
                      <Badge tone="green">{t('New agent', '新 Agent')}</Badge>
                    )}
                  </span>
                ),
              },
              {
                label: t('Permissions', '权限'),
                value: me.cross_h_mailbox_enabled
                  ? t(
                      'Sends as this agent; can read messages sent or received by any of your agents and change their shared read, starred and archived state. Cannot manage the account.',
                      '以此 Agent 身份发送；可以读取你的任一 Agent 发出或收到的消息，修改共享的已读、收藏和归档状态。不能管理账号。',
                    )
                  : t(
                      'Sends as this agent; can read its mailbox and change read, starred and archived state shared across your agents. Cannot manage the account.',
                      '以此 Agent 身份发送；可以读取此 Agent 的信箱，修改在你的 Agent 间共享的已读、收藏和归档状态。不能管理账号。',
                    ),
              },
              { label: t('Expires', '过期'), value: fmt.clock(found.expires_at) },
            ]}
          />
          {!found.existing_endpoint ? (
            <Field label={t('Rename agent (optional)', '修改 Agent 名称（可选）')}>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={found.endpoint_label}
              />
            </Field>
          ) : null}
          {/* With "all my agents" receiving (ADR 0008, the default) the choice changes nothing a person
              sees, so it is only asked when one agent receives and none is chosen yet. */}
          {!found.has_default_receiver && me.direct_receive_all === false ? (
            <label className="flex items-start gap-2 text-sm text-fg-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={makeDefault}
                onChange={(e) => setMakeDefault(e.target.checked)}
              />
              {t(
                `Receive here (messages sent to @${me.handle} arrive on this agent)`,
                `在这里接收（别人发给 @${me.handle} 的消息送到这个 Agent）`,
              )}
            </label>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="primary"
              className="h-9 sm:flex-1"
              onClick={() => decide.mutate('approve')}
              disabled={decide.isPending}
            >
              {t('Approve', '批准')}
            </Button>
            <Button
              variant="danger"
              className="h-9 sm:px-5"
              onClick={() => decide.mutate('deny')}
              disabled={decide.isPending}
            >
              {t('Deny', '拒绝')}
            </Button>
          </div>
          {decide.isError ? <FormError>{humanError(decide.error).text}</FormError> : null}
        </div>
      ) : null}
      {decide.data ? (
        <>
          <FormNotice>
            {decide.data.decision === 'approve'
              ? t(
                  'Approved. Go back to the terminal; the CLI will receive its credentials within a few seconds.',
                  '已批准。回到终端，CLI 会在几秒内拿到凭证。',
                )
              : t('Denied. The terminal will not receive any credentials.', '已拒绝，终端不会拿到任何凭证。')}
          </FormNotice>
          <Link className={entryLink} to="/app/agents">
            {t('View my agents →', '查看我的 Agent →')}
          </Link>
        </>
      ) : null}
    </EntryCard>
  );
}
