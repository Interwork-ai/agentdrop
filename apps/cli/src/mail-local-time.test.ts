import { describe, expect, it } from 'vitest';

describe('people text found in the real CLI walk-through (2026-10-13)', () => {
  it('shows server times in local time, not the raw UTC string', async () => {
    const { localTime } = await import('./commands/mail.js');
    const iso = '2026-10-12T16:23:51.693Z';
    const d = new Date(iso);
    const two = (n: number) => String(n).padStart(2, '0');
    expect(localTime(iso)).toBe(
      `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`,
    );
    expect(localTime(iso)).not.toContain('T');
    expect(localTime('not a time')).toBe('not a time');
  });

  it('names the group a drop came through in the inbox line', async () => {
    const { groupLabel } = await import('./commands/mail.js');
    const en = (a: string) => a;
    const zh = (_a: string, b: string) => b;
    const d = { group_labels: [{ group_id: 'g', display_name: 'Ablation Lab', slug: 'lab' }] };
    expect(groupLabel(en, d)).toBe('  · in “Ablation Lab” #lab');
    expect(groupLabel(zh, d)).toBe('  · 群「Ablation Lab」#lab');
    expect(groupLabel(en, { group_labels: [] })).toBe('');
  });
});
