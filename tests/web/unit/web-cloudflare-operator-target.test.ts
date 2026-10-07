import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareWebOperation,
  runWebOperator,
  webOperatorArguments,
  webOperatorConfig,
} from '../../../scripts/web-cloudflare-operator.ts';

const business = 'fake-paopao-web-business',
  budget = 'fake-paopao-web-budget';

test('operator target defaults to fakebubble-* and accepts only validated explicit service names', (t) => {
  const receipt = '/tmp/receipt.jsonl';
  const base = webOperatorArguments(['--action=status', `--receipt-file=${receipt}`]);
  assert.equal(base.businessService, 'fakebubble-business');
  assert.equal(base.budgetService, 'fakebubble-budget');
  const named = webOperatorArguments([
    '--action=budget-summary',
    `--receipt-file=${receipt}`,
    `--business-service=${business}`,
    `--budget-service=${budget}`,
  ]);
  assert.equal(webOperatorConfig('status', 'a'.repeat(32), named).services[0]!.service, business);
  assert.equal(webOperatorConfig('budget-summary', 'a'.repeat(32), named).services[0]!.service, budget);
  assert.equal(webOperatorConfig('status', 'a'.repeat(32)).services[0]!.service, 'fakebubble-business');
  for (const bad of ['', 'Upper', 'under_score', 'a/b', '-'.repeat(64), 'x'.repeat(64), 'a b', 'é'])
    for (const option of ['business-service', 'budget-service'])
      assert.throws(
        () => webOperatorArguments(['--action=status', `--receipt-file=${receipt}`, `--${option}=${bad}`]),
        /WEB_OPERATOR_(SERVICE_INVALID|ARGUMENT_INVALID)/,
        `${option}=${bad}`,
      );
  assert.throws(
    () => webOperatorConfig('status', 'a'.repeat(32), { businessService: 'Bad_Name', budgetService: budget }),
    /WEB_OPERATOR_SERVICE_INVALID/,
  );
  void t;
});

test('every receipt records the target and a receipt for a different target is refused, never continued', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'web-operator-target-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const operator = { status: async () => ({ ok: true }), summary: async () => [] };
  let proxies = 0;
  const proxy = async () => {
    proxies++;
    return { env: { OPERATOR: operator as never }, dispose: async () => {} };
  };
  const args = (receipt: string, ...extra: string[]) =>
    prepareWebOperation(webOperatorArguments(['--action=status', `--receipt-file=${receipt}`, ...extra]));
  const receipt = join(dir, 'receipt.jsonl');
  await runWebOperator(args(receipt, `--business-service=${business}`, `--budget-service=${budget}`), proxy, '/c');
  const lines = readFileSync(receipt, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => l.state),
    ['prepared', 'completed'],
  );
  for (const line of lines) {
    assert.deepEqual(line.target, { businessService: business, budgetService: budget });
    assert.equal(line.worker, business);
  }
  const before = readFileSync(receipt, 'utf8');
  // A different target on the same receipt is refused before any binding is opened.
  for (const other of [
    ['--business-service=fakebubble-business', `--budget-service=${budget}`],
    [`--business-service=${business}`],
    [`--business-service=${business}`, '--budget-service=other-budget'],
    [],
  ])
    await assert.rejects(runWebOperator(args(receipt, ...other), proxy, '/c'), /WEB_OPERATOR_RECEIPT_TARGET_MISMATCH/);
  // The same target is still never continued: exclusive creation fails and nothing is appended.
  await assert.rejects(
    runWebOperator(args(receipt, `--business-service=${business}`, `--budget-service=${budget}`), proxy, '/c'),
    /EEXIST/,
  );
  assert.equal(proxies, 1);
  assert.equal(readFileSync(receipt, 'utf8'), before);
  // Receipts written before targets were recorded are compared by their worker name.
  const legacy = join(dir, 'legacy.jsonl');
  writeFileSync(
    legacy,
    JSON.stringify({ state: 'prepared', action: 'status', worker: 'fakebubble-business', detail: null }) + '\n',
    {
      mode: 0o600,
    },
  );
  await assert.rejects(runWebOperator(args(legacy, `--business-service=${business}`), proxy, '/c'), /TARGET_MISMATCH/);
  await assert.rejects(runWebOperator(args(legacy), proxy, '/c'), /EEXIST/);
  const garbage = join(dir, 'garbage.jsonl');
  writeFileSync(garbage, 'not json\n', { mode: 0o600 });
  await assert.rejects(runWebOperator(args(garbage), proxy, '/c'), /WEB_OPERATOR_RECEIPT_UNREADABLE/);
  assert.equal(proxies, 1);
});

test('inspect action is read-only RPC on the business service and its result is recorded only in the private receipt', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'web-operator-inspect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const receipt = join(dir, 'inspect.jsonl');
  const args = webOperatorArguments([
    '--action=inspect',
    `--receipt-file=${receipt}`,
    `--business-service=${business}`,
  ]);
  assert.equal(webOperatorConfig('inspect', 'a'.repeat(32), args).services[0]!.service, business);
  assert.equal(webOperatorConfig('inspect', 'a'.repeat(32), args).services[0]!.entrypoint, 'WebOperatorService');
  assert.throws(
    () => webOperatorArguments(['--action=inspect', `--receipt-file=${receipt}`, '--name=x']),
    /WEB_OPERATOR_ARGUMENT_INVALID/,
  );
  const result = await runWebOperator(
    prepareWebOperation(args),
    async () => ({
      env: {
        OPERATOR: {
          inspect: async () => ({ schemaVersion: 116 }),
          status: async () => assert.fail('inspect must not call status'),
        } as never,
      },
      dispose: async () => {},
    }),
    '/c',
  );
  assert.deepEqual(result, { action: 'inspect', receiptFile: receipt });
  const last = JSON.parse(readFileSync(receipt, 'utf8').trim().split('\n').at(-1)!);
  assert.deepEqual(last.detail, { schemaVersion: 116 });
  assert.equal(last.worker, business);
});
