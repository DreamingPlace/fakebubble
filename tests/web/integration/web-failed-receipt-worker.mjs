import { WebStore } from '../../../apps/server/store.ts';
import { WebDispatchLedger } from '../../../apps/server/web-dispatch-ledger.ts';

const [root, instanceId, keyJson, resultJson, nowText] = process.argv.slice(2);
const store = new WebStore(root, { create: false, instanceId });
process.stdin.setEncoding('utf8');
await new Promise((resolve) => process.stdin.once('data', resolve));
try {
  const ledger = new WebDispatchLedger(store, { now: () => Number(nowText) });
  process.stdout.write(
    JSON.stringify({ ok: true, result: ledger.confirm(JSON.parse(keyJson), JSON.parse(resultJson)) }),
  );
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error?.message }));
} finally {
  store.close();
}
