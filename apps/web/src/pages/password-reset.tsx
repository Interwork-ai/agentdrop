import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiFailure, api } from '../lib/api.js';
import { humanError } from '../lib/error-text.js';
import { useT } from '../lib/lang.js';
import { Button, Field, Input } from '../ui/primitives.jsx';
import { entryLink, FormError, Shell } from './auth.jsx';

type ResetChannel = 'email' | 'admin';

/**
 * Public: every way back in this server offers (ADR 0036). A recovery code with the sign-in email and the device
 * path (`agentdrop account recover`) work everywhere; email only where the server sends mail; an administrator is
 * the last resort.
 */
export function ForgotPasswordPage() {
  const t = useT();
  const [channel, setChannel] = useState<ResetChannel | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    api
      .get<{ password_reset?: ResetChannel }>('/v1/auth/signup-policy')
      // an older server without the field cannot mail either
      .then((p) => setChannel(p.password_reset ?? 'admin'))
      .catch(() => setChannel('email'));
  }, []);

  const back = (
    <p className="text-sm text-muted">
      {t('Remembered it? ', '想起来了？')}
      <Link className={entryLink} to="/login">
        {t('Back to sign in', '返回登录')}
      </Link>
    </p>
  );

  if (sent)
    return (
      <Shell
        title={t('Check your email', '查看邮箱')}
        subtitle={t('A reset link is on its way.', '重置链接已发出。')}
        footer={back}
      >
        <p className="text-sm leading-6 text-fg-2">
          {t(
            "If this email has an account, you'll receive a message. Open the link in it to set a new password; the link works once, within 1 hour. If it doesn't arrive, check your spam folder or request another one later.",
            '如果该邮箱已注册，你会收到一封邮件。打开邮件里的链接设置新密码，链接 1 小时内有效、只能使用一次。没收到的话先看看垃圾邮件，或稍后重新申请。',
          )}
        </p>
      </Shell>
    );

  return (
    <Shell
      title={t('Forgot password', '找回密码')}
      subtitle={t('Pick whichever way you have at hand.', '用你手边方便的任意一种方式。')}
      footer={back}
    >
      <div className="space-y-6">
        {channel === 'email' ? (
          <EmailReset onSent={() => setSent(true)} onNoMail={() => setChannel('admin')} />
        ) : null}
        <RecoveryCodeForm />
        <section aria-labelledby="recover-device" className="space-y-1.5">
          <h2 id="recover-device" className="text-sm font-medium text-fg">
            {t('From your computer', '在你的电脑上')}
          </h2>
          <p className="text-sm leading-6 text-fg-2">
            {t(
              'On a computer where one of your agents is paired, type this in a terminal; it prints a link to set a new password:',
              '在配对过 Agent 的电脑上，在终端里输入下面这条命令，它会给出设置新密码的链接：',
            )}
          </p>
          <code className="block select-all rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-xs text-fg">
            agentdrop account recover
          </code>
        </section>
        {channel === 'admin' ? (
          <p className="text-xs leading-5 text-muted">
            {t(
              'Neither works? An administrator of this server can make a reset link for you under Admin → Users.',
              '都用不了？这台服务器的管理员可以在「管理 → 用户」里为你生成重置链接。',
            )}
          </p>
        ) : null}
      </div>
    </Shell>
  );
}

function EmailReset({ onSent, onNoMail }: { onSent: () => void; onNoMail: () => void }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/request-password-reset', { email: email.trim() });
      // the same answer whether or not the address has an account
      onSent();
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 429)
        setError(t('Too many requests. Try again later.', '请求太频繁，请稍后再试。'));
      else if (err instanceof ApiFailure && err.status === 403) onNoMail();
      else setError(humanError(err).text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-labelledby="recover-email">
      <h2 id="recover-email" className="text-sm font-medium text-fg">
        {t('By email', '通过邮件')}
      </h2>
      <Field label={t('The email you signed up with', '注册时用的邮箱')}>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
      </Field>
      {error ? <FormError>{error}</FormError> : null}
      <Button type="submit" variant="primary" disabled={busy} className="h-9 w-full">
        {t('Send reset link', '发送重置链接')}
      </Button>
    </form>
  );
}

