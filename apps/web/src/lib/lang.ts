import { useSyncExternalStore } from 'react';

/**
 * Dashboard language: English by default, Chinese when the person picks it. Kept in this browser only. Notices
 * inside Codex / Claude Code / opencode follow the CLI's own setting (`agentdrop settings --language`).
 *
 * Strings live where they are used, as a pair: `t('Inbox', '收件箱')`. Components call `useT()` so they re-render
 * on a switch; code outside React (errors thrown from lib/) calls `t()`, which reads the current choice.
 */
export type Lang = 'en' | 'zh';
const KEY = 'agentdrop.lang';
const listeners = new Set<() => void>();

export function getLang(): Lang {
  try {
    return globalThis.localStorage?.getItem(KEY) === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

/** Where the service worker (public/sw.js) reads the language for browser notifications; it has no localStorage. */
export const SW_LANG_CACHE = 'agentdrop-prefs';
export const SW_LANG_PATH = '/__agentdrop/lang';

function apply(lang: Lang): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  try {
    void globalThis.caches
      ?.open(SW_LANG_CACHE)
      .then((cache) => cache.put(SW_LANG_PATH, new Response(lang)))
      .catch(() => {});
  } catch {
    /* No Cache Storage (insecure context): notifications stay in English. */
  }
}

/** Tells the service worker the saved choice once per page load, so notifications match the dashboard. */
export function syncLangForNotifications(): void {
  apply(getLang());
}

export function setLang(lang: Lang): void {
  try {
    globalThis.localStorage?.setItem(KEY, lang);
  } catch {
    /* Private mode: the choice lasts for this page only. */
  }
  apply(lang);
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, () => 'en');
}

export type Translate = (en: string, zh: string) => string;

/** Outside React: the current language at call time. */
export const t: Translate = (en, zh) => (getLang() === 'zh' ? zh : en);

/** Inside components: re-renders when the language changes. */
export function useT(): Translate {
  const lang = useLang();
  return (en, zh) => (lang === 'zh' ? zh : en);
}

/** BCP 47 tag for the formatters in lib/format.ts (never the browser locale). */
export function dateLocale(lang: Lang = getLang()): string {
  return lang === 'zh' ? 'zh-CN' : 'en-US';
}
