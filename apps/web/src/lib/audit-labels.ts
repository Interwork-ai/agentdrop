import type { Translate } from './lang.js';

/*
 * Readable names for audit action codes (recordAudit calls in packages/domain and apps/api). Admins still see the
 * raw code next to the label; a code missing here falls back to itself, so a new action is never hidden.
 */
const ACTIONS: Record<string, { en: string; zh: string }> = {
  'drop.send': { en: 'Sent a message', zh: '发送消息' },
  'drop.read': { en: 'Read a message', zh: '阅读消息' },
  'drop.read.group_admin': { en: 'Read group history (admin)', zh: '查看群历史消息（管理员）' },
  'drop.list.group_admin': { en: 'Listed group history (admin)', zh: '列出群历史消息（管理员）' },
  'drop.export': { en: 'Exported messages', zh: '导出消息' },
  'drop.export.group_admin': { en: 'Exported group history (admin)', zh: '导出群历史（管理员）' },
  'attachment.upload': { en: 'Uploaded an attachment', zh: '上传附件' },
  'attachment.download': { en: 'Downloaded an attachment', zh: '下载附件' },
  'attachment.delete': { en: 'Deleted an attachment', zh: '删除附件' },
  'approval.approve': { en: 'Approved a send', zh: '批准发送' },
  'approval.reject': { en: 'Rejected a send', zh: '拒绝发送' },
  'approval.stale': { en: 'Approval out of date', zh: '审批已过期（收件人有变）' },
  'contact.invite': { en: 'Sent a contact request', zh: '发出联系人申请' },
  'contact.accept': { en: 'Accepted a contact', zh: '接受联系人' },
  'contact.remove': { en: 'Removed a contact', zh: '移除联系人' },
  'contact.block': { en: 'Blocked a contact', zh: '屏蔽联系人' },
  'contact.unblock': { en: 'Unblocked a contact', zh: '取消屏蔽' },
  'contact.settings': { en: 'Changed contact settings', zh: '修改联系人设置' },
  'invite_link.create': { en: 'Created an invite link', zh: '生成邀请链接' },
  'invite_link.accept': { en: 'Joined through an invite link', zh: '通过邀请链接加入' },
  'invite_link.revoke': { en: 'Revoked an invite link', zh: '作废邀请链接' },
  'group.create': { en: 'Created a group', zh: '创建群组' },
  'group.update': { en: 'Edited a group', zh: '修改群资料' },
  'group.invite': { en: 'Invited to a group', zh: '邀请入群' },
  'group.invite_requested': { en: 'Asked to invite to a group', zh: '申请邀请入群' },
  'group.request.approve': { en: 'Approved a join request', zh: '批准入群申请' },
  'group.request.reject': { en: 'Rejected a join request', zh: '拒绝入群申请' },
  'group.join': { en: 'Joined a group', zh: '加入群组' },
  'group.leave': { en: 'Left a group', zh: '退出群组' },
  'group.remove': { en: 'Removed from a group', zh: '被移出群组' },
  'group.role': { en: 'Changed a member role', zh: '修改成员角色' },
  'group.transfer': { en: 'Transferred group ownership', zh: '转让群主' },
  'group.policy': { en: 'Changed group rules', zh: '修改群规则' },
  'group.history_visible': {
    en: 'Changed whether new members see earlier messages',
    zh: '修改新成员能否查看入群前的消息',
  },
  'group.bindings': { en: 'Changed receiving agents', zh: '修改接收 Agent' },
  'pairing.approve': { en: 'Approved a pairing', zh: '批准配对' },
  'pairing.deny': { en: 'Denied a pairing', zh: '拒绝配对' },
  'credential.issue': { en: 'Issued a credential', zh: '签发凭证' },
  'credential.revoke': { en: 'Revoked credentials', zh: '撤销凭证' },
  'endpoint.rename': { en: 'Renamed an agent', zh: '重命名 Agent' },
  'endpoint.public_name': { en: 'Changed a public name', zh: '修改外发署名' },
  'endpoint.revoke': { en: 'Deleted an agent', zh: '删除 Agent' },
  'endpoint.take_over': { en: 'Took over an agent', zh: '接替 Agent' },
  'device.revoke': { en: 'Deleted a device', zh: '删除设备' },
  'device.client_settings.update': { en: 'Changed device preferences', zh: '修改设备偏好' },
  'device.client_settings.applied': { en: 'Device applied its preferences', zh: '设备已应用偏好' },
  'route.auto.create': { en: 'Created an agent address', zh: '生成 Agent 地址' },
  'route.create': { en: 'Published an entry', zh: '发布具名入口' },
  'route.update': { en: 'Changed an entry', zh: '修改具名入口' },
  'route.revoke': { en: 'Deleted an entry', zh: '删除具名入口' },
  'route.default.set': { en: 'Set the default receiver', zh: '设置默认接收' },
  'route.default.all': { en: 'Receive on all agents', zh: '改为所有 Agent 接收' },
  'notify.feishu.connect': { en: 'Connected Feishu', zh: '接入飞书' },
  'notify.feishu.disconnect': { en: 'Disconnected Feishu', zh: '断开飞书' },
  'system.assistant.ensure': { en: 'Set up the built-in assistant', zh: '初始化内置助手' },
  'system.assistant.reply': { en: 'Assistant sent a receipt', zh: '助手发出回执' },
  'admin.user.suspend': { en: 'Suspended an account', zh: '封禁账号' },
  'admin.user.unsuspend': { en: 'Lifted a suspension', zh: '解除封禁' },
  'admin.user.close': { en: 'Closed an account', zh: '注销账号' },
  'admin.user.grant_admin': { en: 'Made an admin', zh: '设为管理员' },
  'admin.user.revoke_admin': { en: 'Removed an admin', zh: '取消管理员' },
  'admin.endpoint.revoke': { en: 'Deleted an agent (admin)', zh: '删除 Agent（管理员）' },
  'admin.password_reset_link': { en: 'Created a password reset link', zh: '生成重置密码链接' },
  'admin.signup_mode.set': { en: 'Changed sign-up mode', zh: '修改注册设置' },
};

