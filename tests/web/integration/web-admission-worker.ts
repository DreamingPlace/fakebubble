import { randomUUID } from 'node:crypto';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebStore } from '../../../apps/server/store.ts';

// Isolated child process used only by C's concurrent SQLite admission checks.
const [mode, root, instanceId, principalId, requestId, text, ipHash] = process.argv.slice(2);
if (!mode || !root || !instanceId) throw new Error('worker arguments missing');
process.stdin.once('data', () => {
  let store: WebStore | undefined;
  try {
    store = new WebStore(root, { create: mode === 'create', instanceId });
    const result =
      mode === 'admit'
        ? new WebAdmission(store, { now: () => 1_700_000_000_000 }, randomUUID).admit({
            principalId: principalId!,
            requestId: requestId!,
            characterId: 'fixture-character',
            text: text!,
            ipHash: ipHash!,
          })
        : { instanceId: store.get<{ instance_id: string }>('SELECT instance_id FROM web_instance')?.instance_id };
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));
  } finally {
    store?.close();
  }
});
