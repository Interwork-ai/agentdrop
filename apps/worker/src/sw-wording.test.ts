import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { feishuMessage } from '@agentdrop/domain';
import { describe, expect, it } from 'vitest';

/*
 * The browser shows what the worker pushes through the dashboard's service worker (apps/web/public/sw.js). It must
 * read like the Feishu notice for the same item (packages/domain/src/notify/feishu.ts): same classification, same
 * group and person, both languages.
 */
const source = readFileSync(new URL('../../web/public/sw.js', import.meta.url), 'utf8');

async function render(
  payload: unknown,
  lang: 'en' | 'zh' | null,
): Promise<{ title: string; body: string; tag?: string }> {
  const listeners: Record<string, (event: unknown) => void> = {};
  let shown: { title: string; body: string; tag?: string } | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
    location: { origin: 'https://drop.example.test' },
    registration: {
      showNotification: async (title: string, options: { body: string; tag?: string }) => {
        shown = { title, body: options.body, ...(options.tag ? { tag: options.tag } : {}) };
      },
    },
    skipWaiting() {},
    clients: { claim() {} },
  };
  const caches = {
    open: async () => ({
      match: async () => (lang ? { text: async () => lang } : undefined),
    }),
  };
  runInNewContext(source, { self, caches, URL });
  listeners.push?.({
    data: { json: () => payload },
    waitUntil: (work: Promise<unknown>) => {
      pending = work;
    },
  });
  await pending;
  if (!shown) throw new Error('no notification shown');
  return shown;
}

const feishuLine = (item: Parameters<typeof feishuMessage>[0], lang: 'en' | 'zh') =>
  JSON.stringify(feishuMessage(item, lang));

