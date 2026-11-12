import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Store } from '../../../apps/server/platform/store.ts';
import { migrateWebProviderOffline } from '../../../apps/server/generation/web-provider-migration.ts';
import type { WebRuntimeStore } from '../../../apps/server/platform/web-store-contract.ts';
import { configureWebProvider } from '../../../apps/server/generation/web-provider-configuration.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import { installWebCharacterCatalog } from '../../../apps/server/characters/web-character-catalog.ts';
import { installWebCharacterMaterials } from '../../../apps/server/characters/web-character-material-schema.ts';
import { WebCharacterMaterials } from '../../../apps/server/characters/web-character-materials.ts';
import { WebAdminSpeech } from '../../../apps/server/characters/web-admin-speech.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { syntheticCharacterReview } from '../fixtures/character-review.ts';
import type { FakeFish } from '../../../apps/server/generation/web-provider-runner.ts';

/**
 * Part 29 B, C and D (synthetic only: a fake Fish transport, never a real call).
 *  B: one Fish id, a derived binding, no manual binding.
 *  C: a 素材版本 is bound to the clip manifest (line texts, footer text, voice), not to the draft revision.
 *  D: the footer is a clip only while the free tier is off.
 */
const ORIGIN = 'https://fixture.invalid';
function fixture(t: test.TestContext, freeTier = false) {
  const raw = new Store(':memory:');
  t.after(() => raw.close());
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    raw.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  raw.db.exec('PRAGMA user_version=112');
  raw.run("INSERT INTO web_instance(singleton,instance_id) VALUES (1,'manifest-29')");
  migrateWebProviderOffline(raw);
  raw.db.exec(readFileSync(new URL('119_preview_workbench.sql', folder), 'utf8'));
  const store = Object.assign(raw, {
    instanceId: 'manifest-29',
    publicFreeTier: freeTier,
    webReceiptDigest: (kind: string, json: string) =>
      createHash('sha256').update(`${kind}:fixture:${json}`).digest('hex'),
  }) as unknown as WebRuntimeStore & { publicFreeTier: boolean };
  const now = 1_800_000_000_000,
    clock = { now: () => now },
    selected = syntheticSelection();
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
  const chars = new WebCharacterAdmin(raw, clock, accounts),
    materials = new WebCharacterMaterials(store as never, clock);
  chars.enableMaterials(materials);
  chars.enableProfileImport();
  const sent: string[] = [];
  const fish: FakeFish = async (request) => {
    sent.push(JSON.parse(request.body).text);
    return {
      audio: syntheticTone(300),
      receipt: { requestId: `fake-${sent.length}` },
      usageUnits: request.billedTextBytes,
    };
  };
  // The shared budget is not what these tests are about: a pass-through authority (the ledger's own tests cover it).
  chars.enableSpeech(new WebAdminSpeech(raw, clock, fish, { reserve: () => {}, settle: () => {} }, 's2.1-pro'));
  const login = accounts.login(accounts.issueLoginGrant().token, ORIGIN);
  const auth = { cookie: login.cookie, csrf: login.csrf, origin: ORIGIN };
  let seq = 0;
  const lines = (a = 50, b = 50, second = '今天也是你') => [
    { id: 'line-a', text: '你好呀', weight: a },
    { id: 'line-b', text: second, weight: b },
  ];
  /** A saved draft of a NEW character (no binding in it unless `voice` says so). */
  const draft = (id: string, over: (p: ReturnType<typeof base>) => void = () => {}, expected: number | null = null) => {
    const p = base(id);
    over(p);
    return { profile: p, saved: chars.save(auth, id, { expectedRevision: expected, profile: p }) };
  };
  const base = (id: string) => {
    const profile = chars.detail(auth, 'wei-guagua').published!.profile;
    profile.template.id = id;
    profile.template.version = 1;
    delete profile.template.voice;
    profile.presentation.welcomes = lines();
    return profile;
  };
  const prepare = (id: string, saved: { revision: number; contentHash: string }, model?: string) =>
    chars.materialPrepare(auth, id, {
      requestId: `prepare-${++seq}`,
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      ...(model ? { model } : {}),
    }).materialId;
  const wav = () => syntheticTone().toString('base64');
  const upload = (id: string, materialId: string, kind: 'welcome' | 'footer', lineId?: string) =>
    chars.materialUpload(auth, id, { materialId, kind, base64: wav(), ...(lineId ? { lineId } : {}) });
  const approve = (id: string, materialId: string, footer = true) =>
    chars.materialApprove(auth, id, {
      materialId,
      acknowledgeRights: true,
      acknowledgeLines: ['line-a', 'line-b'],
      ...(footer ? { acknowledgeFooterListening: true } : {}),
      note: '合成',
    });
  const list = (id: string) =>
    chars.materialList(auth, id) as {
      materialId: string;
      number: number;
      approved: boolean;
      stale: string | null;
      voice: { model: string; referenceId: string };
      slots: { kind: string; lineId: string | null; state: string }[];
    }[];
  const publish = async (id: string, saved: { revision: number; contentHash: string }, materialId?: string) =>
    chars.publish(auth, id, {
      requestId: `publish-${++seq}`,
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      previewId: await syntheticCharacterReview(raw, now, id),
      acknowledgeReview: true,
      ...(materialId ? { materialId } : {}),
    });
  const code = (id: string, fish: string, name = id.toUpperCase()) =>
    raw.run(
      'INSERT INTO web_profile_codes(character_id,code,code_key,avatar_file,voice_reference_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      id,
      name,
      name.toLowerCase(),
      null,
      fish,
      1,
      1,
    );
  return { raw, store, chars, auth, sent, draft, prepare, upload, approve, list, publish, code, lines, wav };
}
const revisions = (f: ReturnType<typeof fixture>, id: string) =>
  f.raw.get<{ n: number }>('SELECT count(*) n FROM web_character_revisions WHERE character_id=?', id)!.n;

