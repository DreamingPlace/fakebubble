/**
 * Every literal DomainError code thrown under apps/server (Part 29 G). Used by the refusal-status test: a code that is thrown
 * but is not in the status table would answer 400 and be counted instead of being decided on purpose.
 * Reads `ensure(cond, 'CODE')`, `new DomainError('CODE')`, `new DetailedError('CODE', …)` and `new RetryAfterError('CODE', …)`;
 * a conditional or concatenated second argument contributes every string literal in it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLASSES = new Set(['DomainError', 'DetailedError', 'RetryAfterError']);
const CODE = /^[A-Z][A-Z0-9_]{2,}$/;

function literals(node: ts.Node | undefined, out: Set<string>) {
  if (!node) return;
  if (ts.isStringLiteralLike(node)) {
    if (CODE.test(node.text)) out.add(node.text);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    literals(node.whenTrue, out);
    literals(node.whenFalse, out);
  } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) literals(node.expression, out);
  else if (ts.isBinaryExpression(node)) {
    literals(node.left, out);
    literals(node.right, out);
  }
}

export function thrownDomainErrorCodes(): string[] {
  const files = execFileSync('git', ['ls-files', 'apps/server/*.ts'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && !file.endsWith('.d.ts'));
  const codes = new Set<string>();
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'ensure')
        literals(node.arguments[1], codes);
      else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && CLASSES.has(node.expression.text))
        literals(node.arguments?.[0], codes);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...codes].sort();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(thrownDomainErrorCodes().join('\n'));
