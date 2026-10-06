import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const server = fileURLToPath(new URL('../../../apps/server/', import.meta.url));
const SCOPED_FOLDERS = ['memory', 'conversation'];
// Modules that expose the raw store: the BusinessStore contract and the two concrete implementations.
const RAW_STORE_MODULES = new Set([
  'platform/store-contract.ts',
  'platform/store.ts',
  'cloudflare/store.ts',
  'cloudflare/web-store.ts',
]);
// WebRuntimeStore extends BusinessStore, so it is the same raw access under another name. The vertical publisher
// still needs it (global scheduler/budget tables, provider runtime, private audio files) and is not converted yet.
// This list may only shrink: an entry that no longer imports it fails the ratchet test below.
const RUNTIME_STORE_MODULE = 'platform/web-store-contract.ts';
const RUNTIME_STORE_UNCONVERTED = new Set(['conversation/web-vertical-publisher.ts']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(directory, entry.name)]
        : [],
  );
}

/** Every module specifier a file loads (static import, re-export, dynamic import), resolved under apps/server. */
function importedModules(file: string, source: string): string[] {
  const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g)];
  return specifiers.map((match) => relative(server, resolve(dirname(file), match[2]!)).replace(/\.js$/, '.ts'));
}

function importsRuntimeStore(file: string, source: string) {
  return importedModules(file, source).includes(RUNTIME_STORE_MODULE);
}

/** Reasons a file must not stay in a UserStore-only folder. */
function storeBoundaryViolations(file: string, source: string): string[] {
  const reasons: string[] = [];
  for (const module of importedModules(file, source))
    if (RAW_STORE_MODULES.has(module)) reasons.push(`imports raw store module ${module}`);
  const clauses = source.matchAll(/\b(?:import|export)\s+(?:type\s+)?([^;'"]*?)\s*from\s*['"][^'"]+['"]/g);
  for (const clause of clauses)
    if (/\bBusinessStore\b/.test(clause[1]!)) reasons.push('imports the BusinessStore type');
  if (/\bimport\s*\(\s*['"][^'"]*store-contract/.test(source)) reasons.push('imports the BusinessStore type');
  return reasons;
}

function scopedFiles() {
  return SCOPED_FOLDERS.flatMap((folder) => sourceFiles(join(server, folder)));
}

test('memory/ and conversation/ never import the raw BusinessStore', () => {
  const files = scopedFiles();
  const names = files.map((file) => relative(server, file));
  for (const expected of [
    'memory/memory.ts',
    'memory/memory-review.ts',
    'conversation/scenes.ts',
    'conversation/relationships.ts',
  ])
    assert.ok(names.includes(expected), `${expected} is not scanned`);
  const violations = files.flatMap((file) => {
    const name = relative(server, file);
    const source = readFileSync(file, 'utf8');
    const reasons = storeBoundaryViolations(file, source);
    if (importsRuntimeStore(file, source) && !RUNTIME_STORE_UNCONVERTED.has(name))
      reasons.push(`imports ${RUNTIME_STORE_MODULE} (WebRuntimeStore extends BusinessStore)`);
    return reasons.map((reason) => `${name}: ${reason}`);
  });
  assert.deepEqual(violations, []);
});

test('the unconverted list only shrinks: every listed file still imports the runtime store', () => {
  for (const name of RUNTIME_STORE_UNCONVERTED) {
    const file = join(server, name);
    assert.ok(
      importsRuntimeStore(file, readFileSync(file, 'utf8')),
      `${name} no longer imports ${RUNTIME_STORE_MODULE}; remove it from RUNTIME_STORE_UNCONVERTED`,
    );
  }
});

test('the scanner flags each way of reaching the raw store and accepts UserStore', () => {
  const file = join(server, 'memory/example.ts');
  const bad = [
    `import type { BusinessStore } from '../platform/store-contract.ts';`,
    `import type { BusinessStore as Store } from '../platform/store-contract.js';`,
    `import type {\n  BusinessStore,\n  SQLRow,\n} from '../platform/store-contract.ts';`,
    `import { WebStore } from '../platform/store.ts';`,
    `import type { DurableStore } from '../cloudflare/store.ts';`,
    `export type { BusinessStore } from '../platform/store-contract.ts';`,
    `type S = import('../platform/store-contract.ts').BusinessStore;`,
  ];
  for (const source of bad) assert.notDeepEqual(storeBoundaryViolations(file, source), [], source);
  assert.ok(importsRuntimeStore(file, `import type { WebRuntimeStore } from '../platform/web-store-contract.ts';`));
  assert.deepEqual(
    storeBoundaryViolations(file, `import type { UserStore as Store } from '../platform/store-boundary.ts';`),
    [],
  );
});
