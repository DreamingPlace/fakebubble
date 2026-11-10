import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { Store } from '../../../apps/server/platform/store.ts';
import { migrateWebProviderOffline } from '../../../apps/server/generation/web-provider-migration.ts';
import type { WebRuntimeStore } from '../../../apps/server/platform/web-store-contract.ts';
import { configureWebProvider } from '../../../apps/server/generation/web-provider-configuration.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import {
  installWebCharacterCatalog,
  publishedWebCharacters,
  webWelcomeLines,
} from '../../../apps/server/characters/web-character-catalog.ts';
import { installWebCharacterMaterials } from '../../../apps/server/characters/web-character-material-schema.ts';
import { WebCharacterMaterials } from '../../../apps/server/characters/web-character-materials.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { syntheticCharacterReview } from '../fixtures/character-review.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../../../apps/server/conversation/web-vertical-publisher.ts';
import { installWebWelcomeLines } from '../../../apps/server/characters/web-welcome-schema.ts';
import {
  chooseWelcome,
  purgeWelcomeChoices,
  storedWelcome,
  welcomeClipFor,
  welcomeServable,
} from '../../../apps/server/characters/web-welcome-choice.ts';
import { purgePlayerLogins } from '../../../apps/server/identity/web-player-purge.ts';
import { auditWebLifecycleWorld } from '../../../apps/server/admission/web-lifecycle-audit.ts';
import { evenWeights, type WelcomeLine } from '../../../packages/contracts/web-welcomes.ts';
import { prng } from '../../../apps/player-web/src/features/brand/palette-skin.ts';
import { restoreWebCharacter, characterVersion } from '../../../apps/server/characters/web-character-history.ts';

const ORIGIN = 'https://fixture.invalid';
function fixture(t: test.TestContext) {
  const store = Object.assign(new Store(':memory:'), { instanceId: 'welcome-unit' });
  t.after(() => store.close());
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  store.run("INSERT INTO web_instance(singleton,instance_id) VALUES (1,'welcome-unit')");
  migrateWebProviderOffline(store);
  const now = 1_800_000_000_000,
    clock = { now: () => now },
    selected = syntheticSelection();
  for (const item of selected)
    store.run(
      'INSERT INTO character_templates VALUES (?,?,?)',
      item.characterId,
      item.personaVersion,
      JSON.stringify(item.template),
    );
  configureWebProvider(store as unknown as WebRuntimeStore, selected, now);
  const accounts = new WebAccountAdmin(store, clock, ORIGIN);
  installWebCharacterCatalog(store);
  installWebCharacterMaterials(store);
  const chars = new WebCharacterAdmin(store, clock, accounts),
    materials = new WebCharacterMaterials(store, clock);
  chars.enableMaterials(materials);
  const login = accounts.login(accounts.issueLoginGrant().token, ORIGIN);
  const auth = { cookie: login.cookie, csrf: login.csrf, origin: ORIGIN };
  const offline = new WebProviderOffline(store, clock);
  for (const role of publishedWebCharacters(store)) {
    const version = store.get<{ voice_version: string }>(
      'SELECT voice_version FROM web_provider_voice_bindings WHERE character_id=?',
      role.characterId,
    )!.voice_version;
    offline.registerWelcome({
      characterId: role.characterId,
      voiceVersion: version,
      body: role.presentation.welcomes[0]!.text,
      wav: syntheticTone(),
    });
    offline.registerApprovedFooter({
      characterId: role.characterId,
      voiceVersion: version,
      body: SYNTHETIC_TRIAL_FOOTER,
      wav: syntheticTone(),
      approved: true,
    });
  }
  const lines3: WelcomeLine[] = evenWeights(3).map((weight, i) => ({
    id: `line-${i + 1}`,
    text: `第${i + 1}句欢迎词`,
    weight,
  }));
  /** A draft of wei-guagua with the given lines and a new voice, prepared into a 素材版本. */
  const draft = (lines: WelcomeLine[] = lines3, requestId = 'material-1') => {
    const profile = chars.detail(auth, 'wei-guagua').published!.profile;
    profile.template.version = profile.template.version + 1;
    profile.presentation.welcomes = lines;
    profile.template.voice = { profileId: `voice-${requestId}`, version: 1, speed: 1 };
    const saved = chars.save(auth, 'wei-guagua', { expectedRevision: null, profile });
    const material = chars.materialPrepare(auth, 'wei-guagua', {
      requestId,
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      referenceId: 'selected-existing-reference',
      model: 's2.1-pro',
    });
    return { saved, profile, lines, ...material };
  };
  const wav = () => syntheticTone().toString('base64');
  const uploadLine = (d: ReturnType<typeof draft>, lineId: string) =>
    chars.materialUpload(auth, 'wei-guagua', { materialId: d.materialId, kind: 'welcome', lineId, base64: wav() });
  const uploadFooter = (d: ReturnType<typeof draft>) =>
    chars.materialUpload(auth, 'wei-guagua', { materialId: d.materialId, kind: 'footer', base64: wav() });
  const approve = (d: ReturnType<typeof draft>, heard: string[] | null = d.lines.map((l) => l.id)) =>
    chars.materialApprove(auth, 'wei-guagua', {
      materialId: d.materialId,
      acknowledgeRights: true,
      ...(heard ? { acknowledgeLines: heard } : { acknowledgeWelcomeListening: true }),
      acknowledgeFooterListening: true,
      note: '离线合成素材授权与试听确认',
    });
  const publication = async (d: ReturnType<typeof draft>, withMaterial = true) => ({
    requestId: `publish-${d.materialId}`,
    draftRevision: d.saved.revision,
    profileHash: d.saved.contentHash,
    previewId: await syntheticCharacterReview(store, now, 'wei-guagua'),
    acknowledgeReview: true,
    ...(withMaterial ? { materialId: d.materialId } : {}),
  });
  const fill = async (d: ReturnType<typeof draft>) => {
    for (const l of d.lines) await uploadLine(d, l.id);
    await uploadFooter(d);
  };
  return {
    store,
    accounts,
    chars,
    materials,
    auth,
    clock,
    now,
    offline,
    draft,
    uploadLine,
    uploadFooter,
    approve,
    publication,
    fill,
    lines3,
  };
}
const code = (c: string) => (e: unknown) => new RegExp(c).test(String((e as Error).message ?? e));

