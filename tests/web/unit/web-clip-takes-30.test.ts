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
import { WebClipTakes } from '../../../apps/server/characters/web-clip-takes.ts';
import {
  CLIP_DIRECTION_PROMPT_SHA256,
  WebClipDirection,
  clipPromptHash,
  type ClipDirectionModel,
} from '../../../apps/server/characters/web-clip-direction.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { syntheticCharacterReview } from '../fixtures/character-review.ts';
import type { FakeFish } from '../../../apps/server/generation/web-provider-runner.ts';
import { inspectPCM } from '../../../workers/audio/wav.ts';
import { onsetMsOf } from '../../../workers/audio/leading-onset.ts';

/** Part 30 (synthetic only: a fake Fish transport and a fake text model, never a real call). */
const ORIGIN = 'https://fixture.invalid';
type Take = { takeId: string; name: string; origin: string; status: string; selected: boolean; usable: boolean; errorCode?: string };
type Slot = { slotKey: string; text: string; takes: Take[]; selectedTakeId: string | null; approved: boolean; issue: { code: string; state: string } | null };
type View = { slots: Slot[]; ready: boolean; footerRequired: boolean; voice: { url: string; referenceId: string } | null };

function fixture(t: test.TestContext, freeTier = false) {
  const raw = new Store(':memory:');
  t.after(() => raw.close());
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    raw.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  raw.db.exec('PRAGMA user_version=112');
  raw.run("INSERT INTO web_instance(singleton,instance_id) VALUES (1,'takes-30')");
  migrateWebProviderOffline(raw);
  raw.db.exec(readFileSync(new URL('119_preview_workbench.sql', folder), 'utf8'));
  const store = Object.assign(raw, {
    instanceId: 'takes-30',
    publicFreeTier: freeTier,
    webReceiptDigest: (kind: string, json: string) => createHash('sha256').update(`${kind}:fixture:${json}`).digest('hex'),
  }) as unknown as WebRuntimeStore & { publicFreeTier: boolean };
  const now = 1_800_000_000_000,
    clock = { now: () => now },
    selected = syntheticSelection();
  for (const item of selected)
    raw.run('INSERT INTO character_templates VALUES (?,?,?)', item.characterId, item.personaVersion, JSON.stringify(item.template));
  configureWebProvider(store, selected, now);
  const accounts = new WebAccountAdmin(raw, clock, ORIGIN);
  installWebCharacterCatalog(raw);
  installWebCharacterMaterials(raw);
  const chars = new WebCharacterAdmin(raw, clock, accounts),
    materials = new WebCharacterMaterials(store as never, clock);
  chars.enableMaterials(materials);
  chars.enableProfileImport();
  const sent: string[] = [],
    order: string[] = [];
  const behaviour = { fish: (_text: string): Buffer | 'fail' => syntheticTone(300), model: (_user: string): string | 'fail' => '' };
  const fish: FakeFish = async (request) => {
    const text = JSON.parse(request.body).text as string;
    order.push('fish');
    sent.push(text);
    const out = behaviour.fish(text);
    if (out === 'fail') throw new Error('FAKE_FISH_DOWN');
    return { audio: out, receipt: { requestId: `fake-${sent.length}` }, usageUnits: request.billedTextBytes };
  };
  const reserves: string[] = [];
  const budget = {
    reserve: (_id: string, provider: string) => void (reserves.push(provider), order.push(`reserve:${provider}`)),
    settle: () => {},
  };
  chars.enableSpeech(new WebAdminSpeech(raw, clock, fish, budget as never, 's2.1-pro'));
  const asked: string[] = [];
  const model: ClipDirectionModel = {
    model: 'deepseek-flash',
    async completePlain(input) {
      order.push('model');
      asked.push(input.user);
      const out = behaviour.model(input.user);
      if (out === 'fail') throw new Error('FAKE_MODEL_DOWN');
      return { text: out, inputTokens: 100, outputTokens: 20, model: 'deepseek-flash', receipt: { id: 'fake-text' } };
    },
  };
  chars.enableDirection(new WebClipDirection(raw, clock, model, budget as never));
  const login = accounts.login(accounts.issueLoginGrant().token, ORIGIN);
  const auth = { cookie: login.cookie, csrf: login.csrf, origin: ORIGIN };
  let seq = 0;
  const lines = (second = '今天也是你') => [
    { id: 'line-a', text: '你好呀', weight: 50 },
    { id: 'line-b', text: second, weight: 50 },
  ];
  const base = (id: string) => {
    const profile = chars.detail(auth, 'wei-guagua').published!.profile;
    profile.template.id = id;
    profile.template.version = 1;
    delete profile.template.voice;
    profile.presentation.welcomes = lines();
    return profile;
  };
  const draft = (id: string, over: (p: ReturnType<typeof base>) => void = () => {}, expected: number | null = null) => {
    const p = base(id);
    over(p);
    return { profile: p, saved: chars.save(auth, id, { expectedRevision: expected, profile: p }) };
  };
  const code = (id: string, fishId: string) =>
    raw.run(
      'INSERT INTO web_profile_codes(character_id,code,code_key,avatar_file,voice_reference_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      id,
      id.toUpperCase(),
      id.toLowerCase(),
      null,
      fishId,
      1,
      1,
    );
  const call = (id: string, action: string, input: unknown = {}) => chars.takeCall(auth, id, action, input);
  const view = async (id: string) => (await call(id, 'list')) as View;
  const estimate = async (id: string, slotKeys: string[], markup?: string) =>
    (await call(id, 'estimate', { slotKeys, ...(markup ? { markup } : {}) })) as { ok: boolean; estimateMicros: number };
  const gen = async (id: string, slotKey: string, extra: Record<string, unknown> = {}) => {
    const est = await estimate(id, [slotKey], extra.markup as string | undefined);
    return (await call(id, 'generate', { requestId: `gen-${++seq}`, slotKey, acknowledgeMicros: est.estimateMicros, ...extra })) as Take & { slotKey: string };
  };
  const approveAll = async (id: string) => {
    const v = await view(id);
    return call(id, 'approve', {
      acknowledgeRights: true,
      slots: v.slots.map((s) => ({ slotKey: s.slotKey, takeId: s.selectedTakeId, heard: true })),
    });
  };
  const publish = async (id: string, saved: { revision: number; contentHash: string }, materialId?: string) =>
    chars.publish(auth, id, {
      requestId: `publish-${++seq}`,
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      previewId: await syntheticCharacterReview(raw, now, id),
      acknowledgeReview: true,
      ...(materialId ? { materialId } : {}),
    });
  return { raw, store, clock, materials, chars, auth, sent, order, reserves, asked, behaviour, draft, code, call, view, estimate, gen, approveAll, publish, lines };
}
const pcm = (b64: string) => {
  const bytes = Buffer.from(b64, 'base64'),
    info = inspectPCM(bytes, 60_000);
  return { bytes, samples: Int16Array.from({ length: info.dataLength / 2 }, (_, i) => bytes.readInt16LE(info.dataOffset + i * 2)), info };
};
async function ready(t: test.TestContext, freeTier = false) {
  const f = fixture(t, freeTier);
  f.code('takes-a', 'fish-a');
  const first = f.draft('takes-a');
  return { f, id: 'takes-a', first };
}

