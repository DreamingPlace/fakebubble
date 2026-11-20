import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../apps/server/platform/store.ts';
import { migrateWebProviderOffline } from '../../../apps/server/generation/web-provider-migration.ts';
import type { WebRuntimeStore } from '../../../apps/server/platform/web-store-contract.ts';
import { configureWebProvider } from '../../../apps/server/generation/web-provider-configuration.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import { installWebCharacterCatalog } from '../../../apps/server/characters/web-character-catalog.ts';
import { WebAdminSpeech, type WebAdminSpeechBudget } from '../../../apps/server/characters/web-admin-speech.ts';
import { WebProviderBudget } from '../../../apps/server/budget/web-provider-budget.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import type { FakeFish } from '../../../apps/server/generation/web-provider-runner.ts';
import { WebBroadcast, BROADCAST_LIMITS } from '../../../apps/server/broadcast/web-broadcast.ts';
import {
  installWebBroadcast,
  broadcastResidue,
  purgeBroadcastCharacter,
  purgeBroadcastConversation,
  purgeBroadcastWorld,
} from '../../../apps/server/broadcast/web-broadcast-schema.ts';
import {
  broadcastAudio,
  broadcastContextMessages,
  broadcastHistoryRows,
} from '../../../apps/server/broadcast/web-broadcast-read.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import { freezeWebV7Request, readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { installWriterSetting, writeWriter } from '../../../apps/server/generation/web-writer-setting.ts';
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import { WebShare } from '../../../apps/server/share/web-share.ts';
import { installWebShare, purgeShareConversation } from '../../../apps/server/share/web-share-schema.ts';

const ORIGIN = 'https://fixture.invalid';
type Mode = 'normal' | 'throw';

/** Schema 113 as the speech tests build it (real catalog, three live characters, a real shared budget and a fake Fish). */
function fixture(t: test.TestContext, options: { batch?: number } = {}) {
  let now = 1_800_000_000_000;
  const clock = { now: () => now },
    raw = new Store(':memory:');
  t.after(() => raw.close());
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    raw.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  raw.db.exec('PRAGMA user_version=112');
  raw.run("INSERT INTO web_instance(singleton,instance_id) VALUES (1,'broadcast-instance')");
  migrateWebProviderOffline(raw);
  raw.db.exec(readFileSync(new URL('119_preview_workbench.sql', folder), 'utf8'));
  const store = Object.assign(raw, {
    instanceId: 'broadcast-instance',
    webReceiptDigest: (kind: string, json: string) =>
      createHash('sha256')
        .update(kind + ':fixture:' + json)
        .digest('hex'),
  }) as unknown as WebRuntimeStore;
  const selected = syntheticSelection();
  for (const item of selected)
    raw.run(
      'INSERT INTO character_templates VALUES (?,?,?)',
      item.characterId,
      item.personaVersion,
      JSON.stringify(item.template),
    );
  configureWebProvider(store, selected, now);
  const accounts = new WebAccountAdmin(raw, clock, ORIGIN);
  installWebCharacterCatalog(raw);
  const chars = new WebCharacterAdmin(raw, clock, accounts);
  const login = accounts.login(accounts.issueLoginGrant().token, ORIGIN);
  const auth = { cookie: login.cookie, csrf: login.csrf, origin: ORIGIN };
  // Each live character gets a draft with a voice (the draft is what the admin speech path speaks with).
  for (const id of ['wei-guagua', 'jojo']) {
    const profile = chars.detail(auth, id).published!.profile;
    profile.template.version++;
    profile.template.voice = { profileId: 'draft-voice', version: 1, speed: 1 };
    chars.save(auth, id, { expectedRevision: null, profile });
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'broadcast-'))),
    path = join(root, 'budget.sqlite');
  t.after(() => rmSync(root, { force: true, recursive: true }));
  WebProviderBudget.initialize(
    path,
    ['deepseek', 'fish'].map((provider) => ({
      source: 'offline-history',
      provider: provider as 'deepseek' | 'fish',
      digest: 'a'.repeat(64),
      spentMicros: 0,
      heldMicros: 0,
    })),
  );
  const shared = new WebProviderBudget(path, clock);
  t.after(() => shared.close());
  const log = { reserved: [] as string[] };
  const authority: WebAdminSpeechBudget = {
    reserve: (id, provider, fingerprint, micros) => {
      log.reserved.push(id);
      return shared.reserve(id, provider, fingerprint, micros);
    },
    settle: (id, fingerprint, micros, receipt) => shared.settle(id, fingerprint, micros, receipt),
  };
  let mode: Mode = 'normal';
  const sent: { text: string; reservedBeforeSend: boolean }[] = [];
  const fish: FakeFish = async (request) => {
    sent.push({
      text: JSON.parse(request.body).text,
      // The reservation of THIS call exists before the provider is reached.
      reservedBeforeSend: log.reserved.length === sent.length + 1,
    });
    if (mode === 'throw') throw new Error('offline network interrupted');
    return {
      audio: syntheticTone(600),
      receipt: { requestId: 'fake-' + sent.length, billedBytes: request.billedTextBytes },
      usageUnits: request.billedTextBytes,
    };
  };
  const speech = new WebAdminSpeech(raw, clock, fish, authority, 's2.1-pro');
  chars.enableSpeech(speech);
  installWebBroadcast(raw);
  const make = () => new WebBroadcast(store, clock, accounts, () => chars.speechPath, { batch: options.batch ?? 50 });
  const broadcast = make();
  let n = 0;
  /** A registered player (kind account) or a guest, each with a world of its own. */
  const player = (name: string, kind: 'account' | 'guest' = 'account') => {
    const playerId = `player-${name}`,
      worldId = `world-${name}`,
      principalId = `principal-${name}`;
    raw.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
    raw.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'Asia/Singapore', '{}');
    raw.run(
      'INSERT INTO web_principals(id,player_id,world_id,kind) VALUES (?,?,?,?)',
      principalId,
      playerId,
      worldId,
      kind,
    );
    if (kind === 'account')
      raw.run(
        'INSERT INTO web_accounts(id,principal_id,username_norm,password_salt,password_tag,created_at) VALUES (?,?,?,?,?,?)',
        `acct-${name}`,
        principalId,
        `user-${name}`,
        Buffer.alloc(16),
        Buffer.alloc(32),
        now,
      );
    n++;
    return { principalId, worldId, playerId };
  };
  const messagesOf = (worldId: string, characterId: string) =>
    raw.all<{
      id: string;
      body: string;
      delivery: string;
      media_id: string | null;
      author_kind: string;
      author_id: string;
    }>(
      `SELECT m.id,m.body,m.delivery,m.media_id,m.author_kind,m.author_id FROM messages m JOIN conversations c
      ON c.world_id=m.world_id AND c.id=m.conversation_id WHERE m.world_id=? AND c.private_character_id=? ORDER BY m.seq`,
      worldId,
      characterId,
    );
  const body = (over: Record<string, unknown> = {}) => ({
    requestId: `req-${++n}`,
    bubbles: ['大家好', '今天有个小消息'],
    characterIds: ['wei-guagua'],
    voices: {},
    sendAt: null,
    acknowledge: { characters: 1, recipients: broadcast.recipientCount() },
    ...over,
  });
  const wav = (patch?: (tone: Buffer) => void) => {
    const tone = Buffer.from(syntheticTone(500));
    patch?.(tone);
    return tone.toString('base64');
  };
  return {
    store: raw,
    chars,
    accounts,
    auth,
    broadcast,
    make,
    speech,
    sent,
    log,
    shared,
    player,
    messagesOf,
    body,
    wav,
    fishShared: () => shared.summary().find((row) => row.provider === 'fish')!,
    mode: (m: Mode) => {
      mode = m;
    },
    tick: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}