test('B: an imported character with a Fish id and no binding prepares, generates and publishes with zero voice edits', async (t) => {
  const f = fixture(t);
  f.code('imported-one', 'fish-imported-id', 'IMPORTED-ONE');
  const { saved } = f.draft('imported-one');
  const revisionsBefore = revisions(f, 'imported-one');
  const detail = f.chars.detail(f.auth, 'imported-one') as { speech: { voice: Record<string, unknown> | null } };
  assert.deepEqual(detail.speech.voice, {
    referenceId: 'fish-imported-id',
    profileId: 'imported-one',
    version: 1,
    speed: 1,
    derived: true,
  });
  const materialId = f.prepare('imported-one', saved);
  // 生成 for every slot (the lines and the footer), exactly the estimate the person confirmed.
  for (const slot of f.list('imported-one')[0]!.slots) {
    const est = f.chars.speechEstimate(f.auth, 'imported-one', {
      kind: 'material',
      materialId,
      slot: slot.kind,
      ...(slot.lineId ? { lineId: slot.lineId } : {}),
    }) as { ok: boolean; estimateMicros: number };
    assert.equal(est.ok, true);
    await f.chars.materialGenerate(f.auth, 'imported-one', {
      requestId: `gen-${slot.kind}-${slot.lineId}`,
      materialId,
      kind: slot.kind,
      ...(slot.lineId ? { lineId: slot.lineId } : {}),
      acknowledgeMicros: est.estimateMicros,
    });
  }
  assert.equal(f.sent.length, 3, 'two lines and the footer');
  await f.approve('imported-one', materialId);
  const published = await f.publish('imported-one', saved, materialId);
  assert.equal(published.version, 1);
  // Nothing wrote a draft revision on the way, and the published version carries the derived binding.
  assert.equal(revisions(f, 'imported-one'), revisionsBefore);
  const config = JSON.parse(
    f.raw.get<{ config_json: string }>('SELECT config_json FROM character_templates WHERE id=?', 'imported-one')!
      .config_json,
  );
  assert.deepEqual(config.voice, { profileId: 'imported-one', version: 1, speed: 1, referenceId: 'fish-imported-id' });
  const binding = f.raw.get<{ profile_id: string; reference_id: string; voice_revision: number }>(
    'SELECT * FROM web_provider_voice_bindings WHERE character_id=?',
    'imported-one',
  )!;
  assert.deepEqual(
    [binding.profile_id, binding.reference_id, binding.voice_revision],
    ['imported-one', 'fish-imported-id', 1],
  );
});

