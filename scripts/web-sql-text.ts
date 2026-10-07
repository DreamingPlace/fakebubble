import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Node counterpart of the Cloudflare `Text` rule for *.sql: an import yields the file's exact text, nothing else. */
export function registerSqlTextLoader() {
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:') || !url.endsWith('.sql')) return nextLoad(url, context);
      const source = 'export default ' + JSON.stringify(readFileSync(fileURLToPath(url), 'utf8')) + ';';
      return { format: 'module', source, shortCircuit: true };
    },
  });
}
