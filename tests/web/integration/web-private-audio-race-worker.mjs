import { WebStore } from '../../../apps/server/store.ts';
import { WebSyntheticPrivateAudio } from '../../../apps/server/web-private-audio.ts';
import { tone } from '../../audio-fixtures.ts';

const [root, instanceId, scopeJson, leaseJson, nowText] = process.argv.slice(2);
const store = new WebStore(root, { create: false, instanceId });
process.stdin.setEncoding('utf8');
await new Promise((resolve) => process.stdin.once('data', resolve));
try {
  const audio = new WebSyntheticPrivateAudio(store, { now: () => Number(nowText) });
  process.stdout.write(
    JSON.stringify({ ok: true, result: audio.stage(JSON.parse(scopeJson), JSON.parse(leaseJson), tone(250)) }),
  );
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error?.message }));
} finally {
  store.close();
}