const code = async (work: () => unknown) => {
  try {
    await work();
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
  return 'ok';
};

test('42 schema: a runtime step, digest-checked; no numbered migration; another table of the family stops the start', (t) => {
  const f = fixture(t);
  installWebBroadcast(f.store);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_broadcast_schema')!.n, 1);
  f.store.all('DROP TRIGGER web_broadcast_messages_fixed');
  assert.throws(() => installWebBroadcast(f.store), /WEB_BROADCAST_SCHEMA_MISMATCH/);
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  assert.ok(readdirSync(folder).every((name) => !/broadcast/i.test(name)));
  const bare = new Store(':memory:');
  t.after(() => bare.close());
  bare.db.exec('CREATE TABLE web_broadcast_stray(x INTEGER)');
  assert.throws(() => installWebBroadcast(bare as never), /WEB_BROADCAST_SCHEMA_MISMATCH/);
});

test('42 recipients are the REGISTERED players only; a guest never receives it', async (t) => {
  const f = fixture(t);
  const a = f.player('a'),
    b = f.player('b'),
    guest = f.player('g', 'guest');
  assert.equal(f.broadcast.recipientCount(), 2);
  const view = f.broadcast.create(f.auth, f.body());
  assert.equal(view.state, 'scheduled');
  await f.broadcast.pass();
  assert.equal(f.broadcast.list(f.auth).broadcasts[0]!.state, 'sent');
  assert.equal(f.messagesOf(a.worldId, 'wei-guagua').length, 2);
  assert.equal(f.messagesOf(b.worldId, 'wei-guagua').length, 2);
  assert.equal(f.messagesOf(guest.worldId, 'wei-guagua').length, 0);
  assert.equal(f.store.get<{ n: number }>('SELECT recipients n FROM web_broadcasts')!.n, 2);
});

test("42 one delivery per player per character: the conversation is created, the message is the CHARACTER's own, nothing is charged", async (t) => {
  const f = fixture(t);
  const a = f.player('a');
  assert.equal(f.store.get('SELECT 1 FROM conversations WHERE world_id=?', a.worldId), undefined);
  f.broadcast.create(
    f.auth,
    f.body({ characterIds: ['jojo', 'wei-guagua'], acknowledge: { characters: 2, recipients: 1 } }),
  );
  await f.broadcast.pass();
  await f.broadcast.pass(); // a second pass writes nothing more
  for (const id of ['wei-guagua', 'jojo']) {
    const rows = f.messagesOf(a.worldId, id);
    assert.deepEqual(
      rows.map((r) => r.body),
      ['大家好', '今天有个小消息'],
    );
    assert.ok(rows.every((r) => r.author_kind === 'character' && r.author_id === id && r.delivery === 'text'));
  }
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM conversations WHERE kind='private'")!.n, 2);
  // Not the player's chat and no points: no operation, no points event, no quota row.
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_operations')!.n, 0);
  assert.equal(
    f.store.get<{ n: number }>("SELECT count(*) n FROM sqlite_master WHERE name='web_points_events'")!.n === 0 ||
      f.store.get<{ n: number }>('SELECT count(*) n FROM web_points_events')!.n === 0,
    true,
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_broadcast_messages')!.n, 4);
  const row = f.store.get<{ delivered: number; total: number; recipients: number }>('SELECT * FROM web_broadcasts')!;
  assert.deepEqual([row.recipients, row.total, row.delivered], [1, 2, 2]);
  // The characters were stored in the console's order whatever order the page sent.
  assert.deepEqual(
    JSON.parse(f.store.get<{ c: string }>('SELECT character_ids_json c FROM web_broadcasts')!.c),
    f.broadcast
      .options(f.auth)
      .characters.map((c) => c.characterId)
      .filter((id) => id === 'wei-guagua' || id === 'jojo'),
  );
});

test('42 a restart in the middle of a send resumes from the cursor and writes no message twice', async (t) => {
  const f = fixture(t, { batch: 2 });
  const players = ['a', 'b', 'c', 'd', 'e'].map((x) => f.player(x));
  f.broadcast.create(f.auth, f.body({ acknowledge: { characters: 1, recipients: 5 } }));
  // The object dies after its first batch (the yield throws): two players are done, three are not.
  await assert.rejects(
    () =>
      f.broadcast.pass(async () => {
        throw new Error('process died');
      }),
    /process died/,
  );
  const mid = f.store.get<{ cursor: number; state: string; delivered: number }>('SELECT * FROM web_broadcasts')!;
  assert.deepEqual([mid.cursor, mid.state, mid.delivered], [2, 'sending', 2]);
  // A new object on the same database (the restart) finishes it; calling again changes nothing.
  const restarted = f.make();
  assert.equal(restarted.nextDue(f.now()), f.now(), 'a sending broadcast is due at once');
  while (await restarted.pass());
  await restarted.pass();
  for (const p of players) assert.equal(f.messagesOf(p.worldId, 'wei-guagua').length, 2, 'exactly one delivery each');
  const row = f.store.get<{ delivered: number; state: string; recipients: number }>('SELECT * FROM web_broadcasts')!;
  assert.deepEqual([row.state, row.recipients, row.delivered], ['sent', 5, 5]);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_broadcast_messages')!.n, 10);
  // A repeated batch for a player already delivered writes nothing (the per-message key).
  f.store.run("UPDATE web_broadcasts SET state='sending',cursor=0,delivered=0,finished_at=NULL WHERE 1=1");
  await restarted.pass();
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_broadcast_messages')!.n, 10);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM messages')!.n, 10);
});

