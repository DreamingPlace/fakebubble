import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { VoiceModelBinding } from '../../../packages/contracts/audio.ts';
import { CAST_LIMITS } from '../../../packages/contracts/web-cast.ts';
import { WRITER_CHOICES } from '../../../packages/contracts/web-writer.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import { installWebAdminActions, WebSecurityCounters } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebCastAdmin } from '../../../apps/server/admin/web-cast-admin.ts';
import { WebSystemAdmin } from '../../../apps/server/admin/web-system-admin.ts';
import { castDigest, latestPublication, readDraft } from '../../../apps/server/cast/cast-store.ts';
import { canonicalCastJson, freshCastId, normalizeCastDoc } from '../../../apps/server/cast/cast-validation.ts';
import { compileFullView } from '../../../apps/server/cast/cast-compile.ts';
import { selectCastView } from '../../../apps/server/cast/cast-select.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import {
  framePinsMatch,
  freezeWebV7Request,
  readWebV7Request,
} from '../../../apps/server/generation/web-v7-request.ts';
import { installWriterSetting, readWriter, writeWriter } from '../../../apps/server/generation/web-writer-setting.ts';
import { writerDraftMessages, writerPins } from '../../../apps/server/generation/writer-v8.ts';
import { WebCloudTextGenerator } from '../../../apps/server/cloudflare/web-generators.ts';
import { installCastDocs } from '../../../apps/server/cast/cast-doc-store.ts';
import {
  installMemeStore,
  listMemes,
  readMemesOff,
  setMemesEnabled,
} from '../../../apps/server/memes/web-meme-store.ts';
import { MEME_ENTRIES } from '../../../apps/server/memes/meme-dictionary.ts';
import { writeMemeUse } from '../../../packages/contracts/web-memes.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';
import { FREEZE_NOW, schema128, seedFreezeScenario } from '../fixtures/cast-freeze.ts';
import { cjkRaw } from '../fixtures/cast-big.ts';
import { counterIds, sampleCastRaw } from '../fixtures/cast-sample.ts';
import { tiersFixture } from '../fixtures/invite-tiers.ts';
import { migrateWebProviderCast } from '../../../apps/server/generation/web-provider-migration.ts';

registerSqlTextLoader();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const origin = 'https://fixture.invalid';

// ---- the writer setting: step three, four choices ---------------------------------------------------------------------------------

const STEP_ONE = `CREATE TABLE web_writer_setting(id INTEGER PRIMARY KEY CHECK(id=1),writer TEXT NOT NULL CHECK(writer IN ('v7','v8')),
    changed_by TEXT NOT NULL,changed_at INTEGER NOT NULL) STRICT`;
const STEP_TWO = `CREATE TABLE web_writer_setting(id INTEGER PRIMARY KEY CHECK(id=1),writer TEXT NOT NULL CHECK(writer IN ('v7','v8','v8p')),
    changed_by TEXT NOT NULL,changed_at INTEGER NOT NULL) STRICT`;
/** Recorded by Parts 37a and 37b (taken from main before this Part): steps one and two stay byte for byte. */
const DIGEST_ONE = '04292d5abb2a3b907a9e48fff5e367af6e1d63c8592cbe0c1abffc41e2e255ff';
const fresh = (t: TestContext) => {
  const store = schema128();
  t.after(() => store.close());
  seedFreezeScenario(store, 'character', 's2.1-pro' as VoiceModelBinding);
  return store;
};
const markerTwo = (store: ReturnType<typeof fresh>) => {
  store.run(
    'CREATE TABLE web_writer_schema(version INTEGER PRIMARY KEY CHECK(version IN (1,2)),sha256 TEXT NOT NULL) STRICT',
  );
  store.run('INSERT INTO web_writer_schema VALUES (1,?),(2,?)', DIGEST_ONE, sha([STEP_TWO].join(';\n')));
};

test('steps one and two stay byte for byte (the first two digests of the schema table, forever)', () => {
  assert.equal(sha([STEP_ONE].join(';\n')), DIGEST_ONE);
});

