import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
// TypeScript 7's compiler (Go) has no JavaScript API; the source parser for this check stays on the 5.x API
import ts from 'typescript-api';
import { expect, it } from 'vitest';

/*
 * Every Chinese string in the dashboard must be the Chinese half of a pair, so English (the default) never falls
 * back to Chinese. Allowed places: the second argument of a translate call (`t`, `tNow`), a `zh` property (error
 * tables, LocalError), and the literal language label '中文'.
 */
const SRC = resolve(import.meta.dirname, '..');
const CJK = /[一-鿿]/;
const TRANSLATE = new Set(['t', 'tNow', 'tr']);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function allowed(node: ts.Node): boolean {
  // Walk up through templates, parentheses, `a || '…'` and `c ? '…' : '…'` to the argument that holds the string.
  let child: ts.Node = node;
  let parent = node.parent;
  while (
    parent &&
    (ts.isTemplateSpan(parent) ||
      ts.isTemplateExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isBinaryExpression(parent) ||
      ts.isConditionalExpression(parent))
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return false;
  if (
    ts.isCallExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    TRANSLATE.has(parent.expression.text)
  )
    return parent.arguments.indexOf(child as ts.Expression) === 1;
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name) && parent.name.text === 'zh')
    return true;
  // Inside a `zh: { … }` table (error-text.ts): any ancestor property named zh.
  for (let p: ts.Node | undefined = parent; p; p = p.parent)
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'zh') return true;
  return ts.isStringLiteral(node) && node.text === '中文';
}

it('pairs every Chinese UI string with English', () => {
  const violations: string[] = [];
  for (const file of files(SRC)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      const text =
        ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)
          ? node.text
          : ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
            ? node.text
            : null;
      const target = ts.isTemplateHead(node) ? node.parent : node;
      if (text && CJK.test(text) && (ts.isJsxText(node) || !allowed(target))) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        violations.push(`${relative(SRC, file)}:${line + 1} ${text.trim().slice(0, 40)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
