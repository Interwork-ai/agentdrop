import { Languages, Moon, Sun } from 'lucide-react';
import { setLang, useLang, useT } from '../lib/lang.js';
import { setTheme, useTheme } from '../lib/theme.js';

/**
 * Language + theme switches: compact in a corner of the sign-in pages, or `stretch`ed into two equal buttons with
 * their target named (the sidebar's account area).
 */
export function PreferenceToggles({
  className = '',
  stretch = false,
}: {
  className?: string;
  stretch?: boolean;
}) {
  const lang = useLang();
  const theme = useTheme();
  const t = useT();
  const button = `inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium text-muted transition-colors hover:bg-hover hover:text-fg ${
    stretch ? 'flex-1' : ''
  }`;
  const langWord = lang === 'zh' ? (stretch ? 'English' : 'EN') : '中文';
  const themeLabel =
    theme === 'dark'
      ? t('Switch to light mode', '切换到浅色模式')
      : t('Switch to dark mode', '切换到深色模式');
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <button
        type="button"
        className={button}
        onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
        // the accessible name starts with the visible word (WCAG 2.5.3), then says what it does
        aria-label={`${langWord} · ${t('Switch to Chinese', '切换到英文')}`}
        title={t('Switch to Chinese', '切换到英文')}
      >
        <Languages size={14} aria-hidden="true" />
        {langWord}
      </button>
      <button
        type="button"
        className={button}
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        aria-label={themeLabel}
        title={themeLabel}
      >
        {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        {stretch ? (theme === 'dark' ? t('Light', '浅色') : t('Dark', '深色')) : null}
      </button>
    </div>
  );
}
