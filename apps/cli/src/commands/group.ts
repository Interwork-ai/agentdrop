import { readLanguage } from '../locale.js';
import type { Output } from '../output.js';
import { clientFor } from './mail.js';

type Tr = (en: string, zh: string) => string;
function translator(): Tr {
  const zh = readLanguage() === 'zh';
  return (en, zhText) => (zh ? zhText : en);
}

/**
 * Group management from the terminal. Creating, inviting and leaving are self-scoped, so they run on this
 * profile's credential. Deciding a join request is not: approving one gives a stranger a mailbox relationship
 * with every other member, so it stays in the dashboard and this command only prints where to do it.
 */

function splitHandles(values: string[]): string[] {
  return values
    .flatMap((v) => v.split(/[,\s]+/))
    .map((v) => v.trim().replace(/^@/, ''))
    .filter((v) => v.length > 0);
}

/** `#slug`, a bare slug or a group_id. Matching is exact: slugs are unique, so never guess from a search. */
/** A group as a person names it: `#slug`, `slug` or its id; groups they are in first, then invitations. */
export async function resolveGroupId(
  client: Awaited<ReturnType<typeof clientFor>>['client'],
  target: string,
): Promise<string> {
  const wanted = target.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted)) return wanted;
  const pending = await client.pendingRequests();
  const mine = (pending.groups ?? []).find((g) => g.slug.toLowerCase() === wanted);
  if (mine) return mine.group_id;
  const invited = pending.group_invitations.find((g) => g.slug.toLowerCase() === wanted);
  if (invited) return invited.group_id;
  throw new Error(
    readLanguage() === 'zh'
      ? `你不在 #${wanted} 群里；agentdrop group list 会列出你的群`
      : `you are not in a group #${wanted}; agentdrop group list shows your groups`,
  );
}

export async function groupListCommand(out: Output, opts: { profile: string }): Promise<void> {
  const { client } = clientFor(opts.profile);
  const r = await client.pendingRequests();
  const groups = r.groups ?? [];
  const zh = readLanguage() === 'zh';
  out.result({ groups, invitations: r.group_invitations }, () => {
    if (groups.length === 0 && r.group_invitations.length === 0)
      return zh ? '还没有群组。' : 'No groups yet.';
    const lines: string[] = [];
    if (groups.length > 0) {
      lines.push(zh ? `我的群组：${groups.length} 个` : `My groups: ${groups.length}`);
      for (const g of groups) {
        const problems = [
          g.my_binding_missing ? (zh ? '我没有接收 Agent' : 'None of my agents receive this group') : null,
          g.members_needing_repair > 0
            ? zh
              ? `${g.members_needing_repair} 位成员接收配置待修复`
              : `${g.members_needing_repair} member(s) need to repair receiving settings`
            : null,
          (g.endpoints_over_limit ?? g.endpoint_total > g.endpoint_limit)
            ? zh
              ? '超过投递上限，成员可以减少自己的接收 Agent 后重试'
              : 'Delivery limit exceeded; members can select fewer of their own receiving agents'
            : null,
        ].filter(Boolean);
        lines.push(
          `- ${g.display_name} #${g.slug}${g.current_h_receives ? (zh ? '（此 Agent 接收）' : ' (this agent receives)') : zh ? '（此 Agent 未接收）' : ' (this agent does not receive)'}${
            problems.length ? `\n  ⚠ ${problems.join(zh ? '；' : '; ')}` : ''
          }`,
        );
      }
    }
    if (r.group_invitations.length > 0) {
      lines.push(
        zh
          ? `待我回应的群邀请：${r.group_invitations.length} 个`
          : `Group invitations: ${r.group_invitations.length}`,
      );
      for (const g of r.group_invitations)
        lines.push(
          zh
            ? `- ${g.display_name} #${g.slug}（${g.member_count} 位成员${g.invited_by_handle ? `，@${g.invited_by_handle} 邀请` : ''}）→ agentdrop accept #${g.slug}`
            : `- ${g.display_name} #${g.slug} (${g.member_count} members${g.invited_by_handle ? `, invited by @${g.invited_by_handle}` : ''}) → agentdrop accept #${g.slug}`,
        );
    }
    return lines.join('\n');
  });
}

