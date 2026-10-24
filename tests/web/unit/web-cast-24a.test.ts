import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CAST_LIMITS, type CastDoc } from '../../../packages/contracts/web-cast.ts';
import {
  CAST_DROP_ORDER,
  castKnowledge,
  compileCastView,
  compileCastViewDetailed,
  minimalViewSize,
} from '../../../apps/server/cast/cast-compile.ts';
import {
  canonicalCastJson,
  castEntryIds,
  emptyCastDoc,
  normalizeCastDoc,
  validateCastDoc,
  type CastCharacterLookup,
} from '../../../apps/server/cast/cast-validation.ts';
import {
  CAST_CONTEXT_PROMPT,
  CAST_REVIEW_PROMPT,
  castPromptHash,
} from '../../../apps/server/generation/cast-prompt.ts';
import { promptMessages, reviewPromptMessages } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { PROMPTS_CAST } from '../../../apps/server/generation/cast-prompts.generated.ts';
import { renderCastPromptsModule } from '../../../scripts/build-prompts.ts';
import { textRequest } from '../../text-fixtures.ts';
import { counterIds, maxCastRaw, normalize, sampleCast, sampleCastRaw, sampleId } from '../fixtures/cast-sample.ts';

const present: CastCharacterLookup = { exists: () => true, deleted: () => false };
const codes = (doc: CastDoc, mode: 'draft' | 'publish' = 'draft', lookup = present) => {
  const { errors, warnings } = validateCastDoc(doc, mode, lookup);
  return { errors: errors.map((e) => e.code), warnings: warnings.map((w) => w.code) };
};
const clone = <T>(value: T): T => structuredClone(value);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const refused = (work: () => unknown, code = 'CAST_INVALID') =>
  assert.throws(work, (error: Error & { code?: string }) => error.code === code);

test('the empty document is exactly what migration 129 inserts as the draft', () => {
  const sql = readFileSync(new URL('../../../apps/server/web-migrations/129_cast.sql', import.meta.url), 'utf8');
  const literal = /VALUES \(1,1,'(\{[^']*\})',0\)/.exec(sql)?.[1];
  assert.equal(literal, canonicalCastJson(emptyCastDoc()));
});

test('ids: the server assigns them, keeps the ones it knows and refuses any it did not hand out', () => {
  const first = sampleCast();
  const ids = castEntryIds(first);
  assert.ok(ids.size > 60, 'every editable entry has one');
  assert.equal(new Set([...ids]).size, ids.size);
  // Sending the stored document back keeps every id; it stays byte-identical.
  const again = normalizeCastDoc(JSON.parse(JSON.stringify(first)), { known: ids, fresh: counterIds() });
  assert.equal(canonicalCastJson(again), canonicalCastJson(first));
  // An entry without an id gets a fresh one; one with an invented id is refused.
  const edited = clone(first);
  edited.memes.push({ id: '', key: '新梗', parties: ['c01'], meaning: '', trigger: '', prohibited: '' });
  const next = normalizeCastDoc(edited, { known: ids, fresh: () => 'fresh-1' });
  assert.equal(next.memes.at(-1)!.id, 'fresh-1');
  assert.equal(next.memes[0]!.id, first.memes[0]!.id);
  const forged = clone(first);
  forged.memes[0]!.id = 'invented';
  refused(() => normalizeCastDoc(forged, { known: ids, fresh: counterIds() }));
});

test('a new person can be named new-… and referred to in the same save: the server rewrites every reference', () => {
  const raw = sampleCastRaw();
  const doc = normalize(raw);
  assert.ok(
    doc.people.every((p) => /^e\d+$/.test(p.id)),
    'no new- token survives',
  );
  const mom = doc.people[0]!.id;
  assert.equal(doc.directions.at(-1)!.to, mom);
  assert.ok(doc.ratings.c01 !== undefined && !JSON.stringify(doc).includes('new-'));
  assert.equal(doc.characters[0]!.identity.prototype!.personId, doc.people.find((p) => p.kind === 'prototype')!.id);
  assert.deepEqual(validateCastDoc(doc, 'draft', present), { errors: [], warnings: [] });
});