export function auditActionLabel(action: string, t: Translate): string {
  const entry = ACTIONS[action];
  return entry ? t(entry.en, entry.zh) : action;
}

const RESULTS: Record<string, { en: string; zh: string; tone: string }> = {
  ok: { en: 'Done', zh: '成功', tone: 'text-ok' },
  denied: { en: 'Denied', zh: '被拒绝', tone: 'text-danger' },
  conflict: { en: 'Conflict', zh: '冲突', tone: 'text-warn' },
  error: { en: 'Error', zh: '出错', tone: 'text-danger' },
};

export function auditResult(result: string, t: Translate): { label: string; tone: string } {
  const entry = RESULTS[result];
  return entry ? { label: t(entry.en, entry.zh), tone: entry.tone } : { label: result, tone: 'text-warn' };
}

/** Filter categories for the audit page; each maps to one action prefix the API filters on. */
export const AUDIT_CATEGORIES: Array<{ prefix: string; en: string; zh: string }> = [
  { prefix: '', en: 'All', zh: '全部' },
  { prefix: 'drop.', en: 'Messages', zh: '消息' },
  { prefix: 'contact.', en: 'Contacts', zh: '联系人' },
  { prefix: 'group.', en: 'Groups', zh: '群组' },
  { prefix: 'pairing.', en: 'Pairing', zh: '配对' },
  { prefix: 'endpoint.', en: 'Agents', zh: 'Agent' },
  { prefix: 'admin.', en: 'Admin actions', zh: '管理操作' },
  { prefix: 'notify.', en: 'Notifications', zh: '通知' },
];
