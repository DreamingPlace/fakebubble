import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../../../apps/server/platform/store.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebCharacterAdmin } from '../../../apps/server/characters/web-character-admin.ts';
import {
  installWebCharacterCatalog,
  publishedWebCharacters,
} from '../../../apps/server/characters/web-character-catalog.ts';
import { WEB_PROVIDER_CATALOG, WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

/** Same isolated schema as web-character-publication.test.ts, with the draft left to each test. */
function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  // Metadata-only unit doubles; HTTP tests below cover complete native workerd schema/R2.
  store.all(`CREATE TABLE web_provider_voice_bindings(character_id TEXT PRIMARY KEY,voice_version TEXT,
    profile_id TEXT,voice_revision INTEGER,approved INTEGER,source TEXT) STRICT`);
  store.all(
    `CREATE TABLE web_provider_welcome_assets(character_id TEXT,voice_version TEXT,body TEXT,text_version TEXT,origin TEXT) STRICT`,
  );
  store.all(`CREATE TABLE web_provider_footer_assets(character_id TEXT,voice_version TEXT,origin TEXT) STRICT`);
  store.all(`CREATE TABLE web_operations(character_id TEXT,status TEXT) STRICT`);
  const now = 1_800_000_000_000,
    clock = { now: () => now },
    origin = 'https://fixture.invalid';
  const admin = new WebAccountAdmin(store, clock, origin);
  for (const item of WEB_PROVIDER_CATALOG) {
    const id = item.characterId,
      template = {
        id,
        name: item.displayName,
        version: 1,
        fictional: true,
        persona: '隔离合成角色',
        schedule: defaultSchedule(),
        voice: { profileId: id, version: 1, speed: 1 },
      };
    store.run('INSERT INTO character_templates VALUES (?,1,?)', id, JSON.stringify(template));
    store.run("INSERT INTO web_provider_voice_bindings VALUES (?,'voice-v1',?,1,1,'user_selected')", id, id);
    store.run(
      "INSERT INTO web_provider_welcome_assets VALUES (?,'voice-v1',?,?,'operator_approved')",
      id,
      WEB_PROVIDER_WELCOME[id].text,
      WEB_PROVIDER_WELCOME[id].version,
    );
    store.run("INSERT INTO web_provider_footer_assets VALUES (?,'voice-v1','operator_approved')", id);
  }
  installWebCharacterCatalog(store);
  const service = new WebCharacterAdmin(store, clock, admin),
    login = admin.login(admin.issueLoginGrant().token, origin);
  const auth = { cookie: login.cookie, csrf: login.csrf, origin };
  const profile = service.detail(auth, 'wei-guagua').published!.profile;
  profile.template.version++;
  return { store, service, admin, auth, profile, now };
}

const colourDraft = (f: ReturnType<typeof fixture>, change: (p: typeof f.profile) => void = () => {}) => {
  const next = structuredClone(f.profile);
  next.presentation.color = '#3366CC';
  change(next);
  return f.service.save(f.auth, 'wei-guagua', { expectedRevision: null, profile: next });
};
const colourPublish = (f: ReturnType<typeof fixture>, saved: { revision: number; contentHash: string }) => ({
  requestId: 'colour-1',
  draftRevision: saved.revision,
  profileHash: saved.contentHash,
  acknowledgeReview: true,
});

test('a main colour is validated as #RRGGBB in capitals and kept only when given', (t) => {
  const f = fixture(t);
  for (const bad of ['#36c', '#3366cc', '3366CC', 'rgb(1,2,3)', '#33666', 7, null]) {
    const next = structuredClone(f.profile) as unknown as { presentation: Record<string, unknown> };
    next.presentation.color = bad;
    assert.throws(
      () => f.service.save(f.auth, 'wei-guagua', { expectedRevision: null, profile: next }),
      /INVALID_ADMIN_REQUEST/,
    );
  }
  const saved = colourDraft(f);
  assert.equal(saved.profile.presentation.color, '#3366CC');
  assert.equal('color' in f.profile.presentation, false);
});

