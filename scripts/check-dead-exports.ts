/**
 * Repeatable dead-export check (Part 22x). Fails when a non-test module exports a value (function, class, const, enum or
 * re-export) that nothing outside tests uses: no other non-test module imports it and the declaring file does not use it either. Same-file use does not count and neither does a test: a symbol that only a
 * test calls is dead code with a test attached, so either delete both or take it off the export list.
 *
 * Not covered: exported types and interfaces (they have no runtime), and anything under tests/ or apps/player-web/tests/.
 * An import through `export *`, a bare namespace import whose binding escapes (is used other than `ns.member`), or a dynamic
 * `import()` counts as importing every export of that module, so the check errs on the side of not reporting.
 *
 * The allow-list (config/dead-exports-allowlist.json) names exports that are called by something outside the import graph:
 * Worker/Durable Object entrypoints bound by name in wrangler config, and operator-script exports. Every entry carries a reason.
 *
 *   node scripts/check-dead-exports.ts            # exit 1 and list offenders
 *   node scripts/check-dead-exports.ts --json     # machine-readable
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isTest = (file: string) => file.startsWith('tests/') || file.startsWith('apps/player-web/tests/');

type Allow = { file: string; names: string[] | '*'; reason: string };

export type DeadExport = { file: string; name: string; testOnly: boolean };

function listFiles() {
  return execFileSync('git', ['ls-files', '*.ts'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && !file.endsWith('.d.ts'));
}

function resolveSpecifier(from: string, specifier: string, known: Set<string>) {
  if (!specifier.startsWith('.')) return null;
  const base = relative(root, resolve(root, dirname(from), specifier)).replaceAll('\\', '/');
  for (const candidate of [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`])
    if (known.has(candidate)) return candidate;
  return null;
}

const boundNames = (name: ts.BindingName): string[] =>
  ts.isIdentifier(name)
    ? [name.text]
    : name.elements.flatMap((el) => (ts.isBindingElement(el) ? boundNames(el.name) : []));
const exported = (node: ts.Node) =>
  ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

export function findDeadExports(allow: Allow[] = []): DeadExport[] {
  const files = listFiles();
  const known = new Set(files);
  const exportsOf = new Map<string, Set<string>>();
  const used = new Map<string, { prod: Set<string>; test: Set<string> }>();
  const mark = (file: string, name: string | '*', fromTest: boolean) => {
    const entry = used.get(file) ?? { prod: new Set(), test: new Set() };
    used.set(file, entry);
    (fromTest ? entry.test : entry.prod).add(name);
  };
  const sources = new Map<string, ts.SourceFile>();
  for (const file of files)
    sources.set(file, ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true));

  for (const file of files) {
    if (isTest(file)) continue;
    const names = new Set<string>();
    for (const node of sources.get(file)!.statements) {
      if (ts.isVariableStatement(node)) {
        if (exported(node))
          for (const d of node.declarationList.declarations) for (const bound of boundNames(d.name)) names.add(bound);
      } else if (ts.isExportDeclaration(node)) {
        const clause = node.exportClause;
        if (!node.isTypeOnly && clause && ts.isNamedExports(clause))
          for (const el of clause.elements) if (!el.isTypeOnly) names.add(el.name.text);
      } else if (ts.isExportAssignment(node)) names.add('default');
      else if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) &&
        exported(node) &&
        node.name
      )
        names.add(node.name.text);
    }
    exportsOf.set(file, names);
  }

  for (const file of files) {
    const fromTest = isTest(file);
    const sf = sources.get(file)!;
    const namespaces = new Map<string, string>();
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveSpecifier(file, node.moduleSpecifier.text, known);
        const clause = node.importClause;
        if (target && !clause) mark(target, '*', fromTest);
        else if (target && clause && !clause.isTypeOnly) {
          if (clause.name) mark(target, 'default', fromTest);
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, target);
          else if (bindings)
            for (const el of bindings.elements)
              if (!el.isTypeOnly) mark(target, (el.propertyName ?? el.name).text, fromTest);
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveSpecifier(file, node.moduleSpecifier.text, known);
        const clause = node.exportClause;
        if (target && !node.isTypeOnly) {
          if (!clause || ts.isNamespaceExport(clause)) mark(target, '*', fromTest);
          else
            for (const el of clause.elements)
              if (!el.isTypeOnly) mark(target, (el.propertyName ?? el.name).text, fromTest);
        }
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const target = resolveSpecifier(file, node.arguments[0].text, known);
        if (target) mark(target, '*', fromTest);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (namespaces.size) {
      const walk = (node: ts.Node) => {
        if (ts.isIdentifier(node) && namespaces.has(node.text)) {
          const parent = node.parent;
          const target = namespaces.get(node.text)!;
          if (ts.isNamespaceImport(parent)) return;
          if (ts.isPropertyAccessExpression(parent) && parent.expression === node)
            mark(target, parent.name.text, fromTest);
          else mark(target, '*', fromTest);
        }
        ts.forEachChild(node, walk);
      };
      walk(sf);
    }
  }

  const internalUse = (file: string, name: string) => {
    let found = false;
    const walk = (node: ts.Node) => {
      if (found) return;
      if (ts.isIdentifier(node) && node.text === name) {
        const parent = node.parent;
        const declaration =
          ((ts.isFunctionDeclaration(parent) ||
            ts.isClassDeclaration(parent) ||
            ts.isEnumDeclaration(parent) ||
            ts.isVariableDeclaration(parent)) &&
            parent.name === node) ||
          ts.isExportSpecifier(parent) ||
          ts.isImportSpecifier(parent) ||
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node);
        if (!declaration) found = true;
      }
      ts.forEachChild(node, walk);
    };
    walk(sources.get(file)!);
    return found;
  };
  const allowed = (file: string, name: string) =>
    allow.some((a) => a.file === file && (a.names === '*' || a.names.includes(name)));
  const dead: DeadExport[] = [];
  for (const [file, names] of exportsOf) {
    const u = used.get(file);
    for (const name of [...names].sort()) {
      if (u?.prod.has('*') || u?.prod.has(name) || allowed(file, name) || internalUse(file, name)) continue;
      dead.push({ file, name, testOnly: !!(u?.test.has('*') || u?.test.has(name)) });
    }
  }
  return dead;
}

export function loadAllowList(): Allow[] {
  const raw = JSON.parse(readFileSync(join(root, 'config/dead-exports-allowlist.json'), 'utf8')) as {
    entries: Allow[];
  };
  for (const entry of raw.entries)
    if (typeof entry.reason !== 'string' || entry.reason.length < 10)
      throw new Error(`allow-list entry ${entry.file} needs a reason`);
  return raw.entries;
}

/**
 * Allow-list entries that no longer do anything: the file or the named export is gone, or it now has a caller. A stale entry would
 * hide a future dead export under the same name, so it is a failure of its own.
 */
