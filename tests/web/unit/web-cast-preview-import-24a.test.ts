import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebCastAdmin } from '../../../apps/server/admin/web-cast-admin.ts';
import { buildLegacyCast, type LegacySource } from '../../../apps/server/cast/cast-import.ts';
import { compileCastView } from '../../../apps/server/cast/cast-compile.ts';
import { latestPublication, readDraft } from '../../../apps/server/cast/cast-store.ts';
import { validateCastDoc } from '../../../apps/server/cast/cast-validation.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import { installWebCharacterCatalog } from '../../../apps/server/characters/web-character-catalog.ts';
import { WebCharacterPreviews, readWebPreview } from '../../../apps/server/characters/web-character-preview.ts';
import { configureWebProvider } from '../../../apps/server/generation/web-provider-configuration.ts';
import { migrateWebProviderOffline } from '../../../apps/server/generation/web-provider-migration.ts';
import { promptMessages } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { CAST_CONTEXT_PROMPT } from '../../../apps/server/generation/cast-prompt.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import type { WebRuntimeStore } from '../../../apps/server/platform/web-store-contract.ts';
import type { CharacterTemplate, TextGenerationRequest } from '../../../packages/contracts/index.ts';
import { CAST_LIMITS } from '../../../packages/contracts/web-cast.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';
import { counterIds } from '../fixtures/cast-sample.ts';

const ORIGIN = 'https://fixture.invalid';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const refused = (work: () => unknown, code: string) =>
  assert.throws(work, (error: Error & { code?: string }) => error.code === code || error.message === code);

const canon = (id: string, other: string, third: string): NonNullable<CharacterTemplate['authorCanon']> => ({
  kind: 'author_canon',
  settings: {
    selfIdentity: {
      names: [`合成${id}`, '阿瓜', '这是一个很长很长很长很长的名字', '瓜', '第五个名字'],
      truthScope: 'fictional_world',
      representsRealPerson: false,
    },
    aliases: ['瓜瓜', '小魏', '别名三号', '别名四号'],
    basicInfo: { englishName: 'Guagua', birthPlace: '广州', grewUpIn: '老城' },
    speechStyle: [
      '口头禅：真的假的',
      '说话慢半拍但是句句有分量，喜欢用反问，也喜欢在句尾加个“嘛”，这一条超过四十个字所以只能进示例',
    ],
    dialogueStyle: '安慰人时先沉默一秒',
    dialogueExamples: [{ situation: '问候', player: '早', reply: ['早呀', '睡得好吗'] }],
    background: [{ title: '童年', text: '在老城长大' }, '后来搬去了新区'],
    personalityLayers: { 表面: '嘴硬', 内里: '心软' },
    fictionalPeople: [{ name: '阿嬷', relation: '外婆，住在老城' }, '街角的猫'],
    interests: ['听歌', '散步'],
    fears: ['黑暗'],
    appearanceNotes: '总是戴着耳机',
    canonEvents: [
      {
        title: '初遇',
        summary: '在书店第一次见面',
        date: '2025-06',
        place: '旧书店',
        sourceKind: 'author_canon',
        truthScope: 'fictional_world',
        defaultKnowers: [id, other],
      },
      {
        title: '一个人的夜',
        summary: `${id}独自守夜`,
        date: '去年冬天',
        sourceKind: 'author_canon',
        truthScope: 'fictional_world',
        defaultKnowers: [id, third],
      },
    ],
  },
});

