import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLanguage } from '../locale.js';
import type { Output } from '../output.js';

const GROUP_ID = '00000000-0000-4000-8000-0000000000aa';
const groupLeave = vi.fn(async () => ({
  group_id: GROUP_ID,
  display_name: 'Ablation run',
  slug: 'ablation',
}));
const groupInvite = vi.fn(async () => ({
  group_id: GROUP_ID,
  display_name: 'Ablation run',
  slug: 'ablation',
  invites: [{ handle: 'wang', outcome: 'invited' }],
}));
vi.mock('./mail.js', () => ({ clientFor: () => ({ client: { groupLeave, groupInvite } }) }));

const { groupInviteCommand, groupLeaveCommand } = await import('./group.js');

function capture(): { out: Output; text: () => string } {
  let human = '';
  return {
    out: {
      json: false,
      info: () => {},
      warn: () => {},
      error: () => {},
      result: (_value, render) => {
        human = render();
      },
    },
    text: () => human,
  };
}

/* What the group commands print is read by a person: English by default, Chinese once they choose it. */
describe('agentdrop group: people text follows the language setting', () => {
  let dir: string;
  const saved = process.env.AGENTDROP_CONFIG_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdrop-group-text-'));
    process.env.AGENTDROP_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTDROP_CONFIG_DIR;
    else process.env.AGENTDROP_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it('leave and invite speak English by default', async () => {
    const leave = capture();
    await groupLeaveCommand(leave.out, { profile: 'codex', target: GROUP_ID });
    expect(leave.text()).toBe(
      'Left Ablation run #ablation; you can no longer read this group, copies you already downloaded stay.',
    );
    const invite = capture();
    await groupInviteCommand(invite.out, { profile: 'codex', target: GROUP_ID, handles: ['@wang'] });
    expect(invite.text()).toContain('- @wang: invitation sent');
    await expect(
      groupInviteCommand(capture().out, { profile: 'codex', target: GROUP_ID, handles: [] }),
    ).rejects.toThrow('Give at least one @handle.');
  });

  it('and Chinese after the person chose it', async () => {
    writeLanguage('zh');
    const leave = capture();
    await groupLeaveCommand(leave.out, { profile: 'codex', target: GROUP_ID });
    expect(leave.text()).toBe(
      '已退出 Ablation run #ablation；此后不再能读取此群内容，已下载的副本不受影响。',
    );
    await expect(
      groupInviteCommand(capture().out, { profile: 'codex', target: GROUP_ID, handles: [] }),
    ).rejects.toThrow('给出至少一个 @handle');
  });
});