export function staleAllowEntries(allow: Allow[]): string[] {
  const dead = findDeadExports([]);
  const stale: string[] = [];
  for (const entry of allow) {
    const inFile = dead.filter((d) => d.file === entry.file);
    if (entry.names === '*') {
      if (!inFile.length) stale.push(`${entry.file}: '*' matches no uncalled export`);
      continue;
    }
    for (const name of entry.names) if (!inFile.some((d) => d.name === name)) stale.push(`${entry.file}: ${name}`);
  }
  return stale;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const allow = loadAllowList();
  const dead = findDeadExports(allow);
  const stale = staleAllowEntries(allow);
  if (stale.length) {
    process.stderr.write(`${stale.length} stale allow-list entr${stale.length === 1 ? 'y' : 'ies'}:\n`);
    for (const entry of stale) process.stderr.write(`  ${entry}\n`);
    process.exitCode = 1;
  }
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(dead, null, 2)}\n`);
  else if (dead.length) {
    process.stderr.write(`${dead.length} exported value(s) have no caller outside tests:\n`);
    for (const d of dead) process.stderr.write(`  ${d.file}: ${d.name}${d.testOnly ? '  (only tests use it)' : ''}\n`);
    process.stderr.write(
      'Delete the symbol (and its private helpers), stop exporting it, or add it to config/dead-exports-allowlist.json with a reason.\n',
    );
  } else process.stdout.write('dead-export check: clean\n');
  if (dead.length) process.exitCode = 1;
}