test('the shape is strict: unknown keys, wrong types, control characters, over-long text and too many entries are refused', () => {
  const bad = (change: (raw: ReturnType<typeof sampleCastRaw>) => void) => {
    const raw = sampleCastRaw();
    change(raw);
    refused(() => normalize(raw));
  };
  bad((r) => ((r as Record<string, unknown>).extra = 1));
  bad((r) => ((r.characters[0] as Record<string, unknown>).secret = 'x'));
  bad((r) => (r.world.background = 'x'.repeat(CAST_LIMITS.worldBackground + 1)));
  bad((r) => (r.characters[0]!.identity.oneLiner = 'a\nb'));
  bad((r) => (r.characters[0]!.profile = 'a\u0000b'));
  bad((r) => (r.characters[0]!.identity.names = []));
  bad((r) => (r.characters[0]!.identity.names = Array.from({ length: CAST_LIMITS.names + 1 }, () => ({ text: 'x' }))));
  bad((r) => (r.characters[0]!.identity.aliases[0]!.attitude = 'loves'));
  bad((r) => (r.stories[0]!.period.start = '2026-13'));
  bad((r) => (r.stories[0]!.overrides = [{ characterId: 'c01', level: 'maybe' as never }]));
  bad((r) => ((r.ratings.c01 as Record<string, unknown>).c02 = '3'));
  bad(
    (r) =>
      (r.people = Array.from({ length: CAST_LIMITS.people + 1 }, (_, i) => ({ ...r.people[0]!, id: `new-x${i}` }))),
  );
  bad((r) => (r.characters = [...r.characters, ...r.characters]));
  refused(() => normalize(null));
  refused(() => normalize({ ...sampleCastRaw(), schema: 2 }));
});

test('the document as a whole is capped at 300,000 characters, and so is a field list at its count', () => {
  const raw = maxCastRaw({ directionTargets: 50, groupStories: 6, stories: 60 });
  assert.ok(JSON.stringify(raw).length > CAST_LIMITS.docMax, 'the unbounded maximum is over the cap');
  refused(() => normalize(raw));
  assert.ok(canonicalCastJson(normalize(maxCastRaw())).length <= CAST_LIMITS.docMax);
});

test('meaning: duplicates, unknown references, self-ratings and values off the 0.5 grid are errors', () => {
  const base = sampleCast();
  assert.deepEqual(codes(base), { errors: [], warnings: [] });
  const with_ = (change: (doc: CastDoc) => void) => {
    const doc = clone(base);
    change(doc);
    return codes(doc).errors;
  };
  assert.deepEqual(
    with_((d) => (d.memes[1]!.id = d.memes[0]!.id)),
    ['CAST_DUPLICATE_ID'],
  );
  assert.ok(with_((d) => (d.characters[1]!.characterId = 'c01')).includes('CAST_DUPLICATE_ID'));
  assert.ok(with_((d) => (d.ratings.c01!.nobody = 3)).includes('CAST_UNKNOWN_CHARACTER'));
  assert.ok(with_((d) => (d.ratings.ghost = { c01: 3 })).includes('CAST_UNKNOWN_CHARACTER'));
  assert.ok(with_((d) => d.stories[0]!.participants.push('ghost')).includes('CAST_UNKNOWN_CHARACTER'));
  assert.ok(with_((d) => d.groups[0]!.members.push('ghost')).includes('CAST_UNKNOWN_CHARACTER'));
  assert.ok(with_((d) => d.memes[0]!.parties.push('ghost')).includes('CAST_UNKNOWN_CHARACTER'));
  assert.ok(
    with_((d) => d.stories[1]!.overrides.push({ id: 'o9', characterId: 'ghost', level: 'heard' })).includes(
      'CAST_UNKNOWN_CHARACTER',
    ),
  );
  assert.ok(with_((d) => (d.directions[0]!.to = 'ghost')).includes('CAST_UNKNOWN_CHARACTER'));
  assert.ok(with_((d) => (d.characters[0]!.identity.prototype!.personId = 'c02')).includes('CAST_UNKNOWN_PERSON'));
  assert.deepEqual(
    with_((d) => (d.ratings.c01!.c01 = 3)),
    ['CAST_SELF_RATING'],
  );
  for (const value of [-0.5, 5.5, 3.25, 0.1, Number.POSITIVE_INFINITY].filter(Number.isFinite))
    assert.deepEqual(
      with_((d) => (d.ratings.c01!.c02 = value)),
      ['CAST_RATING_OUT_OF_GRID'],
      String(value),
    );
  for (const value of [0, 0.5, 3, 4.5, 5])
    assert.deepEqual(
      with_((d) => (d.ratings.c01!.c02 = value)),
      [],
      String(value),
    );
  assert.deepEqual(
    with_((d) => d.directions.push({ ...d.directions[0]!, id: 'dup' })),
    ['CAST_DUPLICATE_DIRECTION'],
  );
  assert.deepEqual(
    with_((d) => (d.directions[0]!.to = d.directions[0]!.from)),
    ['CAST_SELF_RELATION'],
  );
  assert.deepEqual(
    with_((d) =>
      d.stories[0]!.overrides.push(
        { id: 'o8', characterId: 'c01', level: 'heard' },
        { id: 'o9', characterId: 'c01', level: 'lived' },
      ),
    ),
    ['CAST_DUPLICATE_OVERRIDE'],
  );
  assert.deepEqual(
    with_((d) => (d.stories[0]!.period = { start: '2026-05', end: '2026-01' })),
    ['CAST_PERIOD_ORDER'],
  );
});