test('an authority on step one takes steps two AND three; on step two takes step three; the value survives; 新+档案+梗 becomes writable', (t) => {
  const one = fresh(t);
  one.run(STEP_ONE);
  one.run('CREATE TABLE web_writer_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT');
  one.run('INSERT INTO web_writer_schema VALUES (1,?)', DIGEST_ONE);
  writeWriter(one, FREEZE_NOW, 'owner', 'v8');
  installWriterSetting(one);
  assert.equal(readWriter(one), 'v8');
  assert.deepEqual(
    one.all<{ version: number }>('SELECT version FROM web_writer_schema ORDER BY version').map((r) => r.version),
    [1, 2, 3],
  );
  writeWriter(one, FREEZE_NOW, 'owner', 'v8m');
  assert.equal(readWriter(one), 'v8m');

  const two = fresh(t);
  two.run(STEP_TWO);
  markerTwo(two);
  writeWriter(two, FREEZE_NOW, 'owner', 'v8p');
  assert.throws(() => writeWriter(two, FREEZE_NOW, 'owner', 'v8m'), /CHECK|constraint/i);
  installWriterSetting(two);
  assert.equal(readWriter(two), 'v8p', 'the choice survives the rebuild');
  writeWriter(two, FREEZE_NOW, 'owner', 'v8m');
  assert.equal(readWriter(two), 'v8m');
  // idempotent, no leftovers, and a changed digest stops the start with the same STOP code as before
  installWriterSetting(two);
  installWriterSetting(two);
  assert.equal(
    two.get<{ n: number }>(
      "SELECT COUNT(*) n FROM sqlite_master WHERE name GLOB 'web_writer_*_prev' OR name GLOB 'web_writer_*_v1'",
    )!.n,
    0,
  );
  two.run('UPDATE web_writer_schema SET sha256=? WHERE version=3', 'f'.repeat(64));
  assert.throws(() => installWriterSetting(two), { code: 'WEB_WRITER_SCHEMA_MISMATCH' });

  const foreign = fresh(t);
  foreign.run('CREATE TABLE web_writer_other(x INTEGER)');
  assert.throws(() => installWriterSetting(foreign), { code: 'WEB_WRITER_SCHEMA_MISMATCH' });
  const wrong = fresh(t);
  wrong.run(STEP_TWO);
  wrong.run(
    'CREATE TABLE web_writer_schema(version INTEGER PRIMARY KEY CHECK(version IN (1,2)),sha256 TEXT NOT NULL) STRICT',
  );
  wrong.run('INSERT INTO web_writer_schema VALUES (1,?),(2,?)', DIGEST_ONE, 'a'.repeat(64));
  assert.throws(() => installWriterSetting(wrong), { code: 'WEB_WRITER_SCHEMA_MISMATCH' });
});

test('the switch across all four choices: each stored and read back; a fifth is not a choice', (t) => {
  const store = fresh(t);
  installWriterSetting(store);
  assert.equal(readWriter(store), 'v7');
  assert.deepEqual([...WRITER_CHOICES], ['v7', 'v8', 'v8p', 'v8m']);
  for (const choice of ['v8', 'v8p', 'v8m', 'v7', 'v8m', 'v8p', 'v8'] as const) {
    writeWriter(store, FREEZE_NOW, 'owner', choice);
    assert.equal(readWriter(store), choice);
  }
  assert.throws(() => store.run("UPDATE web_writer_setting SET writer='v9'"), /CHECK|constraint/i);
});