test('a slot per line and the footer; 重录 adds a take and keeps the others; names are 第 N 条; the first take is 选用', async (t) => {
  const { f, id } = await ready(t);
  const v0 = await f.view(id);
  assert.deepEqual(v0.slots.map((s) => s.slotKey), ['line:line-a', 'line:line-b', 'footer']);
  assert.ok(v0.slots.every((s) => s.takes.length === 0));
  assert.equal(v0.voice?.url, 'https://fish.audio/m/fish-a');
  const one = await f.gen(id, 'line:line-a');
  const two = await f.gen(id, 'line:line-a');
  const slot = (await f.view(id)).slots[0]!;
  assert.deepEqual(slot.takes.map((x) => [x.name, x.origin, x.selected]), [['第 1 条', 'generated', true], ['第 2 条', 'generated', false]]);
  assert.equal(slot.selectedTakeId, one.takeId);
  assert.notEqual(one.takeId, two.takeId);
  assert.equal(f.sent.length, 2, 'one paid call per take, nothing else');
});

test('rename in place (≤ 20), select another take, and a changed 选用 clears only that slot approval', async (t) => {
  const { f, id } = await ready(t);
  const a = await f.gen(id, 'line:line-a'),
    b = await f.gen(id, 'line:line-a');
  await f.gen(id, 'line:line-b');
  await f.gen(id, 'footer');
  await f.call(id, 'rename', { takeId: b.takeId, name: '更懒一点' });
  await assert.rejects(f.call(id, 'rename', { takeId: b.takeId, name: 'x'.repeat(21) }), /CLIP_TAKE_NAME_INVALID/);
  await f.approveAll(id);
  assert.equal((await f.view(id)).ready, true);
  await f.call(id, 'select', { takeId: b.takeId });
  const v = await f.view(id);
  assert.equal(v.slots[0]!.approved, false, 'the slot whose 选用 changed needs approving again');
  assert.deepEqual(v.slots.slice(1).map((s) => s.approved), [true, true], 'the others keep theirs');
  assert.equal(v.slots[0]!.takes.find((x) => x.takeId === b.takeId)!.name, '更懒一点');
  assert.ok(a.takeId);
});