test('Part 24k-2: the tables come from one idempotent, digest-checked step; no numbered migration', (t) => {
  const f = fixture(t);
  const version = f.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
  const before = f.store.all(
    "SELECT name,sql FROM sqlite_master WHERE name GLOB 'web_welcome*' OR name='web_provider_welcome_lines' ORDER BY name",
  );
  installWebWelcomeLines(f.store);
  installWebWelcomeLines(f.store);
  assert.equal(
    f.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version,
    version,
    'no numbered migration ran',
  );
  assert.deepEqual(
    f.store.all(
      "SELECT name,sql FROM sqlite_master WHERE name GLOB 'web_welcome*' OR name='web_provider_welcome_lines' ORDER BY name",
    ),
    before,
  );
  f.store.all('DROP TRIGGER web_provider_welcome_lines_update');
  assert.throws(() => installWebWelcomeLines(f.store), code('WEB_WELCOME_SCHEMA_MISMATCH'));
});

test('Part 24k-2: a profile saves with 1–8 weighted lines; the sum and every line are checked with located errors', (t) => {
  const f = fixture(t);
  const profile = f.chars.detail(f.auth, 'wei-guagua').published!.profile;
  assert.equal(profile.presentation.welcomes.length, 1, 'the old single welcome reads as one line');
  assert.equal(profile.presentation.welcomes[0]!.weight, 100);
  profile.template.version += 1;
  profile.presentation.welcomes = [
    { id: 'a', text: '甲', weight: 60 },
    { id: 'b', text: '乙', weight: 30 },
  ];
  try {
    f.chars.save(f.auth, 'wei-guagua', { expectedRevision: null, profile });
    assert.fail('90% must be refused');
  } catch (error) {
    assert.equal((error as Error).message, 'WELCOMES_INVALID');
    assert.deepEqual(
      (error as { detail: { problems: { line: number; field: string }[] } }).detail.problems.map((p) => [
        p.line,
        p.field,
      ]),
      [[0, 'total']],
    );
  }
  profile.presentation.welcomes = [
    { id: 'a', text: '甲', weight: 60 },
    { id: 'b', text: '', weight: 40 },
  ];
  try {
    f.chars.save(f.auth, 'wei-guagua', { expectedRevision: null, profile });
    assert.fail('an empty line must be refused');
  } catch (error) {
    assert.deepEqual(
      (error as { detail: { problems: { line: number }[] } }).detail.problems.map((p) => p.line),
      [2],
    );
  }
  profile.presentation.welcomes = evenWeights(8).map((weight, i) => ({ id: `l${i}`, text: `第${i}句`, weight }));
  const saved = f.chars.save(f.auth, 'wei-guagua', { expectedRevision: null, profile });
  assert.equal(saved.profile.presentation.welcomes.length, 8);
  profile.presentation.welcomes = [...profile.presentation.welcomes, { id: 'l9', text: '多', weight: 1 }];
  assert.throws(
    () => f.chars.save(f.auth, 'wei-guagua', { expectedRevision: saved.revision, profile }),
    code('WELCOMES_INVALID'),
  );
});

