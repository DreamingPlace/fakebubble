import { createRequire } from 'node:module';
export function loadPlaywright(): any {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { return createRequire(import.meta.url)(c); } catch {} }
  throw new Error('no playwright');
}
