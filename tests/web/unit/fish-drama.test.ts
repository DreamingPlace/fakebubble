import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_SITE_VOICE_MODEL,
  PINNED_S21_BINDING,
  isFishModel,
  isVoiceModelBinding,
  resolveVoiceModel,
  type FishModel,
  type SpeechRequest,
} from '../../../packages/contracts/audio.ts';
import { EXPRESSIONS, SOUND_CUES } from '../../../packages/contracts/index.ts';
import { siteVoiceModelFromEnv } from '../../../config/web-voice-model.ts';
import { FishAudio, fishSpeechRequest, speechPayload } from '../../../workers/audio/fish.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { PROVIDER_PRICES } from '../../../apps/server/generation/web-provider-configuration.ts';
import { parseTextDraft } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { textRequest } from '../../text-fixtures.ts';

// The s2.1-pro half of this fixture was generated from the code on main (Part 17f, cf4d2d6) before Drama 3 existed:
// the s2.1 wire format must stay byte-for-byte what the approved voices use.
const snapshots = JSON.parse(
  readFileSync(new URL('../fixtures/fish-payload-snapshots.json', import.meta.url), 'utf8'),
) as Record<FishModel, Record<string, unknown>>;
const SPEECH_DELIVERY_STYLES = ['conversational', 'quiet', 'tender_whisper'] as const;
const request = (over: Partial<SpeechRequest> = {}): SpeechRequest => ({
  jobId: 'job-1',
  text: '我在这儿，慢慢说。',
  expression: 'neutral',
  speed: 1,
  voice: { profileId: 'profile-1', referenceId: 'ref-1', version: 1 },
  ...over,
});
const textOf = (over: Partial<SpeechRequest>, model: FishModel) =>
  speechPayload(request({ model, ...over }), model).text;

for (const model of ['s2.1-pro', 'drama-3'] as const)
  test(`${model}: payload snapshot for every expression x delivery style (with and without quality guard)`, () => {
    assert.equal(Object.keys(snapshots[model]).length, EXPRESSIONS.length * SPEECH_DELIVERY_STYLES.length * 2);
    for (const expression of EXPRESSIONS)
      for (const deliveryStyle of SPEECH_DELIVERY_STYLES)
        for (const qualityGuard of [false, true])
          assert.deepEqual(
            speechPayload(
              request({ expression, deliveryStyle, model, ...(qualityGuard ? { qualityGuard } : {}) }),
              model,
            ),
            snapshots[model][`${expression}/${deliveryStyle}/${qualityGuard ? 'qg' : 'plain'}`],
            `${expression}/${deliveryStyle}/${qualityGuard}`,
          );
  });

test('an omitted model is s2.1-pro, and soundCue never changes an s2.1 payload', () => {
  assert.deepEqual(speechPayload(request({ expression: 'soft' })), snapshots['s2.1-pro']['soft/conversational/plain']);
  for (const soundCue of SOUND_CUES)
    assert.deepEqual(
      speechPayload(request({ expression: 'soft', soundCue, model: 's2.1-pro' })),
      snapshots['s2.1-pro']['soft/conversational/plain'],
    );
});

test('Drama 3 renders the documented forms only: bracket directions, listed sound tags, <whisper> for tender_whisper', () => {
  assert.equal(
    textOf({ expression: 'neutral', deliveryStyle: 'tender_whisper' }, 'drama-3'),
    '[tender, warm, gentle whisper] <whisper>我在这儿，慢慢说。</whisper>',
  );
  assert.equal(textOf({}, 'drama-3'), '我在这儿，慢慢说。', 'neutral + conversational adds nothing');
  for (const expression of EXPRESSIONS)
    for (const deliveryStyle of SPEECH_DELIVERY_STYLES) {
      const text = textOf({ expression, deliveryStyle }, 'drama-3');
      // No language tags, no phoneme syntax, no speaker tags, and no tag other than the paired whisper.
      assert.equal(/<\|/.test(text) || /<(?!\/?whisper>)/.test(text), false, text);
      assert.equal(/\[(whispering|happy|soft tone)\]/.test(text), false, 's2 cues must not leak into Drama 3');
    }
});

