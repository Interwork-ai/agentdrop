import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { type AcceptInviteResult, ApiFailure, api, type InviteLinkPreview } from '../lib/api.js';
import { humanError } from '../lib/error-text.js';
import { type Translate, useT } from '../lib/lang.js';
import { useSession } from '../lib/session.js';
import { Avatar } from '../ui/layout.jsx';
import { setupCommands } from '../ui/needs-agent.jsx';
import { Button, CodeBlock, Loading } from '../ui/primitives.jsx';
import { EntryCard, entryLink, FormError, FormNotice } from './auth.jsx';

/** The inviter's initial beside the sentence that names them, like the first line of a message. */
function FromInviter({
  inviter,
  children,
}: {
  inviter: InviteLinkPreview['inviter'];
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <Avatar name={inviter.display_name} seed={inviter.handle} size={40} />
      <p className="min-w-0 flex-1 text-sm leading-6 text-fg-2">{children}</p>
    </div>
  );
}

const reasons = (t: Translate): Record<string, string> => ({
  expired: t(
    'This invite link has expired. Ask them to generate a new one on their Contacts page.',
    '这个邀请链接已过期。请让对方在联系人页重新生成一个。',
  ),
  revoked: t(
    'This invite link has been revoked. Ask them to generate a new one.',
    '这个邀请链接已被作废。请让对方重新生成一个。',
  ),
});

/**
 * Contact invite link: /invite/<token>. The token lives in the path (the login redirect keeps paths but drops
 * query strings). Signed out, it shows who is inviting and sends you through login/sign-up back here.
 */
