import { readLanguage } from './locale.js';

/** All human output goes to stderr when running as an MCP server; otherwise stdout for results, stderr for logs. */
export interface Output {
  json: boolean;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  result(value: unknown, human: () => string): void;
}

/** Keep terminal controls visible as data; JSON output retains the original string. */
export function terminalText(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: neutralize terminal controls, preserving LF and tab
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function createOutput(opts: { json: boolean; quiet?: boolean }): Output {
  return {
    json: opts.json,
    info: (m) => {
      if (!opts.quiet) process.stderr.write(`${terminalText(m)}\n`);
    },
    warn: (m) => process.stderr.write(`${prefix('warning')}${terminalText(m)}\n`),
    error: (m) => process.stderr.write(`${prefix('error')}${terminalText(m)}\n`),
    result: (value, human) => {
      process.stdout.write(opts.json ? `${JSON.stringify(value, null, 2)}\n` : `${terminalText(human())}\n`);
    },
  };
}

export const CLI_VERSION = '0.5.17';

/** The label before a warning or an error line, in the person's language. */
export function prefix(kind: 'warning' | 'error'): string {
  let zh = false;
  try {
    zh = readLanguage() === 'zh';
  } catch {
    // no readable settings: English
  }
  if (kind === 'error') return zh ? '错误：' : 'error: ';
  return zh ? '注意：' : 'warning: ';
}