test('42 scheduled: nothing before its time, then it starts with no request; edit and cancel until it starts; later registrations never receive it', async (t) => {
  const f = fixture(t);
  const a = f.player('a');
  const at = f.now() + 10 * 60_000;
  const scheduled = f.broadcast.create(f.auth, f.body({ sendAt: at, acknowledge: { characters: 1, recipients: 1 } }));
  assert.equal(f.broadcast.nextDue(f.now()), at, 'the executor is told when to wake');
  await f.broadcast.pass();
  assert.equal(f.messagesOf(a.worldId, 'wei-guagua').length, 0);
  // edit: new words, a new time; the revision moves; a stale edit is refused
  const edited = f.broadcast.update(f.auth, {
    requestId: 'edit-1',
    id: scheduled.id,
    expectedRevision: 1,
    bubbles: ['改过了'],
    characterIds: ['wei-guagua'],
    voices: {},
    sendAt: at + 60_000,
    acknowledge: { characters: 1, recipients: 1 },
  });
  assert.equal(edited.revision, 2);
  assert.equal(
    await code(() =>
      f.broadcast.update(f.auth, {
        requestId: 'edit-2',
        id: scheduled.id,
        expectedRevision: 1,
        bubbles: ['x'],
        characterIds: ['wei-guagua'],
        voices: {},
        sendAt: at,
        acknowledge: { characters: 1, recipients: 1 },
      }),
    ),
    'BROADCAST_STALE',
  );
  // cancel one and see nothing is ever delivered for it
  const second = f.broadcast.create(f.auth, f.body({ sendAt: at, acknowledge: { characters: 1, recipients: 1 } }));
  assert.equal(f.broadcast.cancel(f.auth, { requestId: 'cancel-1', id: second.id }).state, 'cancelled');
  assert.equal(
    f.broadcast.cancel(f.auth, { requestId: 'cancel-1', id: second.id }).state,
    'cancelled',
    'a repeat answers the same',
  );
  f.tick(20 * 60_000);
  // a player registered AFTER the time but before the pass is still frozen out only if registered after the start; this one
  // registers after the start below. First the start:
  await f.broadcast.pass();
  assert.equal(f.broadcast.detail(f.auth, { id: scheduled.id }).state, 'sent');
  assert.deepEqual(
    f.messagesOf(a.worldId, 'wei-guagua').map((r) => r.body),
    ['改过了'],
  );
  const late = f.player('late');
  await f.broadcast.pass();
  assert.equal(f.messagesOf(late.worldId, 'wei-guagua').length, 0, 'registered after the send: no message');
  assert.equal(
    await code(() => f.broadcast.cancel(f.auth, { requestId: 'cancel-2', id: scheduled.id })),
    'BROADCAST_NOT_CANCELLABLE',
  );
  assert.equal(
    await code(() =>
      f.broadcast.update(f.auth, {
        requestId: 'edit-3',
        id: scheduled.id,
        expectedRevision: 2,
        bubbles: ['x'],
        characterIds: ['wei-guagua'],
        voices: {},
        sendAt: null,
        acknowledge: { characters: 1, recipients: 2 },
      }),
    ),
    'BROADCAST_NOT_EDITABLE',
  );
  // the cancelled one wrote nothing, and it is in the list as cancelled with counts only
  const listed = f.broadcast.list(f.auth).broadcasts;
  assert.deepEqual(listed.map((b) => b.state).sort(), ['cancelled', 'sent']);
  assert.ok(!JSON.stringify(listed).includes('改过了'), 'the list carries no message content');
  // the same request id with another body conflicts
  assert.equal(
    await code(() => f.broadcast.cancel(f.auth, { requestId: 'cancel-1', id: scheduled.id })),
    'IDEMPOTENCY_CONFLICT',
  );
});

