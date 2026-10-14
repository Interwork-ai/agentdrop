import { expect, it } from 'vitest';
import { spaceTitle } from './space.js';

it('derives a My space title from the first file, else the note, within the derived-name cap', () => {
  expect(spaceTitle([{ safe_name: 'ablation-run.csv' }], 'for the server')).toBe('ablation-run.csv');
  expect(spaceTitle([{ safe_name: 'a.txt' }, { safe_name: 'b.txt' }, { safe_name: 'c.txt' }], '')).toBe(
    'a.txt +2',
  );
  expect(spaceTitle([], '\n  Seed list for the north bed  \nsecond line')).toBe(
    'Seed list for the north bed',
  );
  expect(spaceTitle([], '   \n ')).toBe('');
  const long = spaceTitle([], 'x'.repeat(300));
  expect(Array.from(long)).toHaveLength(80);
  expect(long.endsWith('…')).toBe(true);
  const named = spaceTitle([{ safe_name: `${'y'.repeat(200)}.txt` }, { safe_name: 'z.txt' }], '');
  expect(Array.from(named).length).toBeLessThanOrEqual(80);
  expect(named.endsWith(' +1')).toBe(true);
});
