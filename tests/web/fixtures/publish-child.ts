import { WebStore } from '../../../apps/server/store.ts';
import { WebVerticalPublisher, type WebPublicationClaim } from '../../../apps/server/web-vertical-publisher.ts';

const [root, instanceId, serializedClaim, time] = process.argv.slice(2);
if (!root || !instanceId || !serializedClaim || !time) throw new Error('Missing offline publish fixture arguments');
const store = new WebStore(root, { create: false, instanceId });
try {
  const publisher = new WebVerticalPublisher(store, { now: () => Number(time) });
  process.stdout.write(JSON.stringify(publisher.publish(JSON.parse(serializedClaim) as WebPublicationClaim)));
} finally {
  store.close();
}