function fixture(t: test.TestContext) {
  let now = 1_800_000_000_000;
  const clock = { now: () => now },
    store = new Store(':memory:');
  t.after(() => store.close());
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  store.run("INSERT INTO web_instance(singleton,instance_id) VALUES (1,'preview-instance')");
  migrateWebProviderOffline(store);
  // the cast tables (migration 129 is self-contained; the preview harness stops at 113)
  store.db.exec(readFileSync(new URL('129_cast.sql', folder), 'utf8'));
  const selected = syntheticSelection();
  const ids = ['chen-jimi', 'wei-guagua', 'jojo'];
  for (const item of selected) {
    const at = ids.indexOf(item.characterId);
    const template = {
      ...item.template,
      authorCanon: canon(item.characterId, ids[(at + 1) % 3]!, ids[(at + 2) % 3]!),
    };
    store.run(
      'INSERT INTO character_templates VALUES (?,?,?)',
      item.characterId,
      item.personaVersion,
      JSON.stringify(template),
    );
  }
  configureWebProvider(store as unknown as WebRuntimeStore, selected, now);
  const admin = new WebAccountAdmin(store, clock, ORIGIN);
  installWebAdminActions(store);
  installWebCharacterCatalog(store);
  const chars = new WebCharacterAdmin(store, clock, admin),
    previews = new WebCharacterPreviews(store, clock);
  chars.enablePreviews(previews);
  const login = admin.login(admin.issueLoginGrant().token, ORIGIN);
  const auth = { cookie: login.cookie, csrf: login.csrf, origin: ORIGIN };
  const cast = new WebCastAdmin(store, clock, admin);
  const profile = chars.detail(auth, 'wei-guagua').published!.profile;
  profile.template.version++;
  profile.template.persona += '修改后的角色';
  const saved = chars.save(auth, 'wei-guagua', { expectedRevision: null, profile });
  let n = 0;
  const preview = (extra: Record<string, unknown> = {}) =>
    chars.startPreview(auth, 'wei-guagua', {
      requestId: `preview-${String(++n).padStart(6, '0')}`,
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      relationship: 'friend',
      message: `今天好吗${n}`,
      ...extra,
    });
  const requestOf = (previewId: string) =>
    JSON.parse(readWebPreview(store, previewId).request_json) as TextGenerationRequest;
  let r = 0;
  const request = () => `cast-request-${String(++r).padStart(6, '0')}`;
  return {
    store,
    admin,
    auth,
    chars,
    cast,
    preview,
    requestOf,
    request,
    importAndPublish() {
      const imported = cast.importLegacy(auth, { requestId: request(), expectedRevision: 1, overwrite: false });
      const published = cast.publish(auth, { requestId: request(), expectedRevision: imported.revision });
      return { imported, published };
    },
  };
}

const sources = (): LegacySource[] => [
  {
    characterId: 'a',
    displayName: '甲',
    publicDescription: '甲的一句话简介',
    template: {
      id: 'a',
      name: '甲甲',
      version: 1,
      fictional: true,
      persona: '甲的人设',
      schedule: { timeZone: 'UTC', days: {} as never },
      authorCanon: canon('a', 'b', 'b'),
    },
  },
  {
    characterId: 'b',
    displayName: '乙',
    publicDescription: '这个简介太长了这个简介太长了这个简介太长了这个简介太长了这个简介太长了这个简介太长了',
    template: {
      id: 'b',
      name: '乙乙',
      version: 1,
      fictional: true,
      persona: '乙的人设',
      schedule: { timeZone: 'UTC', days: {} as never },
      authorCanon: canon('b', 'a', 'a'),
    },
  },
  {
    characterId: 'c',
    displayName: '丙',
    publicDescription: '',
    template: {
      id: 'c',
      name: '丙',
      version: 1,
      fictional: true,
      persona: '没有 canon',
      schedule: { timeZone: 'UTC', days: {} as never },
    },
  },
];