test('draft saves only warn about characters that are not published (yet); publishing needs every one to exist and not be deleted', () => {
  const doc = sampleCast();
  const lookup = { exists: (id: string) => id !== 'c02', deleted: (id: string) => id === 'c03' };
  assert.deepEqual(codes(doc, 'draft', lookup), {
    errors: [],
    warnings: ['CAST_CHARACTER_MISSING', 'CAST_CHARACTER_DELETED'],
  });
  assert.deepEqual(codes(doc, 'publish', lookup), {
    errors: ['CAST_CHARACTER_MISSING', 'CAST_CHARACTER_DELETED'],
    warnings: [],
  });
  assert.deepEqual(codes(doc, 'publish', present), { errors: [], warnings: [] });
});

test('knowledge rule: participants lived it; a rating of 3 or more toward a participant means heard; everyone else does not know; an override wins', () => {
  const doc = sampleCast();
  const level = (id: string, title: string) => {
    const story = doc.stories.find((s) => s.title === title)!;
    return castKnowledge(doc, id).find((k) => k.storyId === story.id)!;
  };
  assert.deepEqual(level('c01', '雨夜的告白'), { storyId: doc.stories[0]!.id, level: 'lived', fromOverride: false });
  // c05 rates c01 at 3.5: heard, by the rating alone
  assert.deepEqual(level('c05', '雨夜的告白'), { storyId: doc.stories[0]!.id, level: 'heard', fromOverride: false });
  // exactly 3 counts, 2.5 does not
  const edge = clone(doc);
  edge.ratings.c06 = { c01: 3 };
  edge.ratings.c07 = { c01: 2.5 };
  assert.equal(castKnowledge(edge, 'c06')[0]!.level, 'heard');
  assert.equal(castKnowledge(edge, 'c07')[0]!.level, 'unknown');
  // not set is not 0, and neither reaches 3
  assert.equal(castKnowledge(edge, 'c09')[0]!.level, 'unknown');
  // someone who rates a PARTICIPANT high hears; someone rated by the participant does not
  edge.ratings.c01 = { ...edge.ratings.c01, c08: 5 };
  assert.equal(castKnowledge(edge, 'c08')[0]!.level, 'unknown', 'incoming ratings do not count');
  // override: c01 lived the school show without taking part; c07 does not know the photo although he is a participant
  assert.deepEqual(level('c01', '校庆演出'), { storyId: doc.stories[1]!.id, level: 'lived', fromOverride: true });
  assert.deepEqual(level('c07', '旧照片'), { storyId: doc.stories[2]!.id, level: 'unknown', fromOverride: true });
  // an override can also lower or raise to heard
  assert.equal(level('c10', '天台的约定').level, 'heard');
  assert.equal(level('c10', '天台的约定').fromOverride, true);
});

