import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { useT } from '../lib/lang.js';

/** The title index.html ships with, kept for the product page, which names itself. */
const ORIGINAL = typeof document === 'undefined' ? 'AgentDrop' : document.title;

/** Sets the browser tab's title ("Inbox (13) · AgentDrop") while the calling component shows; null leaves it. */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title !== null) document.title = title;
  }, [title]);
}

/**
 * Titles for the pages outside the workspace (sign-in, sign-up, pairing, invitations, password reset). The
 * workspace (`/app/…`) sets its own, with the unread count, in the shell; the product page keeps index.html's.
 */
export function PublicPageTitle() {
  const { pathname } = useLocation();
  const t = useT();
  const name = pathname.startsWith('/app')
    ? null
    : pathname === '/'
      ? ''
      : pathname.startsWith('/login')
        ? t('Sign in', '登录')
        : pathname.startsWith('/signup')
          ? t('Create your account', '注册账号')
          : pathname.startsWith('/pair')
            ? t('Pair an agent', '配对 Agent')
            : pathname.startsWith('/invite')
              ? t('Invitation', '邀请')
              : pathname.startsWith('/forgot-password') || pathname.startsWith('/reset-password')
                ? t('Reset your password', '重置密码')
                : null;
  useDocumentTitle(name === null ? null : name ? `${name} · AgentDrop` : ORIGINAL);
  return null;
}