test('the owner flips all four; staff cannot; one audit row each; a replay changes nothing', (t) => {
  const f = tiersFixture(t);
  installWebAdminActions(f.store);
  const live = { now: () => f.clock() };
  const admin = new WebSystemAdmin(f.store, live, f.accounts, {
    security: new WebSecurityCounters(f.store, live),
    emailKey: Buffer.alloc(32, 7),
  });
  assert.deepEqual(admin.writerRead(f.owner, {}), { writer: 'v7', available: true }, 'the default is unchanged');
  const staff = f.member(['points.grant', 'system.read', 'models.manage', 'invites.manage']);
  assert.throws(() => admin.writerSave(staff, { requestId: 'writer-x-1', writer: 'v8m' }), /ADMIN_OWNER_REQUIRED/);
  assert.equal(readWriter(f.store), 'v7');
  for (const [i, writer] of (['v8', 'v8p', 'v8m', 'v7'] as const).entries()) {
    const saved = admin.writerSave(f.owner, { requestId: `switch-${i}`, writer });
    assert.deepEqual({ ...saved }, { writer, available: true, duplicate: false });
    assert.equal(readWriter(f.store), writer);
  }
  assert.equal(admin.writerSave(f.owner, { requestId: 'switch-2', writer: 'v8m' }).duplicate, true);
  assert.equal(readWriter(f.store), 'v7');
  assert.deepEqual(
    f.store
      .all<{ target_id: string }>("SELECT target_id FROM web_admin_audit WHERE action='writer-set' ORDER BY seq")
      .map((r) => r.target_id),
    ['v7>v8', 'v8>v8p', 'v8p>v8m', 'v8m>v7'],
  );
});

// ---- the live request -------------------------------------------------------------------------------------------------------------

const frozenOf = (store: ReturnType<typeof fresh>) => {
  freezeInputSnapshot(store as unknown as WebStore, 'operation', FREEZE_NOW);
  freezeWebV7Request(store as unknown as WebStore, 'operation', FREEZE_NOW);
  return readWebV7Request(store as unknown as WebStore, 'operation');
};
const withChoice = (
  t: TestContext,
  choice: 'v7' | 'v8' | 'v8p' | 'v8m',
  body = '今天想聊什么？',
  settings?: object,
) => {
  const store = fresh(t);
  installWriterSetting(store);
  installMemeStore(store);
  writeWriter(store, FREEZE_NOW, 'owner', choice);
  store.run("UPDATE messages SET body=? WHERE id='input'", body);
  if (settings) {
    const template = JSON.parse(
      store.get<{ config_json: string }>("SELECT config_json FROM character_templates WHERE id='character'")!
        .config_json,
    );
    store.run(
      "UPDATE character_templates SET config_json=? WHERE id='character'",
      JSON.stringify(writeMemeUse(template, settings as never)),
    );
  }
  return store;
};

test('the live request per choice: 旧, 新 and 新+档案 gain no meme key and keep their pins; 新+档案+梗 adds the flag, the hits and ITS pins', (t) => {
  const body = '这个松弛感也太绝了，嘴替';
  const v7 = frozenOf(withChoice(t, 'v7', body));
  const v8 = frozenOf(withChoice(t, 'v8', body));
  const profile = frozenOf(withChoice(t, 'v8p', body));
  const memes = frozenOf(withChoice(t, 'v8m', body, { level: 'use', overrides: { 嘴替: 'avoid' } }));
  for (const { request } of [v7, v8, profile]) {
    assert.ok(!('writerMemes' in request) && !('memeHits' in request));
    assert.ok(!JSON.stringify(request).includes('memeLevel'));
  }
  assert.equal(memes.request.writer, 'v8');
  assert.equal(memes.request.writerProfile, true);
  assert.equal(memes.request.writerMemes, true);
  assert.deepEqual(
    memes.request.memeHits?.map((h) => [h.term, h.level]),
    [
      ['松弛感', 'use'],
      ['嘴替', 'avoid'],
    ],
  );
  assert.ok(
    !JSON.stringify(memes.request.character).includes('memeLevel'),
    "the character's own settings never reach a prompt",
  );
  assert.ok(!JSON.stringify(memes.request.character).includes('memeOverrides'));
  assert.deepEqual(
    { protocolDigest: memes.row.protocol_digest, promptDigest: memes.row.prompt_digest },
    writerPins(true, true),
  );
  assert.deepEqual(
    { protocolDigest: profile.row.protocol_digest, promptDigest: profile.row.prompt_digest },
    writerPins(true),
  );
  assert.deepEqual({ protocolDigest: v8.row.protocol_digest, promptDigest: v8.row.prompt_digest }, writerPins());
  assert.equal(framePinsMatch(memes.row, profile.request), false);
  assert.equal(framePinsMatch(profile.row, memes.request), false);
  assert.equal(framePinsMatch(memes.row, memes.request), true);
  // the policy hash: 新+档案+梗 has its own, the others are what they were
  const generator = new DeepSeekTextGenerator({ apiKey: 'offline-only', fetch: async () => new Response('{}') });
  assert.equal(generator.policyHashFor(memes.request), generator.writerMemesPolicyHash);
  assert.equal(generator.policyHashFor(profile.request), generator.writerProfilePolicyHash);
  assert.equal(generator.policyHashFor(v8.request), generator.writerPolicyHash);
  assert.equal(generator.policyHashFor(v7.request), generator.policyHash);
  assert.equal(new WebCloudTextGenerator({} as never).writerMemesPolicyHash, generator.writerMemesPolicyHash);
  // the prompt: the matched meanings come after everything else, with the character's level
  const text = writerDraftMessages(memes.request, 'deepseek')[0]!.content;
  assert.ok(text.indexOf('网络梗（') > text.indexOf('作者设定（JSON）'));
  assert.match(text, /「松弛感」：.*（会用：/);
  assert.match(text, /「嘴替」：.*（不碰：/);
});