export function InvitePage() {
  const { token = '' } = useParams();
  const { me, loading } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const here = `/invite/${token}`;
  const t = useT();
  const preview = useQuery({
    queryKey: ['invite-link', token],
    queryFn: () => api.get<InviteLinkPreview>(`/v1/invite/${encodeURIComponent(token)}`),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => api.post<AcceptInviteResult>(`/v1/me/invite/${encodeURIComponent(token)}/accept`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contacts'] });
    },
  });
  /*
   * Contacts need somewhere to deliver (ADR 0014). Without a paired agent, accepting leaves the inviter's contact
   * request on the server, on the Contacts page in every browser; the person accepts it there after pairing.
   */
  const hasAgent = !!me && me.endpoints.some((e) => !e.revoked_at);
  /*
   * Arriving back from "Sign up to accept" / "I have an account, log in" means the person already said yes; asking
   * again would be a second confirmation of the same thing. Without an agent, opening the link only leaves a request
   * the person can still decline, so it is recorded at once. Accepting is idempotent.
   */
  const fromAuth = (useLocation().state as { acceptInvite?: boolean } | null)?.acceptInvite === true;
  const ready =
    (fromAuth || !hasAgent) &&
    !!me &&
    preview.data?.valid === true &&
    me.handle !== preview.data.inviter.handle;
  const { mutate, isIdle } = accept;
  useEffect(() => {
    if (ready && isIdle) mutate();
  }, [ready, isIdle, mutate]);

  if (loading || preview.isLoading)
    return (
      <EntryCard>
        <Loading />
      </EntryCard>
    );
  if (preview.isError || !preview.data)
    return (
      <EntryCard title={t("Can't open this invite", '无法打开这个邀请')}>
        <p>
          {preview.error instanceof ApiFailure && preview.error.status === 404
            ? t(
                'Invite link not found. Check that the whole link was copied, or ask them to generate a new one.',
                '邀请链接不存在。请确认链接完整复制，或让对方重新生成。',
              )
            : t(
                "Can't open this invite link right now. Please refresh later.",
                '暂时无法打开这个邀请链接，请稍后刷新。',
              )}
        </p>
        <Link className={entryLink} to={me ? '/app/contacts' : '/login'}>
          {me ? t('Go to Contacts', '去联系人页') : t('Go to log in', '去登录')}
        </Link>
      </EntryCard>
    );

  const p = preview.data;
  const who = (
    <span className="font-medium text-fg">
      {p.inviter.display_name} <span className="font-normal text-dim">@{p.inviter.handle}</span>
    </span>
  );

  if (!p.valid)
    return (
      <EntryCard title={t("This invite can't be used", '这个邀请无法使用')}>
        <FromInviter inviter={p.inviter}>
          {who}
          {t("'s invite link can't be used. ", ' 的邀请链接无法使用。')}
          {reasons(t)[p.reason ?? ''] ?? ''}
        </FromInviter>
      </EntryCard>
    );

  if (!me)
    return (
      <EntryCard title={t('Contact invitation', '联系人邀请')}>
        <FromInviter inviter={p.inviter}>
          {who}
          {t(
            ' invited you to be an AgentDrop contact. As contacts, your agents can send each other results, files and context directly.',
            ' 邀请你成为 AgentDrop 联系人。成为联系人后，你们的 Agent 可以直接互相发送结果、文件和上下文。',
          )}
        </FromInviter>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="primary"
            className="h-9 sm:flex-1"
            onClick={() => nav(`/signup?next=${encodeURIComponent(here)}`)}
          >
            {t('Sign up to accept', '注册后接受')}
          </Button>
          <Button className="h-9 sm:flex-1" onClick={() => nav(`/login?next=${encodeURIComponent(here)}`)}>
            {t('I have an account, log in', '已有账号，登录')}
          </Button>
        </div>
      </EntryCard>
    );

  if (me.handle === p.inviter.handle)
    return (
      <EntryCard title={t('Invite a colleague', '邀请同事')}>
        <p>
          {t(
            'This is your own invite link. Send it to a colleague: once they sign up and pair an agent, you become contacts.',
            '这是你自己的邀请链接。把它发给同事：对方注册并配对 Agent 后，你们就成为联系人。',
          )}
        </p>
        <Link className={entryLink} to="/app/contacts">
          {t('Back to Contacts →', '回到联系人页 →')}
        </Link>
      </EntryCard>
    );

  if (accept.data?.pending)
    return (
      <EntryCard title={t('Pair an agent to connect', '配对 Agent 即可成为联系人')} wide>
        <FromInviter inviter={p.inviter}>
          {who}
          {t(
            "'s invitation is saved. You become contacts as soon as you pair an agent, with nothing more to click: until then nobody can send to you and you cannot send. Run this in a terminal on your computer, then confirm in the page it opens.",
            ' 的邀请已保存。配对 Agent 后你们自动成为联系人，无需再点接受：配对之前别人发不到你这里，你也发不出去。在电脑终端运行下面的命令，再在它打开的网页里确认。',
          )}
        </FromInviter>
        <CodeBlock code={setupCommands()} />
        <Link className={entryLink} to="/app/contacts">
          {t('Go to Contacts →', '去联系人页 →')}
        </Link>
      </EntryCard>
    );

  if (!hasAgent && !accept.data)
    return (
      <EntryCard>
        {accept.isError ? <FormError>{humanError(accept.error).text}</FormError> : <Loading />}
      </EntryCard>
    );

  if (accept.data)
    return (
      <EntryCard title={t('Contact invitation', '联系人邀请')}>
        <FromInviter inviter={p.inviter}>{who}</FromInviter>
        <FormNotice>
          {accept.data.created || fromAuth
            ? t('Added as a contact. ', '已加为联系人。')
            : t('You are already contacts. ', '你们已经是联系人了。')}
          {t(
            `Your agents can now send to @${p.inviter.handle}.`,
            `现在可以让 Agent 发给 @${p.inviter.handle}。`,
          )}
        </FormNotice>
        <Link className={entryLink} to={`/app/contacts/${accept.data.contact.user_id}`}>
          {t('View contact →', '查看联系人 →')}
        </Link>
      </EntryCard>
    );

  return (
    <EntryCard title={t('Contact invitation', '联系人邀请')}>
      <FromInviter inviter={p.inviter}>
        {who}
        {t(
          ' invited you to be an AgentDrop contact. Once you accept, you become contacts and can send to each other.',
          ' 邀请你成为 AgentDrop 联系人。接受后双方直接互为联系人，可以互相发送。',
        )}
      </FromInviter>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="primary"
          className="h-9 sm:flex-1"
          disabled={accept.isPending}
          onClick={() => accept.mutate()}
        >
          {t('Add as contact', '加为联系人')}
        </Button>
        <Button className="h-9 sm:flex-1" onClick={() => nav('/app/inbox')}>
          {t('Not now', '暂不')}
        </Button>
      </div>
      {accept.isError ? <FormError>{humanError(accept.error).text}</FormError> : null}
    </EntryCard>
  );
}
