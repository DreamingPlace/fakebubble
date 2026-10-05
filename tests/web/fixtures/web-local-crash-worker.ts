import { WebStore } from '../../../apps/server/store.ts';
import { WebLocalExecutor } from '../../../apps/server/web-local-executor.ts';

const [root, instanceId, time, mode] = process.argv.slice(2);
if (!root || !instanceId || !time || !['sent', 'known'].includes(mode ?? '')) process.exit(2);
const store = new WebStore(root, { create: false, instanceId });
const executor = new WebLocalExecutor(store, { now: () => Number(time) }, {
  ...(mode === 'sent' ? { afterSpeechSent: () => process.exit(85) } : {}),
  ...(mode === 'known' ? { afterSpeechConfirm: () => process.exit(86) } : {}),
});
executor.start();
setTimeout(() => process.exit(87), 5_000);
