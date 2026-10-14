import { expect, it, vi } from 'vitest';
import { createOutput } from './output.js';

it('neutralizes terminal controls in human output while preserving Unicode, newlines and tabs', () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const body = '你好\n\ttext\u001b[2J\u001b]52;c;YWJj\u0007\u009b2J\rspoof\b\u202efdp.exe';
  try {
    createOutput({ json: false }).result({ body }, () => body);
    const rendered = String(stdout.mock.calls[0]?.[0]);
    expect(rendered).toContain('你好\n\ttext');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: regression checks that terminal controls are absent
    expect(rendered).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  } finally {
    stdout.mockRestore();
  }
});

it('preserves original control characters as JSON string data', () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const body = 'text\u001b[2J\r\u202e';
  try {
    createOutput({ json: true }).result({ body }, () => body);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({ body });
  } finally {
    stdout.mockRestore();
  }
});