test('soundCue renders as the documented tag between the directions and the words; Drama 3 only', () => {
  assert.equal(
    textOf({ expression: 'soft', soundCue: 'small_laugh' }, 'drama-3'),
    '[soft and gentle, unhurried, tender] [small laugh] 我在这儿，慢慢说。',
  );
  assert.equal(textOf({ soundCue: 'shaky_breath' }, 'drama-3'), '[shaky breath] 我在这儿，慢慢说。');
  assert.equal(
    textOf({ expression: 'sad', deliveryStyle: 'tender_whisper', soundCue: 'shaky_breath' }, 'drama-3'),
    '[sad and subdued, low energy, a heavy heart] [tender, warm, gentle whisper] [shaky breath] <whisper>我在这儿，慢慢说。</whisper>',
  );
  for (const soundCue of ['sigh', '[small laugh]', '', '<whisper>', 'toString'])
    assert.throws(
      () => speechPayload(request({ model: 'drama-3', soundCue: soundCue as never }), 'drama-3'),
      /INVALID_SOUND_CUE/,
    );
});

test('model/player text with brackets or tags is rejected on both models; the cue is only added by the server', () => {
  for (const model of ['s2.1-pro', 'drama-3'] as const)
    for (const text of [
      '[small laugh] 嗯',
      '嗯[sigh]',
      '<whisper>嗯</whisper>',
      '</whisper>',
      '<|speaker:1|>嗯',
      '<|phoneme_start|>x<|phoneme_end|>',
      '<french>bonjour</french>',
      '嗯>',
      '嗯]',
    ])
      assert.throws(
        () => fishSpeechRequest(request({ text, model, soundCue: 'small_laugh' }), model),
        /AUDIO_CONTROL_MARKER_FORBIDDEN/,
        text,
      );
});

test('the request model must match the model it is serialized for', () => {
  assert.throws(() => fishSpeechRequest(request({ model: 's2.1-pro' }), 'drama-3'), /VOICE_MODEL_MISMATCH/);
  assert.throws(() => speechPayload(request({ model: 'drama-3' }), 's2.1-pro'), /VOICE_MODEL_MISMATCH/);
  assert.throws(() => speechPayload(request(), 'drama-3-preview' as never), /VOICE_MODEL_MISMATCH/);
});

test('quality-guard feature is sent on s2 only; the wire hash differs by model', () => {
  const s21 = fishSpeechRequest(request({ qualityGuard: true, model: 's2.1-pro' }), 's2.1-pro');
  const drama = fishSpeechRequest(request({ qualityGuard: true, model: 'drama-3' }), 'drama-3');
  assert.match(s21.body, /quality-guard/);
  assert.doesNotMatch(drama.body, /quality-guard/);
  assert.notEqual(s21.requestHash, drama.requestHash);
});

test('the model header is the verified value "drama-3" and a misspelling cannot be configured', async () => {
  const seen: Record<string, string>[] = [];
  const fetchMock: typeof fetch = async (_url, init) => {
    seen.push(init?.headers as Record<string, string>);
    return new Response(Uint8Array.from(syntheticTone()), { headers: { 'content-type': 'audio/wav' } });
  };
  const audio = new FishAudio({ apiKey: 'key', model: 'drama-3', fetch: fetchMock });
  await audio.generate(request({ model: 'drama-3' }), new AbortController().signal);
  assert.equal(seen[0]!.model, 'drama-3');
  for (const bad of ['drama-3-preview', 'drama', 'Drama-3', '']) {
    assert.throws(() => new FishAudio({ apiKey: 'key', model: bad as never }), /UNSUPPORTED_FISH_MODEL/);
    assert.equal(isFishModel(bad), false);
  }
  await assert.rejects(
    audio.generate(request({ model: 's2.1-pro' }), new AbortController().signal),
    /VOICE_MODEL_MISMATCH/,
  );
});

test('FISH_VOICE_MODEL: unset is s2.1-pro; drama-3 is accepted; anything that Fish would silently ignore is refused', () => {
  assert.equal(DEFAULT_SITE_VOICE_MODEL, 's2.1-pro');
  assert.equal(siteVoiceModelFromEnv(undefined), 's2.1-pro');
  assert.equal(siteVoiceModelFromEnv(''), 's2.1-pro');
  assert.equal(siteVoiceModelFromEnv('s2.1-pro'), 's2.1-pro');
  assert.equal(siteVoiceModelFromEnv('drama-3'), 'drama-3');
  for (const bad of ['drama', 'drama-3-preview', 'DRAMA-3', 's2-pro', 's1', 'pin:s2.1-pro', ' drama-3'])
    assert.throws(() => siteVoiceModelFromEnv(bad), /INVALID_FISH_VOICE_MODEL/, bad);
});

