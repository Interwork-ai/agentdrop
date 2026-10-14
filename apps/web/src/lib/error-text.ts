import type { ErrorCode } from '@agentdrop/contracts';
import { ApiFailure } from './api.js';
import { formatBytes } from './bytes.js';
import { getLang, type Lang } from './lang.js';

/*
 * What a person sees when something fails. The server's `message` and `next_action` are written for programs and
 * models (tool names, request ids); a person in this dashboard gets a sentence saying what happened and what they
 * can do here, in their language (English by default). The server text stays available as `detail` for debugging.
 *
 * `Record<ErrorCode, …>` per language: adding an error code without both sentences fails the typecheck.
 */
const BY_CODE: Record<Lang, Record<ErrorCode, string>> = {
  en: {
    UNAUTHORIZED: 'Your session has expired. Please sign in again.',
    FORBIDDEN: 'You are not allowed to do this.',
    NOT_FOUND: 'This does not exist, or you cannot see it.',
    VALIDATION_FAILED: 'Some of what you entered is not valid. Check it and try again.',
    PAYLOAD_TOO_LARGE: 'This is too long. Shorten the message or send the content as an attachment.',
    IDEMPOTENCY_CONFLICT: 'This conflicts with an earlier submission. Refresh the page and send again.',
    VERSION_CONFLICT: 'This was just changed somewhere else. Refresh and try again.',
    NO_DELIVERY_ROUTE:
      'The recipient has not set a default receiving agent yet, so this cannot be delivered. Ask them to set one.',
    PREFERRED_ROUTE_UNAVAILABLE:
      'The entry you saved for this contact is no longer available. Choose where to send it; nothing was sent.',
    ROUTE_UNAVAILABLE: 'This receiving entry was revoked or is no longer open to you. Choose another one.',
    GROUP_RECIPIENT_UNAVAILABLE:
      'A group member has no usable receiving agent, so nothing was sent. That member or a group admin needs to fix it.',
    TOO_MANY_RECIPIENTS: 'Too many recipients. Split it into several sends.',
    AMBIGUOUS_TARGET: 'Several matches have that name. Pick one from the list.',
    NOT_A_CONTACT:
      'You can only send to accepted contacts or members of a shared group. Invite them under Contacts first.',
    BLOCKED: 'This cannot be delivered to that recipient.',
    ATTACHMENT_NOT_READY: 'The attachment has not finished uploading. Wait for it or upload it again.',
    ATTACHMENT_NOT_OWNED: 'Only attachments uploaded by this agent can be sent.',
    PATH_NOT_ALLOWED: 'This file is in a folder that may not be uploaded from, or it is a sensitive file.',
    FILE_TOO_LARGE: 'The file is larger than the per-file or per-message limit.',
    QUOTA_EXCEEDED:
      "This agent's upload space is full. Delete items you no longer need from My space, then try again.",
    GROUP_STORAGE_FULL:
      "This group's file space is full. A group admin can remove old files on the group page, or send it without files.",
    FILE_REMOVED: 'This file was removed after it was sent and can no longer be downloaded.',
    NEEDS_APPROVAL: 'This send needs your approval. Nothing is delivered until you approve it.',
    STALE_APPROVAL: 'The recipients changed after approval. Preview and approve again.',
    APPROVAL_EXPIRED: 'The approval expired. Send it again.',
    RESYNC_REQUIRED: 'This list is out of date. Refresh the page.',
    ACCOUNT_SUSPENDED: 'This account is suspended. Contact the server administrator.',
    SIGNUP_DISABLED: 'Sign-up is closed on this server. Ask the administrator for an account.',
    ENDPOINT_REVOKED: 'This agent was disconnected. Pair it again under My Agents.',
    AGENT_REQUIRED: 'Pair an agent first: until then you cannot add contacts, create or join groups.',
    RATE_LIMITED: 'Too many attempts. Please wait a moment and try again.',
    UPSTREAM_UNAVAILABLE: 'The server is temporarily unavailable. Please try again later.',
    NETWORK_ERROR:
      'A network problem occurred and it is unclear whether this went through. Refresh to check first.',
    INTERNAL: 'Something went wrong on the server. Please try again later.',
  },
  zh: {
    UNAUTHORIZED: '登录已过期，请重新登录。',
    FORBIDDEN: '你没有权限执行这个操作。',
    NOT_FOUND: '要找的内容不存在，或你没有权限查看。',
    VALIDATION_FAILED: '填写的内容不符合要求，请检查后重试。',
    PAYLOAD_TOO_LARGE: '内容太长了，请缩短正文，或改成附件发送。',
    IDEMPOTENCY_CONFLICT: '这次提交和之前的一次冲突了，请刷新页面后重新发送。',
    VERSION_CONFLICT: '内容刚在别处被修改过，请刷新后再试。',
    NO_DELIVERY_ROUTE: '对方还没有设置默认接收的 Agent，暂时发不过去；请对方先在网页里设置。',
    PREFERRED_ROUTE_UNAVAILABLE: '你给这个联系人记住的接收入口已经不可用，请重新选择发送目标；这次没有发出。',
    ROUTE_UNAVAILABLE: '这个接收入口已被撤销或不再对你开放，请重新选择。',
    GROUP_RECIPIENT_UNAVAILABLE: '群里有成员没有可用的接收 Agent，这次没有发出；请该成员或群管理员修复。',
    TOO_MANY_RECIPIENTS: '收件人太多，请分几次发送。',
    AMBIGUOUS_TARGET: '有多个对象同名，请从候选里选一个。',
    NOT_A_CONTACT: '只能发给已接受的联系人或同群成员，请先在「联系人」里发出邀请。',
    BLOCKED: '无法发送给这个对象。',
    ATTACHMENT_NOT_READY: '附件还没上传完成，请等上传完成或重新上传。',
    ATTACHMENT_NOT_OWNED: '只能发送由当前 Agent 上传的附件。',
    PATH_NOT_ALLOWED: '这个文件所在的目录不允许上传，或它属于敏感文件。',
    FILE_TOO_LARGE: '文件超过了单个文件或单条消息的大小上限。',
    QUOTA_EXCEEDED: '这个 Agent 的上传空间已满。在「我的空间」里删除不再需要的条目后再试。',
    GROUP_STORAGE_FULL: '这个群的文件空间已满。群管理员可以在群页面删除旧文件，或者这次不带文件发送。',
    FILE_REMOVED: '这个文件在发送后已被移除，无法再下载。',
    NEEDS_APPROVAL: '这次发送需要你审批，审批通过前不会送达。',
    STALE_APPROVAL: '审批之后收件人有变化，请重新预览并审批。',
    APPROVAL_EXPIRED: '审批已过期，请重新发送。',
    RESYNC_REQUIRED: '列表已过期，请刷新页面。',
    ACCOUNT_SUSPENDED: '这个账号已被停用，请联系服务器管理员。',
    SIGNUP_DISABLED: '这个服务器已关闭注册，请联系管理员开通账号。',
    ENDPOINT_REVOKED: '这个 Agent 的连接已被撤销，需要在「我的 Agent」里重新配对。',
    AGENT_REQUIRED: '请先配对一个 Agent：配对之前不能加联系人、建群或入群。',
    RATE_LIMITED: '操作太频繁了，请稍后再试。',
    UPSTREAM_UNAVAILABLE: '服务器暂时不可用，请稍后再试。',
    NETWORK_ERROR: '网络出了问题，不确定是否已经完成；请刷新确认后再重试。',
    INTERNAL: '服务器出错了，请稍后再试。',
  },
};

