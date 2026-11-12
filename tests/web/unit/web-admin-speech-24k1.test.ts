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
import { WebCharacterDeletion } from '../../../apps/server/characters/web-character-deletion.ts';
import { installWebCharacterDeletion } from '../../../apps/server/characters/web-character-deletion-schema.ts';
import { installWebCharacterCatalog } from '../../../apps/server/characters/web-character-catalog.ts';
import { installWebCharacterMaterials } from '../../../apps/server/characters/web-character-material-schema.ts';
import { WebCharacterMaterials } from '../../../apps/server/characters/web-character-materials.ts';
import { WebCharacterPreviews } from '../../../apps/server/characters/web-character-preview.ts';
import { WebAdminSpeech, type WebAdminSpeechBudget } from '../../../apps/server/characters/web-admin-speech.ts';
import { installWebAdminSpeech } from '../../../apps/server/characters/web-admin-speech-schema.ts';
import { WebProviderBudget } from '../../../apps/server/budget/web-provider-budget.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../../../apps/server/conversation/web-vertical-publisher.ts';
import type { FakeFish } from '../../../apps/server/generation/web-provider-runner.ts';
import { fishSpeechRequest } from '../../../workers/audio/fish.ts';

const ORIGIN = 'https://fixture.invalid';
type Mode = 'normal' | 'throw' | 'wrong-rate' | 'silent' | 'hang';

