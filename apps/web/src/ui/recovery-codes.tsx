import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '../lib/api.js';
import { useFormat } from '../lib/format.js';
import { useT } from '../lib/lang.js';
import { Chip, Panel } from './layout.jsx';
import { Button, copyText, ErrorBox, Field, Input, Loading } from './primitives.jsx';

interface RecoveryStatus {
  remaining: number;
  total: number;
  created_at: string | null;
}

/**
 * Settings → Account: ways back in without email or an administrator (ADR 0036). Recovery codes are made here
 * (the current password is asked again) and shown once; the device path is a terminal command.
 */
export function RecoveryCodesCard() {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['recovery-codes'],
    queryFn: () => api.get<RecoveryStatus>('/v1/me/recovery-codes'),
  });
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const generate = useMutation({
    mutationFn: (pw: string) =>
      api.post<{ codes: string[]; status: RecoveryStatus }>('/v1/me/recovery-codes', { password: pw }),
    onSuccess: (res) => {
      setCodes(res.codes);
      setAsking(false);
      setPassword('');
      qc.setQueryData(['recovery-codes'], res.status);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (password) generate.mutate(password);
  }

  const s = status.data;
  const text = codes ? `${t('AgentDrop recovery codes', 'AgentDrop 恢复码')}\n${codes.join('\n')}\n` : '';

  return (
    // a named region, so the card is one landmark people (and the e2e journey) can find
    <section aria-label={t('If you forget your password', '忘记密码时')}>
      <Panel
        icon={<KeyRound size={16} />}
        title={t('If you forget your password', '忘记密码时')}
        description={t(
          'Get back in without email or an administrator: with a recovery code and your sign-in email on the sign-in page, or from a computer where one of your agents is paired by running agentdrop account recover in a terminal.',
          '不用邮件、也不用找管理员就能找回：在登录页用恢复码加登录邮箱，或者在配对过 Agent 的电脑终端里运行 agentdrop account recover。',
        )}
      >
        {status.isLoading ? <Loading /> : null}
        {status.isError ? <ErrorBox error={status.error} retry={() => status.refetch()} /> : null}
        {s && !codes ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
            {s.total === 0 ? (
              t('No recovery codes yet.', '还没有生成恢复码。')
            ) : (
              <>
                <span>
                  {t(`${s.remaining} of ${s.total} codes left`, `还剩 ${s.remaining} / ${s.total} 个恢复码`)}
                  {s.created_at
                    ? ` · ${t(`made ${fmt.date(s.created_at)}`, `生成于 ${fmt.date(s.created_at)}`)}`
                    : ''}
                </span>
                {s.remaining <= 2 ? <Chip tone="warn">{t('Make new ones soon', '建议重新生成')}</Chip> : null}
              </>
            )}
          </p>
        ) : null}

        {codes ? (
          <div className="space-y-3">
            <p className="text-sm leading-6 text-fg-2" role="status">
              {t(
                'Shown only now. Keep them somewhere safe, such as a password manager or a printout; each code works once. Anyone with your email and one code can set a new password.',
                '只显示这一次。请保存在安全的地方，比如密码管理器或打印出来；每个恢复码只能用一次。知道你的邮箱和任意一个恢复码的人就能重设密码。',
              )}
            </p>
            <ul
              aria-label={t('Recovery codes', '恢复码')}
              className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-line bg-bg px-3 py-2 font-mono text-sm text-fg sm:grid-cols-5"
            >
              {codes.map((c) => (
                <li key={c} className="select-all">
                  {c}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() =>
                  copyText(text).then((ok) => {
                    setCopied(ok ? 'copied' : 'failed');
                    setTimeout(() => setCopied('idle'), 2000);
                  })
                }
              >
                {copied === 'copied'
                  ? t('Copied', '已复制')
                  : copied === 'failed'
                    ? t('Copy failed; select them manually', '复制失败，请手动选择')
                    : t('Copy codes', '复制恢复码')}
              </Button>
              <a
                className="inline-flex h-9 items-center rounded-md border border-line px-3 text-sm text-fg hover:bg-hover"
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
                download="agentdrop-recovery-codes.txt"
              >
                {t('Download as text', '下载为文本')}
              </a>
              <Button variant="ghost" onClick={() => setCodes(null)}>
                {t('I saved them', '我已保存')}
              </Button>
            </div>
          </div>
        ) : asking ? (
          <form onSubmit={submit} className="space-y-3">
            <Field
              label={t('Your current password', '当前密码')}
              {...(s && s.total > 0
                ? {
                    hint: t(
                      'New codes replace the old ones; those stop working.',
                      '新的恢复码会替换旧的，旧的立即失效。',
                    ),
                  }
                : {})}
            >
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                maxLength={256}
              />
            </Field>
            {generate.isError ? <ErrorBox error={generate.error} /> : null}
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={!password || generate.isPending}>
                {generate.isPending ? t('Generating…', '生成中…') : t('Generate codes', '生成恢复码')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setAsking(false);
                  setPassword('');
                  generate.reset();
                }}
              >
                {t('Cancel', '取消')}
              </Button>
            </div>
          </form>
        ) : s ? (
          <Button onClick={() => setAsking(true)}>
            {s.total === 0
              ? t('Generate recovery codes', '生成恢复码')
              : t('Generate new codes', '重新生成恢复码')}
          </Button>
        ) : null}
      </Panel>
    </section>
  );
}