test('a reply where nothing matched, and one whose entry the administrator switched off, say nothing about memes', (t) => {
  const none = frozenOf(withChoice(t, 'v8m', '在吗，今天吃什么'));
  assert.equal(none.request.writerMemes, true);
  assert.ok(!('memeHits' in none.request));
  assert.ok(!writerDraftMessages(none.request, 'deepseek')[0]!.content.includes('网络梗'));
  const off = withChoice(t, 'v8m', '这个松弛感也太绝了');
  setMemesEnabled(off, FREEZE_NOW, ['松弛感'], false);
  const got = frozenOf(off);
  assert.ok(!('memeHits' in got.request));
});

test('the frozen request is immutable: a switch flipped after the freeze changes nothing already frozen', (t) => {
  const store = withChoice(t, 'v8m', '这个松弛感也太绝了');
  const before = frozenOf(store);
  setMemesEnabled(store, FREEZE_NOW + 1, ['松弛感'], false);
  const after = readWebV7Request(store as unknown as WebStore, 'operation');
  assert.deepEqual(
    after.request.memeHits?.map((h) => h.term),
    ['松弛感'],
  );
  assert.equal(after.row.request_digest, before.row.request_digest);
});

const castScenario = (t: TestContext, choice: 'v8p' | 'v8m', body: string) => {
  const f = castFixture(t);
  seedFreezeScenario(f.store, 'c01');
  installWriterSetting(f.store);
  installMemeStore(f.store);
  f.publish(cjkRaw(40));
  Object.assign(f.store, { castContext: true });
  f.store.run("UPDATE messages SET body=? WHERE id='input'", body);
  writeWriter(f.store, FREEZE_NOW, 'owner', choice);
  return { f, frozen: frozenOf(f.store as never) };
};

test('live cast context: with CAST_CONTEXT_ENABLED the request carries the SELECTED view of the frozen publication, never the whole library', (t) => {
  const body = '你们最近怎么样';
  const { f, frozen: picked } = castScenario(t, 'v8m', body);
  const { frozen: plain } = castScenario(t, 'v8p', body);
  assert.ok(plain.request.cast && picked.request.cast);
  const published = latestPublication(f.store)!;
  assert.equal(picked.request.cast.version, published.version, 'the publication the snapshot froze');
  const expected = selectCastView(compileFullView(published.doc, 'c01'), [body]);
  assert.deepEqual(picked.request.cast.view, expected);
  assert.equal(picked.request.cast.digest, castDigest(JSON.stringify(expected)));
  const items =
    JSON.stringify(picked.request.cast.view.stories).length + JSON.stringify(picked.request.cast.view.memes).length;
  assert.ok(items <= 4_200, `items ${items} chars`);
  // the 24a view of 新+档案 is what it was: capped by compile, not selected
  assert.ok(JSON.stringify(plain.request.cast.view).length <= CAST_LIMITS.viewMax);
});

