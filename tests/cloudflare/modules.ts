import { readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import ts from 'typescript';
import type { ModuleDefinition } from 'miniflare';

/** Compile the real dependency graph for workerd, using the project's existing TypeScript compiler. */
export function testModules(entry: string): ModuleDefinition[] {
  const modules = new Map<string, ModuleDefinition>();
  function visit(path: string) {
    if (modules.has(path)) return;
    const source = readFileSync(path, 'utf8');
    if (path.endsWith('.sql')) {
      modules.set(path, { type: 'Text', path, contents: source });
      return;
    }
    if (path.endsWith('.json')) {
      modules.set(path, {
        type: 'ESModule',
        path,
        contents: 'export default ' + JSON.stringify(JSON.parse(source)) + ';',
      });
      return;
    }
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
        useDefineForClassFields: true,
      },
      transformers: {
        before: [
          (context) => (file) =>
            ts.visitNode(file, function visit(node: ts.Node): ts.VisitResult<ts.Node> {
              if (
                ts.isImportDeclaration(node) &&
                ts.isStringLiteral(node.moduleSpecifier) &&
                ['jose', 'jose/jwt/verify', 'jose/jwks/remote'].includes(node.moduleSpecifier.text)
              ) {
                const resolved = relative(dirname(path), require.resolve(node.moduleSpecifier.text));
                return context.factory.updateImportDeclaration(
                  node,
                  node.modifiers,
                  node.importClause,
                  context.factory.createStringLiteral(resolved.startsWith('.') ? resolved : './' + resolved),
                  node.attributes,
                );
              }
              if (
                ts.isImportDeclaration(node) &&
                ts.isStringLiteral(node.moduleSpecifier) &&
                node.moduleSpecifier.text.endsWith('.json')
              )
                return context.factory.updateImportDeclaration(
                  node,
                  node.modifiers,
                  node.importClause,
                  node.moduleSpecifier,
                  undefined,
                );
              return ts.visitEachChild(node, visit, context);
            }) as ts.SourceFile,
        ],
      },
    });
    modules.set(path, { type: 'ESModule', path, contents: outputText });
    const parsed = ts.createSourceFile(path, outputText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    for (const node of parsed.statements) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const name = node.moduleSpecifier.text;
        if (name.startsWith('.')) visit(resolve(dirname(path), name));
        else if (
          ![
            'cloudflare:workers',
            'node:crypto',
            'node:buffer',
            'node:zlib',
            'node:util',
            'node:timers/promises',
          ].includes(name)
        )
          throw new Error(`Unexpected runtime dependency in Cloudflare storage tests: ${name}`);
      }
    }
  }
  visit(resolve(entry));
  return [...modules.values()];
}