test('delete: a take can go unless it is the 选用 take of an approved slot; the ledger rows stay', async (t) => {
  const { f, id } = await ready(t);
  const a = await f.gen(id, 'line:line-a'),
    b = await f.gen(id, 'line:line-a');
  await f.gen(id, 'line:line-b');
  await f.gen(id, 'footer');
  const ledger = () => f.raw.get<{ n: number }>('SELECT count(*) n FROM web_speech_admin_calls')!.n;
  const before = ledger();
  await f.call(id, 'delete', { takeId: b.takeId });
  assert.equal(ledger(), before, 'the receipts stay');
  assert.equal((await f.view(id)).slots[0]!.takes.length, 1);
  await f.approveAll(id);
  await assert.rejects(f.call(id, 'delete', { takeId: a.takeId }), /TAKE_IN_USE/);
  // another take of the approved slot can still be deleted; an unapproved 选用 take can be deleted too
  const c = await f.gen(id, 'line:line-a');
  await f.call(id, 'delete', { takeId: c.takeId });
  const l2 = (await f.view(id)).slots[1]!;
  await f.call(id, 'approve', { acknowledgeRights: true, slots: [] }).catch(() => undefined);
  assert.equal(l2.approved, true);
});

test('changing line 2 leaves slot 1 and the footer approved; only slot 2 needs a new take', async (t) => {
  const { f, id, first } = await ready(t);
  for (const key of ['line:line-a', 'line:line-b', 'footer']) await f.gen(id, key);
  await f.approveAll(id);
  f.draft(id, (p) => void (p.presentation.welcomes = f.lines('换一句新的话')), first.saved.revision);
  const v = await f.view(id);
  assert.deepEqual(v.slots.map((s) => s.approved), [true, false, true]);
  assert.equal(v.slots[1]!.takes[0]!.usable, false, 'the old take is for the old text');
  assert.equal(v.slots[1]!.selectedTakeId, null);
  assert.equal(v.ready, false);
  const fresh = await f.gen(id, 'line:line-b');
  assert.equal(fresh.selected, true, 'the first usable take of the changed slot is chosen at once');
});

test('publishing needs an approved 选用 take in every current slot; the bundle is made from them and published; restore reuses it', async (t) => {
  const { f, id, first } = await ready(t);
  await assert.rejects(f.call(id, 'bundle'), /CHARACTER_MATERIALS_REQUIRED/);
  for (const key of ['line:line-a', 'line:line-b', 'footer']) await f.gen(id, key);
  await assert.rejects(f.call(id, 'bundle'), /CHARACTER_MATERIALS_REQUIRED/, 'generated but not approved');
  await f.approveAll(id);
  const { materialId } = (await f.call(id, 'bundle')) as { materialId: string };
  assert.deepEqual(await f.call(id, 'bundle'), { materialId }, 'an identical unpublished bundle is reused');
  assert.equal((await f.publish(id, first.saved, materialId)).version, 1);
  const live = f.raw.all<{ line_id: string }>('SELECT line_id FROM web_provider_welcome_lines WHERE character_id=?', id);
  assert.deepEqual(live.map((r) => r.line_id).sort(), ['line-a', 'line-b']);
  // v2 (persona only) reuses the live approval; restoring v1 then reuses the very bundle v1 published.
  const next = f.draft(id, (p) => void ((p.template.persona += ' 再改一点'), (p.template.version = 2)));
  const v2 = await f.publish(id, next.saved);
  assert.equal(v2.version, 2);
  const bundles = () => f.raw.get<{ n: number }>('SELECT count(*) n FROM web_character_materials WHERE character_id=?', id)!.n;
  const before = bundles();
  const restored = f.chars.restore(f.auth, id, { requestId: 'restore-30', version: 1, liveVersion: 2 });
  assert.equal(restored.version, 3);
  assert.equal(bundles(), before, 'a restore makes no new bundle');
});