// ---- the full-size cast file ------------------------------------------------------------------------------------------------------

function castFixture(t: TestContext) {
  const store = schema128();
  migrateWebProviderCast(store);
  t.after(() => store.close());
  let n = 0;
  const clock = { now: () => FREEZE_NOW };
  for (let i = 1; i <= 15; i++)
    store.run(
      'INSERT OR IGNORE INTO character_templates(id,version,config_json) VALUES (?,?,?)',
      `c${String(i).padStart(2, '0')}`,
      1,
      '{}',
    );
  installCastDocs(store);
  const accounts = new WebAccountAdmin(store, clock, origin);
  installWebAdminActions(store);
  const owner = accounts.login(accounts.issueLoginGrant().token, origin);
  const auth = { cookie: owner.cookie, csrf: owner.csrf, origin };
  const cast = new WebCastAdmin(store, clock, accounts);
  const request = () => `big-request-${String(++n).padStart(6, '0')}`;
  return {
    store,
    cast,
    auth,
    accounts,
    owner,
    request,
    publish(raw: unknown) {
      const draft = cast.draft(auth, {});
      const saved = cast.save(auth, { requestId: request(), expectedRevision: draft.revision, doc: raw });
      return { saved, published: cast.publish(auth, { requestId: request(), expectedRevision: saved.revision }) };
    },
  };
}

/** The largest number of full stories the limits accept for this shape (bisected), with ids as the server makes them. */
const largest = (memes: number, groups: number) => {
  const fits = (n: number) => {
    try {
      normalizeCastDoc(cjkRaw(n, memes, groups), { known: new Set(), fresh: freshCastId });
      return true;
    } catch {
      return false;
    }
  };
  let low = 0,
    high = 600;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  assert.equal(fits(low + 1), false);
  return low;
};

test('a full-size cast (every 汉字 field at its maximum, 300 inside jokes, 600 groups) saves, publishes and reads back from its own row', (t) => {
  const f = castFixture(t);
  const low = largest(300, 600);
  assert.ok(low >= 100 && low < 600, `the size cap, not the story cap, ends it: ${low} full stories`);
  const { saved, published } = f.publish(cjkRaw(low));
  const draft = readDraft(f.store);
  const json = canonicalCastJson(draft.doc);
  const bytes = Buffer.byteLength(json);
  console.log(
    `full cast: ${low} full stories + 300 inside jokes + 600 groups = ${json.length} characters, ${bytes} UTF-8 bytes`,
  );
  assert.ok(json.length > 300_000, 'over the 300,000 characters migration 129 allows in a row');
  assert.ok(bytes <= CAST_LIMITS.docBytesMax && bytes > 1_500_000, `bytes ${bytes}`);
  assert.ok(json.length <= CAST_LIMITS.docMax);
  assert.equal(draft.digest, castDigest(json));
  // the draft row holds a short pointer; the document is ONE row of web_cast_docs, under the Durable Object value limit byte for byte
  const row = f.store.get<{ doc_json: string }>('SELECT doc_json FROM web_cast_draft')!.doc_json;
  assert.ok(row.startsWith('{"largeDoc":') && row.length < 200, row);
  const stored = f.store.get<{ n: number }>('SELECT length(CAST(doc_json AS BLOB)) n FROM web_cast_docs')!.n;
  assert.equal(stored, bytes);
  assert.ok(stored < 2 * 1024 * 1024);
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_cast_docs')!.n,
    1,
    'the draft and the publication share one row',
  );
  const latest = latestPublication(f.store)!;
  assert.equal(latest.version, published.version);
  assert.ok(canonicalCastJson(latest.doc) === json, 'the publication reads back byte for byte');
  assert.equal(latest.digest, castDigest(json));
  assert.equal(saved.counts.stories, low);
  assert.equal(saved.counts.memes, 300);
  assert.equal(saved.counts.groups, 600);
  // it reads back through the admin routes, and compiles
  assert.equal(f.cast.draft(f.auth, {}).doc.stories.length, low);
  assert.ok(f.cast.compilePreview(f.auth, { characterId: 'c01', source: 'published' }).size <= CAST_LIMITS.viewMax);
  assert.equal(f.cast.versions(f.auth, {}).versions.length, 1);
  // a change saves a new draft; the old row stays (a publication points at it); a smaller document is stored inline again
  const next = f.cast.save(f.auth, {
    requestId: f.request(),
    expectedRevision: draft.revision,
    doc: { ...draft.doc, world: { background: '改了一下' } },
  });
  assert.ok(next.revision > draft.revision);
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_cast_docs')!.n,
    2,
    'the published document is kept',
  );
  f.cast.save(f.auth, { requestId: f.request(), expectedRevision: next.revision, doc: sampleCastRaw() });
  assert.ok(
    !f.store.get<{ doc_json: string }>('SELECT doc_json FROM web_cast_draft')!.doc_json.startsWith('{"largeDoc"'),
  );
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_cast_docs')!.n,
    1,
    'the draft is small again: only the published one is kept',
  );
  // a pointer whose row was changed or removed is refused on read (CAST_STORED_DOC_INVALID), never read as another document
  f.store.run('DELETE FROM web_cast_docs');
  assert.throws(() => latestPublication(f.store), /CAST_STORED_DOC_INVALID/);
});