test('42 words, time, count and permission are checked; only the owner or broadcast.send may', async (t) => {
  const f = fixture(t);
  f.player('a');
  const bad = async (over: Record<string, unknown>) => code(() => f.broadcast.create(f.auth, f.body(over)));
  assert.equal(await bad({ bubbles: [] }), 'BROADCAST_TEXT_INVALID');
  assert.equal(await bad({ bubbles: ['a', 'b', 'c', 'd'] }), 'BROADCAST_TEXT_INVALID');
  assert.equal(await bad({ bubbles: ['长'.repeat(BROADCAST_LIMITS.bubbleCharacters + 1)] }), 'BROADCAST_TEXT_INVALID');
  assert.equal(await bad({ bubbles: ['长'.repeat(60), '长'.repeat(60), '长'.repeat(40)] }), 'BROADCAST_TEXT_INVALID');
  assert.equal(await bad({ characterIds: [] }), 'BROADCAST_CHARACTERS_INVALID');
  assert.equal(await bad({ characterIds: ['nobody'] }), 'BROADCAST_CHARACTERS_INVALID');
  assert.equal(
    await bad({ sendAt: f.now() + 1000, acknowledge: { characters: 1, recipients: 1 } }),
    'BROADCAST_TIME_INVALID',
  );
  assert.equal(await bad({ acknowledge: { characters: 1, recipients: 99 } }), 'BROADCAST_COUNT_CHANGED');
  assert.equal(await bad({ acknowledge: { characters: 2, recipients: 1 } }), 'BROADCAST_COUNT_CHANGED');
  assert.equal(await bad({ extra: 1 }), 'INVALID_REQUEST');
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_broadcasts')!.n, 0, 'nothing was recorded');
  // permission: an administrator without broadcast.send is refused, with it is not
  const grant = f.accounts.issueMember(f.auth.cookie, f.auth.csrf, ORIGIN, {
    requestId: 'm-1',
    label: 'Staff',
    memberId: null,
    permissions: ['characters.read:*'],
  });
  const login = f.accounts.login(grant.token, ORIGIN);
  const staff = { cookie: login.cookie, csrf: login.csrf, origin: ORIGIN };
  assert.equal(await code(() => f.broadcast.list(staff)), 'ADMIN_PERMISSION_REQUIRED');
  const granted = f.accounts.issueMember(f.auth.cookie, f.auth.csrf, ORIGIN, {
    requestId: 'm-2',
    label: 'Sender',
    memberId: null,
    permissions: ['broadcast.send'],
  });
  const sender = f.accounts.login(granted.token, ORIGIN);
  assert.equal(await code(() => f.broadcast.list({ cookie: sender.cookie, csrf: sender.csrf, origin: ORIGIN })), 'ok');
  // CSRF and Origin are checked first
  assert.equal(await code(() => f.broadcast.list({ ...f.auth, csrf: 'x'.repeat(64) })), 'ADMIN_CSRF_REQUIRED');
  assert.equal(await code(() => f.broadcast.list({ ...f.auth, origin: 'https://evil.invalid' })), 'ADMIN_UNAUTHORIZED');
});