test('B: a hand-made binding is kept exactly; no Fish id and no binding says 先填 Fish 音色 ID', async (t) => {
  const f = fixture(t);
  const hand = { profileId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', version: 4, speed: 1.25 };
  const { saved } = f.draft('by-hand', (p) => void (p.template.voice = { ...hand }));
  const detail = f.chars.detail(f.auth, 'by-hand') as { speech: { voice: Record<string, unknown> } };
  assert.equal(detail.speech.voice.derived, false);
  assert.equal(detail.speech.voice.profileId, hand.profileId);
  assert.equal(detail.speech.voice.version, 4);
  // The Fish id typed as the 音色档案 ID is the voice.
  assert.equal(detail.speech.voice.referenceId, hand.profileId);
  f.prepare('by-hand', saved);
  const stored = JSON.parse(
    f.raw.get<{ profile_json: string }>(
      'SELECT profile_json FROM web_character_revisions WHERE character_id=?',
      'by-hand',
    )!.profile_json,
  );
  assert.deepEqual(stored.template.voice, hand, 'the draft binding is untouched');
  const none = f.draft('no-voice');
  assert.throws(() => f.prepare('no-voice', none.saved), /CHARACTER_VOICE_REQUIRED/);
});

test('C: a weight or the persona changes nothing about a 素材版本; it stays valid, approved and publishable', async (t) => {
  const f = fixture(t);
  f.code('manifest-a', 'fish-a');
  const first = f.draft('manifest-a');
  const materialId = f.prepare('manifest-a', first.saved);
  for (const line of ['line-a', 'line-b']) await f.upload('manifest-a', materialId, 'welcome', line);
  await f.upload('manifest-a', materialId, 'footer');
  await f.approve('manifest-a', materialId);
  // A weight.
  const weights = f.draft('manifest-a', (p) => void (p.presentation.welcomes = f.lines(70, 30)), first.saved.revision);
  let [version] = f.list('manifest-a');
  assert.equal(version!.stale, null);
  assert.equal(version!.approved, true);
  // The persona.
  const persona = f.draft(
    'manifest-a',
    (p) => void ((p.presentation.welcomes = f.lines(70, 30)), (p.template.persona += ' 再改一点')),
    weights.saved.revision,
  );
  [version] = f.list('manifest-a');
  assert.equal(version!.stale, null);
  assert.deepEqual(
    version!.slots.map((s) => s.state),
    ['ready', 'ready', 'ready'],
  );
  assert.equal((await f.publish('manifest-a', persona.saved, materialId)).version, 1);
});

test('C: changing line 2 leaves only slot 2 needing a clip; changing the Fish id makes the whole version stale', async (t) => {
  const f = fixture(t);
  f.code('manifest-b', 'fish-b');
  const first = f.draft('manifest-b');
  const oldId = f.prepare('manifest-b', first.saved);
  for (const line of ['line-a', 'line-b']) await f.upload('manifest-b', oldId, 'welcome', line);
  await f.upload('manifest-b', oldId, 'footer');
  await f.approve('manifest-b', oldId);
  const edited = f.draft(
    'manifest-b',
    (p) => void (p.presentation.welcomes = f.lines(50, 50, '换一句新的话')),
    first.saved.revision,
  );
  const [stale] = f.list('manifest-b');
  assert.equal(stale!.stale, 'text', '需重新准备');
  assert.deepEqual(
    stale!.slots.map((s) => s.state),
    ['ready', 'stale', 'ready'],
  );
  // 准备新素材版本: the clips whose text is unchanged come along, so only slot 2 is empty.
  const next = f.prepare('manifest-b', edited.saved);
  await f.chars.materialCarry(f.auth, 'manifest-b', next);
  const fresh = f.list('manifest-b').find((m) => m.materialId === next)!;
  assert.equal(fresh.number, 2, '素材版本 N, in creation order');
  assert.deepEqual(
    fresh.slots.map((s) => s.state),
    ['ready', 'empty', 'ready'],
  );
  await f.upload('manifest-b', next, 'welcome', 'line-b');
  await f.approve('manifest-b', next);
  assert.equal((await f.publish('manifest-b', edited.saved, next)).version, 1);
  // The Fish id: a binding that names a different one makes the whole version stale and nothing is carried.
  const g = fixture(t);
  g.code('manifest-c', 'fish-c');
  const one = g.draft('manifest-c');
  const m1 = g.prepare('manifest-c', one.saved);
  await g.upload('manifest-c', m1, 'welcome', 'line-a');
  const moved = g.draft(
    'manifest-c',
    (p) => void (p.template.voice = { profileId: 'manifest-c', version: 2, speed: 1, referenceId: 'fish-other' }),
    one.saved.revision,
  );
  assert.equal(g.list('manifest-c')[0]!.stale, 'voice');
  const m2 = g.prepare('manifest-c', moved.saved);
  await g.chars.materialCarry(g.auth, 'manifest-c', m2);
  assert.deepEqual(
    g
      .list('manifest-c')
      .find((m) => m.materialId === m2)!
      .slots.map((s) => s.state),
    ['empty', 'empty', 'empty'],
  );
});

test('C: the model shown for a 素材版本 is the one that will actually speak', async (t) => {
  const f = fixture(t);
  f.code('manifest-d', 'fish-d');
  const { saved } = f.draft('manifest-d');
  const unpinned = f.prepare('manifest-d', saved);
  const pinned = f.prepare('manifest-d', saved, 'pin:s2.1-pro');
  const by = (id: string) => f.list('manifest-d').find((m) => m.materialId === id)!;
  assert.equal(by(unpinned).voice.model, 's2.1-pro', "the site's model (FISH_VOICE_MODEL) here");
  assert.equal(by(pinned).voice.model, 's2.1-pro');
});

test('D: with the free tier on no footer is shown or required and publishing works; with it off the footer is required', async (t) => {
  const on = fixture(t, true);
  on.code('free-on', 'fish-on');
  const a = on.draft('free-on');
  const id = on.prepare('free-on', a.saved);
  assert.deepEqual(
    on.list('free-on')[0]!.slots.map((s) => s.kind),
    ['welcome', 'welcome'],
    'no footer slot',
  );
  await assert.rejects(on.upload('free-on', id, 'footer'), /FOOTER_NOT_REQUIRED/);
  for (const line of ['line-a', 'line-b']) await on.upload('free-on', id, 'welcome', line);
  await on.approve('free-on', id, false);
  assert.equal((await on.publish('free-on', a.saved, id)).version, 1);
  assert.equal(
    on.raw.get<{ n: number }>("SELECT count(*) n FROM web_provider_footer_assets WHERE character_id='free-on'")!.n,
    0,
  );
  // Switched off later: the next publication needs the footer again (no material, and the live bundle has none).
  on.store.publicFreeTier = false;
  const live = (
    on.chars.detail(on.auth, 'free-on') as { published: { profile: ReturnType<typeof on.draft>['profile'] } }
  ).published.profile;
  live.template.version = 2;
  live.template.persona += ' v2';
  const next = on.chars.save(on.auth, 'free-on', { expectedRevision: null, profile: live });
  await assert.rejects(on.publish('free-on', next), /MATERIALS_REQUIRED/);
});

test('D: the footer is required while the free tier is off', async (t) => {
  const off = fixture(t, false);
  off.code('free-off', 'fish-off');
  const a = off.draft('free-off');
  const id = off.prepare('free-off', a.saved);
  assert.deepEqual(
    off.list('free-off')[0]!.slots.map((s) => s.kind),
    ['welcome', 'welcome', 'footer'],
  );
  for (const line of ['line-a', 'line-b']) await off.upload('free-off', id, 'welcome', line);
  await assert.rejects(off.approve('free-off', id), /MATERIALS_REQUIRED/);
  await off.upload('free-off', id, 'footer');
  await assert.rejects(off.approve('free-off', id, false), /APPROVAL_REQUIRED/);
  await off.approve('free-off', id);
});

/** Part 29 G (audit F-07): the save body limit is derived from the validators, in one constant both transports use. */
test('G: the largest profile the validators accept saves, and its body is below the shared limit; a body over it is 413', async (t) => {
  const { PROFILE_BODY_LIMIT } = await import('../../../apps/server/characters/web-profile-limits.ts');
  const { cloudJSON } = await import('../../../apps/server/cloudflare/json.ts');
  const f = fixture(t);
  const profile = (f.chars.detail(f.auth, 'wei-guagua') as { published: { profile: Record<string, any> } }).published
    .profile;
  const cjk = (n: number) => '汉'.repeat(n);
  profile.template.id = 'largest';
  profile.template.version = 1;
  delete profile.template.voice;
  profile.template.name = cjk(100);
  profile.template.persona = cjk(20_000);
  profile.template.authorCanon = {
    kind: 'author_canon',
    settings: { background: cjk(48_000 - JSON.stringify({ background: '' }).length) },
  };
  // 48 half-hour slots a day, the one catch-up window the schedule needs.
  profile.template.schedule.days = Object.fromEntries(
    [0, 1, 2, 3, 4, 5, 6].map((day) => [
      day,
      Array.from({ length: 48 }, (_, i) => ({
        startMinute: i * 30,
        endMinute: i * 30 + 30,
        probability: 0.5,
        catchUp: i === 0,
      })),
    ]),
  );
  profile.presentation.displayName = cjk(100);
  profile.presentation.publicDescription = cjk(500);
  profile.presentation.welcomes = Array.from({ length: 8 }, (_, i) => ({
    id: `l${i}`.padEnd(64, 'x'),
    text: cjk(200),
    weight: i < 4 ? 13 : 12,
  }));
  profile.presentation.palette = [
    { hex: '#112233', name: cjk(24), role: 'main' },
    ...[1, 2, 3, 4].map((n) => ({ hex: '#44556' + n, name: cjk(24), role: 'accent' })),
  ];
  profile.presentation.color = '#112233';
  const body = JSON.stringify({ expectedRevision: null, profile });
  assert.ok(new TextEncoder().encode(body).length < PROFILE_BODY_LIMIT, 'below the route limit');
  const saved = f.chars.save(f.auth, 'largest', { expectedRevision: null, profile });
  assert.ok(saved.revision > 0, 'the validators accept it');
  const request = (text: string) =>
    new Request('https://fixture.invalid/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
    });
  assert.deepEqual(Object.keys((await cloudJSON(request(body), PROFILE_BODY_LIMIT)) as object), [
    'expectedRevision',
    'profile',
  ]);
  await assert.rejects(
    cloudJSON(request(JSON.stringify({ pad: 'x'.repeat(PROFILE_BODY_LIMIT) })), PROFILE_BODY_LIMIT),
    /PAYLOAD_TOO_LARGE/,
  );
});