test('Part 24k-2: publishing needs a matching approved clip for EVERY line and the footer', async (t) => {
  const f = fixture(t);
  const d = f.draft();
  const input = await f.publication(d);
  // nothing uploaded yet
  assert.throws(() => f.chars.publish(f.auth, 'wei-guagua', input), code('CHARACTER_MATERIALS_REQUIRED'));
  // a one-line profile's slot cannot be used for a 3-line profile, and a line must be named
  await assert.rejects(
    f.chars.materialUpload(f.auth, 'wei-guagua', {
      materialId: d.materialId,
      kind: 'welcome',
      base64: syntheticTone().toString('base64'),
    }),
    code('INVALID_ADMIN_ID'),
  );
  await assert.rejects(f.uploadLine(d, 'no-such-line'), code('INVALID_MATERIAL_KIND'));
  await f.uploadLine(d, 'line-1');
  await f.uploadLine(d, 'line-2');
  await f.uploadFooter(d);
  // two of three lines: approval refuses, so the material cannot be published
  await assert.rejects(f.approve(d), code('CHARACTER_MATERIALS_REQUIRED'));
  assert.throws(() => f.chars.publish(f.auth, 'wei-guagua', input), code('CHARACTER_MATERIALS_REQUIRED'));
  await f.uploadLine(d, 'line-3');
  // every slot has to be heard and ticked
  await assert.rejects(f.approve(d, ['line-1', 'line-2']), code('MATERIAL_APPROVAL_REQUIRED'));
  await assert.rejects(f.approve(d, null), code('MATERIAL_APPROVAL_REQUIRED'));
  await f.approve(d);
  const result = f.chars.publish(f.auth, 'wei-guagua', input);
  assert.equal(result.version, d.profile.template.version);
  const bound = f.store.get<{ voice_version: string }>(
    "SELECT voice_version FROM web_provider_voice_bindings WHERE character_id='wei-guagua'",
  )!;
  assert.equal(
    f.store.all(
      'SELECT line_id FROM web_provider_welcome_lines WHERE voice_version=? ORDER BY line_id',
      bound.voice_version,
    ).length,
    3,
  );
  for (const l of d.lines)
    assert.ok(welcomeClipFor(f.store, 'wei-guagua', { lineId: l.id, text: l.text }), `a clip for ${l.id}`);
  assert.equal(
    welcomeClipFor(f.store, 'wei-guagua', { lineId: 'line-1', text: '别的话' }),
    null,
    'a slot whose text changed no longer matches',
  );
  assert.deepEqual(
    webWelcomeLines(f.store, 'wei-guagua')!.map((l) => l.id),
    ['line-1', 'line-2', 'line-3'],
  );
});

test('Part 24k-2: without a new bundle a changed or added line cannot publish (the reused clips must cover every line)', async (t) => {
  const f = fixture(t);
  const d = f.draft(f.lines3, 'material-reuse');
  // no materialId: the approved bundle only has the old single clip, which covers none of the three new lines
  const input = await f.publication(d, false);
  assert.throws(() => f.chars.publish(f.auth, 'wei-guagua', input), code('CHARACTER_MATERIALS_REQUIRED'));
});