test('42 a generated voice reserves the budget BEFORE the call, is placed at 0.3 s, is kept as a take, is stored ONCE per character and shared by every message', async (t) => {
  const f = fixture(t);
  const players = ['a', 'b', 'c'].map((x) => f.player(x));
  const bubbles = ['听我说', '一件事'];
  const est = f.broadcast.estimate(f.auth, { characterId: 'wei-guagua', bubbles }) as {
    ok: true;
    estimateMicros: number;
  };
  assert.equal(est.ok, true);
  assert.equal(f.sent.length, 0, 'an estimate reserves and sends nothing');
  const take = await f.broadcast.speak(f.auth, {
    requestId: 'voice-1',
    characterId: 'wei-guagua',
    bubbles,
    acknowledgeMicros: est.estimateMicros,
  });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.reservedBeforeSend, true);
  assert.ok(f.sent[0]!.text.endsWith('听我说一件事'));
  assert.equal(take.origin, 'generated');
  // placed at 0.3 s: the stored clip starts with about 300 ms of quiet
  const listen = f.broadcast.takeAudio(f.auth, { takeId: take.takeId });
  assert.ok(listen.durationMs > 300);
  // the same request id replays the same take and spends nothing
  const again = await f.broadcast.speak(f.auth, {
    requestId: 'voice-1',
    characterId: 'wei-guagua',
    bubbles,
    acknowledgeMicros: est.estimateMicros,
  });
  assert.equal(again.takeId, take.takeId);
  assert.equal(f.sent.length, 1);
  assert.equal(f.fishShared().heldMicros, 0, 'the bill is known and settled');
  // words changed after the voice was made: the voice is stale
  assert.equal(
    await code(() =>
      f.broadcast.create(
        f.auth,
        f.body({
          bubbles: ['别的话'],
          voices: { 'wei-guagua': take.takeId },
          acknowledge: { characters: 1, recipients: 3 },
        }),
      ),
    ),
    'BROADCAST_VOICE_STALE',
  );
  // someone else's character: refused
  assert.equal(
    await code(() =>
      f.broadcast.create(
        f.auth,
        f.body({
          characterIds: ['jojo'],
          bubbles,
          voices: { jojo: take.takeId },
          acknowledge: { characters: 1, recipients: 3 },
        }),
      ),
    ),
    'BROADCAST_VOICE_INVALID',
  );
  f.broadcast.create(
    f.auth,
    f.body({ bubbles, voices: { 'wei-guagua': take.takeId }, acknowledge: { characters: 1, recipients: 3 } }),
  );
  await f.broadcast.pass();
  // one clip stored for the character in this broadcast; every player's message points at it
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_broadcast_characters WHERE audio IS NOT NULL')!.n,
    1,
  );
  const media = new Set<string>();
  for (const p of players) {
    const rows = f.messagesOf(p.worldId, 'wei-guagua');
    assert.equal(rows.length, 1, 'one voice message per player');
    assert.equal(rows[0]!.delivery, 'voice');
    assert.equal(rows[0]!.body, '听我说\n一件事', 'its words are the transcript');
    media.add(rows[0]!.media_id!);
    const scope = {
      principalId: p.principalId,
      worldId: p.worldId,
      conversationId: f.store.get<{ id: string }>('SELECT id FROM conversations WHERE world_id=?', p.worldId)!.id,
    };
    assert.ok(broadcastAudio(f.store, scope, rows[0]!.id, rows[0]!.media_id!), 'the player reads it');
    // another player cannot read it (scoped by principal, world and conversation)
    const other = players.find((q) => q !== p)!;
    assert.equal(
      broadcastAudio(f.store, { ...scope, principalId: other.principalId }, rows[0]!.id, rows[0]!.media_id!),
      null,
    );
    assert.equal(broadcastAudio(f.store, { ...scope, worldId: other.worldId }, rows[0]!.id, rows[0]!.media_id!), null);
  }
  assert.equal(media.size, 1, 'the same stored clip is referenced by every message');
  const history = broadcastHistoryRows(
    f.store,
    {
      principalId: players[0]!.principalId,
      worldId: players[0]!.worldId,
      conversationId: f.store.get<{ id: string }>('SELECT id FROM conversations WHERE world_id=?', players[0]!.worldId)!
        .id,
    },
    null,
  );
  assert.equal(history.length, 1);
  assert.ok((history[0]!.duration_ms ?? 0) > 0);
});

test('42 an UNKNOWN voice call is never sent again and keeps its reservation', async (t) => {
  const f = fixture(t);
  f.mode('throw');
  const est = f.broadcast.estimate(f.auth, { characterId: 'wei-guagua', bubbles: ['你好'] }) as {
    estimateMicros: number;
  };
  const speak = () =>
    f.broadcast.speak(f.auth, {
      requestId: 'voice-u',
      characterId: 'wei-guagua',
      bubbles: ['你好'],
      acknowledgeMicros: est.estimateMicros,
    });
  assert.equal(await code(speak), 'SPEECH_CALL_UNKNOWN');
  assert.equal(f.sent.length, 1);
  const held = f.fishShared().heldMicros;
  assert.ok(held > 0, 'both holds stay');
  f.mode('normal');
  assert.equal(await code(speak), 'SPEECH_CALL_UNKNOWN', 'the same request id is never resent');
  assert.equal(f.sent.length, 1);
  assert.equal(f.fishShared().heldMicros, held);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_broadcast_takes')!.n, 0, 'no take came of it');
  // a wrong estimate sends nothing and holds nothing
  assert.equal(
    await code(() =>
      f.broadcast.speak(f.auth, {
        requestId: 'voice-w',
        characterId: 'wei-guagua',
        bubbles: ['你好'],
        acknowledgeMicros: 1,
      }),
    ),
    'SPEECH_ESTIMATE_CHANGED',
  );
  assert.equal(f.sent.length, 1);
});