/** Codes from the sign-in/password library, which answers with its own vocabulary. */
const AUTH_CODES: Record<Lang, Record<string, string>> = {
  en: {
    USER_ALREADY_EXISTS: 'This email is already registered. Sign in instead.',
    USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'This email is already registered. Sign in, or use another email.',
    INVALID_EMAIL: 'This email address is not valid.',
    INVALID_EMAIL_OR_PASSWORD: 'Wrong email or password.',
    PASSWORD_TOO_SHORT: 'The password is too short.',
    PASSWORD_TOO_LONG: 'The password is too long.',
    INVALID_TOKEN: 'This link is invalid or has expired. Request a new one.',
  },
  zh: {
    USER_ALREADY_EXISTS: '这个邮箱已经注册过了，请直接登录。',
    USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: '这个邮箱已经注册过了，请直接登录或换一个邮箱。',
    INVALID_EMAIL: '邮箱格式不正确。',
    INVALID_EMAIL_OR_PASSWORD: '邮箱或密码不正确。',
    PASSWORD_TOO_SHORT: '密码太短了。',
    PASSWORD_TOO_LONG: '密码太长了。',
    INVALID_TOKEN: '链接无效或已过期，请重新申请。',
  },
};

const FALLBACK: Record<
  Lang,
  {
    generic: string;
    network: string;
    handle: string;
    staleClosed: string;
    passwordIncorrect: string;
    recoveryCodeInvalid: string;
    groupFull: (used: string, limit: string) => string;
    unknownHandles: (handles: string) => string;
    assistantNoGroups: (handle: string) => string;
    tooManyHandles: (limit: number) => string;
    inviteSelfGroup: string;
    inviteSelf: string;
    inviteBlocked: (handle: string) => string;
  }
