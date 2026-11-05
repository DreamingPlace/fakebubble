import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import test from 'node:test';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebCastAdmin } from '../../../apps/server/admin/web-cast-admin.ts';
import { castDigest, latestPublication, readDraft } from '../../../apps/server/cast/cast-store.ts';
import { migrateWebProviderCast } from '../../../apps/server/generation/web-provider-migration.ts';
import { FREEZE_NOW, schema128 } from '../fixtures/cast-freeze.ts';
import { sampleCast, sampleCastRaw } from '../fixtures/cast-sample.ts';

const origin = 'https://fixture.invalid';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fixture(t: TestContext) {
  const store = schema128();
  migrateWebProviderCast(store);
  t.after(() => store.close());
  let ids = 0;
  const clock = { now: () => FREEZE_NOW };
  for (let i = 1; i <= 15; i++)
    store.run(
      'INSERT OR IGNORE INTO character_templates(id,version,config_json) VALUES (?,?,?)',
      `c${String(i).padStart(2, '0')}`,
      1,
      '{}',
    );
  const accounts = new WebAccountAdmin(store, clock, origin);
  installWebAdminActions(store);
  const owner = accounts.login(accounts.issueLoginGrant().token, origin);
  const auth = { cookie: owner.cookie, csrf: owner.csrf, origin };
  const cast = new WebCastAdmin(store, clock, accounts);
  return { store, cast, auth, request: () => `cast-24i-${String(++ids).padStart(6, '0')}` };
}

/** What migration 129 era code wrote: schema 1, `address` a string, aliases without a kind. Key order as the old normalizer built it. */
function schema1Json() {
  const doc = clone(sampleCast()) as unknown as Record<string, any>;
  doc.schema = 1;
  for (const c of doc.characters)
    c.identity.aliases = c.identity.aliases.map(({ id, text, attitude }: any) => ({ id, text, attitude }));
  doc.directions = doc.directions.map((d: any, i: number) => ({
    id: d.id,
    from: d.from,
    to: d.to,
    address: i === 0 ? '小羊 / XX老师、XXX' : (d.addresses[0]?.text ?? ''),
    treatment: d.treatment,
  }));
  return JSON.stringify(doc);
}

test('a stored schema-1 draft and publication read, compile and roll back unchanged; nothing stored is rewritten by a read', (t) => {
  const f = fixture(t);
  const json = schema1Json();
  const old = JSON.parse(json) as Record<string, any>;
  f.store.run('UPDATE web_cast_draft SET doc_json=? WHERE singleton=1', json);
  f.store.run(
    "INSERT INTO web_cast_publications(version,doc_json,digest,published_at,kind,from_version) VALUES (1,?,?,?,'publish',NULL)",
    json,
    castDigest(json),
    FREEZE_NOW,
  );
  const stored = () =>
    f.store.get<{ doc_json: string }>('SELECT doc_json FROM web_cast_draft WHERE singleton=1')!.doc_json;
  const storedPublication = () =>
    f.store.get<{ doc_json: string; digest: string }>(
      'SELECT doc_json,digest FROM web_cast_publications WHERE version=1',
    )!;

  // read: upgraded in memory
  const draft = readDraft(f.store);
  assert.equal(draft.doc.schema, 2);
  const first = draft.doc.directions[0]!;
  assert.deepEqual(
    first.addresses.map((a) => a.text),
    ['小羊 / XX老师、XXX'],
    'ONE item, the "/" is not a separator',
  );
  assert.equal(first.id, old.directions[0].id);
  assert.ok(
    draft.doc.characters.every((c) =>
      c.identity.aliases.every(
        (a, i) =>
          a.kind === 'other' &&
          a.attitude === old.characters[draft.doc.characters.indexOf(c)].identity.aliases[i].attitude,
      ),
    ),
  );
  assert.equal(draft.digest, castDigest(json), 'the digest is the stored bytes');
  assert.equal(stored(), json, 'a read never rewrites the draft');
  // the same read twice: same ids
  assert.deepEqual(readDraft(f.store).doc, draft.doc);
  // the publication compiles (compile-preview of the stored version) with the string as ONE address
  const preview = f.cast.compilePreview(f.auth, { characterId: first.from, source: 'published', version: 1 }) as any;
  const relation = preview.view.relations.find((r: any) => r.addresses?.length);
  assert.deepEqual(relation.addresses, ['小羊 / XX老师、XXX']);
  const publication = latestPublication(f.store)!;
  assert.equal(publication.doc.schema, 2);
  assert.equal(storedPublication().doc_json, json, 'the stored publication is byte for byte what it was');

  // rollback: a NEW version carrying the same content, written as schema 2; version 1 itself is untouched
  const rolled = f.cast.rollback(f.auth, { requestId: f.request(), version: 1 });
  assert.equal(rolled.kind, 'rollback');
  const second = latestPublication(f.store)!;
  assert.equal(second.version, 2);
  assert.deepEqual(second.doc, publication.doc, 'rolls back unchanged');
  assert.equal(
    JSON.parse(
      f.store.get<{ doc_json: string }>('SELECT doc_json FROM web_cast_publications WHERE version=2')!.doc_json,
    ).schema,
    2,
  );
  assert.equal(storedPublication().doc_json, json);
  assert.equal(storedPublication().digest, castDigest(json));

  // the next save writes schema 2 (and a client that still sends schema 1 is converted, not refused)
  const saved = f.cast.save(f.auth, { requestId: f.request(), expectedRevision: draft.revision, doc: draft.doc });
  assert.equal(JSON.parse(stored()).schema, 2);
  assert.deepEqual(
    readDraft(f.store).doc.directions[0]!.addresses.map((a) => a.text),
    ['小羊 / XX老师、XXX'],
  );
  const legacyClient = f.cast.save(f.auth, { requestId: f.request(), expectedRevision: saved.revision, doc: old });
  assert.ok(legacyClient.revision > saved.revision);
});