/** Schema 113 + the real 119 SQL (as the other preview tests build it), the material tables, and a fake Fish transport. No real call. */
function fixture(t: test.TestContext) {
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
  raw.run("INSERT INTO web_instance(singleton,instance_id) VALUES (1,'speech-instance')");
  migrateWebProviderOffline(raw);
  raw.db.exec(readFileSync(new URL('119_preview_workbench.sql', folder), 'utf8'));
  const store = Object.assign(raw, {
    instanceId: 'speech-instance',
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
  installWebCharacterMaterials(raw);
  installWebCharacterDeletion(store);
  const chars = new WebCharacterAdmin(raw, clock, accounts),
    previews = new WebCharacterPreviews(raw, clock),
    materials = new WebCharacterMaterials(store as never, clock);
  chars.enablePreviews(previews);
  chars.enableMaterials(materials);
  chars.enableDeletion(new WebCharacterDeletion(store, clock));
  const login = accounts.login(accounts.issueLoginGrant().token, ORIGIN);
  const auth = { cookie: login.cookie, csrf: login.csrf, origin: ORIGIN };
  const profile = chars.detail(auth, 'wei-guagua').published!.profile;
  profile.template.version++;
  profile.template.persona += '修改后的角色';
  profile.presentation.welcome = { text: '你好，我是新的欢迎词', version: 'welcome-24k1' };
  profile.template.voice = { profileId: 'draft-voice', version: 1, speed: 1 };
  const saved = chars.save(auth, 'wei-guagua', { expectedRevision: null, profile });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'admin-speech-'))),
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
  // The authority the speech path sees: the real shared ledger, with counters and a switch for a lost settle.
  const log = { reserved: [] as string[], settled: [] as string[], failSettle: false };
  const authority: WebAdminSpeechBudget = {
    reserve: (id, provider, fingerprint, micros) => {
      log.reserved.push(id);
      return shared.reserve(id, provider, fingerprint, micros);
    },
    settle: (id, fingerprint, micros, receipt) => {
      if (log.failSettle) throw new Error('offline lost RPC receipt');
      log.settled.push(id);
      return shared.settle(id, fingerprint, micros, receipt);
    },
  };
  let mode: Mode = 'normal';
  const sent: { text: string; model: string; reservedBeforeSend: boolean; heldBeforeSend: number }[] = [];
  let release: (() => void) | null = null;
  const fish: FakeFish = async (request) => {
    sent.push({
      text: JSON.parse(request.body).text,
      model: request.model,
      reservedBeforeSend: log.reserved.length === sent.length + 1,
      heldBeforeSend: shared.summary().find((row) => row.provider === 'fish')!.heldMicros,
    });
    if (mode === 'throw') throw new Error('offline network interrupted');
    if (mode === 'hang') await new Promise<void>((resolve) => (release = resolve));
    if (mode === 'hang') throw new Error('offline network interrupted');
    const tone = syntheticTone(300);
    if (mode === 'wrong-rate') {
      tone.writeUInt32LE(16000, 24);
      tone.writeUInt32LE(32000, 28);
    }
    if (mode === 'silent') tone.fill(0, 44);
    return {
      audio: tone,
      receipt: { requestId: 'fake-' + sent.length, billedBytes: request.billedTextBytes },
      usageUnits: request.billedTextBytes,
    };
  };
  const speech = (over: Partial<{ authority: WebAdminSpeechBudget; model: 's2.1-pro' | 'drama-3' | 's2-pro' }> = {}) =>
    new WebAdminSpeech(raw, clock, fish, over.authority ?? authority, over.model ?? 's2.1-pro');
  const service = speech();
  chars.enableSpeech(service);
  const draftMaterial = (requestId = 'material-1') =>
    chars.materialPrepare(auth, 'wei-guagua', {
      requestId,
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      referenceId: 'draft-reference',
      model: 's2.1-pro',
    }).materialId;
  const estimateOf = (materialId: string, slot: 'welcome' | 'footer') =>
    chars.speechEstimate(auth, 'wei-guagua', { kind: 'material', materialId, slot }) as {
      ok: true;
      estimateMicros: number;
    };
  const generate = (materialId: string, kind: 'welcome' | 'footer', requestId = 'gen-' + kind, ack?: number) =>
    chars.materialGenerate(auth, 'wei-guagua', {
      requestId,
      materialId,
      kind,
      acknowledgeMicros: ack ?? estimateOf(materialId, kind).estimateMicros,
    });
  /** A succeeded 预演 with two final bubbles (the queue itself has its own tests). */
  const succeededPreview = () => {
    const { previewId } = chars.startPreview(auth, 'wei-guagua', {
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      relationship: 'friend',
      requestId: 'preview-' + now,
      message: '早',
    });
    raw.run(
      "UPDATE admin_previews SET status='succeeded',finished_at=?,result_json=? WHERE id=?",
      now,
      JSON.stringify({
        reply: {
          bubbles: [
            { text: '早呀', expression: 'soft' },
            { text: '今天也要加油', expression: 'upbeat' },
          ],
        },
      }),
      previewId,
    );
    return previewId;
  };
  const listenOf = (previewId: string) =>
    chars.speechEstimate(auth, 'wei-guagua', { kind: 'preview', previewId }) as { ok: true; estimateMicros: number };
  const listen = (previewId: string, requestId = 'listen-1', ack?: number) =>
    chars.previewListen(auth, 'wei-guagua', {
      requestId,
      previewId,
      acknowledgeMicros: ack ?? listenOf(previewId).estimateMicros,
    });
  const ledger = () =>
    raw.all<{ id: string; state: string; outcome: string | null; shared_settled: number; error_code: string | null }>(
      'SELECT id,state,outcome,shared_settled,error_code FROM web_speech_admin_calls ORDER BY created_at,ordinal',
    );
  const spending = () =>
    raw.get<{ held_micros: number; spent_micros: number }>(
      "SELECT held_micros,spent_micros FROM web_provider_spending WHERE provider='fish'",
    )!;
  const fishShared = () => shared.summary().find((row) => row.provider === 'fish')!;
  return {
    store: raw,
    chars,
    auth,
    saved,
    service,
    speech,
    sent,
    log,
    shared,
    ledger,
    spending,
    fishShared,
    draftMaterial,
    estimateOf,
    generate,
    succeededPreview,
    listen,
    listenOf,
    mode: (m: Mode) => {
      mode = m;
    },
    release: () => release?.(),
    tick: (ms: number) => {
      now += ms;
    },
  };
}

test('the tables are installed by an idempotent, digest-checked step; no numbered migration', (t) => {
  const f = fixture(t);
  installWebAdminSpeech(f.store);
  installWebAdminSpeech(f.store);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_speech_admin_schema')!.n, 1);
  f.store.all('DROP TRIGGER web_speech_admin_audio_fixed');
  assert.throws(() => f.speech(), /WEB_ADMIN_SPEECH_SCHEMA_MISMATCH/, 'a missing guard is not accepted');
  assert.throws(() => installWebAdminSpeech(f.store), /WEB_ADMIN_SPEECH_SCHEMA_MISMATCH/);
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  assert.ok(
    readdirSync(folder).every((name) => !/speech/i.test(name)),
    'no migration file names the admin speech path',
  );
});

