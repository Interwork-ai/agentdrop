import { dateLocale, getLang, type Lang, useLang } from './lang.js';

/*
 * Times, counts and sizes as people read them, in the dashboard's language (lib/lang.ts), never the browser's
 * locale: an English dashboard on a Chinese system says "Sep 25", a Chinese one "9月25日". Pages call `useFormat()`
 * so they re-render on a language switch; code outside React passes the language or reads the current one.
 * docs/DESIGN.md: no `toLocale*` calls in pages, everything goes through here.
 */

export { formatBytes } from './bytes.js';

/** A translate function for a given language (the i18n coverage test accepts `tr('English', '中文')`). */
const translator =
  (lang: Lang) =>
  (en: string, zh: string): string =>
    lang === 'zh' ? zh : en;

const toDate = (iso: string | Date): Date => (iso instanceof Date ? iso : new Date(iso));

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "14:02" / "2:02 PM": the time of day. */
export function formatClock(iso: string | Date, lang: Lang = getLang()): string {
  return new Intl.DateTimeFormat(dateLocale(lang), { hour: '2-digit', minute: '2-digit' }).format(
    toDate(iso),
  );
}

/** "Sep 25" / "9月25日", with the year when it is not this year. */
export function formatDay(iso: string | Date, lang: Lang = getLang(), now: Date = new Date()): string {
  const d = toDate(iso);
  return new Intl.DateTimeFormat(dateLocale(lang), {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(d);
}

/** "Sep 25, 2026, 14:02" / "2026年9月25日 14:02": the full time, for tooltips and detail lists. */
export function formatDateTime(iso: string | Date, lang: Lang = getLang()): string {
  return new Intl.DateTimeFormat(dateLocale(lang), { dateStyle: 'medium', timeStyle: 'short' }).format(
    toDate(iso),
  );
}

/** "Sep 25, 2026" / "2026年9月25日": a date without the time. */
export function formatDate(iso: string | Date, lang: Lang = getLang()): string {
  return new Intl.DateTimeFormat(dateLocale(lang), { dateStyle: 'medium' }).format(toDate(iso));
}

/**
 * Short enough for a list row: "now", "3 min", "14:02" (today), "Yesterday", "Sep 25". The full time goes in a
 * tooltip (`formatDateTime`).
 */
export function formatShort(iso: string | Date, lang: Lang = getLang(), now: Date = new Date()): string {
  const d = toDate(iso);
  const tr = translator(lang);
  const minutes = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (minutes < 1) return tr('now', '刚刚');
  if (minutes < 60) return tr(`${minutes} min`, `${minutes} 分钟前`);
  if (sameDay(d, now)) return formatClock(d, lang);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return tr('Yesterday', '昨天');
  return formatDay(d, lang, now);
}

/**
 * Spoken form for accessible names: "just now", "15 min ago", "3 hours ago", "yesterday", "Sep 25". Screen
 * readers read "3m" as "3 meters".
 */
export function formatAgo(iso: string | Date, lang: Lang = getLang(), now: Date = new Date()): string {
  const d = toDate(iso);
  const tr = translator(lang);
  const minutes = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (minutes < 1) return tr('just now', '刚刚');
  if (minutes < 60) return tr(`${minutes} min ago`, `${minutes} 分钟前`);
  const hours = Math.floor(minutes / 60);
  if (sameDay(d, now) || hours < 6) return tr(`${plural(hours, 'hour', 'hours')} ago`, `${hours} 小时前`);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return tr('yesterday', '昨天');
  return formatDay(d, lang, now);
}

/**
 * "1 reply" / "2 replies": an English count with the right noun. Chinese has no plural, so callers write the
 * Chinese half themselves: `t(plural(n, 'reply', 'replies'), `${n} 条回复`)`.
 */
export function plural(n: number, one: string, other: string): string {
  return `${n} ${n === 1 ? one : other}`;
}

/** The formatters bound to the dashboard's current language; the component re-renders on a switch. */
export function useFormat() {
  const lang = useLang();
  return {
    lang,
    short: (iso: string | Date) => formatShort(iso, lang),
    ago: (iso: string | Date) => formatAgo(iso, lang),
    dateTime: (iso: string | Date) => formatDateTime(iso, lang),
    date: (iso: string | Date) => formatDate(iso, lang),
    clock: (iso: string | Date) => formatClock(iso, lang),
    day: (iso: string | Date) => formatDay(iso, lang),
  };
}