test('the worst case a cast can store: full 汉字 stories only, to the limit; it stays under the byte cap and the 2 MiB value limit', (t) => {
  const f = castFixture(t);
  const low = largest(0, 0);
  const doc = normalizeCastDoc(cjkRaw(low, 0, 0), { known: new Set(), fresh: freshCastId });
  const json = canonicalCastJson(doc);
  const bytes = Buffer.byteLength(json);
  console.log(
    `worst case: ${low} full stories = ${json.length} characters, ${bytes} UTF-8 bytes (cap ${CAST_LIMITS.docBytesMax}; 2 MiB = 2,097,152)`,
  );
  assert.ok(json.length <= CAST_LIMITS.docMax && bytes <= CAST_LIMITS.docBytesMax && bytes > 1_700_000);
  f.publish(cjkRaw(low, 0, 0));
  // (the server gives every entry a fresh random id, so compare what was stored with itself, never with the document above)
  const stored = canonicalCastJson(readDraft(f.store).doc);
  assert.ok(canonicalCastJson(latestPublication(f.store)!.doc) === stored, 'the publication reads back byte for byte');
  assert.equal(
    f.store.get<{ n: number }>('SELECT length(CAST(doc_json AS BLOB)) n FROM web_cast_docs')!.n,
    Buffer.byteLength(stored),
  );
  assert.ok(Buffer.byteLength(stored) <= CAST_LIMITS.docBytesMax);
});

test('a cast over the byte cap is refused whole, and the draft is untouched', (t) => {
  const f = castFixture(t);
  const before = f.cast.draft(f.auth, {});
  assert.throws(
    () => f.cast.save(f.auth, { requestId: f.request(), expectedRevision: before.revision, doc: cjkRaw(400) }),
    /CAST_INVALID|INVALID/,
  );
  assert.equal(f.cast.draft(f.auth, {}).revision, before.revision);
  assert.equal(readDraft(f.store).digest, before.digest);
});

// ---- the dictionary's switches ------------------------------------------------------------------------------------------------------

test('the meme tables are a digest-checked runtime step: idempotent, a foreign table or a changed digest stops the start', (t) => {
  const store = fresh(t);
  installMemeStore(store);
  installMemeStore(store);
  assert.equal(readMemesOff(store).size, 72, 'every entry is on until it is switched off, but the 72 common words');
  const other = fresh(t);
  other.run('CREATE TABLE web_meme_other(x INTEGER)');
  assert.throws(() => installMemeStore(other), { code: 'WEB_MEME_SCHEMA_MISMATCH' });
  store.run('UPDATE web_meme_schema SET sha256=?', 'f'.repeat(64));
  assert.throws(() => installMemeStore(store), { code: 'WEB_MEME_SCHEMA_MISMATCH' });
  // a database without the table has nothing off (a read never fails there)
  const bare = fresh(t);
  assert.equal(readMemesOff(bare).size, 72, 'without the table the defaults still hold');
});