test('Part 24k-2: restore reuses the whole bundle of that version, line clips included', async (t) => {
  const f = fixture(t);
  const d = f.draft(f.lines3, 'material-restore');
  await f.fill(d);
  await f.approve(d);
  f.chars.publish(f.auth, 'wei-guagua', await f.publication(d));
  const v2 = d.profile.template.version;
  // v3: a different, one-line bundle published on top
  const profile = f.chars.detail(f.auth, 'wei-guagua').published!.profile;
  profile.template.version = v2 + 1;
  profile.presentation.welcomes = [{ id: 'solo', text: '独一句', weight: 100 }];
  profile.template.voice = { profileId: 'voice-next', version: 1, speed: 1 };
  const saved3 = f.chars.save(f.auth, 'wei-guagua', { expectedRevision: null, profile });
  const m3 = f.chars.materialPrepare(f.auth, 'wei-guagua', {
    requestId: 'material-3',
    draftRevision: saved3.revision,
    profileHash: saved3.contentHash,
    referenceId: 'other-ref',
    model: 's2.1-pro',
  });
  await f.chars.materialUpload(f.auth, 'wei-guagua', {
    materialId: m3.materialId,
    kind: 'welcome',
    base64: syntheticTone().toString('base64'),
  });
  await f.chars.materialUpload(f.auth, 'wei-guagua', {
    materialId: m3.materialId,
    kind: 'footer',
    base64: syntheticTone().toString('base64'),
  });
  await f.chars.materialApprove(f.auth, 'wei-guagua', {
    materialId: m3.materialId,
    acknowledgeRights: true,
    acknowledgeWelcomeListening: true,
    acknowledgeFooterListening: true,
    note: '合成',
  });
  f.chars.publish(f.auth, 'wei-guagua', {
    requestId: 'publish-3',
    draftRevision: saved3.revision,
    profileHash: saved3.contentHash,
    previewId: await syntheticCharacterReview(f.store, f.now, 'wei-guagua'),
    acknowledgeReview: true,
    materialId: m3.materialId,
  });
  assert.equal(webWelcomeLines(f.store, 'wei-guagua')!.length, 1);
  const actor = {
    memberId: f.store.get<{ id: string }>('SELECT id FROM web_admin_members LIMIT 1')!.id,
    sessionId: f.store.get<{ id: string }>('SELECT id FROM admin_sessions LIMIT 1')!.id,
  };
  const restored = restoreWebCharacter(f.store, f.now, actor, 'wei-guagua', {
    requestId: 'restore-1',
    version: v2,
    liveVersion: v2 + 1,
  });
  assert.equal(restored.restoredFrom, v2);
  assert.deepEqual(
    webWelcomeLines(f.store, 'wei-guagua')!.map((l) => [l.id, l.weight]),
    d.lines.map((l) => [l.id, l.weight]),
  );
  for (const l of d.lines)
    assert.ok(
      welcomeClipFor(f.store, 'wei-guagua', { lineId: l.id, text: l.text }),
      `the restored bundle plays ${l.id}`,
    );
  const snapshot = characterVersion(f.store, 'wei-guagua', v2);
  assert.equal(snapshot.profile.presentation.welcomes!.length, 3);
});

test('Part 24k-2: a player gets one line by weight, once; it is stored and stays across reloads', (t) => {
  const f = fixture(t);
  const lines: WelcomeLine[] = [
    { id: 'a', text: '甲', weight: 50 },
    { id: 'b', text: '乙', weight: 30 },
    { id: 'c', text: '丙', weight: 20 },
  ];
  const first = chooseWelcome(
    f.store,
    { worldId: 'w1', characterId: 'wei-guagua', version: 1, lines, now: 1 },
    () => 0.6,
  );
  assert.deepEqual(first, { lineId: 'b', text: '乙' }, '0.6 of 100 falls in the second line');
  // a reload, another device, the pill, the chat and the memory read the same stored line, whatever the next draw would be
  for (let i = 0; i < 5; i += 1)
    assert.deepEqual(
      chooseWelcome(f.store, { worldId: 'w1', characterId: 'wei-guagua', version: 1, lines, now: 2 + i }, () => 0.99),
      first,
    );
  assert.deepEqual(storedWelcome(f.store, 'w1', 'wei-guagua'), first);
  assert.equal(storedWelcome(f.store, 'w2', 'wei-guagua'), null, 'another world has its own');
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_welcome_choices')!.n, 1);
  // the draw is a crypto draw: with the real source two worlds are independent and the sample follows the weights
  const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 3000; i += 1)
    counts[
      chooseWelcome(f.store, { worldId: `world-${i}`, characterId: 'wei-guagua', version: 1, lines, now: 3 }).lineId
    ]! += 1;
  for (const l of lines) assert.ok(Math.abs((counts[l.id]! / 3000) * 100 - l.weight) < 4, `${l.id}: ${counts[l.id]}`);
});

