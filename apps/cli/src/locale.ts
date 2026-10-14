import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './paths.js';
import { writePrivateFile } from './store.js';

/**
 * Language of text written for people (hook notices, update notices). English by default; `agentdrop settings
 * --language zh` switches it. Text for models (prompt context, Cursor framing, autorun) is always English.
 *
 * Kept in its own file rather than settings.json: that file is parsed strictly, and an older CLI reading an
 * unknown key would reject the whole file.
 */
export const LANGUAGES = ['en', 'zh'] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((l) => l === value);
}

export function localePath(): string {
  return join(configDir(), 'locale.json');
}

export function readLanguage(): Language {
  try {
    const value = (JSON.parse(readFileSync(localePath(), 'utf8')) as { language?: unknown }).language;
    return isLanguage(value) ? value : 'en';
  } catch {
    return 'en';
  }
}

export function writeLanguage(language: Language): void {
  writePrivateFile(localePath(), `${JSON.stringify({ language }, null, 2)}\n`);
}