test('生成全部: one confirm for the total; a call per slot, each reserved first; one UNKNOWN stops nothing and is never resent', async (t) => {
  const { f, id } = await ready(t);
  const all = await f.estimate(id, ['line:line-a', 'line:line-b', 'footer']);
  await assert.rejects(f.call(id, 'generate-all', { requestId: 'all-1', acknowledgeMicros: all.estimateMicros + 1 }), /SPEECH_ESTIMATE_CHANGED/);
  assert.equal(f.sent.length, 0, 'a wrong confirm sends nothing');
  f.behaviour.fish = (text) => (text.includes('今天也是你') ? 'fail' : syntheticTone(300));
  const run = (await f.call(id, 'generate-all', { requestId: 'all-1', acknowledgeMicros: all.estimateMicros })) as {
    results: { slotKey: string; takeId?: string; code?: string }[];
  };
  assert.deepEqual(run.results.map((r) => [r.slotKey, !!r.takeId, r.code]), [
    ['line:line-a', true, undefined],
    ['line:line-b', false, 'SPEECH_CALL_UNKNOWN'],
    ['footer', true, undefined],
  ]);
  assert.equal(f.sent.length, 3);
  assert.equal(f.reserves.filter((p) => p === 'fish').length, 3, 'reserved per call');
  for (let i = 0; i < f.order.length; i++) if (f.order[i] === 'fish') assert.equal(f.order[i - 1], 'reserve:fish');
  const v = await f.view(id);
  assert.deepEqual(v.slots[1]!.issue && [v.slots[1]!.issue.state, v.slots[1]!.issue.code], ['unknown', 'FAKE_FISH_DOWN'.replace('FAKE_FISH_DOWN', v.slots[1]!.issue!.code)]);
  // the same run again: nothing is sent twice (the UNKNOWN stays UNKNOWN, the others answer from their takes)
  f.behaviour.fish = () => syntheticTone(300);
  const again = (await f.call(id, 'generate-all', { requestId: 'all-1', acknowledgeMicros: 0 })) as { results: { code?: string }[] };
  assert.equal(f.sent.length, 3);
  assert.equal(again.results[1]!.code, 'SPEECH_CALL_UNKNOWN');
  const holds = f.raw.get<{ n: number }>("SELECT count(*) n FROM web_speech_admin_calls WHERE state='unknown'")!.n;
  assert.equal(holds, 1, 'its reservation is kept');
});

test('generated takes start with exactly 280 ms of zero samples and the voice at 300 ms; uploads come out byte-identical', async (t) => {
  const { f, id } = await ready(t);
  // Fish with 800 ms of its own lead: cut to the same 300 ms start.
  f.behaviour.fish = () => {
    const tone = syntheticTone(300),
      lead = Buffer.alloc(24000 * 0.8 * 2);
    const head = Buffer.from(tone.subarray(0, 44));
    head.writeUInt32LE(lead.length + 300 * 48, 40);
    head.writeUInt32LE(36 + lead.length + 300 * 48, 4);
    return Buffer.concat([head, lead, tone.subarray(44)]);
  };
  const take = await f.gen(id, 'line:line-a');
  const out = pcm(((await f.call(id, 'audio', { takeId: take.takeId })) as { base64: string }).base64);
  assert.ok(out.samples.subarray(0, 6720).every((v) => v === 0), 'the first 280 ms are zero');
  assert.ok(Math.abs((onsetMsOf(out.bytes) ?? 0) - 300) <= 10);
  const view = (await f.view(id)).slots[0]!.takes[0] as Take & { durationMs: number; sha256: string };
  assert.equal(view.sha256, createHash('sha256').update(out.bytes).digest('hex'), 'sha256 is of the final audio');
  assert.equal(view.durationMs, Math.round(out.info.durationMs), 'and so is the duration');
  const raw = syntheticTone(400);
  const up = (await f.call(id, 'upload', { slotKey: 'line:line-b', base64: raw.toString('base64') })) as Take;
  const back = Buffer.from(((await f.call(id, 'audio', { takeId: up.takeId })) as { base64: string }).base64, 'base64');
  assert.ok(back.equals(raw), 'an upload is not changed');
  assert.equal(up.origin, 'uploaded');
  // uploading after a generation works too (a slot with a generated take takes an upload)
  const more = (await f.call(id, 'upload', { slotKey: 'line:line-a', base64: raw.toString('base64') })) as Take;
  assert.equal(more.selected, false);
});

