import { describe, expect, it } from 'vitest';
import { formatAgo, formatBytes, formatDateTime, formatDay, formatShort, plural } from './format.js';

// Local times, so the expectations hold in every time zone the tests run in.
const now = new Date(2026, 8, 25, 15, 30);
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi);

describe('formatShort (list rows)', () => {
  it('counts minutes, then shows the time today, "Yesterday", then the day', () => {
    expect(formatShort(at(2026, 8, 25, 15, 30), 'en', now)).toBe('now');
    expect(formatShort(at(2026, 8, 25, 15, 18), 'en', now)).toBe('12 min');
    expect(formatShort(at(2026, 8, 25, 15, 18), 'zh', now)).toBe('12 分钟前');
    expect(formatShort(at(2026, 8, 25, 9, 5), 'en', now)).toMatch(/^0?9:05/);
    expect(formatShort(at(2026, 8, 24, 9, 5), 'en', now)).toBe('Yesterday');
    expect(formatShort(at(2026, 8, 24, 9, 5), 'zh', now)).toBe('昨天');
    expect(formatShort(at(2026, 7, 3, 9, 5), 'en', now)).toBe('Aug 3');
    expect(formatShort(at(2026, 7, 3, 9, 5), 'zh', now)).toBe('8月3日');
  });
  it('follows the dashboard language, not the browser locale, and adds the year only for other years', () => {
    expect(formatDay(at(2025, 11, 31, 9, 0), 'en', now)).toBe('Dec 31, 2025');
    expect(formatDay(at(2025, 11, 31, 9, 0), 'zh', now)).toBe('2025年12月31日');
  });
});

describe('formatAgo (spoken in accessible names)', () => {
  it('uses words a screen reader can say', () => {
    expect(formatAgo(at(2026, 8, 25, 15, 15), 'en', now)).toBe('15 min ago');
    expect(formatAgo(at(2026, 8, 25, 14, 15), 'en', now)).toBe('1 hour ago');
    expect(formatAgo(at(2026, 8, 25, 11, 15), 'en', now)).toBe('4 hours ago');
    expect(formatAgo(at(2026, 8, 25, 11, 15), 'zh', now)).toBe('4 小时前');
    expect(formatAgo(at(2026, 8, 24, 11, 15), 'en', now)).toBe('yesterday');
  });
});

it('formatDateTime gives the full date and time in the chosen language', () => {
  expect(formatDateTime(at(2026, 8, 25, 15, 4), 'en')).toMatch(/Sep 25, 2026.*3:04/);
  expect(formatDateTime(at(2026, 8, 25, 15, 4), 'zh')).toMatch(/2026年9月25日.*15:04/);
});

it('plural picks the English noun by count', () => {
  expect(plural(1, 'reply', 'replies')).toBe('1 reply');
  expect(plural(0, 'reply', 'replies')).toBe('0 replies');
  expect(plural(13, 'file', 'files')).toBe('13 files');
});

it('formatBytes reads like people write sizes', () => {
  expect(formatBytes(512)).toBe('512 B');
  expect(formatBytes(1536)).toBe('1.5 KB');
  expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
});