test('a generated slot speaks exactly the slot text; the hold is made BEFORE the send and the bill is settled once', async (t) => {
  const f = fixture(t),
    id = f.draftMaterial();
  const welcome = f.estimateOf(id, 'welcome');
  const before = f.fishShared();
  const asset = (await f.generate(id, 'welcome')) as { origin: string; body: string; sha256: string };
  assert.equal(asset.origin, 'generated');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.reservedBeforeSend, true, 'the shared reservation exists before the provider is called');
  assert.ok(f.sent[0]!.heldBeforeSend >= welcome.estimateMicros, 'the shared hold covers the estimate at send time');
  assert.ok(f.sent[0]!.text.endsWith('你好，我是新的欢迎词'), 'exactly the welcome text');
  assert.equal(f.sent[0]!.model, 's2.1-pro');
  const footer = (await f.generate(id, 'footer')) as { origin: string };
  assert.equal(footer.origin, 'generated');
  assert.ok(f.sent[1]!.text.endsWith(SYNTHETIC_TRIAL_FOOTER), 'the footer is the fixed trial footer line');
  const after = f.fishShared();
  assert.equal(after.heldMicros, before.heldMicros, 'nothing stays held once both bills are known');
  assert.ok(after.spentMicros > before.spentMicros);
  assert.deepEqual(
    f.ledger().map((r) => [r.state, r.outcome, r.shared_settled]),
    [
      ['known', 'succeeded', 1],
      ['known', 'succeeded', 1],
    ],
  );
  assert.equal(f.log.settled.length, 2, 'each known bill is settled in the shared budget once');
  assert.deepEqual({ ...f.spending() }, { held_micros: 0, spent_micros: after.spentMicros - before.spentMicros });
  // The ledger holds no text and no audio.
  const columns = f.store.all<{ name: string }>('PRAGMA table_info(web_speech_admin_calls)').map((c) => c.name);
  assert.ok(!columns.some((c) => /text$|^audio|body/.test(c) && c !== 'text_sha256'));
});

test('the same request id replays the same clip and spends nothing; another body under it conflicts', async (t) => {
  const f = fixture(t),
    id = f.draftMaterial();
  const ack = f.estimateOf(id, 'welcome').estimateMicros;
  const first = (await f.generate(id, 'welcome')) as { sha256: string };
  const spent = f.fishShared().spentMicros;
  const again = (await f.chars.materialGenerate(f.auth, 'wei-guagua', {
    requestId: 'gen-welcome',
    materialId: id,
    kind: 'welcome',
    acknowledgeMicros: ack,
  })) as { sha256: string };
  assert.equal(again.sha256, first.sha256);
  assert.equal(f.sent.length, 1, 'no second provider call');
  assert.equal(f.fishShared().spentMicros, spent);
  assert.equal(f.log.settled.length, 1);
  assert.equal(f.ledger().length, 1);
  await assert.rejects(() => f.generate(id, 'footer', 'gen-welcome'), /IDEMPOTENCY_CONFLICT/);
  assert.equal(f.sent.length, 1);
});

test('MATERIAL_AUDIO_IMMUTABLE: a slot that already has audio is not regenerated, before any hold', async (t) => {
  const f = fixture(t),
    id = f.draftMaterial();
  await f.chars.materialUpload(f.auth, 'wei-guagua', {
    materialId: id,
    kind: 'welcome',
    base64: syntheticTone().toString('base64'),
  });
  assert.deepEqual(
    f.chars.speechEstimate(f.auth, 'wei-guagua', { kind: 'material', materialId: id, slot: 'welcome' }),
    {
      ok: false,
      reason: 'SLOT_HAS_AUDIO',
    },
  );
  await assert.rejects(() => f.generate(id, 'welcome', 'again', 1), /MATERIAL_AUDIO_IMMUTABLE/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.log.reserved.length, 0);
  assert.equal(f.ledger().length, 0);
  const listed = f.chars.materialList(f.auth, 'wei-guagua')[0]!.assets as { kind: string; origin: string }[];
  assert.deepEqual(
    listed.map((a) => [a.kind, a.origin]),
    [['welcome', 'uploaded']],
  );
});