> = {
  en: {
    generic: 'That did not work. Please try again later.',
    network: 'Could not reach the server. Check your connection and try again.',
    handle: 'This username is taken or not allowed. Choose another one.',
    staleClosed: 'The recipients changed while this was waiting, so the send was cancelled. Send it again.',
    passwordIncorrect: 'That is not your current password.',
    recoveryCodeInvalid:
      'That email and recovery code do not match an unused code. Check both; each code works only once.',
    groupFull: (used, limit) =>
      `This group's file space is full (${used} of ${limit}). A group admin can remove old files on the group page, or send it without files.`,
    unknownHandles: (handles) =>
      `Nobody on this server has the username ${handles}. Check the spelling; nobody was invited.`,
    assistantNoGroups: (handle) => `The built-in assistant @${handle} cannot join groups. Leave it out.`,
    tooManyHandles: (limit) => `Invite at most ${limit} people at a time; nobody was invited.`,
    inviteSelfGroup: 'You are already in this group. Leave your own username out.',
    inviteSelf: 'That is your own username. Enter someone else’s.',
    inviteBlocked: (handle) => `You cannot invite @${handle}: one of you has blocked the other.`,
  },
  zh: {
    generic: '操作没有完成，请稍后再试。',
    network: '网络连接失败，请检查网络后重试。',
    handle: '这个用户名已被占用或不符合规则，请换一个。',
    staleClosed: '收件人在审批期间发生了变化，这次发送已取消，请重新发送。',
    passwordIncorrect: '当前密码不对。',
    recoveryCodeInvalid: '邮箱和恢复码对不上一个未用过的恢复码。请检查两者；每个恢复码只能用一次。',
    groupFull: (used, limit) =>
      `这个群的文件空间已满（已用 ${used}，上限 ${limit}）。群管理员可以在群页面删除旧文件，或者这次不带文件发送。`,
    unknownHandles: (handles) => `这个服务器上没有用户名为 ${handles} 的人。请核对拼写；这次没有邀请任何人。`,
    assistantNoGroups: (handle) => `内置助手 @${handle} 不能加入群组，请把它去掉。`,
    tooManyHandles: (limit) => `一次最多邀请 ${limit} 人；这次没有邀请任何人。`,
    inviteSelfGroup: '你已经在这个群里了，请去掉你自己的用户名。',
    inviteSelf: '这是你自己的用户名，请输入别人的。',
    inviteBlocked: (handle) => `无法邀请 @${handle}：你们之间有一方屏蔽了对方。`,
  },
};

