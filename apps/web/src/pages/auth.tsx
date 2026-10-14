import { Waypoints } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../lib/api.js';
import { humanError, LocalError } from '../lib/error-text.js';
import { useT } from '../lib/lang.js';
import { useSession } from '../lib/session.js';
import { setupCommands } from '../ui/needs-agent.jsx';
import { PreferenceToggles } from '../ui/preferences.jsx';
import { Button, CodeBlock, Field, Input } from '../ui/primitives.jsx';

/** The product mark and name, as in the app's sidebar. */
export function Brand({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <span className="brand-mark" aria-hidden="true">
        <Waypoints size={15} strokeWidth={2.25} />
      </span>
      <span className="text-md font-semibold tracking-tight text-fg">AgentDrop</span>
    </div>
  );
}

/** A form's error line: one sentence, announced when it appears. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-lg border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger"
      role="alert"
    >
      {children}
    </div>
  );
}

/** A form's "done" line. */
export function FormNotice({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-lg border border-ok-line bg-ok-bg px-3 py-2 text-sm leading-5 text-fg-2"
      role="status"
    >
      {children}
    </div>
  );
}

/** A text link on the entry pages. */
export const entryLink = 'font-medium text-accent-fg underline underline-offset-2 hover:decoration-2';

/** Background, preference switches and brand for the pages people see outside the app: one centred card. */
export function EntryCard({
  title,
  description,
  children,
  wide = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <main className="bg-mesh relative flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-16 sm:px-6">
      <PreferenceToggles className="absolute right-4 top-4 z-10" />
      <Brand />
      <section
        className={`card w-full animate-fade-in space-y-5 rounded-xl p-6 text-sm leading-6 text-fg-2 sm:p-8 ${
          wide ? 'max-w-lg' : 'max-w-md'
        }`}
      >
        {title ? (
          <header className="space-y-1">
            <h1 className="text-lg font-semibold tracking-tight text-fg">{title}</h1>
            {description ? <p className="text-sm leading-6 text-muted">{description}</p> : null}
          </header>
        ) : null}
        {children}
      </section>
    </main>
  );
}

/**
 * Sign-in, sign-up and password pages: what AgentDrop is and how to start on the left, the form card on the right.
 * Below `lg` the form comes first and the introduction follows it.
 */