test('the compiled view: own sections in full, cards for the others, outgoing relations only, flagged stories', () => {
  const doc = sampleCast();
  const view = compileCastView(doc, 'c01');
  assert.deepEqual(Object.keys(view), ['world', 'self', 'others', 'relations', 'groups', 'stories', 'memes']);
  assert.deepEqual(Object.keys(view.self), [
    'name',
    'oneLiner',
    'names',
    'aliases',
    'selfConcept',
    'prototype',
    'profile',
    'personality',
    'speech',
    'experiences',
    'performance',
    'hiddenSettings',
  ]);
  assert.equal(view.self.name, '林小满');
  assert.equal(view.self.hiddenSettings.rule, '你知道这些设定，但绝不直接说出口。');
  assert.deepEqual(view.self.hiddenSettings.items, ['林小满其实怕黑，从没告诉过别人。']);
  assert.equal(view.self.prototype!.name, '舞台上的她');
  const json = JSON.stringify(view);
  // other people: a compact card and nothing else
  for (const other of doc.characters.slice(1)) {
    const name = other.identity.names[0]!.text;
    assert.ok(view.others.some((card) => card.name === name));
    assert.ok(!json.includes(other.hidden[0]!.text), 'hidden settings of others never appear');
    assert.ok(!json.includes(other.performance), '演绎说明 of others never appears');
    assert.ok(
      !json.includes(other.speech.samples[0]!.text) ||
        other.speech.samples[0]!.text === doc.characters[0]!.speech.samples[0]!.text,
    );
    assert.ok(!json.includes(other.personality));
  }
  assert.deepEqual(Object.keys(view.others[0]!), ['name', 'names', 'aliases', 'oneLiner']);
  assert.equal(view.others.length, 14 + 6);
  // outgoing ratings, 称呼 and 相处; never what the others think of him
  assert.deepEqual(
    view.relations.find((r) => r.to === '陈阿杰'),
    { to: '陈阿杰', rating: 4, address: '阿杰', treatment: '嘴上互怼，其实最信任他' },
  );
  assert.equal(view.relations.length, 3 + 1, 'three ratings and the direction to the mother');
  assert.ok(!json.includes('嘴硬，会替她出头'), 'the 相处 text of c02 toward c01 is incoming');
  assert.equal(compileCastView(doc, 'c02').relations.find((r) => r.to === '林小满')!.address, '小满');
  // groups with their stories, memes he is party to
  assert.deepEqual(
    view.groups.map((g) => g.name),
    ['文学社'],
  );
  assert.equal(view.groups[0]!.stories[0]!.level, '亲历');
  assert.equal(view.groups[0]!.stories[0]!.details, '封面是苏念画的，错了两个字。');
  assert.deepEqual(
    view.memes.map((m) => m.key),
    ['落汤鸡'],
  );
  // stories: lived or heard only, tagged; the override is marked
  assert.deepEqual(
    view.stories.map((s) => [s.title, s.level, s.fromOverride]),
    [
      ['雨夜的告白', '亲历', false],
      ['校庆演出', '亲历', true],
      ['天台的约定', '亲历', false],
    ],
  );
  assert.equal(view.stories[0]!.narrationBoundary, '只能点到为止，不能复述原话。');
});

test('a story he only heard of is its summary alone; one he does not know is not there at all', () => {
  const doc = sampleCast();
  const view = compileCastView(doc, 'c05');
  const heard = view.stories.find((s) => s.title === '雨夜的告白')!;
  assert.equal(heard.level, '听说');
  assert.equal(heard.fromOverride, false);
  assert.equal(heard.summary, '小满在雨夜向阿杰说出了心里话。');
  assert.equal('details' in heard, false);
  assert.ok(!JSON.stringify(view).includes('公交站台'), 'the details of a heard story never reach him');
  assert.ok(
    !JSON.stringify(compileCastView(doc, 'c07')).includes('旧照片'),
    'an override to 不知道 removes the story and its title',
  );
  assert.ok(!JSON.stringify(compileCastView(doc, 'c09')).includes('雨夜的告白'));
  // group stories: every member lived them, nobody else sees them
  assert.ok(compileCastView(doc, 'c04').groups[0]!.stories[0]!.title === '社刊创刊');
  assert.ok(!JSON.stringify(compileCastView(doc, 'c09')).includes('社刊创刊'));
});