test('42 upload: the same checks as a clip upload (a WAV, mono 24 kHz, audible, bounded); a take for the right character only', async (t) => {
  const f = fixture(t);
  f.player('a');
  const up = (base64: string, characterId = 'wei-guagua') =>
    code(() => f.broadcast.upload(f.auth, { characterId, base64 }));
  assert.equal(await up(f.wav()), 'ok');
  assert.equal(
    await up(
      f.wav((tone) => {
        tone.writeUInt32LE(16000, 24);
        tone.writeUInt32LE(32000, 28);
      }),
    ),
    'INVALID_BROADCAST_AUDIO',
  );
  assert.equal(await up(f.wav((tone) => tone.fill(0, 44))), 'INVALID_BROADCAST_AUDIO', 'silence');
  assert.equal(await up(Buffer.from('not a wav at all').toString('base64')), 'INVALID_BROADCAST_AUDIO');
  assert.equal(await up('%%%'), 'INVALID_BROADCAST_AUDIO');
  const huge = Buffer.concat([Buffer.from(syntheticTone(500)), Buffer.alloc(BROADCAST_LIMITS.audioBytes)]);
  assert.equal(await up(huge.toString('base64')), 'INVALID_BROADCAST_AUDIO');
  assert.equal(await up(f.wav(), 'nobody'), 'BROADCAST_CHARACTERS_INVALID');
  const take = f.broadcast.upload(f.auth, { characterId: 'wei-guagua', base64: f.wav() });
  assert.equal(take.origin, 'uploaded');
  // an uploaded voice for another character is not accepted into this broadcast
  assert.equal(
    await code(() =>
      f.broadcast.create(
        f.auth,
        f.body({
          characterIds: ['jojo'],
          voices: { jojo: take.takeId },
          acknowledge: { characters: 1, recipients: 1 },
        }),
      ),
    ),
    'BROADCAST_VOICE_INVALID',
  );
  // it can be used and the words need not match it
  const sent = f.broadcast.create(
    f.auth,
    f.body({ voices: { 'wei-guagua': take.takeId }, acknowledge: { characters: 1, recipients: 1 } }),
  );
  await f.broadcast.pass();
  assert.equal(
    f.store.get<{ voice: string }>('SELECT voice FROM web_broadcast_characters WHERE broadcast_id=?', sent.id)!.voice,
    'uploaded',
  );
});

test("42 the writer reads the broadcast as the character's own earlier message, in order, scoped to that player", async (t) => {
  const f = fixture(t);
  const a = f.player('a'),
    b = f.player('b');
  f.broadcast.create(f.auth, f.body({ acknowledge: { characters: 1, recipients: 2 } }));
  await f.broadcast.pass();
  const conv = (w: string) => f.store.get<{ id: string }>('SELECT id FROM conversations WHERE world_id=?', w)!.id;
  const seen = broadcastContextMessages(
    f.store,
    { principalId: a.principalId, worldId: a.worldId, conversationId: conv(a.worldId), characterId: 'wei-guagua' },
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(seen.length, 2);
  const texts = f.store.all<{ body: string; author_kind: string; author_id: string }>(
    `SELECT body,author_kind,author_id FROM messages WHERE id IN (${seen.map(() => '?').join(',')}) ORDER BY seq`,
    ...seen.map((s) => s.id),
  );
  assert.deepEqual(
    texts.map((t) => [t.body, t.author_kind, t.author_id]),
    [
      ['大家好', 'character', 'wei-guagua'],
      ['今天有个小消息', 'character', 'wei-guagua'],
    ],
  );
  // only before the input: a later message is not context for it
  assert.equal(
    broadcastContextMessages(
      f.store,
      { principalId: a.principalId, worldId: a.worldId, conversationId: conv(a.worldId), characterId: 'wei-guagua' },
      seen[0]!.seq,
    ).length,
    0,
  );
  // never across players, worlds, conversations or characters
  assert.equal(
    broadcastContextMessages(
      f.store,
      { principalId: b.principalId, worldId: a.worldId, conversationId: conv(a.worldId), characterId: 'wei-guagua' },
      Number.MAX_SAFE_INTEGER,
    ).length,
    0,
  );
  assert.equal(
    broadcastContextMessages(
      f.store,
      { principalId: a.principalId, worldId: a.worldId, conversationId: conv(b.worldId), characterId: 'wei-guagua' },
      Number.MAX_SAFE_INTEGER,
    ).length,
    0,
  );
  assert.equal(
    broadcastContextMessages(
      f.store,
      { principalId: a.principalId, worldId: a.worldId, conversationId: conv(a.worldId), characterId: 'jojo' },
      Number.MAX_SAFE_INTEGER,
    ).length,
    0,
  );
});

test("42 purges: the world, one conversation and a character each remove the player's broadcast messages (and the clips of a deleted character)", async (t) => {
  const f = fixture(t);
  const a = f.player('a'),
    b = f.player('b');
  const take = f.broadcast.upload(f.auth, { characterId: 'jojo', base64: f.wav() });
  f.broadcast.create(
    f.auth,
    f.body({
      characterIds: ['jojo', 'wei-guagua'],
      voices: { jojo: take.takeId },
      acknowledge: { characters: 2, recipients: 2 },
    }),
  );
  await f.broadcast.pass();
  const links = () => f.store.get<{ n: number }>('SELECT count(*) n FROM web_broadcast_messages')!.n;
  const before = links();
  assert.ok(before >= 4);
  const convA = f.store.get<{ id: string }>(
    "SELECT id FROM conversations WHERE world_id=? AND private_character_id='wei-guagua'",
    a.worldId,
  )!.id;
  f.store.transaction(() => purgeBroadcastConversation(f.store, a.worldId, convA));
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_broadcast_messages WHERE conversation_id=?', convA)!.n,
    0,
  );
  assert.ok(links() > 0, 'other conversations stay');
  f.store.transaction(() => purgeBroadcastWorld(f.store, a.worldId));
  assert.equal(broadcastResidue(f.store, a.worldId), 0);
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_broadcast_recipients WHERE principal_id=?', a.principalId)!
      .n,
    0,
  );
  assert.ok(broadcastResidue(f.store, b.worldId) > 0, 'another world is untouched');
  f.store.transaction(() => purgeBroadcastCharacter(f.store, 'jojo'));
  assert.equal(
    f.store.get<{ n: number }>("SELECT count(*) n FROM web_broadcast_messages WHERE character_id='jojo'")!.n,
    0,
  );
  assert.equal(
    f.store.get<{ n: number }>(
      "SELECT count(*) n FROM web_broadcast_characters WHERE character_id='jojo' AND audio IS NOT NULL",
    )!.n,
    0,
  );
  assert.equal(
    f.store.get<{ n: number }>("SELECT count(*) n FROM web_broadcast_takes WHERE character_id='jojo'")!.n,
    0,
  );
  // the record itself keeps counts only: no player identity in it
  const columns = f.store.all<{ name: string }>('PRAGMA table_info(web_broadcasts)').map((c) => c.name);
  assert.ok(!columns.some((c) => /(^|_)(principal|player|world|email|nick|ip)(_|$)/.test(c)));
});