test('import-legacy maps the known fields, sends the rest to the per-character unmapped note, and touches nothing', () => {
  const before = JSON.stringify(sources());
  const { doc, report } = buildLegacyCast(sources(), counterIds());
  assert.equal(JSON.stringify(sources()), before);
  assert.deepEqual(report, { characters: 3, people: 2, stories: 3, overrides: 2, withUnmapped: 2, unmappedCut: 0 });
  const a = doc.characters[0]!;
  // identity: the template name first, then selfIdentity.names (a name over the cap and the 4th+ go to the note); aliases ok
  assert.deepEqual(
    a.identity.names.map((n) => n.text),
    ['甲甲', '合成a', '阿瓜'],
  );
  assert.deepEqual(
    a.identity.aliases.map((x) => [x.text, x.attitude]),
    [
      ['瓜瓜', 'ok'],
      ['小魏', 'ok'],
      ['别名三号', 'ok'],
    ],
  );
  assert.equal(a.identity.oneLiner, '甲的一句话简介');
  assert.equal(doc.characters[1]!.identity.oneLiner, '', 'a description over the cap does not become the one-liner');
  // profile: basicInfo lines
  assert.equal(a.profile, '英文名：Guagua\n出生地：广州\n成长地：老城');
  // speech: short speechStyle → catchphrases, long → samples, dialogueStyle and dialogueExamples → samples
  assert.deepEqual(
    a.speech.catchphrases.map((x) => x.text),
    ['口头禅：真的假的'],
  );
  assert.equal(a.speech.samples.length, 3);
  assert.ok(a.speech.samples.some((x) => x.text.startsWith('说话慢半拍')));
  assert.ok(a.speech.samples.some((x) => x.text === '安慰人时先沉默一秒'));
  assert.ok(a.speech.samples.some((x) => x.text === '问候｜玩家：早 / 甲甲：早呀 / 睡得好吗'));
  // experiences, personality
  assert.deepEqual(
    a.experiences.map((e) => [e.title, e.text]),
    [
      ['童年', '在老城长大'],
      ['背景', '后来搬去了新区'],
    ],
  );
  assert.equal(a.personality, '表面：嘴硬\n内里：心软');
  // people: from fictionalPeople, de-duplicated across characters (same name and line = one person)
  assert.deepEqual(
    doc.people.map((p) => [p.names[0]!.text, p.oneLiner, p.kind]),
    [
      ['阿嬷', '外婆，住在老城', 'person'],
      ['街角的猫', '', 'person'],
    ],
  );
  // nothing lost: what has no field is in the note, with its label
  assert.match(a.unmapped, /【interests】听歌；散步/);
  assert.match(a.unmapped, /【fears】黑暗/);
  assert.match(a.unmapped, /【appearanceNotes】总是戴着耳机/);
  assert.match(a.unmapped, /【名字（超出上限）】瓜/);
  assert.match(a.unmapped, /【名字（超出上限）】第五个名字/);
  assert.match(a.unmapped, /【名字】这是一个很长很长很长很长的名字/);
  assert.match(a.unmapped, /【别名（超出上限）】别名四号/);
  assert.equal(doc.characters[2]!.unmapped, '', 'a character without canon has nothing to put aside');
  // stories: the same event in two canons is ONE story; defaultKnowers become overrides only where they differ from the rule
  assert.deepEqual(
    doc.stories.map((s) => s.title),
    ['初遇', '一个人的夜', '一个人的夜'],
  );
  const meeting = doc.stories[0]!;
  assert.deepEqual(meeting.participants, ['a', 'b']);
  assert.deepEqual(
    meeting.overrides,
    [],
    'both owners are participants who know it: nothing differs from the default rule',
  );
  assert.equal(meeting.period.start, '2025-06');
  const night = doc.stories[1]!;
  assert.deepEqual(night.participants, ['a']);
  assert.deepEqual(
    night.overrides.map((o) => [o.characterId, o.level]),
    [['b', 'heard']],
    'b knows but did not take part',
  );
  assert.match(night.details, /时间：去年冬天/, 'a date that is not YYYY-MM-DD goes to the details');
  assert.match(meeting.details, /place：旧书店/);
  // the result is a valid draft
  assert.deepEqual(validateCastDoc(doc, 'draft', { exists: () => true, deleted: () => false }).errors, []);
});

test('import-legacy keeps the caps: an overlong note is cut with a mark, never silently', () => {
  const big = sources();
  (big[0]!.template.authorCanon!.settings as Record<string, unknown>).fears = Array.from(
    { length: 400 },
    (_, i) => `恐惧${i}：${'暗'.repeat(30)}`,
  );
  const { doc, report } = buildLegacyCast(big, counterIds());
  assert.equal(report.unmappedCut, 1);
  assert.equal(doc.characters[0]!.unmapped.length, CAST_LIMITS.unmapped);
  assert.ok(doc.characters[0]!.unmapped.endsWith('…（未完整保留，原文仍在角色设定中）'));
  assert.deepEqual(validateCastDoc(doc, 'draft', { exists: () => true, deleted: () => false }).errors, []);
});

test('import-legacy through the API: only into an empty draft, or with overwrite=true and the current revision; character_templates is untouched', (t) => {
  const f = fixture(t);
  const templates = () => sha(JSON.stringify(f.store.all('SELECT * FROM character_templates ORDER BY id')));
  const catalog = () =>
    sha(JSON.stringify(f.store.all('SELECT * FROM web_character_versions ORDER BY character_id,version')));
  const before = [templates(), catalog()];
  const imported = f.cast.importLegacy(f.auth, { requestId: f.request(), expectedRevision: 1, overwrite: false });
  assert.equal(imported.revision, 2);
  assert.equal(imported.report.characters, 3);
  assert.deepEqual(imported.counts, { characters: 3, people: imported.counts.people, groups: 0, stories: 4, memes: 0 });
  assert.deepEqual(
    readDraft(f.store).doc.characters.map((c) => c.characterId),
    ['wei-guagua', 'jojo', 'chen-jimi'], // the order of the published catalog
  );
  // not empty any more: refused without overwrite
  refused(
    () => f.cast.importLegacy(f.auth, { requestId: f.request(), expectedRevision: 2, overwrite: false }),
    'CAST_DRAFT_NOT_EMPTY',
  );
  // overwrite needs the CAS too
  refused(
    () => f.cast.importLegacy(f.auth, { requestId: f.request(), expectedRevision: 1, overwrite: true }),
    'CAST_REVISION_CONFLICT',
  );
  assert.equal(
    f.cast.importLegacy(f.auth, { requestId: f.request(), expectedRevision: 2, overwrite: true }).revision,
    3,
  );
  // ids of the entries are new on an overwrite (it replaces the draft), the content is the same
  assert.deepEqual([templates(), catalog()], before, 'persona and authorCanon stay exactly as they were');
  refused(
    () => f.cast.importLegacy(f.auth, { requestId: f.request(), expectedRevision: 3, overwrite: 'yes' as never }),
    'INVALID_REQUEST',
  );
});