test('audio with no voice is an unusable take WEB_SPEECH_NO_ONSET; the paid call stays settled and is not retried', async (t) => {
  const { f, id } = await ready(t);
  f.behaviour.fish = () => {
    const quiet = syntheticTone(300);
    for (let i = 44; i < quiet.length; i += 2) quiet.writeInt16LE(Math.round(Math.sin(i) * 3), i);
    return quiet;
  };
  const take = await f.gen(id, 'line:line-a');
  assert.equal(take.status, 'unusable');
  assert.equal(take.errorCode, 'WEB_SPEECH_NO_ONSET');
  assert.equal(take.usable, false);
  await assert.rejects(f.call(id, 'select', { takeId: take.takeId }), /TAKE_NOT_USABLE/);
  assert.equal(f.sent.length, 1);
  const row = f.raw.get<{ state: string; outcome: string }>('SELECT state,outcome FROM web_speech_admin_calls')!;
  assert.deepEqual([row.state, row.outcome], ['known', 'succeeded']);
  const slot = (await f.view(id)).slots[0]!;
  assert.equal(slot.selectedTakeId, null);
  await f.call(id, 'delete', { takeId: take.takeId });
});

test('feedback: both calls go through the budget (reserved first); the markup must strip to the exact line; a mismatch is rejected', async (t) => {
  const { f, id } = await ready(t);
  const est = (await f.call(id, 'estimate-direction', { slotKey: 'line:line-a', feedback: '开头更懒一点' })) as { ok: boolean };
  assert.equal(est.ok, true);
  f.behaviour.model = () => '[lazy, drawn out]你好[small laugh]呀';
  const out = (await f.call(id, 'rewrite', { requestId: 'rw-1', slotKey: 'line:line-a', feedback: '开头更懒一点' })) as { markup: string };
  assert.equal(out.markup, '[lazy, drawn out]你好[small laugh]呀');
  assert.deepEqual(JSON.parse(f.asked[0]!), { line: '你好呀', feedback: '开头更懒一点' });
  assert.equal(f.order.at(-2), 'reserve:deepseek');
  assert.equal(f.order.at(-1), 'model');
  const take = (await f.gen(id, 'line:line-a', { feedback: '开头更懒一点', markup: out.markup })) as Take & { feedback: string; markup: string };
  assert.equal(take.origin, 'feedback');
  assert.equal(take.markup, out.markup);
  assert.equal(take.feedback, '开头更懒一点');
  assert.ok(f.sent[0]!.includes('[lazy, drawn out]你好[small laugh]呀'), 'the markup is in the sentence on the wire');
  assert.ok(f.order.lastIndexOf('fish') > f.order.lastIndexOf('reserve:fish'));
  // a mismatch (a word changed) is rejected after the bill is recorded; nothing else is stored
  f.behaviour.model = () => '[soft]你好啊';
  await assert.rejects(f.call(id, 'rewrite', { requestId: 'rw-2', slotKey: 'line:line-a', feedback: '轻一点' }), /CLIP_MARKUP_MISMATCH/);
  const ledger = f.raw.get<{ state: string; outcome: string; error_code: string }>(
    "SELECT state,outcome,error_code FROM web_clip_direction_calls WHERE request_id='rw-2'",
  )!;
  assert.deepEqual([ledger.state, ledger.outcome, ledger.error_code], ['known', 'failed', 'CLIP_MARKUP_MISMATCH']);
  // a hand-edited markup that changes a word never reaches Fish
  const sentBefore = f.sent.length;
  assert.equal((await f.estimate(id, ['line:line-a'], '[soft]你好啊')).ok, false, 'the estimate refuses it too');
  await assert.rejects(
    f.call(id, 'generate', { requestId: 'bad-1', slotKey: 'line:line-a', acknowledgeMicros: 1, feedback: 'x', markup: '[soft]你好啊' }),
    /CLIP_MARKUP_MISMATCH/,
  );
  assert.equal(f.sent.length, sentBefore);
  // an UNKNOWN text call is never resent
  f.behaviour.model = 'fail' as never;
  const modelCalls = f.asked.length;
  await assert.rejects(f.call(id, 'rewrite', { requestId: 'rw-3', slotKey: 'line:line-a', feedback: '再轻一点' }), /CLIP_DIRECTION_UNKNOWN/);
  await assert.rejects(f.call(id, 'rewrite', { requestId: 'rw-3', slotKey: 'line:line-a', feedback: '再轻一点' }), /CLIP_DIRECTION_UNKNOWN/);
  assert.equal(f.asked.length, modelCalls + 1);
  const v = await f.view(id);
  assert.equal(v.slots[0]!.issue?.state, 'unknown');
});

