import { WebStore } from '../../../apps/server/platform/store.ts';
import { WebVerticalPublisher } from '../../../apps/server/conversation/web-vertical-publisher.ts';

const [root, instanceId, claimJson, nowText] = process.argv.slice(2);
const store = new WebStore(root, { create: false, instanceId });
process.stdin.setEncoding('utf8');
await new Promise((resolve) => process.stdin.once('data', resolve));
try {
  const publisher = new WebVerticalPublisher(store, { now: () => Number(nowText) });
  process.stdout.write(JSON.stringify({ ok: true, receipt: publisher.publish(JSON.parse(claimJson)) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error?.message }));
} finally {
  store.close();
}