describe('browser push wording matches Feishu', () => {
  const drop = {
    event_id: 'e1',
    kind: 'drop',
    drop_id: 'd',
    h_id: 'h',
    from_handle: 'bob',
    from_display_name: '王同学',
    group_name: 'Core team',
    group_slug: 'core',
    mentioned: true,
    title: 'Plan',
    url: '/app/inbox/d?h=h',
  };

  it('labels group messages, names the group and the sender, and says when you were mentioned', async () => {
    const zh = await render(drop, 'zh');
    expect(zh).toEqual({
      title: 'Plan',
      body: '群消息 ·「Core team」#core：王同学（@bob） @了你',
      tag: 'agentdrop:e1',
    });
    expect(
      feishuLine(
        {
          kind: 'drop',
          fromName: '王同学',
          fromHandle: 'bob',
          title: 'Plan',
          group: { name: 'Core team', slug: 'core' },
          mentioned: true,
          link: null,
        },
        'zh',
      ),
    ).toContain(`${zh.body}·「Plan」`);
    const en = await render(drop, null);
    expect(en.body).toBe('Group message · “Core team” #core: 王同学 (@bob) mentioned you');
    const direct = await render({ ...drop, group_name: null, group_slug: null, mentioned: false }, 'en');
    expect(direct.body).toBe('Direct message: 王同学 (@bob)');
    expect(
      feishuLine({ kind: 'drop', fromName: '王同学', fromHandle: 'bob', title: 'Plan', link: null }, 'en'),
    ).toContain(`${direct.body} · “Plan”`);
  });

  it('says a drop is a reply, naming the original, only when the server sent it (ADR 0016)', async () => {
    const reply = { ...drop, group_name: null, group_slug: null, mentioned: false, title: 'Re: Plan' };
    const mine = { ...reply, reply_to_title: 'Plan', reply_to_mine: true };
    expect((await render(mine, 'en')).body).toBe('Direct message: 王同学 (@bob) replied to your “Plan”');
    expect((await render(mine, 'zh')).body).toBe('私信：王同学（@bob） 回复了你的「Plan」');
    const item = {
      kind: 'drop' as const,
      fromName: '王同学',
      fromHandle: 'bob',
      title: 'Re: Plan',
      replyTo: { title: 'Plan', mine: true },
      link: null,
    };
    // "Re: Plan" would only repeat the reply words, so Feishu leaves the title out
    expect(feishuLine(item, 'en')).toContain('"Direct message: 王同学 (@bob) replied to your “Plan”"');
    expect(feishuLine(item, 'zh')).toContain('"私信：王同学（@bob） 回复了你的「Plan」"');
    // someone else's drop in a group, with a mention and a title of its own
    const group = { ...drop, title: 'Numbers', reply_to_title: 'Plan', reply_to_mine: false };
    const groupEn = await render(group, 'en');
    expect(groupEn.body).toBe(
      'Group message · “Core team” #core: 王同学 (@bob) mentioned you and replied to “Plan”',
    );
    expect(
      feishuLine(
        {
          ...item,
          title: 'Numbers',
          group: { name: 'Core team', slug: 'core' },
          mentioned: true,
          replyTo: { title: 'Plan', mine: false },
        },
        'en',
      ),
    ).toContain(`${groupEn.body} · “Numbers”`);
    const groupZh = await render(group, 'zh');
    expect(groupZh.body).toBe('群消息 ·「Core team」#core：王同学（@bob） @了你，并回复了「Plan」');
    // without the field (an original the person may not read) it is an ordinary message
    expect((await render(reply, 'en')).body).toBe('Direct message: 王同学 (@bob)');
  });

  it('names the progress a reply gives, in the same words as Feishu (ADR 0038)', async () => {
    const reply = { ...drop, group_name: null, group_slug: null, mentioned: false, title: 'Re: Plan' };
    const item = {
      kind: 'drop' as const,
      fromName: '王同学',
      fromHandle: 'bob',
      title: 'Re: Plan',
      replyTo: { title: 'Plan', mine: true },
      link: null,
    };
    const cases = [
      ['started', 'started on your “Plan”', '开始处理你的「Plan」'],
      ['done', 'finished your “Plan”', '完成了你的「Plan」'],
      ['declined', 'declined your “Plan”', '婉拒了你的「Plan」'],
      ['needs_info', 'needs more information for your “Plan”', '需要补充信息才能处理你的「Plan」'],
    ] as const;
    for (const [progress, en, zh] of cases) {
      const payload = { ...reply, reply_to_title: 'Plan', reply_to_mine: true, reply_progress: progress };
      expect((await render(payload, 'en')).body).toBe(`Direct message: 王同学 (@bob) ${en}`);
      expect((await render(payload, 'zh')).body).toBe(`私信：王同学（@bob） ${zh}`);
      expect(feishuLine({ ...item, progress }, 'en')).toContain(`"Direct message: 王同学 (@bob) ${en}"`);
      expect(feishuLine({ ...item, progress }, 'zh')).toContain(`"私信：王同学（@bob） ${zh}"`);
    }
    // a group reply that also mentions the person
    const group = {
      ...drop,
      title: 'Numbers',
      reply_to_title: 'Plan',
      reply_to_mine: false,
      reply_progress: 'done',
    };
    expect((await render(group, 'zh')).body).toBe(
      '群消息 ·「Core team」#core：王同学（@bob） @了你，并完成了「Plan」',
    );
    // an unknown value from a newer server reads as a plain reply
    for (const odd of ['paused', 'constructor', '__proto__']) {
      const unknown = { ...reply, reply_to_title: 'Plan', reply_to_mine: true, reply_progress: odd };
      expect((await render(unknown, 'en')).body).toBe('Direct message: 王同学 (@bob) replied to your “Plan”');
    }
  });

  it('renders contact requests, invitations and join requests in the dashboard language', async () => {
    const contact = await render(
      { event_id: 'e2', kind: 'contact', from_handle: 'bob', from_display_name: '王同学' },
      'zh',
    );
    expect(contact).toMatchObject({ title: '联系人申请', body: '王同学（@bob）想加你为联系人' });
    expect(
      feishuLine({ kind: 'contact', fromName: '王同学', fromHandle: 'bob', link: null }, 'zh'),
    ).toContain(`${contact.title}：${contact.body}`);
    const invitation = await render(
      { kind: 'invitation', group_name: 'Core team', group_slug: 'core' },
      'en',
    );
    expect(invitation).toMatchObject({
      title: 'Group invitation',
      body: 'You are invited to “Core team” #core',
    });
    const join = {
      event_id: 'e3',
      kind: 'join',
      group_name: 'Core team',
      group_slug: 'core',
      invitee_handle: 'carol',
      invited_by_handle: 'bob',
    };
    const zh = await render(join, 'zh');
    expect(zh).toEqual({
      title: '入群申请',
      body: '@carol 想加入「Core team」#core（@bob 邀请），只能在网页上决定',
      // One event may carry several requests: each keeps its own notification.
      tag: 'agentdrop:e3:carol',
    });
    expect(
      feishuLine(
        {
          kind: 'join',
          groupName: 'Core team',
          groupSlug: 'core',
          inviteeHandle: 'carol',
          invitedByHandle: 'bob',
          link: null,
        },
        'zh',
      ),
    ).toContain(`${zh.title}：${zh.body}`);
    expect((await render(join, 'en')).body).toBe(
      '@carol wants to join “Core team” #core (invited by @bob); only you can decide, in the dashboard',
    );
  });

  it('strips invisible and direction-changing characters from received names and titles', async () => {
    const shown = await render(
      {
        ...drop,
        title: 'P\u200bl\u202ea\ufeffn\u061c',
        from_display_name: 'W\u200fang',
        group_name: 'Co\u2066re',
      },
      'en',
    );
    expect(`${shown.title}${shown.body}`).not.toMatch(
      /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\u061c\ufeff]/,
    );
    // A payload without `kind` (sent before this release) is a drop.
    const old = await render({ from_handle: 'bob', title: 'Old' }, 'en');
    expect(old).toMatchObject({ title: 'Old', body: 'Direct message: @bob' });
  });
});