test('compileCastView is pure and deterministic: the same document gives byte-identical output, whatever order keys were built in', () => {
  const doc = sampleCast();
  for (let i = 0; i < 15; i++) {
    const id = sampleId(i);
    assert.equal(JSON.stringify(compileCastView(doc, id)), JSON.stringify(compileCastView(clone(doc), id)));
  }
  // ratings written in another key order normalize to the same document and the same view
  const raw = sampleCastRaw();
  raw.ratings = Object.fromEntries(
    Object.entries(raw.ratings)
      .reverse()
      .map(([k, v]) => [k, Object.fromEntries(Object.entries(v).reverse())]),
  );
  assert.equal(canonicalCastJson(normalize(raw)), canonicalCastJson(doc));
  refused(() => compileCastView(doc, 'nobody') as never, 'CAST_CHARACTER_NOT_IN_CAST');
});

test('size: all 15 characters at the maximum of every field stay under 24,000 characters, and so does the prompt around them', () => {
  const doc = normalize(maxCastRaw());
  assert.ok(canonicalCastJson(doc).length <= CAST_LIMITS.docMax);
  assert.deepEqual(codes(doc, 'publish').errors, [], 'a document at the maximum can be published');
  const base = textRequest();
  // a heavy request around the cast: the longest persona and canon the template check allows, a full short-term history
  const settings = { note: '设'.repeat(40_000) };
  for (const character of doc.characters) {
    const view = compileCastView(doc, character.characterId);
    const size = JSON.stringify(view).length;
    assert.ok(size <= CAST_LIMITS.viewMax, `${character.characterId}: ${size}`);
    assert.ok(minimalViewSize(doc, character.characterId) <= CAST_LIMITS.viewMax);
    const request = {
      ...base,
      character: {
        ...base.character,
        id: base.scope.characterId,
        persona: '人'.repeat(20_000),
        authorCanon: { kind: 'author_canon' as const, settings },
      },
      messages: Array.from({ length: 24 }, (_, i) => ({
        ...base.messages[0]!,
        id: i === 23 ? 'question-1' : `m-${i}`,
        authorKind: i === 23 ? ('player' as const) : ('character' as const),
        authorId: i === 23 ? 'text-player' : base.scope.characterId,
        text: '话'.repeat(1_500),
      })),
    };
    const without = promptMessages(request);
    const withCast = promptMessages({
      ...request,
      cast: { version: 1, digest: sha(JSON.stringify(view)), promptHash: castPromptHash(), view },
    });
    assert.ok(withCast[1]!.content.length < 200_000);
    assert.ok(withCast[1]!.content.length - without[1]!.content.length <= CAST_LIMITS.viewMax + 20);
    const review = reviewPromptMessages(
      { ...request, cast: { version: 1, digest: sha(JSON.stringify(view)), promptHash: castPromptHash(), view } },
      { mode: 'casual', bubbles: [{ text: '好', expression: 'neutral' }], endsSession: false } as never,
    );
    assert.ok(review[1]!.content.length < 210_000);
  }
});

