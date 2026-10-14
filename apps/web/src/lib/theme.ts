import { useSyncExternalStore } from 'react';

/** Dark by default; light when the person picks it. Kept in this browser; applied before first paint by index.html. */
export type Theme = 'dark' | 'light';
const KEY = 'agentdrop.theme';
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  try {
    return globalThis.localStorage?.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function apply(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#f5f7f5' : '#0b0f10');
}

export function setTheme(theme: Theme): void {
  try {
    globalThis.localStorage?.setItem(KEY, theme);
  } catch {
    /* Private mode: the choice lasts for this page only. */
  }
  apply(theme);
  for (const notify of listeners) notify();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    getTheme,
    () => 'dark',
  );
}