test('预演 uses the same compile as production: castSource none | published | draft, default none while the switch is off and published while it is on', (t) => {
  const f = fixture(t);
  // nothing published yet: the default is none (switch off or not), an explicit published has nothing to read
  assert.equal(f.requestOf(f.preview().previewId).cast, undefined);
  refused(() => f.preview({ castSource: 'published' }), 'CAST_NOT_PUBLISHED');
  refused(() => f.preview({ castSource: 'everything' }), 'INVALID_CAST_SOURCE');
  Object.assign(f.store, { castContext: true });
  assert.equal(
    f.requestOf(f.preview().previewId).cast,
    undefined,
    'on, but nothing published: none, like a live reply',
  );
  const { published } = f.importAndPublish();
  const doc = latestPublication(f.store)!.doc;
  const playerState = () =>
    [
      'worlds',
      'messages',
      'web_operations',
      'web_input_snapshots',
      'web_v7_requests',
      'web_principals',
      'memory_topics',
    ].map((table) => f.store.get<{ n: number }>(`SELECT count(*) n FROM ${table}`)!.n);
  const before = playerState();

  // switch ON, nothing asked: the published cast
  const dflt = f.requestOf(f.preview().previewId);
  assert.deepEqual(dflt.cast!.view, compileCastView(doc, 'wei-guagua'));
  assert.equal(dflt.cast!.version, published.version);
  assert.equal(dflt.cast!.digest, sha(JSON.stringify(compileCastView(doc, 'wei-guagua'))));
  const keys = Object.keys(dflt);
  assert.equal(keys[keys.indexOf('character') + 1], 'cast');
  // the very same promptMessages path as production
  const messages = promptMessages(dflt);
  assert.ok(messages[0]!.content.endsWith(CAST_CONTEXT_PROMPT));
  assert.deepEqual(Object.keys(JSON.parse(messages[1]!.content).cast), ['view']);
  // explicit none wins over the switch
  assert.equal(f.requestOf(f.preview({ castSource: 'none' }).previewId).cast, undefined);
  // switch OFF: the default is none again, but published and draft can still be asked for (to test before turning it on)
  Object.assign(f.store, { castContext: false });
  assert.equal(f.requestOf(f.preview().previewId).cast, undefined);
  assert.deepEqual(f.requestOf(f.preview({ castSource: 'published' }).previewId).cast, dflt.cast);
  // draft: edit the draft (not published) and see it in the preview
  const draft = f.cast.draft(f.auth, {});
  const edited = structuredClone(draft.doc);
  edited.characters.find((c) => c.characterId === 'wei-guagua')!.hidden.push({ id: '', text: '只在草稿里的隐藏设定' });
  const saved = f.cast.save(f.auth, { requestId: f.request(), expectedRevision: draft.revision, doc: edited });
  const fromDraft = f.requestOf(f.preview({ castSource: 'draft' }).previewId);
  assert.ok(JSON.stringify(fromDraft.cast!.view).includes('只在草稿里的隐藏设定'));
  assert.equal(fromDraft.cast!.version, saved.revision, 'a draft view carries the draft revision');
  assert.deepEqual(fromDraft.cast!.view, compileCastView(readDraft(f.store).doc, 'wei-guagua'));
  assert.ok(
    !JSON.stringify(f.requestOf(f.preview({ castSource: 'published' }).previewId).cast).includes(
      '只在草稿里的隐藏设定',
    ),
  );
  // a preview writes no snapshot and nothing of a player's
  assert.deepEqual(playerState(), before);
  // idempotency still covers castSource: the same request id with another source is a conflict
  const base = {
    requestId: 'preview-fixed-0001',
    draftRevision: 1,
    profileHash: 'a'.repeat(64),
    relationship: 'friend',
    message: 'x',
  };
  assert.throws(() => f.chars.startPreview(f.auth, 'wei-guagua', { ...base, castSource: 'none' }));
});
