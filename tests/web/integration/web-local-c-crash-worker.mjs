import { WebStore } from '../../../apps/server/platform/store.ts';
import { WebLocalExecutor } from '../../../apps/server/platform/web-local-executor.ts';

const [root, instanceId, nowRaw, mode] = process.argv.slice(2);
if (!root || !instanceId || !nowRaw || !['sent', 'known'].includes(mode)) process.exit(70);
const store = new WebStore(root, { create: false, instanceId });
const executor = new WebLocalExecutor(
  store,
  { now: () => Number(nowRaw) },
  {
    afterSpeechSent: () => {
      if (mode === 'sent') process.exit(85);
    },
    afterSpeechConfirm: () => {
      if (mode === 'known') process.exit(86);
    },
  },
);
executor.start();
for (let step = 0; step < 10; step++) executor.pump();
process.exit(71);
