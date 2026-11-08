import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  ERROR_SENTENCES,
  REFUSED,
  UNKNOWN_OUTCOME,
} from '../../../apps/player-web/src/features/admin/error-sentences.ts';
import { adminAccountError } from '../../../apps/player-web/src/features/admin/account-admin-page.ts';
import { InviteLocalApiError } from '../../../apps/player-web/src/services/invite-local-api.ts';

/**
 * Part 24m: every code the server can answer the character workbench with has a client sentence. The codes are collected from the
 * server's own source (the `ensure(..., 'CODE')` and `new DomainError('CODE')` calls of the workbench's paths: save, discard,
 * 预演, runs, materials, publish, restore, 下线/上线, code, checklist, profile import, deletion), so a new code cannot slip through.
 */
const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const SERVER = [
  ...readdirSync(new URL('apps/server/characters/', root))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `apps/server/characters/${name}`),
  'packages/domain/schedule.ts',
  'packages/domain/autonomy.ts',
];
const CODE =
  /(?:ensure\((?:[^;]*?),\s*|new (?:Domain|Detailed|RetryAfter)Error\(\s*)'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/gs;
/** Named exception: codes that only a corrupted store or a programming error can raise; the admin is told to contact the owner via the generic text. */
const INTERNAL = new Set<string>([]);

test('every server code on the workbench paths has a client sentence', () => {
  const missing = new Set<string>();
  for (const file of SERVER)
    for (const match of read(file).matchAll(CODE)) {
      const code = match[1]!;
      if (!ERROR_SENTENCES[code] && !INTERNAL.has(code)) missing.add(`${code} (${file})`);
    }
  assert.deepEqual([...missing].sort(), [], 'add a sentence to features/admin/error-sentences.ts');
});

test('the generic "unconfirmed" text is only for an outcome that is really unknown', () => {
  assert.equal(adminAccountError(new InviteLocalApiError(409, 'DRAFT_CONFLICT')), ERROR_SENTENCES.DRAFT_CONFLICT);
  assert.match(ERROR_SENTENCES.DRAFT_CONFLICT!, /草稿已在别处更新/);
  assert.equal(
    adminAccountError(new InviteLocalApiError(409, 'CONFLICTING_BIRTH_DATE')),
    ERROR_SENTENCES.CONFLICTING_BIRTH_DATE,
  );
  assert.equal(adminAccountError(new InviteLocalApiError(500, 'INTERNAL_ERROR')), UNKNOWN_OUTCOME);
  assert.equal(adminAccountError(new InviteLocalApiError(503, 'WHATEVER')), UNKNOWN_OUTCOME);
  assert.equal(adminAccountError(new Error('network')), UNKNOWN_OUTCOME);
  assert.equal(adminAccountError(new InviteLocalApiError(409, 'NOT_A_KNOWN_CODE')), REFUSED);
  for (const [code, text] of Object.entries(ERROR_SENTENCES)) {
    assert.ok(text.length > 0 && text.length <= 60, `${code}: short`);
    assert.notEqual(text, UNKNOWN_OUTCOME);
  }
});