test('42 routes: send, update and cancel queue work; the body is read after the permission; unknown paths are not routes', async (t) => {
  const f = fixture(t);
  f.player('a');
  const route = (path: string, body: unknown, auth = f.auth) =>
    routeWebAccountAdmin(
      f.accounts,
      {
        method: 'POST',
        path: `/api/web/local/admin/${path}`,
        adminCookie: auth.cookie,
        csrf: auth.csrf,
        origin: auth.origin,
        body,
      } as never,
      undefined,
      undefined,
      null,
      null,
      null,
      null,
      f.broadcast,
    );
  const sent = (await route('broadcast/send', f.body()))!;
  assert.equal(sent.queuesWork, true, 'it marks that it queues work');
  const id = (sent.body as { id: string }).id;
  assert.equal((await route('broadcast/list', {}))!.queuesWork, undefined);
  assert.equal((await route('broadcast/cancel', { requestId: 'c-1', id }))!.queuesWork, true);
  assert.equal(await code(() => route('broadcast/nope', {})), 'NOT_FOUND');
  assert.equal(
    await code(() => route('broadcast/send', f.body(), { ...f.auth, csrf: 'y'.repeat(64) })),
    'ADMIN_CSRF_REQUIRED',
  );
});

test('42 load: 1,000 registered players, two characters, delivered in batches of 50 with chat served between them', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 1000; i++) f.player(`p${i}`);
  for (let i = 0; i < 100; i++) f.player(`g${i}`, 'guest');
  f.broadcast.create(
    f.auth,
    f.body({ characterIds: ['jojo', 'wei-guagua'], acknowledge: { characters: 2, recipients: 1000 } }),
  );
  const batches: number[] = [];
  let yields = 0;
  const started = performance.now();
  for (;;) {
    const at = performance.now();
    const worked = await f.broadcast.pass(async () => {
      batches.push(performance.now() - at);
      yields++;
    });
    if (!worked) break;
  }
  const total = performance.now() - started;
  const row = f.store.get<{ state: string; recipients: number; delivered: number; total: number }>(
    'SELECT * FROM web_broadcasts',
  )!;
  assert.deepEqual([row.state, row.recipients, row.delivered, row.total], ['sent', 1000, 2000, 2000]);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_broadcast_messages')!.n, 4000);
  assert.equal(yields, 20, '1,000 players are 20 batches of 50, each followed by a yield');
  const slowest = Math.max(...batches.map((b, i) => (i ? b - batches[i - 1]! : b)));
  console.log(
    JSON.stringify({
      event: 'broadcast_load',
      batch: 50,
      batches: yields,
      totalMs: Math.round(total),
      slowestBatchMs: Math.round(slowest),
    }),
  );
});