test('save → export → import: three addresses and four alias kinds survive the whole path on the real store', (t) => {
  const f = fixture(t);
  const raw = clone(sampleCastRaw()) as any;
  raw.directions[0].addresses = ['小羊', 'XX老师', 'XXX'].map((text) => ({ text }));
  raw.characters[0].identity.aliases = [
    { text: 'Mary Jane', kind: 'other', attitude: 'likes' },
    { text: '本姑娘', kind: 'self', attitude: 'ok' },
    { text: '路人甲', kind: 'neutral', attitude: 'ok' },
    { text: '怂包', kind: 'insult', attitude: 'dislikes' },
  ];
  const draft = f.cast.draft(f.auth, {});
  const saved = f.cast.save(f.auth, { requestId: f.request(), expectedRevision: draft.revision, doc: raw });
  const exported = f.cast.exportFile(f.auth, {}).file as any;
  assert.equal(exported.schema, 2);
  assert.deepEqual(
    exported.directions[0].addresses.map((a: any) => a.text),
    ['小羊', 'XX老师', 'XXX'],
  );
  const preview = f.cast.importPreview(f.auth, { file: exported }) as any;
  assert.equal(preview.importable, true, JSON.stringify(preview.problems));
  assert.equal(preview.summary.unchanged, true);
  const before = readDraft(f.store);
  const result = f.cast.importFile(f.auth, {
    requestId: f.request(),
    expectedRevision: saved.revision,
    file: exported,
  }) as any;
  assert.equal(result.unchanged, true);
  const after = readDraft(f.store);
  assert.equal(after.revision, before.revision, 'importing the same file again changes nothing');
  assert.deepEqual(after.doc, before.doc);
  assert.deepEqual(
    after.doc.characters[0]!.identity.aliases.map((a) => [a.text, a.kind, a.attitude]),
    [
      ['Mary Jane', 'other', 'likes'],
      ['本姑娘', 'self', 'ok'],
      ['路人甲', 'neutral', 'ok'],
      ['怂包', 'insult', 'dislikes'],
    ],
  );
  // a 17-unit item is refused by save, with the located path
  const bad = clone(exported);
  bad.characters[0].identity.aliases[3].text = '字'.repeat(17);
  assert.throws(
    () =>
      f.cast.save(f.auth, {
        requestId: f.request(),
        expectedRevision: after.revision,
        doc: (({ format, version, ...doc }) => doc)(bad),
      }),
    (error: any) =>
      error.code === 'CAST_INVALID' &&
      error.detail.issues[0].code === 'CAST_ITEM_TOO_LONG' &&
      error.detail.issues[0].path === 'doc.characters[0].identity.aliases[3].text',
  );
});