test('a colour-only change publishes without a 预演 and records no preview', (t) => {
  const f = fixture(t),
    saved = colourDraft(f);
  const result = f.service.publish(f.auth, 'wei-guagua', colourPublish(f, saved));
  assert.equal(result.version, 2);
  assert.equal(result.previewId, null);
  assert.equal(
    publishedWebCharacters(f.store).find((c) => c.characterId === 'wei-guagua')!.presentation.color,
    '#3366CC',
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_character_publications')!.n, 0);
  assert.ok(
    f.store.get(
      `SELECT 1 FROM web_admin_audit WHERE action='character-published:2:colour-only' AND target_id='wei-guagua'`,
    ),
  );
  // Clearing the colour later is a colour-only change as well, and the others' bytes never moved.
  const back = structuredClone(f.service.detail(f.auth, 'wei-guagua').published!.profile);
  delete back.presentation.color;
  back.template.version = 3;
  const cleared = f.service.save(f.auth, 'wei-guagua', { expectedRevision: null, profile: back });
  assert.equal(
    f.service.publish(f.auth, 'wei-guagua', { ...colourPublish(f, cleared), requestId: 'colour-2' }).version,
    3,
  );
});

test('every other change still requires its 预演, with or without a colour', (t) => {
  const f = fixture(t);
  const refuse = (saved: { revision: number; contentHash: string }, extra: object = {}) =>
    assert.throws(
      () => f.service.publish(f.auth, 'wei-guagua', { ...colourPublish(f, saved), ...extra }),
      /VALID_PREVIEW_REQUIRED/,
    );
  // the colour plus a persona edit, a display-name edit, a welcome edit, a voice edit
  const edits: Array<(p: typeof f.profile) => void> = [
    (p) => void (p.template.persona += '新的资料'),
    (p) => void (p.presentation.displayName = '新的显示名'),
    (p) => void (p.presentation.publicDescription = '新的简介'),
    (p) => void (p.presentation.welcome.version = 'welcome-v9'),
    (p) => void (p.template.voice = { profileId: 'other', version: 1, speed: 1 }),
  ];
  for (const edit of edits) {
    const saved = colourDraft(f, edit);
    refuse(saved);
    f.service.discard(f.auth, 'wei-guagua', saved.revision);
  }
  // no colour change at all, nothing else either
  const same = structuredClone(f.profile);
  const saved = f.service.save(f.auth, 'wei-guagua', { expectedRevision: null, profile: same });
  refuse(saved);
  f.service.discard(f.auth, 'wei-guagua', saved.revision);
  // a colour-only draft that names a material is not the shortcut either
  const only = colourDraft(f);
  refuse(only, { materialId: 'm1' });
  assert.equal(f.service.detail(f.auth, 'wei-guagua').published!.version, 1);
});

test('the admin routes let castSource through on both 预演 starts and let a colour-only publish omit previewId', async () => {
  const { routeWebAccountAdmin } = await import('../../../apps/server/admin/web-account-admin-routes.ts');
  const seen: Record<string, unknown> = {};
  const characters = {
    startPreview: (_a: unknown, _id: string, body: unknown) => (seen.single = body),
    startRun: (_a: unknown, _id: string, body: unknown) => (seen.run = body),
    publish: (_a: unknown, _id: string, body: unknown) => (seen.publish = body),
  };
  const admin = { authorize: () => ({}) };
  const call = (path: string, body: Record<string, unknown>) =>
    routeWebAccountAdmin(
      admin as never,
      {
        method: 'POST',
        path: `/api/web/local/admin/characters/jojo/${path}`,
        body,
        adminCookie: 'c',
        csrf: 'x',
        origin: 'o',
      } as never,
      characters as never,
    );
  const draft = { requestId: 'r', draftRevision: 1, profileHash: 'a'.repeat(64), relationship: 'new' };
  for (const castSource of ['none', 'published', 'draft']) {
    await call('review-start', { ...draft, message: 'hi', castSource });
    assert.equal((seen.single as { castSource: string }).castSource, castSource);
    await call('run-start', { ...draft, inputs: [], castSource });
    assert.equal((seen.run as { castSource: string }).castSource, castSource);
  }
  await call('publish', { requestId: 'r', draftRevision: 1, profileHash: 'a'.repeat(64), acknowledgeReview: true });
  assert.equal('previewId' in (seen.publish as object), false);
  await assert.rejects(
    () =>
      call('publish', {
        requestId: 'r',
        draftRevision: 1,
        profileHash: 'a'.repeat(64),
        acknowledgeReview: true,
        extra: 1,
      }),
    /INVALID_REQUEST/,
  );
});