test("42 the real writer request (v7 and v8) carries the broadcast as the character's own earlier message, before the player's input", async (t) => {
  for (const writer of ['v7', 'v8'] as const) {
    const f = fixture(t);
    installWriterSetting(f.store as never);
    if (writer === 'v8') writeWriter(f.store as never, f.now(), 'owner', 'v8');
    const a = f.player(`w-${writer}`);
    f.broadcast.create(f.auth, f.body({ acknowledge: { characters: 1, recipients: 1 } }));
    await f.broadcast.pass();
    f.tick(60_000);
    // the player answers: an input message and an operation, as admission writes them
    const conversationId = f.store.get<{ id: string }>('SELECT id FROM conversations WHERE world_id=?', a.worldId)!.id;
    f.store.run(
      `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,request_id,request_hash)
      VALUES ('input',?,?,'player',?,?,?,'text','r1','h1')`,
      a.worldId,
      conversationId,
      a.playerId,
      '收到啦，谢谢',
      f.now(),
    );
    f.store.run(
      `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,character_id,input_message_id,
      ip_window_id,status,quota_state,created_at,deadline_at,metering_type)
      VALUES ('operation',?,'r1','h1',?,?,'wei-guagua','input',NULL,'queued','reserved',?,?,'entitled')`,
      a.principalId,
      a.worldId,
      conversationId,
      f.now(),
      f.now() + 100_000,
    );
    freezeInputSnapshot(f.store as never, 'operation', f.now());
    freezeWebV7Request(f.store as never, 'operation', f.now());
    const { request } = readWebV7Request(f.store as never, 'operation');
    assert.equal(request.writer, writer === 'v8' ? 'v8' : undefined);
    assert.deepEqual(
      request.messages.map((m) => [m.authorKind, m.authorId, m.text]),
      [
        ['character', 'wei-guagua', '大家好'],
        ['character', 'wei-guagua', '今天有个小消息'],
        ['player', a.playerId, '收到啦，谢谢'],
      ],
      writer,
    );
    assert.deepEqual(request.requiredMessageIds, ['input']);
  }
});

// Part 45 (an addition to this file because the broadcast fixture lives here): a character's broadcast VOICE message can be shared
// like a reply's voice, and a broadcast text message cannot. The link opens to the character and the clip, and nothing names the player.
test('45 a broadcast voice message can be shared; its text bubble and another player cannot', async (t) => {
  const f = fixture(t);
  const a = f.player('a'),
    b = f.player('b');
  const take = f.broadcast.upload(f.auth, { characterId: 'wei-guagua', base64: f.wav() });
  f.broadcast.create(
    f.auth,
    f.body({
      bubbles: ['听我说', '一件事'],
      characterIds: ['wei-guagua'],
      voices: { 'wei-guagua': take.takeId },
      acknowledge: { characters: 1, recipients: 2 },
    }),
  );
  await f.broadcast.pass();
  const clock = { now: () => 1_800_000_000_500 };
  const shares = new WebShare(
    f.store as unknown as WebRuntimeStore,
    clock,
    Buffer.alloc(32, 7),
    {
      readPublishedAudioAsync: async () => {
        throw new Error('a broadcast voice is not read through the publisher');
      },
    },
    () => [
      {
        characterId: 'wei-guagua',
        displayName: '瓜瓜',
        portraitUrl: null,
        mainColor: null,
        palette: null,
        birthDate: null,
      },
    ],
    '/api/web/provider',
  );
  installWebShare(f.store);
  // an account's data is protected (the retention gate the share checks)
  for (const p of [a, b])
    f.store.run(
      "INSERT OR IGNORE INTO web_guest_retention(principal_id,world_id,state) VALUES (?,?,'protected')",
      p.principalId,
      p.worldId,
    );
  const rows = f.messagesOf(a.worldId, 'wei-guagua');
  assert.ok(rows.length >= 1);
  const voice = rows.find((row) => row.media_id)!;
  const conversationId = f.store.get<{ id: string }>('SELECT id FROM conversations WHERE world_id=?', a.worldId)!.id;
  const principal = { principalId: a.principalId, player_id: a.playerId, world_id: a.worldId };
  const made = f.store.transaction(() =>
    shares.create(principal, { requestId: 'share-1', conversationId, messageId: voice.id }),
  );
  assert.equal(made.duplicate, false);
  const card = shares.open(made.token)!;
  assert.equal(card.characterId, 'wei-guagua');
  assert.ok(card.durationMs && card.durationMs > 0);
  assert.equal(card.voiceUrl, `/api/web/provider/shares/${made.token}/audio`);
  const clip = await shares.audio(made.token);
  assert.ok(clip && clip.length > 100, 'the stored clip, read through the token');
  assert.deepEqual(Object.keys(card).sort(), [
    'birthDate',
    'characterId',
    'displayName',
    'durationMs',
    'mainColor',
    'noRank',
    'palette',
    'portraitUrl',
    'voiceUrl',
  ]);
  // not the other player's: a message of the same broadcast in b's conversation, shared by a
  const bConversation = f.store.get<{ id: string }>('SELECT id FROM conversations WHERE world_id=?', b.worldId)!.id;
  const bVoice = f.messagesOf(b.worldId, 'wei-guagua').find((row) => row.media_id)!;
  for (const ids of [
    { conversationId: bConversation, messageId: bVoice.id },
    { conversationId, messageId: bVoice.id },
    { conversationId: bConversation, messageId: voice.id },
  ])
    assert.throws(
      () => f.store.transaction(() => shares.create(principal, { requestId: `x-${ids.messageId}`, ...ids })),
      /NOT_FOUND/,
    );
  // a conversation's deletion (the purge) closes it
  f.store.transaction(() => purgeShareConversation(f.store, a.worldId, conversationId));
  assert.equal(shares.open(made.token), null);
  assert.equal(await shares.audio(made.token), null);
});
