import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const original = crypto.argon2;
let calls = 0;
crypto.argon2 = function (...args) {
  calls++;
  if (process.argv[2] === 'fail-kdf' && args[1]?.message === 'injected-kdf-failure') {
    queueMicrotask(() => args[2](new Error('INJECTED_KDF')));
    return;
  }
  return original(...args);
};
syncBuiltinESMExports();

const { WebStore } = await import('../../../apps/server/store.ts');
const { WebIdentity } = await import('../../../apps/server/web-identity.ts');
const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-kdf-'));
const root = join(parent, 'web'), instanceId = crypto.randomUUID();
const store = new WebStore(root, { create: true, instanceId });
try {
  store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(crypto.randomUUID());
  const origin = 'https://verify.example.test', password = 'synthetic-password-123';
  const identity = new WebIdentity(store, { origin, cookieName: '__Host-verify_session',
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) },
    clock: { now: () => 1_700_000_000_000 } });
  const guest = identity.bootstrap(), input = { requestId: 'register', username: 'owner_one', password };
  await identity.register(guest.issuedToken, guest.csrf, origin, input);
  const challenge = identity.receiptChallenge(guest.issuedToken).csrf;
  const baseline = calls;
  if (process.argv[2] === 'fail-kdf') {
    let error = '';
    try { await identity.recoverReceipt(guest.issuedToken, challenge, origin,
      { ...input, password: 'injected-kdf-failure' }); }
    catch (cause) { error = cause.message; }
    const attempts = store.get('SELECT failed_attempts FROM web_identity_receipts').failed_attempts;
    const recovered = await identity.recoverReceipt(guest.issuedToken, challenge, origin, input);
    process.stdout.write(JSON.stringify({ error, attempts, recovered: recovered.issuedToken.length === 43 }));
  } else {
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => identity.recoverReceipt(
    guest.issuedToken, challenge, origin, { ...input, password: 'wrong-synthetic-password' })));
  const limited = results.filter(result => result.status === 'rejected' && /WEB_IDENTITY_RATE_LIMITED/.test(String(result.reason))).length;
  const attempts = store.get('SELECT failed_attempts FROM web_identity_receipts').failed_attempts;
  process.stdout.write(JSON.stringify({ kdfCalls: calls - baseline, limited, attempts }));
  }
} finally {
  store.close();
  rmSync(parent, { recursive: true, force: true });
}