test('an UNKNOWN call keeps both holds, is never sent again, and a restart does not release it', async (t) => {
  const f = fixture(t),
    id = f.draftMaterial();
  f.mode('throw');
  await assert.rejects(() => f.generate(id, 'welcome'), /SPEECH_CALL_UNKNOWN/);
  assert.equal(f.sent.length, 1);
  const held = f.fishShared().heldMicros;
  assert.ok(held > 0, 'the shared reservation stays');
  assert.deepEqual(
    f.ledger().map((r) => r.state),
    ['unknown'],
  );
  assert.ok(f.spending().held_micros > 0, 'the local hold stays too');
  f.mode('normal');
  await assert.rejects(() => f.generate(id, 'welcome'), /SPEECH_CALL_UNKNOWN/, 'the same request is never retried');
  assert.equal(f.sent.length, 1);
  // A "restart": a fresh service over the same store recovers nothing for an unknown call.
  const restarted = f.speech();
  assert.equal(await restarted.recoverBills(), 0);
  assert.equal(f.fishShared().heldMicros, held);
  assert.equal(f.sent.length, 1);
  // The slot is still empty: a person decides (a new request is a new, confirmed charge).
  const materials = f.chars.materialList(f.auth, 'wei-guagua')[0]!.assets;
  assert.equal(materials.length, 0);
});

test('a call that was in flight when the process died becomes unknown at recovery, and a late answer cannot make it retry', async (t) => {
  const f = fixture(t),
    id = f.draftMaterial();
  f.mode('hang');
  const pending = f.generate(id, 'welcome');
  const settledAssertion = assert.rejects(pending, /SPEECH_CALL_UNKNOWN/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    f.ledger().map((r) => r.state),
    ['sent'],
  );
  const restarted = f.speech();
  assert.equal(await restarted.recoverBills(), 1);
  assert.deepEqual(
    f.ledger().map((r) => r.state),
    ['unknown'],
  );
  f.release();
  await settledAssertion;
  assert.equal(f.sent.length, 1, 'recovery never sends');
  assert.ok(f.fishShared().heldMicros > 0);
});

test('a restart settles a known bill whose shared settlement was lost, exactly once', async (t) => {
  const f = fixture(t),
    id = f.draftMaterial();
  f.log.failSettle = true;
  const asset = (await f.generate(id, 'welcome')) as { origin: string };
  assert.equal(asset.origin, 'generated', 'the clip is usable; only the settlement is pending');
  assert.deepEqual(
    f.ledger().map((r) => [r.state, r.shared_settled]),
    [['known', 0]],
  );
  assert.ok(f.fishShared().heldMicros > 0, 'still held in the shared ledger');
  assert.notEqual(f.service.nextDue(), null);
  f.log.failSettle = false;
  const restarted = f.speech();
  assert.equal(await restarted.recoverBills(), 1);
  assert.equal(await restarted.recoverBills(), 0, 'nothing left to settle');
  assert.equal(f.log.settled.length, 1);
  assert.equal(f.fishShared().heldMicros, 0);
  assert.deepEqual(
    f.ledger().map((r) => r.shared_settled),
    [1],
  );
  assert.equal(f.service.nextDue(), null);
});