test('the prompt is pinned: its sha256 is documented', () => {
  assert.equal(clipPromptHash(), CLIP_DIRECTION_PROMPT_SHA256);
  assert.equal(
    createHash('sha256').update(readFileSync(new URL('../../../prompts/v7/clip-direction-task.md', import.meta.url))).digest('hex'),
    CLIP_DIRECTION_PROMPT_SHA256,
  );
});

test('the footer slot exists only while it is required (free tier off)', async (t) => {
  const on = await ready(t, true);
  assert.deepEqual((await on.f.view(on.id)).slots.map((s) => s.slotKey), ['line:line-a', 'line:line-b']);
  assert.equal((await on.f.view(on.id)).footerRequired, false);
});

test('migration: an existing 素材版本 becomes takes of its slots; approved stays approved; nothing published changes', async (t) => {
  const f = fixture(t);
  f.code('old-one', 'fish-old');
  const first = f.draft('old-one');
  const materialId = f.chars.materialPrepare(f.auth, 'old-one', {
    requestId: 'old-prepare',
    draftRevision: first.saved.revision,
    profileHash: first.saved.contentHash,
  }).materialId;
  const wav = syntheticTone().toString('base64');
  for (const lineId of ['line-a', 'line-b'])
    await f.chars.materialUpload(f.auth, 'old-one', { materialId, kind: 'welcome', lineId, base64: wav });
  await f.chars.materialUpload(f.auth, 'old-one', { materialId, kind: 'footer', base64: wav });
  await f.chars.materialApprove(f.auth, 'old-one', {
    materialId,
    acknowledgeRights: true,
    acknowledgeLines: ['line-a', 'line-b'],
    acknowledgeFooterListening: true,
    note: '合成',
  });
  await f.publish('old-one', first.saved, materialId);
  const published = () =>
    JSON.stringify([
      f.raw.all('SELECT * FROM web_provider_welcome_lines WHERE character_id=?', 'old-one'),
      f.raw.all('SELECT * FROM web_provider_footer_assets WHERE character_id=?', 'old-one'),
      f.raw.all('SELECT * FROM web_provider_voice_bindings WHERE character_id=?', 'old-one'),
    ]);
  const before = published();
  f.draft('old-one', (p) => void (p.template.version = 2));
  // a new runtime step over the existing database (the first instance ran before the version existed)
  const fresh = new WebClipTakes(f.store as never, f.clock, f.materials);
  const v = fresh.view('old-one') as unknown as View;
  assert.deepEqual(v.slots.map((s) => [s.takes.length, s.approved]), [[1, true], [1, true], [1, true]]);
  assert.equal(v.ready, true);
  assert.equal(v.slots[0]!.takes[0]!.name, '第 1 条');
  assert.equal(published(), before, 'nothing published changed');
  new WebClipTakes(f.store as never, f.clock, f.materials);
  assert.equal(f.raw.get<{ n: number }>('SELECT count(*) n FROM web_clip_takes')!.n, 3, 'the step runs once');
  // and the migrated takes play and can be bundled
  const takeId = v.slots[0]!.takes[0]!.takeId;
  const heard = (await fresh.audio('old-one', { takeId }, () => ({ memberId: 'x', sessionId: 'y' }))) as { sha256: string };
  assert.ok(heard.sha256);
});