test('per-voice resolution: only unpinned (s2.1-pro) bindings follow the site default', () => {
  const resolve = (binding: string, site: FishModel) => resolveVoiceModel(binding as never, site);
  assert.equal(resolve('s2.1-pro', 's2.1-pro'), 's2.1-pro');
  assert.equal(resolve('s2.1-pro', 'drama-3'), 'drama-3');
  assert.equal(resolve(PINNED_S21_BINDING, 'drama-3'), 's2.1-pro');
  assert.equal(resolve(PINNED_S21_BINDING, 's2.1-pro'), 's2.1-pro');
  assert.equal(resolve('drama-3', 's2.1-pro'), 'drama-3');
  assert.equal(resolve('s2-pro', 'drama-3'), 's2-pro');
  assert.equal(isVoiceModelBinding('drama-3-preview'), false);
  assert.equal(isVoiceModelBinding('pin:drama-3'), false);
});

// Part 21i (named exception): the ledger now reserves 50 micros/byte for drama-3 (Fish bills it per character: USD 10/M until
// 2026-11-12, USD 50/M after; a byte is never fewer than a character), no longer the s2.1 bound of 15. s2.1-pro is unchanged.
test('ledger: drama-3 reserves 50 micros/byte, the post-discount list price per character; s2.1-pro stays 15', () => {
  const fish = PROVIDER_PRICES.filter((price) => price.provider === 'fish');
  const s21 = fish.find((price) => price.model === 's2.1-pro')!;
  const drama = fish.find((price) => price.model === 'drama-3')!;
  assert.equal(s21.upper, 15);
  assert.equal(drama.upper, 50);
  assert.equal(drama.unit, 'byte');
  assert.equal(drama.phase, 'speech');
  // Mixed ASCII (1 byte per character) and Chinese (3): never below 50 per character.
  const text = '[soft and gentle, unhurried] 你好呀 ok';
  assert.ok(Buffer.byteLength(text) * drama.upper >= [...text].length * 50);
});

test('draft: soundCue is optional ("none" = absent), whitelisted, and never part of the displayed text', () => {
  const voice = { ...textRequest(), deliveryMode: 'voice' as const };
  const wire = (utterance: Record<string, unknown>, afterthoughts: unknown[] = []) => ({
    mode: 'casual',
    utterance,
    afterthoughts,
    endsSession: false,
  });
  const ok = (soundCue?: string) => ({ text: '嗯，我在听。', expression: 'soft', ...(soundCue ? { soundCue } : {}) });
  assert.deepEqual(parseTextDraft(wire(ok('none')), voice).bubbles, [{ text: '嗯，我在听。', expression: 'soft' }]);
  assert.deepEqual(parseTextDraft(wire(ok()), voice).bubbles, [{ text: '嗯，我在听。', expression: 'soft' }]);
  assert.deepEqual(parseTextDraft(wire(ok('small_laugh'), [ok('shaky_breath'), ok('none')]), voice).bubbles, [
    { text: '嗯，我在听。', expression: 'soft', soundCue: 'small_laugh' },
    { text: '嗯，我在听。', expression: 'soft', soundCue: 'shaky_breath' },
    { text: '嗯，我在听。', expression: 'soft' },
  ]);
  for (const bad of ['sigh', '[small laugh]', 'Small_Laugh', '', null, 1, ['small_laugh']])
    assert.throws(() => parseTextDraft(wire({ ...ok(), soundCue: bad }), voice), /INVALID_BUBBLES/, String(bad));
  // A cue is a separate field: tags inside the text are still rejected before speech (see the payload tests).
  assert.throws(
    () => fishSpeechRequest(request({ text: '[small laugh] 嗯', model: 'drama-3' }), 'drama-3'),
    /AUDIO_CONTROL_MARKER_FORBIDDEN/,
  );
});