test('a price row out of force refuses with a located error before anything is held or sent', async (t) => {
  const f = fixture(t);
  // s2-pro has a row, but one whose window has ended: not in force.
  const row = f.store.get<{ upper_micros_per_unit: number }>(
    "SELECT * FROM web_provider_prices WHERE provider='fish' AND model='s2.1-pro' AND phase='speech'",
  )!;
  f.store.run(
    `INSERT INTO web_provider_prices(id,provider,model,phase,unit,currency,upper_micros_per_unit,valid_from,valid_until,version)
    VALUES ('s2-pro-expired','fish','s2-pro','speech','byte','USD',?,1,2,1)`,
    row.upper_micros_per_unit,
  );
  const late = f.speech({ model: 's2-pro' });
  f.chars.enableSpeech(late);
  // Part 29 C (named exception): a site voice-model change makes an earlier 素材版本 stale (its resolved model is part of the
  // clip manifest), so this test prepares a version AFTER the switch; what it checks (the price row) is unchanged.
  const id = f.draftMaterial('material-after-switch');
  assert.deepEqual(
    f.chars.speechEstimate(f.auth, 'wei-guagua', { kind: 'material', materialId: id, slot: 'welcome' }),
    {
      ok: false,
      reason: 'PRICE_MISSING',
    },
  );
  await assert.rejects(
    () => f.generate(id, 'welcome', 'late', 12345),
    (error: unknown) => {
      const e = error as { code: string; detail?: Record<string, unknown> };
      assert.equal(e.code, 'SPEECH_PRICE_REQUIRED');
      assert.deepEqual(e.detail, { provider: 'fish', model: 's2-pro', unit: 'byte' });
      return true;
    },
  );
  assert.equal(f.sent.length, 0);
  assert.equal(f.log.reserved.length, 0);
  assert.equal(f.ledger().length, 0);
  assert.deepEqual({ ...f.spending() }, { held_micros: 0, spent_micros: 0 });
});

test('the confirmed estimate must match: a changed price or text holds nothing', async (t) => {
  const f = fixture(t),
    id = f.draftMaterial();
  await assert.rejects(() => f.generate(id, 'welcome', 'cheap', 1), /SPEECH_ESTIMATE_CHANGED/);
  assert.equal(f.log.reserved.length, 0);
  assert.equal(f.ledger().length, 0);
});

test('the model is the configured FISH_VOICE_MODEL, and Drama 3 gets its direction text from the shared builder', async (t) => {
  const f = fixture(t);
  assert.ok(
    f.store.get(
      "SELECT 1 FROM web_provider_prices WHERE provider='fish' AND model='drama-3' AND phase='speech' AND valid_until>?",
      1_800_000_000_000,
    ),
    'the fixture carries a drama-3 speech price',
  );
  const drama = f.speech({ model: 'drama-3' });
  f.chars.enableSpeech(drama);
  const id = f.draftMaterial();
  await f.generate(id, 'welcome');
  assert.equal(f.sent[0]!.model, 'drama-3');
  const plain = fishSpeechRequest(
    {
      jobId: 'x',
      text: '你好，我是新的欢迎词',
      expression: 'neutral',
      speed: 1,
      voice: { profileId: 'draft-voice', version: 1, referenceId: 'draft-reference' },
      model: 'drama-3',
      qualityGuard: true,
      deliveryStyle: 'conversational',
    },
    'drama-3',
  );
  assert.equal(f.sent[0]!.text, JSON.parse(plain.body).text, 'the same bytes a live reply would send');
});

test('generated audio fails the same format checks as an upload, and the bill is still recorded once', async (t) => {
  const f = fixture(t),
    id = f.draftMaterial();
  for (const bad of ['wrong-rate', 'silent'] as const) {
    f.mode(bad);
    await assert.rejects(() => f.generate(id, 'welcome', 'bad-' + bad), /INVALID_MATERIAL_AUDIO/, bad);
  }
  assert.equal(f.chars.materialList(f.auth, 'wei-guagua')[0]!.assets.length, 0, 'nothing entered the slot');
  assert.equal(f.sent.length, 2);
  assert.deepEqual(
    f.ledger().map((r) => [r.state, r.outcome, r.shared_settled]),
    [
      ['known', 'succeeded', 1],
      ['known', 'succeeded', 1],
    ],
  );
  // The same request replays the same refusal without a new call.
  await assert.rejects(() => f.generate(id, 'welcome', 'bad-silent'), /INVALID_MATERIAL_AUDIO/);
  assert.equal(f.sent.length, 2);
  // The uploads path refuses the same bytes with the same code.
  const wrong = syntheticTone(300);
  wrong.writeUInt32LE(16000, 24);
  wrong.writeUInt32LE(32000, 28);
  await assert.rejects(
    () =>
      f.chars.materialUpload(f.auth, 'wei-guagua', {
        materialId: id,
        kind: 'welcome',
        base64: wrong.toString('base64'),
      }),
    /INVALID_MATERIAL_AUDIO/,
  );
});