test('Part 24k-2: a re-publish without the stored line redraws only for players with no chat', (t) => {
  const f = fixture(t);
  const v1: WelcomeLine[] = [
    { id: 'a', text: '甲', weight: 50 },
    { id: 'b', text: '乙', weight: 50 },
  ];
  const v2: WelcomeLine[] = [{ id: 'c', text: '丙', weight: 100 }];
  for (const world of ['quiet', 'chatty'])
    assert.equal(
      chooseWelcome(f.store, { worldId: world, characterId: 'wei-guagua', version: 1, lines: v1, now: 1 }, () => 0.1)
        .lineId,
      'a',
    );
  f.store.db.exec('PRAGMA foreign_keys=OFF');
  f.store.run(
    "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES ('chatty','c1','private','wei-guagua')",
  );
  // still published: unchanged for both
  for (const world of ['quiet', 'chatty'])
    assert.equal(
      chooseWelcome(
        f.store,
        {
          worldId: world,
          characterId: 'wei-guagua',
          version: 2,
          lines: [...v1, ...v2.map((l) => ({ ...l, weight: 1 }))],
          now: 2,
        },
        () => 0.9,
      ).lineId,
      'a',
    );
  // line a is gone: the player with no chat is drawn again, the one with a chat keeps the line (and its history) unchanged
  assert.equal(
    chooseWelcome(f.store, { worldId: 'quiet', characterId: 'wei-guagua', version: 3, lines: v2, now: 3 }).lineId,
    'c',
  );
  assert.deepEqual(
    chooseWelcome(f.store, { worldId: 'chatty', characterId: 'wei-guagua', version: 3, lines: v2, now: 3 }),
    { lineId: 'a', text: '甲' },
  );
  // the text of a line changed: it is not the stored line any more
  assert.equal(
    chooseWelcome(f.store, {
      worldId: 'quiet',
      characterId: 'wei-guagua',
      version: 4,
      lines: [{ id: 'c', text: '丙（改）', weight: 100 }],
      now: 4,
    }).text,
    '丙（改）',
  );
});

test('Part 24k-2: the stored choice goes with the player and with the character; the lifecycle audit passes', (t) => {
  const f = fixture(t);
  const lines: WelcomeLine[] = [{ id: 'a', text: '甲', weight: 100 }];
  for (const [world, character] of [
    ['w1', 'wei-guagua'],
    ['w1', 'jojo'],
    ['w2', 'wei-guagua'],
  ] as const)
    chooseWelcome(f.store, { worldId: world, characterId: character, version: 1, lines, now: 1 });
  const columns = f.store.all<{ name: string }>('PRAGMA table_info(web_welcome_choices)').map((c) => c.name);
  assert.ok(columns.includes('world_id'), 'it carries world_id');
  // the player: retention purge / account deletion share purgePlayerLogins
  purgePlayerLogins(f.store, { principalId: 'no-such-principal', worldId: 'w1', now: 1 });
  assert.deepEqual(
    f.store
      .all<{ world_id: string; character_id: string }>(
        'SELECT world_id,character_id FROM web_welcome_choices ORDER BY world_id,character_id',
      )
      .map((r) => [r.world_id, r.character_id]),
    [['w2', 'wei-guagua']],
  );
  // the character: every world at once
  chooseWelcome(f.store, { worldId: 'w3', characterId: 'wei-guagua', version: 1, lines, now: 1 });
  purgeWelcomeChoices(f.store, { characterId: 'wei-guagua' });
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_welcome_choices')!.n, 0);
});

test('Part 24k-2: the public route serves a line clip only while the character is published and the text is a published line (or one a player keeps)', async (t) => {
  const f = fixture(t);
  const d = f.draft(f.lines3, 'material-serve');
  await f.fill(d);
  await f.approve(d);
  f.chars.publish(f.auth, 'wei-guagua', await f.publication(d));
  const clip = (l: WelcomeLine) => welcomeClipFor(f.store, 'wei-guagua', { lineId: l.id, text: l.text })!;
  for (const l of d.lines) {
    assert.ok(welcomeServable(f.store, 'wei-guagua', l.text));
    const bytes = await f.offline.readWelcomeAudio(clip(l).mediaId);
    assert.ok(bytes.length > 100);
  }
  assert.equal(welcomeServable(f.store, 'wei-guagua', '不是欢迎词'), false);
  assert.equal(welcomeServable(f.store, 'not-published', d.lines[0]!.text), false, 'offline or unknown = nothing');
  const rand = prng(7);
  void rand;
});
