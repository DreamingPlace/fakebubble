import assert from 'node:assert/strict';
import test from 'node:test';
import { purgeLegacyInvites, playerLoginsRemain } from '../../../apps/server/identity/web-player-purge.ts';
import { schema125 } from '../fixtures/invite-tiers.ts';

// Part 22a2: the one helper the cloud clearDatabase, the Node cleaner and the player-deletion purge share (all through
// purgePlayerLogins). It runs on the real schema with foreign keys ON, so a wrong delete order fails here.
const NOW = 1_800_000_000_000;

test('purgeLegacyInvites deletes children before parents, revokes the grant, leaves other principals alone and is repeatable', (t) => {
  const store = schema125();
  t.after(() => store.close());
  assert.equal(store.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys, 1);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', 'c', 1, '{}');
  store.run("INSERT INTO admin_sessions VALUES ('admin','h',?,?,NULL)", NOW, NOW + 1000);
  for (const name of ['a', 'b']) {
    store.run('INSERT INTO api_players VALUES (?,?)', `player-${name}`, NOW);
    store.run('INSERT INTO worlds VALUES (?,?,?,?)', `world-${name}`, `player-${name}`, 'Asia/Singapore', '{}');
    store.run(
      "INSERT INTO web_principals(id,player_id,world_id,kind) VALUES (?,?,?,'guest')",
      `principal-${name}`,
      `player-${name}`,
      `world-${name}`,
    );
    for (const s of ['old', 'new'])
      store.run(
        'INSERT INTO web_sessions(id,token_digest,principal_id,recovery_epoch,security_revision,csrf_seed,created_at,last_active_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
        `${s}-${name}`,
        `digest-${s}-${name}`,
        `principal-${name}`,
        'e',
        1,
        new Uint8Array(32),
        NOW,
        NOW,
        NOW + 1000,
      );
    store.run(
      `INSERT INTO web_invite_codes(id,code_digest,issue_request_id,issue_digest,capacity,redeemed_count,status,batch,created_by,created_at)
      VALUES (?,?,?,?,1,1,'active','b','admin',?)`,
      `code-${name}`,
      `cd-${name}`,
      `ir-${name}`,
      'd',
      NOW,
    );
    store.run(
      'INSERT INTO web_invite_grants(id,invite_id,principal_id,player_id,world_id,redeemed_at) VALUES (?,?,?,?,?,?)',
      `grant-${name}`,
      `code-${name}`,
      `principal-${name}`,
      `player-${name}`,
      `world-${name}`,
      NOW,
    );
    store.run(
      'INSERT INTO web_invite_credentials(grant_id,secret_digest,created_at) VALUES (?,?,?)',
      `grant-${name}`,
      `s-${name}`,
      NOW,
    );
    store.run(
      'INSERT INTO web_invite_identity_receipts(id,old_session_id,new_session_id,grant_id,request_id,code_digest,public_receipt,key_id,nonce,ciphertext,auth_tag,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      `ir-${name}`,
      `old-${name}`,
      `new-${name}`,
      `grant-${name}`,
      'r',
      `cd-${name}`,
      'p',
      'k',
      new Uint8Array(1),
      new Uint8Array(1),
      new Uint8Array(1),
      NOW,
      NOW + 1,
    );
    store.run(
      'INSERT INTO web_invite_credential_receipts(id,grant_id,request_id,old_secret_digest,new_secret_digest,new_session_id,key_id,nonce,ciphertext,auth_tag,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      `cr-${name}`,
      `grant-${name}`,
      'r2',
      `s-${name}`,
      `s2-${name}`,
      `new-${name}`,
      'k',
      new Uint8Array(1),
      new Uint8Array(1),
      new Uint8Array(1),
      NOW,
      NOW + 1,
    );
    store.run(
      'INSERT INTO web_invite_redemptions(principal_id,request_id,code_digest,grant_id,redeemed_at) VALUES (?,?,?,?,?)',
      `principal-${name}`,
      'r',
      `cd-${name}`,
      `grant-${name}`,
      NOW,
    );
  }
  assert.equal(playerLoginsRemain(store, ['principal-a']), true, 'the audit sees the legacy rows');
  purgeLegacyInvites(store, { principalId: 'principal-a', now: NOW });
  purgeLegacyInvites(store, { principalId: 'principal-a', now: NOW + 5 });
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
  const count = (table: string, who: string) =>
    store.get<{ n: number }>(
      `SELECT count(*) n FROM ${table} WHERE ${table === 'web_invite_redemptions' ? 'principal_id' : 'grant_id'}=?`,
      table === 'web_invite_redemptions' ? `principal-${who}` : `grant-${who}`,
    )!.n;
  for (const table of [
    'web_invite_credentials',
    'web_invite_identity_receipts',
    'web_invite_credential_receipts',
    'web_invite_redemptions',
  ]) {
    assert.equal(count(table, 'a'), 0, table);
    assert.equal(count(table, 'b'), 1, `${table} of the other principal`);
  }
  assert.deepEqual(
    store.all('SELECT id,revoked_at FROM web_invite_grants ORDER BY id').map((row) => ({ ...row })),
    [
      { id: 'grant-a', revoked_at: NOW },
      { id: 'grant-b', revoked_at: null },
    ],
    'the grant is revoked once and stays as a shell; the other principal is untouched',
  );
  assert.equal(playerLoginsRemain(store, ['principal-a']), false);
  assert.equal(playerLoginsRemain(store, ['principal-b']), true);
  assert.equal(
    store.get('SELECT 1 FROM web_invite_codes WHERE id=?', 'code-a') !== undefined,
    true,
    'the code digest row stays',
  );
});