test('over the cap, items are dropped in the documented order and the character’s own sections never are', () => {
  assert.equal(CAST_DROP_ORDER.length, 5);
  const doc = sampleCast();
  const full = compileCastViewDetailed(doc, 'c05');
  const fullSize = JSON.stringify(full.view).length;
  assert.deepEqual(full.dropped, { memes: 0, heardStories: 0, groupStories: 0, livedStories: 0, relationTexts: 0 });
  // 1. memes first
  const noMemes = compileCastViewDetailed(doc, 'c05', fullSize - 1);
  assert.deepEqual(noMemes.dropped, { memes: 1, heardStories: 0, groupStories: 0, livedStories: 0, relationTexts: 0 });
  assert.equal(noMemes.view.memes.length, 0);
  assert.equal(noMemes.view.stories.length, full.view.stories.length);
  // 2. then the OLDEST heard story: 天台的约定 (2025-06) before 雨夜的告白 (2026-04-12)
  const sizeNoMemes = JSON.stringify(noMemes.view).length;
  const oneHeard = compileCastViewDetailed(doc, 'c05', sizeNoMemes - 1);
  assert.deepEqual(oneHeard.dropped, { memes: 1, heardStories: 1, groupStories: 0, livedStories: 0, relationTexts: 0 });
  assert.deepEqual(
    oneHeard.view.stories.map((s) => s.title),
    ['雨夜的告白', '决赛前夜'],
  );
  const twoHeard = compileCastViewDetailed(doc, 'c05', JSON.stringify(oneHeard.view).length - 1);
  assert.deepEqual(
    twoHeard.view.stories.map((s) => s.title),
    ['决赛前夜'],
  );
  // 3. group stories, 4. lived stories, 5. relation texts: each class only starts once every class before it is gone
  const c01 = compileCastViewDetailed(doc, 'c01');
  const total = {
    memes: c01.view.memes.length,
    group: c01.view.groups.reduce((n, g) => n + g.stories.length, 0),
    lived: c01.view.stories.length,
    texts: c01.view.relations.filter((r) => r.address !== undefined || r.treatment !== undefined).length,
  };
  assert.deepEqual(total, { memes: 1, group: 1, lived: 3, texts: 2 });
  let seen = { memes: 0, group: 0, lived: 0, texts: 0 };
  for (let cap = JSON.stringify(c01.view).length; cap >= 0; cap -= 5) {
    const { dropped: d } = compileCastViewDetailed(doc, 'c01', cap);
    assert.equal(d.heardStories, 0, 'c01 heard nothing');
    if (d.groupStories) assert.equal(d.memes, total.memes);
    if (d.livedStories) assert.equal(d.groupStories, total.group);
    if (d.relationTexts) assert.equal(d.livedStories, total.lived);
    seen = {
      memes: Math.max(seen.memes, d.memes),
      group: Math.max(seen.group, d.groupStories),
      lived: Math.max(seen.lived, d.livedStories),
      texts: Math.max(seen.texts, d.relationTexts),
    };
  }
  assert.deepEqual(seen, total, 'with a small enough cap every droppable class is eventually dropped');
  const last = compileCastViewDetailed(doc, 'c01', 1);
  assert.equal(last.view.self.hiddenSettings.items.length, 1, 'the hidden settings are never dropped');
  // never the character's own sections, whatever the cap
  const tiny = compileCastViewDetailed(doc, 'c01', 1);
  assert.deepEqual(tiny.view.self, compileCastView(doc, 'c01').self);
  assert.equal(tiny.view.others.length, 20);
  assert.equal(tiny.view.world.background, doc.world.background);
  assert.deepEqual(tiny.view.memes, []);
  assert.deepEqual(tiny.view.stories, []);
  assert.deepEqual(tiny.view.groups[0]!.stories, []);
  assert.ok(tiny.view.relations.every((r) => r.address === undefined && r.treatment === undefined));
  assert.ok(
    tiny.view.relations.some((r) => r.rating !== undefined),
    'the ratings stay',
  );
});

test('prompt files: the cast prompts are pinned, separate from PROMPTS_V7, and generated from prompts/v7/cast-*.md', () => {
  assert.equal(
    readFileSync(new URL('../../../apps/server/generation/cast-prompts.generated.ts', import.meta.url), 'utf8'),
    renderCastPromptsModule(),
  );
  assert.deepEqual(Object.keys(PROMPTS_CAST), ['castContext', 'castReview']);
  // Part 24a: pinned on purpose. Changing either file changes castPromptHash(), which every request that carries `cast` records.
  assert.equal(sha(CAST_CONTEXT_PROMPT), '469c2ab4337ce20c71b96ecc3d27cea6988d79b108b4d1f08034659c9a694f78');
  assert.equal(sha(CAST_REVIEW_PROMPT), 'b2550c319c3759499f093f96309ef38d386449bb5a378476bccdf937c60e51e2');
  assert.equal(castPromptHash(), '2c48c7e99bf67daa6d834eb12e542d0fadc5a90509e42a00d8145d21428b1ad7');
  for (const marker of ['亲历', '听说', '不知道', 'narrationBoundary', 'hiddenSettings'])
    assert.ok(CAST_CONTEXT_PROMPT.includes(marker), marker);
  for (const marker of ['hiddenSettings', '不知道', 'narrationBoundary'])
    assert.ok(CAST_REVIEW_PROMPT.includes(marker), marker);
});