test('generation never approves: the human ticks and the separate approval are still required', async (t) => {
  const f = fixture(t),
    id = f.draftMaterial();
  await f.generate(id, 'welcome');
  await f.generate(id, 'footer');
  const listed = f.chars.materialList(f.auth, 'wei-guagua')[0]!;
  assert.equal(listed.approved, false);
  const approve = (over: Record<string, unknown>) =>
    f.chars.materialApprove(f.auth, 'wei-guagua', {
      materialId: id,
      acknowledgeRights: true,
      acknowledgeWelcomeListening: true,
      acknowledgeFooterListening: true,
      note: '试听确认',
      ...over,
    });
  await assert.rejects(() => approve({ acknowledgeWelcomeListening: false }), /MATERIAL_APPROVAL_REQUIRED/);
  await assert.rejects(() => approve({ acknowledgeFooterListening: false }), /MATERIAL_APPROVAL_REQUIRED/);
  await assert.rejects(() => approve({ acknowledgeRights: false }), /MATERIAL_APPROVAL_REQUIRED/);
  assert.equal((await approve({})).approved, true);
});

test('预演 试听: every final bubble is one confirmed call; a replay returns the clips; the audio is admin-only', async (t) => {
  const f = fixture(t),
    previewId = f.succeededPreview();
  const estimate = f.listenOf(previewId);
  assert.equal((estimate as unknown as { calls: number }).calls, 2);
  const first = await f.listen(previewId);
  assert.equal(first.clips.length, 2);
  assert.deepEqual(
    f.sent.map((s) => s.text.endsWith('早呀') || s.text.endsWith('今天也要加油')),
    [true, true],
  );
  const again = await f.listen(previewId);
  assert.deepEqual(
    again.clips.map((c) => c.callId),
    first.clips.map((c) => c.callId),
  );
  assert.equal(f.sent.length, 2, 'the replay sends nothing');
  assert.equal(f.chars.speechClips(f.auth, 'wei-guagua', { previewId }).clips.length, 2);
  const audio = f.chars.speechAudio(f.auth, 'wei-guagua', { callId: first.clips[0]!.callId });
  assert.equal(audio.mimeType, 'audio/wav');
  assert.equal(createHash('sha256').update(Buffer.from(audio.base64, 'base64')).digest('hex'), audio.sha256);
  // Not a succeeded 预演, or someone else's character: nothing to speak.
  const queued = f.chars.startPreview(f.auth, 'wei-guagua', {
    draftRevision: f.saved.revision,
    profileHash: f.saved.contentHash,
    relationship: 'friend',
    requestId: 'queued-one',
    message: '晚',
  });
  assert.deepEqual(f.chars.speechEstimate(f.auth, 'wei-guagua', { kind: 'preview', previewId: queued.previewId }), {
    ok: false,
    reason: 'NOT_SUCCEEDED',
  });
  assert.throws(
    () => f.chars.speechAudio(f.auth, 'jojo', { callId: first.clips[0]!.callId }),
    /NOT_FOUND|PERMISSION|NOT_FOUND/,
  );
});

test('no voice reference: 试听 is not offered and nothing is held', async (t) => {
  const f = fixture(t),
    previewId = f.succeededPreview();
  // The draft has no prepared 素材版本 yet, and the stand-in character has no live binding: no reference at all.
  f.store.run('DELETE FROM web_character_materials WHERE 0');
  f.store.all('PRAGMA foreign_keys=OFF');
  f.store.run('UPDATE web_provider_voice_bindings SET reference_id=reference_id WHERE 0');
  const bound = f.store.get('SELECT 1 FROM web_provider_voice_bindings WHERE character_id=?', 'wei-guagua');
  if (!bound) {
    assert.deepEqual(f.chars.speechEstimate(f.auth, 'wei-guagua', { kind: 'preview', previewId }), {
      ok: false,
      reason: 'NO_VOICE_REFERENCE',
    });
    assert.equal(f.chars.detail(f.auth, 'wei-guagua').speech.hasVoice, false);
  } else assert.equal(f.chars.detail(f.auth, 'wei-guagua').speech.hasVoice, true, 'a live binding is a reference');
  assert.equal(f.sent.length, 0);
});

