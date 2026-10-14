import { AgentDropError, type ContactRemoval } from '@agentdrop/contracts';
import { readLanguage } from '../locale.js';
import type { Output } from '../output.js';
import { clientFor } from './mail.js';

/**
 * `agentdrop contact remove @a @b [--confirm]`. Two steps by design: without --confirm nothing changes and the
 * contacts are described in full, so whoever runs it (a person, or an agent that must show this to its user)
 * sees exactly who would be removed. Only an explicit "yes" from the person leads to the second run with
 * --confirm. The companion skill spells this out for agents; there is no MCP tool for removing contacts.
 */
export async function contactRemoveCommand(
  out: Output,
  opts: { profile: string; handles: string[]; confirm: boolean },
): Promise<void> {
  const handles = opts.handles
    .flatMap((v) => v.split(/[,\s]+/))
    .map((v) => v.trim().replace(/^@/, ''))
    .filter(Boolean);
  if (handles.length === 0) throw new Error('name at least one contact, e.g. agentdrop contact remove @wang');
  const { client } = clientFor(opts.profile);
  const r = await client.contactRemove({ handles, confirm: opts.confirm });
  const zh = readLanguage() === 'zh';
  const describe = (c: ContactRemoval) => {
    const date = (iso: string | null) => (iso ? iso.slice(0, 10) : zh ? '无' : 'none');
    return [
      `- @${c.handle} · ${c.display_name}${c.remark ? (zh ? `（备注：${c.remark}）` : ` (your note: ${c.remark})`) : ''}${c.is_system ? (zh ? ' · 内置助手' : ' · built-in assistant') : ''}`,
      zh
        ? `  状态：${c.status}；联系人自 ${date(c.contact_since)}；收到 ${c.drops_from_them} 条，发出 ${c.drops_to_them} 条，最近一条 ${date(c.last_drop_at)}`
        : `  status: ${c.status}; contact since ${date(c.contact_since)}; ${c.drops_from_them} drops from them, ${c.drops_to_them} to them, last ${date(c.last_drop_at)}`,
      ...(c.shared_groups.length
        ? [
            zh
              ? `  仍同在群 ${c.shared_groups.map((s) => `#${s}`).join(' ')}：移除联系人后对方仍可在群里给你发消息`
              : `  still shares ${c.shared_groups.map((s) => `#${s}`).join(' ')}: they can still reach you there`,
          ]
        : []),
    ].join('\n');
  };
  out.result(r, () =>
    r.removed
      ? [
          zh ? `已移除 ${r.contacts.length} 个联系人：` : `Removed ${r.contacts.length} contact(s):`,
          ...r.contacts.map(describe),
          zh
            ? '已有的消息不删除；对方以后要再加你需要重新申请。'
            : 'Existing messages are kept; they would have to send a new request to reconnect.',
        ].join('\n')
      : [
          zh
            ? `将要移除以下 ${r.contacts.length} 个联系人（尚未移除）：`
            : `About to remove these ${r.contacts.length} contact(s) (nothing removed yet):`,
          ...r.contacts.map(describe),
          zh
            ? '确认要删除的话，再加 --confirm 运行同一条命令。'
            : 'To remove them, run the same command again with --confirm.',
        ].join('\n'),
  );
}

/**
 * `agentdrop contact add @a @b`: a contact request per handle, the same as the `contact_request` tool. The other
 * person accepts in their agent, in the dashboard or with `agentdrop accept @me`; if they had already asked, this
 * accepts at once.
 */
export async function contactAddCommand(
  out: Output,
  opts: { profile: string; handles: string[] },
): Promise<void> {
  const zh = readLanguage() === 'zh';
  const handles = [
    ...new Set(
      opts.handles
        .flatMap((v) => v.split(/[,\s]+/))
        .map((v) => v.trim().replace(/^@/, ''))
        .filter(Boolean),
    ),
  ];
  if (handles.length === 0)
    throw new Error(
      zh
        ? '至少写一个 @handle，例如 agentdrop contact add @wang'
        : 'name at least one person, e.g. agentdrop contact add @wang',
    );
  const { client } = clientFor(opts.profile);
  const results: Array<{ handle: string; status?: string; display_name?: string; error?: string }> = [];
  for (const handle of handles) {
    try {
      const r = await client.contactRequest({ handle });
      results.push({ handle: r.handle, status: r.status, display_name: r.display_name });
    } catch (err) {
      if (!(err instanceof AgentDropError)) throw err;
      results.push({ handle, error: err.code });
    }
  }
  const line = (r: (typeof results)[number]) => {
    const who = r.display_name ? `${r.display_name} @${r.handle}` : `@${r.handle}`;
    if (r.error === 'NOT_FOUND' || r.error === 'BLOCKED')
      return zh
        ? `@${r.handle}：没有发出。这个 handle 不存在，或无法向对方发申请；请核对拼写，或在网页的联系人页生成邀请链接发给对方。`
        : `@${r.handle}: not sent. No such handle, or a request to them is not possible; check the spelling, or send them an invite link from the dashboard's Contacts page.`;
    if (r.error === 'VALIDATION_FAILED')
      return zh ? `@${r.handle}：不能加自己为联系人。` : `@${r.handle}: you cannot add yourself.`;
    if (r.error)
      return zh ? `@${r.handle}：没有发出（${r.error}）。` : `@${r.handle}: not sent (${r.error}).`;
    switch (r.status) {
      case 'accepted':
        return zh
          ? `${who} 已是联系人，你们可以互发消息了。`
          : `${who} is a contact; you can send to each other.`;
      case 'invited':
        return zh
          ? `已向 ${who} 发出联系人申请。对方在自己的 Agent 里、网页上，或用 agentdrop accept 同意后即可互发消息。`
          : `Sent a contact request to ${who}. Once they accept (in their agent, the dashboard or agentdrop accept), you can send to each other.`;
      case 'requested':
        return zh
          ? `${who} 已向你发过申请，用 agentdrop accept @${r.handle} 同意即可。`
          : `${who} already asked you; accept with agentdrop accept @${r.handle}.`;
      default:
        return zh ? `${who}：${r.status}` : `${who}: ${r.status}`;
    }
  };
  out.result({ results }, () => results.map(line).join('\n'));
  if (results.every((r) => r.error)) process.exitCode = 1;
}
