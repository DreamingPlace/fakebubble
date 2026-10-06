import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebProviderBudget, type BudgetHistory } from '../../../apps/server/budget/web-provider-budget.ts';

const clock = { now: () => 1234 };
const fingerprint = 'a'.repeat(64);
function fixture(t: test.TestContext, spent = 0) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'web-shared-budget-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'budget.sqlite');
  const history: BudgetHistory[] = ['deepseek', 'fish'].map((provider) => ({
    source: 'legacy-instance',
    provider: provider as 'deepseek' | 'fish',
    digest: fingerprint,
    spentMicros: spent,
    heldMicros: 0,
  }));
  WebProviderBudget.initialize(path, history);
  return { path, history };
}

test('shared budget includes immutable historical spent and UNKNOWN holds, cannot reinitialize', (t) => {
  const { path, history } = fixture(t, 1_000_000);
  const budget = new WebProviderBudget(path, clock);
  t.after(() => budget.close());
  budget.verifyHistory(history);
  assert.throws(() => budget.verifyHistory(history.map((r) => ({ ...r, heldMicros: 1 }))), /HISTORY_CHANGED/);
  assert.throws(() => WebProviderBudget.initialize(path, history), /EEXIST/);
  budget.reserve('instance-a', 'deepseek', fingerprint, 1_500_000);
  assert.throws(() => budget.reserve('instance-b', 'deepseek', fingerprint, 500_001), /BUDGET_EXHAUSTED/);
  assert.equal(budget.summary()[0]!.remainingMicros, 500_000);
});

test('sent boundary survives restart; repeated or mutated requests cannot send again', (t) => {
  const { path } = fixture(t);
  let budget = new WebProviderBudget(path, clock);
  budget.reserve('one', 'fish', fingerprint, 100);
  budget.close();
  budget = new WebProviderBudget(path, clock);
  t.after(() => budget.close());
  assert.equal(budget.read('one', fingerprint)!.state, 'sent');
  assert.throws(() => budget.reserve('one', 'fish', fingerprint, 100), /ATTEMPT_UNRESOLVED/);
  assert.throws(() => budget.reserve('one', 'fish', 'b'.repeat(64), 100), /REQUEST_CONFLICT/);
  assert.equal(budget.summary()[1]!.heldMicros, 100);
});

test('known settlement is idempotent, bounded, and keeps durable material bytes', (t) => {
  const { path } = fixture(t);
  const budget = new WebProviderBudget(path, clock);
  t.after(() => budget.close());
  budget.reserve('asset', 'fish', fingerprint, 100);
  assert.throws(() => budget.settle('asset', fingerprint, 101, {}), /RECEIPT_INVALID/);
  const audio = Buffer.from('durable-output');
  budget.settle('asset', fingerprint, 60, { request: 'one' }, audio);
  budget.settle('asset', fingerprint, 60, { request: 'one' }, audio);
  assert.throws(() => budget.settle('asset', fingerprint, 0, {}), /RECEIPT_CONFLICT/);
  assert.deepEqual(Buffer.from(budget.read('asset', fingerprint)!.audio!), audio);
  assert.equal(budget.summary()[1]!.spentMicros, 60);
  assert.equal(budget.summary()[1]!.heldMicros, 0);
});

test('two independent processes competing for the last shared allowance admit exactly one', async (t) => {
  const { path } = fixture(t, 2_999_900);
  const module = new URL('../../../apps/server/budget/web-provider-budget.ts', import.meta.url).href;
  const children = [0, 1].map((index) =>
    spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { WebProviderBudget } from ${JSON.stringify(module)};
    const b=new WebProviderBudget(${JSON.stringify(path)}, {now:()=>1234});
    try { b.reserve('process-${index}','deepseek','${fingerprint}',100); console.log('reserved'); }
    catch(e) { console.log(e.code ?? e.message); } finally { b.close(); }
  `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
  const outputs = await Promise.all(
    children.map(async (child) => {
      let out = '',
        err = '';
      child.stdout!.on('data', (s) => (out += s));
      child.stderr!.on('data', (s) => (err += s));
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, err);
      return out.trim();
    }),
  );
  assert.deepEqual(outputs.sort(), ['WEB_SHARED_BUDGET_EXHAUSTED', 'reserved'].sort());
});

test('provider CLI defaults reject live serve and asset rendering before any file or key access', () => {
  for (const action of ['serve', 'render-assets']) {
    const result = spawnSync(
      process.execPath,
      ['scripts/web-provider.ts', action, '/does-not-exist', '/never-read-credentials'],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WEB_PROVIDER_LIVE_OPT_IN_REQUIRED/);
    assert.doesNotMatch(result.stderr, /ENOENT|CREDENTIAL_MISSING/);
  }
});

test('cloud allocation and a concurrent local send cannot spend the same last allowance', async (t) => {
  const { path } = fixture(t, 2_999_900);
  const module = new URL('../../../apps/server/budget/web-provider-budget.ts', import.meta.url).href;
  const target = { accountId: 'a'.repeat(32), namespaceId: 'b'.repeat(32), objectId: 'c'.repeat(64) };
  const children = [0, 1].map((index) =>
    spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { WebProviderBudget } from ${JSON.stringify(module)};
    const b=new WebProviderBudget(${JSON.stringify(path)}, {now:()=>1234});
    try { ${
      index === 0
        ? `b.allocateCloud('cloud',${JSON.stringify(target)},'deepseek',100)`
        : `b.reserve('local','deepseek','${fingerprint}',100)`
    }; console.log('reserved'); }
    catch(e) { console.log(e.code ?? e.message); } finally { b.close(); }
  `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
  const outputs = await Promise.all(
    children.map(async (child) => {
      let out = '',
        err = '';
      child.stdout!.on('data', (s) => (out += s));
      child.stderr!.on('data', (s) => (err += s));
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, err);
      return out.trim();
    }),
  );
  assert.deepEqual(outputs.sort(), ['WEB_SHARED_BUDGET_EXHAUSTED', 'reserved'].sort());
});