export interface HumanError {
  /** The sentence to show. */
  text: string;
  /** Server-side code and message, for a tooltip or a bug report; never the main text. */
  detail?: string;
}

export function humanError(error: unknown, lang: Lang = getLang()): HumanError {
  const t = FALLBACK[lang];
  if (error instanceof ApiFailure) {
    const { code, message, details } = error.body;
    const detail = `${code}: ${message}`;
    // The dashboard's own fallback for a non-JSON answer is already written for people.
    if (error.local) return { text: message, detail };
    if (code === 'VALIDATION_FAILED' && details?.field === 'handle') return { text: t.handle, detail };
    if (
      code === 'VALIDATION_FAILED' &&
      details?.field === 'email' &&
      details?.reason === 'already_registered'
    )
      return { text: AUTH_CODES[lang].USER_ALREADY_EXISTS ?? t.generic, detail };
    if (code === 'STALE_APPROVAL' && details?.closed === true) return { text: t.staleClosed, detail };
    if (code === 'VALIDATION_FAILED' && details?.reason === 'password_incorrect')
      return { text: t.passwordIncorrect, detail };
    if (code === 'VALIDATION_FAILED' && details?.reason === 'recovery_code_invalid')
      return { text: t.recoveryCodeInvalid, detail };
    if (code === 'VALIDATION_FAILED' && details?.field === 'public_email')
      return { text: AUTH_CODES[lang].INVALID_EMAIL ?? t.generic, detail };
    if (
      code === 'GROUP_STORAGE_FULL' &&
      typeof details?.used === 'number' &&
      typeof details?.limit === 'number'
    )
      return { text: t.groupFull(formatBytes(details.used), formatBytes(details.limit)), detail };
    // Inviting people (contacts, groups): say which username is the problem instead of "does not exist".
    const handles = Array.isArray(details?.handles)
      ? details.handles.filter((h): h is string => typeof h === 'string')
      : [];
    if (code === 'NOT_FOUND' && handles.length > 0)
      return {
        text: t.unknownHandles(handles.map((h) => `@${h}`).join(lang === 'zh' ? '、' : ', ')),
        detail,
      };
    if (code === 'VALIDATION_FAILED' && details?.field === 'handles') {
      if (typeof details.handle === 'string') return { text: t.assistantNoGroups(details.handle), detail };
      if (typeof details.limit === 'number') return { text: t.tooManyHandles(details.limit), detail };
      return { text: t.inviteSelfGroup, detail };
    }
    const text = BY_CODE[lang][code as ErrorCode] ?? AUTH_CODES[lang][code];
    return { text: text ?? t.generic, detail };
  }
  // Errors the dashboard raises itself carry `humanText`; a failed fetch or a library message does not.
  if (error instanceof LocalError) return { text: error.humanText[lang] };
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError) return { text: t.network, detail: message };
  return { text: t.generic, detail: message };
}

/**
 * A failed invitation of one person by @handle (Contacts → Invite). The server answers in general terms (no such
 * user, not allowed); the person typed one username, so the sentence names it.
 */
export function humanInviteError(error: unknown, handle: string, lang: Lang = getLang()): HumanError {
  const t = FALLBACK[lang];
  const name = handle.trim().replace(/^@+/, '');
  if (error instanceof ApiFailure && !error.local) {
    const { code, message, details } = error.body;
    const detail = `${code}: ${message}`;
    if (code === 'NOT_FOUND') return { text: t.unknownHandles(`@${name}`), detail };
    if (code === 'BLOCKED') return { text: t.inviteBlocked(name), detail };
    // the only refusal without a field: inviting yourself
    if (code === 'VALIDATION_FAILED' && !details?.field) return { text: t.inviteSelf, detail };
  }
  return humanError(error, lang);
}

/** An error the dashboard raises itself, already written for people in both languages. */
export class LocalError extends Error {
  constructor(readonly humanText: Record<Lang, string>) {
    super(humanText.en);
  }
}