test('网络梗 admin: list (search, year, tag, state), switch one and many, counts, permissions, audit without a term, idempotent', async (t) => {
  const f = castFixture(t);
  installMemeStore(f.store);
  let n = 100;
  const staff = (permissions: string[]) => {
    const grant = f.accounts.issueMember(f.owner.cookie, f.owner.csrf, origin, {
      requestId: `issue-staff-${String(++n).padStart(6, '0')}`,
      label: 'S',
      memberId: null,
      permissions,
    });
    const login = f.accounts.login(grant.token, origin);
    return { cookie: login.cookie, csrf: login.csrf, origin };
  };
  const list = (over: object = {}, auth = f.auth) =>
    f.cast.memesList(auth, { query: '', year: null, tag: null, state: 'all', page: 1, ...over });
  const all = list();
  assert.equal(all.total, 1806);
  assert.equal(all.on, 1806 - 72, 'the 72 common words ship switched off');
  assert.equal(all.defaultOff, 72);
  assert.equal(all.entries.length, 50);
  assert.equal(all.pages, Math.ceil(1806 / 50));
  assert.ok(all.years.includes(2023) && all.years.every((y) => y >= 2022));
  assert.ok(all.tags.length > 0 && all.tags.length <= 40);
  // filters
  assert.ok(list({ query: '松弛感' }).entries.some((e) => e.term === '松弛感'));
  assert.equal(list({ query: '松弛感' }).entries[0]!.term, '松弛感', 'the exact term comes first');
  assert.ok(list({ year: 2023 }).matching < 1806 && list({ year: 2023 }).entries.every((e) => e.year === 2023));
  const tag = all.tags[0]!.tag;
  assert.ok(list({ tag }).entries.every((e) => e.tags.includes(tag)));
  assert.equal(list({ query: 'zzzzzz-nothing' }).matching, 0);
  assert.equal(list({ page: 9999 }).page, all.pages, 'a page past the end is the last page');
  // permissions: reading needs cast.read, switching needs cast.edit
  const reader = staff(['cast.read']);
  assert.equal(list({}, reader).total, 1806);
  assert.throws(
    () => f.cast.memesSet(reader, { requestId: 'meme-r-1', keys: ['松弛感'], enabled: false }),
    /ADMIN_PERMISSION_REQUIRED/,
  );
  assert.throws(() => list({}, staff(['points.grant'])), /ADMIN_PERMISSION_REQUIRED/);
  // switch one, then many; counts follow; unknown keys are refused
  assert.deepEqual(
    { ...f.cast.memesSet(f.auth, { requestId: 'meme-s-1', keys: ['松弛感'], enabled: false }) },
    { changed: 1, duplicate: false },
  );
  assert.equal(list().on, 1733);
  assert.equal(list({ state: 'off' }).matching, 73);
  assert.equal(list({ state: 'default-off' }).matching, 72);
  assert.ok(list({ state: 'default-off' }).entries.every((e) => e.defaultOff && !e.enabled));
  assert.equal(f.cast.memesSet(f.auth, { requestId: 'meme-s-1', keys: ['松弛感'], enabled: false }).duplicate, true);
  assert.throws(
    () => f.cast.memesSet(f.auth, { requestId: 'meme-s-1', keys: ['松弛感'], enabled: true }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const page = all.entries.map((e) => e.key);
  const pageOn = all.entries.filter((e) => e.enabled && e.term !== '松弛感').length;
  assert.equal(f.cast.memesSet(f.auth, { requestId: 'meme-s-2', keys: page, enabled: false }).changed, pageOn);
  assert.equal(list().on, 1733 - pageOn);
  // both ways: a default-off entry switched on is ON, and switched off again drops back to the default (no row left)
  const common = list({ state: 'default-off' }).entries[0]!;
  assert.equal(list({ query: common.term }).entries[0]!.enabled, false);
  f.cast.memesSet(f.auth, { requestId: 'meme-s-3', keys: [common.key], enabled: true });
  assert.equal(list({ query: common.term }).entries[0]!.enabled, true);
  assert.equal(f.store.get<{ n: number }>('SELECT COUNT(*) n FROM web_meme_switch WHERE enabled=1')!.n, 1);
  f.cast.memesSet(f.auth, { requestId: 'meme-s-6', keys: [common.key], enabled: false });
  assert.equal(
    f.store.get<{ n: number }>('SELECT COUNT(*) n FROM web_meme_switch WHERE entry_key=?', common.key)!.n,
    0,
  );
  // the page switched back on: everything but the default-off ones is on again
  f.cast.memesSet(f.auth, { requestId: 'meme-s-7', keys: [...page, '松弛感'], enabled: true });
  assert.equal(list().on, 1734 + page.filter((k) => all.entries.find((e) => e.key === k)!.defaultOff).length);
  assert.throws(
    () => f.cast.memesSet(f.auth, { requestId: 'meme-s-4', keys: ['不在词库里的词'], enabled: false }),
    /MEME_NOT_FOUND/,
  );
  assert.throws(() => f.cast.memesSet(f.auth, { requestId: 'meme-s-5', keys: [], enabled: false }), /INVALID_REQUEST/);
  assert.throws(
    () => f.cast.memesList(f.auth, { query: '', year: null, tag: null, state: 'all', page: 0 }),
    /INVALID_REQUEST/,
  );
  assert.throws(
    () => f.cast.memesList(f.auth, { query: '', year: null, tag: null, state: 'all', page: 1, extra: 1 }),
    /INVALID_REQUEST/,
  );
  // the audit says what happened in counts, never a term
  const audit = f.store
    .all<{ target_id: string }>("SELECT target_id FROM web_admin_audit WHERE action='memes-set' ORDER BY seq")
    .map((r) => r.target_id);
  assert.equal(audit.length, 5);
  assert.ok(
    audit.every((line) => /^enabled=[01];changed=\d+;asked=\d+$/.test(line)),
    audit.join(' | '),
  );
  assert.ok(!audit.join('').includes('松弛感'));
  // and the routes exist (the list is a read-only route)
  const routed = await routeWebAccountAdmin(
    f.accounts,
    {
      method: 'POST',
      path: '/api/web/local/admin/cast/memes-list',
      body: { query: '', year: null, tag: null, state: 'on', page: 1 },
      adminCookie: f.owner.cookie,
      csrf: f.owner.csrf,
      origin,
    } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    f.cast,
  );
  assert.equal((routed?.body as { on: number }).on, 1734 + 0 * 1806);
  assert.ok(MEME_ENTRIES.length === 1806);
  void sampleCastRaw;
});

test('default-off: a common word never matches until switched on; switching works both ways; the live request and a rehearsal respect it', async (t) => {
  const store = withChoice(t, 'v8m', '这个优化也太离谱了，还有松弛感');
  // 优化 is a common word (shipped default OFF); 松弛感 is a meme
  assert.deepEqual(
    frozenOf(store).request.memeHits?.map((h) => h.term),
    ['松弛感'],
  );
  const on = withChoice(t, 'v8m', '这个优化也太离谱了，还有松弛感');
  setMemesEnabled(on, FREEZE_NOW, ['优化'], true);
  assert.deepEqual(
    frozenOf(on)
      .request.memeHits?.map((h) => h.term)
      .sort(),
    ['优化', '松弛感'],
  );
  // both ways: any entry off, a default-off entry on, back to the default
  setMemesEnabled(on, FREEZE_NOW, ['松弛感'], false);
  assert.ok(readMemesOff(on).has('松弛感') && !readMemesOff(on).has('优化'));
  setMemesEnabled(on, FREEZE_NOW, ['优化'], false);
  assert.ok(readMemesOff(on).has('优化'));
  assert.equal(on.get<{ n: number }>("SELECT COUNT(*) n FROM web_meme_switch WHERE entry_key='优化'")!.n, 0);
});