export async function groupCreateCommand(
  out: Output,
  opts: { profile: string; slug?: string; name?: string; description?: string; invite?: string[] },
): Promise<void> {
  const { client } = clientFor(opts.profile);
  const handles = splitHandles(opts.invite ?? []);
  const r = await client.groupCreate({
    // Both optional: the server names the group after its members and derives the slug from their handles.
    ...(opts.slug ? { slug: opts.slug.replace(/^#/, '') } : {}),
    ...(opts.name ? { display_name: opts.name } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(handles.length ? { invite_handles: handles } : {}),
  });
  const t = translator();
  out.result(r, () =>
    [
      t(
        `Created ${r.display_name} #${r.slug} (all my agents receive it, including ones paired later)`,
        `已创建 ${r.display_name} #${r.slug}（我的所有 Agent 都接收，之后新配对的也会加入）`,
      ),
      ...(r.invites ?? []).map((i) =>
        i.outcome === 'requested'
          ? t(
              `- @${i.handle}: requested, waiting for an admin to approve`,
              `- @${i.handle}：已提交，等待管理员批准`,
            )
          : i.outcome === 'already_member'
            ? t(`- @${i.handle}: already in the group`, `- @${i.handle}：已在群里`)
            : t(
                `- @${i.handle}: invitation sent, waiting for them to accept`,
                `- @${i.handle}：邀请已发出，等对方接受`,
              ),
      ),
      t(
        'To have only some of your agents receive it, change the group settings in the dashboard to "only selected agents".',
        '只想让部分 Agent 接收，去网页的群设置里改成「只用选中的 Agent」。',
      ),
    ].join('\n'),
  );
}

export async function groupInviteCommand(
  out: Output,
  opts: { profile: string; target: string; handles: string[] },
): Promise<void> {
  const { client } = clientFor(opts.profile);
  const handles = splitHandles(opts.handles);
  const t = translator();
  if (handles.length === 0) throw new Error(t('Give at least one @handle.', '给出至少一个 @handle'));
  const groupId = await resolveGroupId(client, opts.target);
  const r = await client.groupInvite({ group_id: groupId, handles });
  out.result(r, () =>
    [
      `${r.display_name} #${r.slug}`,
      ...(r.invites ?? []).map((i) =>
        i.outcome === 'requested'
          ? t(
              `- @${i.handle}: join request submitted, waiting for an admin to approve it in the dashboard`,
              `- @${i.handle}：已提交入群申请，等待管理员在网页批准`,
            )
          : i.outcome === 'already_member'
            ? t(`- @${i.handle}: already in the group`, `- @${i.handle}：已在群里`)
            : t(`- @${i.handle}: invitation sent`, `- @${i.handle}：邀请已发出`),
      ),
    ].join('\n'),
  );
}

/** Read-only on purpose: the decision itself needs a browser session. */
export async function groupRequestsCommand(out: Output, opts: { profile: string }): Promise<void> {
  const { client } = clientFor(opts.profile);
  const r = await client.pendingRequests();
  const requests = r.group_join_requests ?? [];
  const t = translator();
  out.result({ join_requests: requests }, () =>
    requests.length === 0
      ? t('No join requests waiting for you.', '没有待我批准的入群申请。')
      : [
          t(`Join requests waiting for you: ${requests.length}`, `待我批准的入群申请：${requests.length} 个`),
          ...requests.map((j) =>
            t(
              `- ${j.invitee_display_name} @${j.invitee_handle} → ${j.display_name} #${j.slug} (invited by @${j.invited_by_handle})\n  Approve or decline: ${j.decide_url}`,
              `- ${j.invitee_display_name} @${j.invitee_handle} → ${j.display_name} #${j.slug}（@${j.invited_by_handle} 邀请）\n  批准/拒绝：${j.decide_url}`,
            ),
          ),
          t(
            'Approving happens in the dashboard: joining lets them message every member directly, so this decision is not left to an agent.',
            '批准要在网页上做：入群会让对方能直接私信全群成员，这个决定不交给 Agent。',
          ),
        ].join('\n'),
  );
}

export async function groupLeaveCommand(
  out: Output,
  opts: { profile: string; target: string },
): Promise<void> {
  const { client } = clientFor(opts.profile);
  const groupId = await resolveGroupId(client, opts.target);
  const r = await client.groupLeave({ group_id: groupId });
  const t = translator();
  out.result(r, () =>
    t(
      `Left ${r.display_name} #${r.slug}; you can no longer read this group, copies you already downloaded stay.`,
      `已退出 ${r.display_name} #${r.slug}；此后不再能读取此群内容，已下载的副本不受影响。`,
    ),
  );
}