/** A recovery code plus the sign-in email: the server answers with a one-time reset link, opened right away. */
function RecoveryCodeForm() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ url: string }>('/v1/auth/recover-with-code', {
        email: email.trim(),
        code: code.trim(),
      });
      window.location.assign(res.url);
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 429)
        setError(t('Too many attempts. Try again in an hour.', '尝试次数太多，请一小时后再试。'));
      else setError(humanError(err).text);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-labelledby="recover-code">
      <h2 id="recover-code" className="text-sm font-medium text-fg">
        {t('With a recovery code', '用恢复码')}
      </h2>
      <Field label={t('Sign-in email', '登录邮箱')}>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
      </Field>
      <Field
        label={t('Recovery code', '恢复码')}
        hint={t(
          'One of the codes you saved from Settings, like k7m2-q9xa-3fpw',
          '在设置里保存的恢复码之一，形如 k7m2-q9xa-3fpw',
        )}
      >
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          autoComplete="one-time-code"
          spellCheck={false}
          maxLength={64}
        />
      </Field>
      {error ? <FormError>{error}</FormError> : null}
      <Button type="submit" disabled={busy} className="h-9 w-full">
        {busy ? t('Checking…', '核对中…') : t('Continue', '继续')}
      </Button>
    </form>
  );
}

/** Public: sets a new password with the one-time token from the email or from an administrator. */
export function ResetPasswordPage() {
  const t = useT();
  const nav = useNavigate();
  // read once, then drop it from the address bar so it does not linger in history or screenshots
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') ?? '');
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
  }, []);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10)
      return setError(t('The new password needs at least 10 characters.', '新密码至少 10 个字符。'));
    if (password !== confirm) return setError(t("The passwords don't match.", '两次输入的密码不一致。'));
    setBusy(true);
    try {
      await api.post('/api/auth/reset-password', { token, newPassword: password });
      nav('/login?reset=done', { replace: true });
    } catch (err) {
      const code = err instanceof ApiFailure ? String(err.body.code) : '';
      if (code === 'INVALID_TOKEN')
        setError(
          t(
            'This link is invalid or has expired (it works once, within 1 hour). Go back to sign in and choose "Forgot password" to get a new one.',
            '链接无效或已过期（有效期 1 小时，只能用一次）。请回到登录页点「忘记密码」重新申请。',
          ),
        );
      else if (code === 'PASSWORD_TOO_SHORT')
        setError(t('The new password needs at least 10 characters.', '新密码至少 10 个字符。'));
      else if (code === 'PASSWORD_TOO_LONG') setError(t('The new password is too long.', '新密码太长了。'));
      else setError(humanError(err).text);
    } finally {
      setBusy(false);
    }
  }

  if (!token)
    return (
      <Shell
        title={t('Reset password', '重置密码')}
        footer={
          <p className="text-sm text-muted">
            <Link className={entryLink} to="/forgot-password">
              {t('Request a new link', '重新申请')}
            </Link>
          </p>
        }
      >
        <p className="text-sm leading-6 text-fg-2">
          {t(
            'This link is incomplete. Open it again from where you got it, or get a new one.',
            '这个链接不完整。请从拿到它的地方重新打开，或者重新获取一个。',
          )}
        </p>
      </Shell>
    );

  return (
    <Shell
      title={t('Set a new password', '设置新密码')}
      subtitle={t('Choose a new password for your account.', '为你的账号设置一个新密码。')}
      footer={
        <p className="text-xs leading-5 text-muted">
          {t(
            'Saving signs out web sessions on all devices; paired agents are not affected.',
            '保存后，所有设备上的网页登录都会退出；已配对的 Agent 不受影响。',
          )}
        </p>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('New password', '新密码')} hint={t('At least 10 characters', '至少 10 个字符')}>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={10}
            maxLength={256}
            autoComplete="new-password"
          />
        </Field>
        <Field label={t('Enter it again', '再输入一次')}>
          <Input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={10}
            maxLength={256}
            autoComplete="new-password"
          />
        </Field>
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" disabled={busy} className="h-9 w-full">
          {t('Save new password', '保存新密码')}
        </Button>
      </form>
    </Shell>
  );
}
