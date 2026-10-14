import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

/**
 * The dashboard's layout rules (docs/DESIGN.md): colours come from theme tokens so the light
 * theme works everywhere, and text is never smaller than 12 px. index.css defines the tokens and is not scanned.
 */
const root = join(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx|ts)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const RULES: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'raw palette colour (use ok/warn/danger/info tokens)',
    pattern:
      /\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|decoration|shadow)-(?:amber|rose|emerald|sky|red|green|yellow|orange|blue|lime|teal|cyan|indigo|violet|purple|fuchsia|pink|slate|gray|zinc|neutral|stone)-\d{2,3}\b/,
  },
  {
    name: 'white/black tint (use hover/selected/line tokens)',
    pattern: /\b(?:bg|text|border|ring|from|to|shadow)-(?:white|black)(?:\/|\b)/,
  },
  { name: 'hex colour in a class', pattern: /(?:bg|text|border|ring|shadow|from|to)-\[#[0-9a-fA-F]{3,8}\]/ },
  { name: 'arbitrary rgb colour in a class', pattern: /-\[[^\]]*rgb\(/ },
  { name: 'text smaller than 12px', pattern: /text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/ },
  {
    name: 'browser-locale date (use lib/format.ts, which follows the dashboard language)',
    pattern: /\.toLocale(?:Date|Time)?String\(/,
  },
];

it('uses theme tokens for colour and the type scale for sizes in every dashboard source', () => {
  const problems: string[] = [];
  for (const file of sources(root).filter((f) => !f.endsWith(join('lib', 'format.ts')))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const rule of RULES)
        if (rule.pattern.test(line))
          problems.push(`${relative(root, file)}:${i + 1} ${rule.name}: ${line.trim()}`);
    });
  }
  expect(problems).toEqual([]);
});

/*
 * Contrast (WCAG 2.2 AA) computed from the CSS variables in index.css, for the dark theme (`@theme`) and the light
 * theme (`html[data-theme="light"]`): body and secondary text ≥ 4.5:1 on every surface they sit on, the keyboard
 * focus ring ≥ 3:1. Translucent tokens (hover, selected, state backgrounds, accent tints) are composited over the
 * surface beneath them first.
 */
const css = readFileSync(join(root, 'index.css'), 'utf8');

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const open = css.indexOf('{', start);
  const body = css.slice(open + 1, css.indexOf('}', open));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--color-([\w-]+):\s*([^;]+);/g)) if (m[1] && m[2]) out[m[1]] = m[2].trim();
  return out;
}

type Rgba = [number, number, number, number];
function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(value);
  if (!rgb) throw new Error(`cannot read colour ${value}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) : 1];
}
const over = (top: Rgba, under: Rgba): Rgba => [
  top[0] * top[3] + under[0] * (1 - top[3]),
  top[1] * top[3] + under[1] * (1 - top[3]),
  top[2] * top[3] + under[2] * (1 - top[3]),
  1,
];
const withAlpha = (c: Rgba, a: number): Rgba => [c[0], c[1], c[2], a];
function luminance(c: Rgba): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}
function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const dark = tokens('@theme');
const THEMES: Record<string, Record<string, string>> = {
  dark,
  light: { ...dark, ...tokens('html[data-theme="light"] {') },
};

it.each(Object.keys(THEMES))('%s theme: text and focus ring meet WCAG AA contrast', (theme) => {
  const v = THEMES[theme] as Record<string, string>;
  const c = (name: string) => {
    const value = v[name];
    if (!value) throw new Error(`--color-${name} is missing in the ${theme} theme`);
    return parse(value);
  };
  const bg = c('bg');
  const surface = over(c('surface'), bg);
  const surfaces: Record<string, Rgba> = {
    bg,
    surface,
    'surface-2': over(c('surface-2'), bg),
    'surface-3': over(c('surface-3'), bg),
    'hover on surface': over(c('hover'), surface),
    'selected on surface': over(c('selected'), surface),
  };
  const failures: string[] = [];
  const check = (what: string, fg: Rgba, back: Rgba, min: number) => {
    const ratio = contrast(over(fg, back), back);
    if (ratio < min) failures.push(`${what}: ${ratio.toFixed(2)}:1 (needs ${min}:1)`);
  };
  for (const text of ['fg', 'fg-2', 'muted', 'dim', 'accent-fg', 'ok', 'warn', 'danger', 'info'])
    for (const [name, back] of Object.entries(surfaces)) check(`${text} on ${name}`, c(text), back, 4.5);
  // state text on its own tinted background (banners, chips), accent text on accent tints (chips, badges)
  for (const state of ['ok', 'warn', 'danger', 'info'])
    check(`${state} on ${state}-bg`, c(state), over(c(`${state}-bg`), surface), 4.5);
  for (const alpha of [0.08, 0.12, 0.15])
    check(
      `accent-fg on accent/${alpha * 100}`,
      c('accent-fg'),
      over(withAlpha(c('accent'), alpha), surface),
      4.5,
    );
  // filled buttons and badges
  check('on-accent on accent', c('on-accent'), c('accent'), 4.5);
  check('bg on warn', bg, c('warn'), 4.5);
  for (const [name, back] of Object.entries(surfaces)) check(`focus ring on ${name}`, c('focus'), back, 3);
  expect(failures).toEqual([]);
});