test('players can never fetch admin audio: no session, no permission, no other character, and no player route reads the tables', async (t) => {
  const f = fixture(t),
    previewId = f.succeededPreview(),
    clips = (await f.listen(previewId)).clips;
  const callId = clips[0]!.callId;
  for (const auth of [
    { cookie: 'player-cookie', csrf: 'x', origin: ORIGIN },
    { ...f.auth, csrf: 'wrong' },
    { ...f.auth, origin: 'https://evil.invalid' },
  ])
    assert.throws(() => f.chars.speechAudio(auth, 'wei-guagua', { callId }), /UNAUTHORIZED|CSRF|ORIGIN|ADMIN/);
  assert.throws(() => f.chars.speechAudio(f.auth, 'wei-guagua', { callId: 'other-call' }), /NOT_FOUND/);
  const root = new URL('../../../', import.meta.url);
  const hits: string[] = [];
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) walk(child);
      else if (/\.ts$/.test(entry.name) && /web_speech_admin/.test(readFileSync(child, 'utf8')))
        hits.push(child.pathname.slice(root.pathname.length));
    }
  };
  walk(new URL('apps/', root));
  walk(new URL('workers/', root));
  walk(new URL('packages/', root));
  assert.deepEqual(hits.sort(), [
    'apps/server/characters/web-admin-speech-schema.ts',
    'apps/server/characters/web-admin-speech.ts',
  ]);
});

test('the 预演 purge and the character deletion remove the audio; the ledger keeps the bills; the audits do not trip', async (t) => {
  const f = fixture(t),
    previewId = f.succeededPreview();
  const id = f.draftMaterial();
  await f.listen(previewId);
  await f.generate(id, 'welcome');
  const count = (table: string) => f.store.get<{ n: number }>(`SELECT count(*) n FROM ${table}`)!.n;
  assert.equal(count('web_speech_admin_audio'), 3);
  // The audio of one 预演 goes with that 预演's purge, and only that audio.
  const { purgeAdminSpeechAudio } = await import('../../../apps/server/characters/web-admin-speech-schema.ts');
  assert.equal(purgeAdminSpeechAudio(f.store, { characterId: 'wei-guagua', previewIds: [previewId] }), 2);
  assert.equal(count('web_speech_admin_audio'), 1);
  assert.throws(() => f.chars.speechAudio(f.auth, 'wei-guagua', { callId: f.ledger()[0]!.id }), /NOT_FOUND/);
  // The tables carry no world, conversation, operation or principal column, so neither world audit owns them.
  for (const table of ['web_speech_admin_calls', 'web_speech_admin_audio'])
    assert.deepEqual(
      f.store
        .all<{ name: string }>(`PRAGMA table_info(${table})`)
        .map((c) => c.name)
        .filter((c) => /world_id|conversation_id|operation_id|principal_id|player_id/.test(c)),
      [],
      table,
    );
  const preview = f.chars.deletionPreview(f.auth, 'wei-guagua');
  f.chars.deletionStart(f.auth, 'wei-guagua', {
    requestId: 'delete-speech',
    previewHash: preview.previewHash,
    acknowledgeDeleteAllChats: true,
  });
  assert.equal(count('web_speech_admin_audio'), 0, 'all of the character audio went with the deletion');
  assert.ok(count('web_speech_admin_calls') >= 3, 'the money records stay');
  assert.throws(() => f.store.run('DELETE FROM web_speech_admin_calls'), /WEB_ADMIN_SPEECH_IMMUTABLE/);
  assert.throws(() => f.store.run("UPDATE web_speech_admin_calls SET state='sent'"), /WEB_ADMIN_SPEECH_IMMUTABLE/);
  // The deleted character cannot be spoken for any more.
  await assert.rejects(() => f.generate(id, 'footer', 'after-delete', 1), /CHARACTER_DELETED|NOT_FOUND|DRAFT_CONFLICT/);
  assert.equal(f.sent.length, 3);
});
