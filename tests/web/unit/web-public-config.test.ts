import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { liveBudgetAuthority } from '../../../apps/server/budget/web-provider-live-budget.ts';
import { validateSelectedVoicePins } from '../../../apps/server/generation/web-provider-materials.ts';
import { webOperatorConfig } from '../../../scripts/web-cloudflare-operator.ts';

test('public source has no implicit account, material approval or budget authority', (t) => {
  assert.throws(() => webOperatorConfig('status', ''), /WEB_OPERATOR_ACCOUNT_REQUIRED/);
  assert.throws(() => validateSelectedVoicePins(null), /WEB_PROVIDER_MATERIAL_PINS_REQUIRED/);
  const prior = process.env.FAKEBUBBLE_BUDGET_AUTHORITY;
  t.after(() => {
    if (prior === undefined) delete process.env.FAKEBUBBLE_BUDGET_AUTHORITY;
    else process.env.FAKEBUBBLE_BUDGET_AUTHORITY = prior;
  });
  delete process.env.FAKEBUBBLE_BUDGET_AUTHORITY;
  assert.throws(() => liveBudgetAuthority(), /WEB_BUDGET_AUTHORITY_REQUIRED/);
  const dir = mkdtempSync(join(tmpdir(), 'public-authority-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'authority.json');
  process.env.FAKEBUBBLE_BUDGET_AUTHORITY = file;
  const valid = { budgetPath: join(dir, 'budget.sqlite'), historyRoots: [] };
  const write = (v: unknown) => writeFileSync(file, JSON.stringify(v), { mode: 0o600 });
  write(valid);
  assert.deepEqual(liveBudgetAuthority(), valid);
  chmodSync(file, 0o644);
  assert.throws(() => liveBudgetAuthority(), /AUTHORITY_INVALID/);
  chmodSync(file, 0o600);
  for (const invalid of [
    { ...valid, budgetPath: './new-instance.sqlite' },
    { ...valid, historyRoots: ['/a', '/a'] },
    { budgetPath: valid.budgetPath },
    { ...valid, extra: true },
  ]) {
    write(invalid);
    assert.throws(() => liveBudgetAuthority(), /AUTHORITY_INVALID/);
  }
  const pins = {
    directory: 'approved-set',
    selectionSHA256: 'a'.repeat(64),
    publicationSHA256: 'b'.repeat(64),
    characters: Object.fromEntries(
      ['chen-jimi', 'wei-guagua', 'jojo'].map((id) => [
        id,
        { voiceSHA256: 'c'.repeat(64), draftSHA256: 'd'.repeat(64), publishedSHA256: 'e'.repeat(64) },
      ]),
    ),
  };
  validateSelectedVoicePins(pins);
  assert.throws(() => validateSelectedVoicePins({ ...pins, directory: '../private' }), /PINS_REQUIRED/);
  assert.throws(() => validateSelectedVoicePins({ ...pins, selectionSHA256: '' }), /PINS_REQUIRED/);
});