export function Shell({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  /** The link to the neighbouring page ("No account yet? Sign up"), under a hairline at the card's foot. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const steps = [
    {
      title: t('Install and pair an agent', '安装并配对 Agent'),
      text: t('Your agent gets its own mailbox on this server.', 'Agent 在这台服务器上有了自己的收件箱。'),
    },
    {
      title: t('Add a colleague', '添加同事'),
      text: t('Invite them by username or with a link.', '用用户名或邀请链接把对方加为联系人。'),
    },
    {
      title: t('Send results as messages', '用消息发送成果'),
      text: t(
        'Your agent sends results, files and context to theirs.',
        '你的 Agent 把结果、文件和上下文直接发到对方的 Agent。',
      ),
    },
  ];
  return (
    <main className="bg-mesh relative flex min-h-dvh flex-col px-4 py-16 sm:px-8 lg:py-12">
      <PreferenceToggles className="absolute right-4 top-4 z-10" />
      <div className="m-auto grid w-full max-w-5xl gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-stretch">
        <section
          aria-labelledby="brand-heading"
          className="order-2 flex min-w-0 flex-col justify-center lg:order-1"
        >
          <Brand className="mb-10 hidden lg:flex" />
          <h1
            id="brand-heading"
            className="text-xl font-semibold tracking-tight text-fg lg:text-4xl lg:leading-tight"
          >
            {t('Deliver results straight', '让成果直接抵达')} <br className="hidden sm:block" />
            <span className="text-accent-fg">{t('to the next agent.', '下一个 Agent。')}</span>
          </h1>
          <p className="mt-3 text-base text-muted">
            {t(
              'Send results and pass context along, without copy and paste.',
              '发送结果、传递上下文，不再依赖复制粘贴。',
            )}
          </p>
          <ol className="mt-8 space-y-4">
            {steps.map((step, i) => (
              <li key={step.title} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="mt-px inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/10 text-xs font-semibold tabular-nums text-accent-fg"
                >
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">{step.title}</p>
                  <p className="text-sm text-muted">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-8 space-y-2">
            <p className="text-sm text-fg-2">
              {t(
                'To start, run this in a terminal on your computer. It opens a page where you sign in and confirm the pairing.',
                '开始时，在你电脑的终端里运行下面的命令。它会打开一个网页，在那里登录并确认配对即可。',
              )}
            </p>
            <CodeBlock code={setupCommands()} />
            <p className="text-xs text-dim">
              {t(
                'Works with Codex CLI, Claude Code, opencode, Cursor and oh-my-pi.',
                '支持 Codex CLI、Claude Code、opencode、Cursor 和 oh-my-pi。',
              )}
            </p>
          </div>
        </section>
        <div className="order-1 flex min-w-0 flex-col gap-6 lg:order-2">
          <Brand className="justify-center lg:hidden" />
          <section
            aria-labelledby="auth-heading"
            className="card mx-auto flex w-full max-w-md flex-1 flex-col rounded-xl p-6 sm:p-8"
          >
            <div className="flex flex-1 flex-col justify-center space-y-6">
              <div className="space-y-1">
                <h2 id="auth-heading" className="text-lg font-semibold tracking-tight text-fg">
                  {title}
                </h2>
                {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
              </div>
              {children}
            </div>
            {footer ? <div className="mt-8 border-t border-line pt-5">{footer}</div> : null}
          </section>
        </div>
      </div>
    </main>
  );
}

export function LoginPage() {
  const t = useT();
  const { refresh } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get('next');
  const resetDone = params.get('reset') === 'done';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      // Sign-in allows a few attempts per address: behind a shared office or lab network that is easy to reach, and
      // "wrong password" would send the person hunting for a typo that is not there.
      if (res.status === 429)
        throw new LocalError({
          en: 'Too many sign-in attempts from this network. Wait a few seconds and try again.',
          zh: '这个网络的登录尝试太频繁了，请等几秒再试。',
        });
      if (!res.ok) throw new LocalError({ en: 'Wrong email or password.', zh: '邮箱或密码不正确' });
      await refresh();
      // Back to an invite link: the person already chose to accept it by logging in from there.
      nav(next ?? '/app/inbox', next?.startsWith('/invite/') ? { state: { acceptInvite: true } } : undefined);
    } catch (err) {
      setError(humanError(err).text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      title={t('Sign in', '登录')}
      subtitle={t('Enter your agent workspace.', '进入你的 Agent 协作空间。')}
      footer={
        <p className="text-sm text-muted">
          {t('No account yet? ', '还没有账号？')}
          <Link className={entryLink} to={next ? `/signup?next=${encodeURIComponent(next)}` : '/signup'}>
            {t('Sign up', '注册')}
          </Link>
        </p>
      }
    >
      {resetDone ? (
        <FormNotice>
          {t(
            'Password reset. Sign in with your new password. Web sessions on other devices have been signed out.',
            '密码已重置，请用新密码登录。其他设备上的网页登录已退出。',
          )}
        </FormNotice>
      ) : null}
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('Email', '邮箱')}>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </Field>
        <div className="space-y-1.5">
          <Field label={t('Password', '密码')}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </Field>
          <div className="text-right text-xs">
            <Link className="text-muted hover:text-accent-fg hover:underline" to="/forgot-password">
              {t('Forgot password', '忘记密码')}
            </Link>
          </div>
        </div>
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" disabled={busy} className="h-9 w-full">
          {t('Sign in', '登录')}
        </Button>
      </form>
    </Shell>
  );
}

export function SignupPage() {
  const t = useT();
  const { refresh } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ email: '', password: '', handle: '', display_name: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // the operator can close sign-up at runtime; ask before showing a form that would only 403
  const [mode, setMode] = useState<'open' | 'closed' | null>(null);
  const next = params.get('next');
  useEffect(() => {
    api
      .get<{ mode: 'open' | 'closed' }>('/v1/auth/signup-policy')
      .then((p) => setMode(p.mode))
      .catch(() => setMode('open'));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // arriving from a contact invite link (/invite/<token>): the inviter's contact request waits for the new
      // account, which accepts it on Contacts once an agent is paired (ADR 0014)
      const inviteToken = /^\/invite\/([A-Za-z0-9_-]+)$/.exec(next ?? '')?.[1];
      await api.post('/v1/auth/sign-up', inviteToken ? { ...form, invite_token: inviteToken } : form);
      await refresh();
      nav(
        next ?? '/app/agents',
        next?.startsWith('/invite/') ? { state: { acceptInvite: true } } : undefined,
      );
    } catch (err) {
      setError(humanError(err).text);
    } finally {
      setBusy(false);
    }
  }
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const signIn = (
    <p className="text-sm text-muted">
      {t('Already have an account? ', '已有账号？')}
      <Link className={entryLink} to={next ? `/login?next=${encodeURIComponent(next)}` : '/login'}>
        {t('Sign in', '登录')}
      </Link>
    </p>
  );

  if (mode === 'closed')
    return (
      <Shell title={t('Sign-up is closed', '注册已关闭')} footer={signIn}>
        <p className="text-sm leading-6 text-fg-2">
          {t(
            "This server doesn't allow self-service sign-up. If you should have an account, ask whoever runs this server.",
            '这台服务器目前不开放自助注册。如果你应该有账号，请向运营这台服务器的人索取。',
          )}
        </p>
      </Shell>
    );

  return (
    <Shell
      title={t('Sign up', '注册')}
      subtitle={t('Create an account, then pair your first agent.', '创建账号，然后配对你的第一个 Agent。')}
      footer={signIn}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('Email', '邮箱')}>
          <Input type="email" value={form.email} onChange={set('email')} required autoComplete="email" />
        </Field>
        <Field label={t('Password', '密码')} hint={t('At least 10 characters', '至少 10 个字符')}>
          <Input
            type="password"
            value={form.password}
            onChange={set('password')}
            required
            minLength={10}
            autoComplete="new-password"
          />
        </Field>
        <Field
          label={t('Username', '用户名')}
          hint={t(
            "Lowercase letters, digits and underscores; can't be changed later",
            '小写字母、数字、下划线；注册后不可改',
          )}
        >
          <Input value={form.handle} onChange={set('handle')} required placeholder="wang" />
        </Field>
        <Field
          label={t('Display name', '公开昵称')}
          hint={t('Change it any time; need not be unique', '可随时修改，可重名')}
        >
          <Input
            value={form.display_name}
            onChange={set('display_name')}
            required
            placeholder={t('Alex Wang', '王同学')}
          />
        </Field>
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" disabled={busy} className="h-9 w-full">
          {t('Create account', '创建账号')}
        </Button>
      </form>
    </Shell>
  );
}
