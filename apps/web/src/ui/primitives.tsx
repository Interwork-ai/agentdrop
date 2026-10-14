import { type ComponentPropsWithRef, type ReactNode, type TextareaHTMLAttributes, useState } from 'react';
import { humanError } from '../lib/error-text.js';
import { useLang, useT } from '../lib/lang.js';

export function Button({
  variant = 'default',
  className = '',
  ...props
}: ComponentPropsWithRef<'button'> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' }) {
  const base =
    'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-[background-color,border-color,color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-40';
  const v =
    variant === 'primary'
      ? 'bg-accent text-on-accent hover:brightness-110'
      : variant === 'danger'
        ? 'border border-danger-line bg-danger-bg text-danger hover:border-danger'
        : variant === 'ghost'
          ? 'text-fg-2 hover:bg-hover hover:text-fg'
          : 'border border-line-strong bg-surface-2 text-fg hover:border-accent/40 hover:bg-surface-3';
  return <button type="button" className={`${base} ${v} ${className}`} {...props} />;
}

const control =
  'w-full rounded-lg border border-line-strong bg-surface-2 text-sm text-fg placeholder:text-dim transition-[border-color,box-shadow] duration-150 focus:border-accent/60 focus:ring-3 focus:ring-accent/15 focus:outline-none';

export function Input({ className = '', ...props }: ComponentPropsWithRef<'input'>) {
  return <input className={`${control} h-9 px-3 ${className}`} {...props} />;
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${control} px-3 py-2 ${className}`} {...props} />;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is always passed as children
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-fg-2">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-dim">{hint}</span> : null}
    </label>
  );
}

export function Badge({
  children,
  tone = 'zinc',
}: {
  children: ReactNode;
  tone?: 'zinc' | 'blue' | 'green' | 'amber' | 'red';
}) {
  const t: Record<string, string> = {
    zinc: 'bg-hover text-fg-2 ring-line-strong',
    blue: 'bg-accent/12 text-accent-fg ring-accent/25',
    green: 'bg-ok-bg text-ok ring-ok-line',
    amber: 'bg-warn-bg text-warn ring-warn-line',
    red: 'bg-danger-bg text-danger ring-danger-line',
  };
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-px text-xs font-medium ring-1 ring-inset ${t[tone]}`}
    >
      {children}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full w-full min-h-[12rem] flex-1 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="max-w-md space-y-3">
        <div className="text-md font-semibold text-fg">{title}</div>
        {children ? <div className="space-y-3 text-sm leading-6 text-muted">{children}</div> : null}
      </div>
    </div>
  );
}

export function ErrorBox({
  error,
  retry,
  children,
}: {
  error: unknown;
  retry?: () => void;
  /** Extra, error-specific detail (e.g. which handles were unknown), shown under the message. */
  children?: ReactNode;
}) {
  // The server's message and next_action are written for programs and models; people get humanError's sentence.
  const lang = useLang();
  const t = useT();
  const { text, detail } = humanError(error, lang);
  return (
    <div
      className="m-3 rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger"
      role="alert"
      title={detail}
    >
      <div className="font-medium">{text}</div>
      {children ? <div className="mt-1.5 text-xs text-danger">{children}</div> : null}
      {retry ? (
        <Button className="mt-2" onClick={retry}>
          {t('Retry', '重试')}
        </Button>
      ) : null}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-muted" aria-busy="true">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      {label ?? t('Loading…', '加载中…')}
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="glass sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-line px-4 md:px-6">
      <h1 className="text-md font-semibold">{title}</h1>
      {children ? <div className="flex items-center gap-2">{children}</div> : null}
    </div>
  );
}

/**
 * Copies text even on plain-http origins, where `navigator.clipboard` is undefined (it needs a secure context):
 * falls back to a temporary textarea + execCommand. Returns false when neither route worked.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Install / CLI snippet with a copy control. Commands are copied verbatim. */
export function CodeBlock({ code }: { code: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const t = useT();
  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-bg text-left">
      <div className="flex h-8 items-center justify-between border-b border-line px-3">
        <span className="text-xs font-medium text-dim">{t('Terminal', '终端')}</span>
        <button
          type="button"
          className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors hover:bg-hover ${
            state === 'copied' ? 'text-ok' : state === 'failed' ? 'text-warn' : 'text-muted hover:text-fg'
          }`}
          onClick={() => {
            copyText(code).then((ok) => {
              setState(ok ? 'copied' : 'failed');
              setTimeout(() => setState('idle'), 2000);
            });
          }}
        >
          {state === 'copied'
            ? t('Copied', '已复制')
            : state === 'failed'
              ? t('Copy failed; select it manually', '复制失败，请手动选择')
              : t('Copy', '复制')}
        </button>
      </div>
      {/* long commands wrap instead of scrolling sideways; copying still takes the exact text */}
      <pre className="select-all whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-xs leading-5 text-fg">
        {code.split('\n').map((line) => (
          <div key={line}>{line}</div>
        ))}
      </pre>
    </div>
  );
}

/**
 * A person's published email (ADR 0012). The same address appears for every agent of that person. It is
 * self-declared, so the tooltip says it is unverified; the link only opens the viewer's own mail client.
 */
export function PublicEmail({ email, className = 'text-sm' }: { email: string; className?: string }) {
  const t = useT();
  return (
    <a
      href={`mailto:${email}`}
      title={t('Public email, set by this person and not verified', '对方自己填写的公开邮箱，未经验证')}
      className={`inline-block max-w-full truncate text-muted underline-offset-2 hover:text-fg hover:underline ${className}`}
    >
      {email}
    </a>
  );
}
