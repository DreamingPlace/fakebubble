import assert from 'node:assert/strict';
import test from 'node:test';
import type { FishModel, SpeechRequest } from '../../../packages/contracts/audio.ts';
import { EXPRESSIONS } from '../../../packages/contracts/index.ts';
import { fishSpeechRequest, speechPayload } from '../../../workers/audio/fish.ts';
import { validateVoiceBinding } from '../../../apps/server/characters/voices.ts';
import { validatedTemplate } from '../../../apps/server/characters/template-validation.ts';
import { characterProfileHash } from '../../../apps/server/characters/web-character-catalog.ts';
import { editedCharacter, emptyCharacter } from '../../../apps/player-web/src/features/admin/character-form.ts';
import { contentHash } from '../../../apps/server/characters/admin-content-hash.ts';

// Part 23b: a per-character base direction on the Drama 3 wire. Absent = exactly what main sends.
const DIRECTION = '像平时聊天，不朗诵、不表演。并列短句连贯稍快。';
const request = (over: Partial<SpeechRequest> = {}): SpeechRequest => ({
  jobId: 'job-1',
  text: '我在这儿，慢慢说。',
  expression: 'soft',
  speed: 1,
  voice: { profileId: 'profile-1', referenceId: 'ref-1', version: 1 },
  ...over,
});
const wire = (over: Partial<SpeechRequest>, model: FishModel) => fishSpeechRequest(request({ model, ...over }), model);

test('drama-3: the direction bracket is first, then expression, delivery, sound tag, then the words', () => {
  assert.equal(
    speechPayload(request({ model: 'drama-3', direction: DIRECTION }), 'drama-3').text,
    `[${DIRECTION}] [soft and gentle, unhurried, tender] 我在这儿，慢慢说。`,
  );
  assert.equal(
    speechPayload(
      request({
        model: 'drama-3',
        direction: '语速舒缓',
        expression: 'upbeat',
        deliveryStyle: 'tender_whisper',
        soundCue: 'small_laugh',
      }),
      'drama-3',
    ).text,
    '[语速舒缓] [bright and upbeat, warm, a smile in the voice] [tender, warm, gentle whisper] [small laugh] <whisper>我在这儿，慢慢说。</whisper>',
  );
  // A neutral line with no other brackets: just the direction and the words.
  assert.equal(
    speechPayload(request({ model: 'drama-3', direction: '语速舒缓', expression: 'neutral' }), 'drama-3').text,
    '[语速舒缓] 我在这儿，慢慢说。',
  );
});

test('drama-3: a direction changes the body, the wire hash and the reserved byte count; none changes nothing', () => {
  const plain = wire({}, 'drama-3');
  const directed = wire({ direction: DIRECTION }, 'drama-3');
  assert.notEqual(directed.requestHash, plain.requestHash);
  assert.notEqual(directed.body, plain.body);
  const text = JSON.parse(directed.body).text as string;
  assert.equal(
    directed.bytes,
    Buffer.byteLength(text, 'utf8'),
    'the reservation counts payload.text, direction included',
  );
  assert.equal(directed.bytes - plain.bytes, Buffer.byteLength(`[${DIRECTION}] `, 'utf8'));
  // Without a direction (absent) the request is the same on every build.
  assert.equal(wire({}, 'drama-3').requestHash, plain.requestHash);
});

test('s2.1-pro ignores the direction: body, hash and bytes are those of main for every expression', () => {
  for (const expression of EXPRESSIONS)
    for (const deliveryStyle of ['conversational', 'quiet', 'tender_whisper'] as const) {
      const base = wire({ expression, deliveryStyle }, 's2.1-pro');
      const directed = wire({ expression, deliveryStyle, direction: DIRECTION }, 's2.1-pro');
      assert.deepEqual(directed, base);
    }
  assert.equal(
    speechPayload(request({ direction: DIRECTION }), 's2.1-pro').text.includes(DIRECTION),
    false,
    'omitted model is s2.1-pro too',
  );
});

test('the wire refuses a direction that is not plain text, whatever the model', () => {
  for (const model of ['s2.1-pro', 'drama-3'] as const)
    for (const bad of ['', ' ', ' 前有空格', '[x]', 'a<b', 'a>b', 'a\nb', 'a\rb', 'x'.repeat(41)])
      assert.throws(() => speechPayload(request({ model, direction: bad }), model), /INVALID_VOICE_DIRECTION/, bad);
  assert.doesNotThrow(() => speechPayload(request({ model: 'drama-3', direction: '好'.repeat(40) }), 'drama-3'));
});

const binding = (extra: Record<string, unknown> = {}) => ({ profileId: 'p', version: 1, speed: 1, ...extra });
test('validation: 1-40 characters of plain text; empty, too long, brackets, angle brackets and newlines are refused', () => {
  validateVoiceBinding(binding());
  validateVoiceBinding(binding({ direction: '好' }));
  validateVoiceBinding(binding({ direction: '好'.repeat(40) }));
  validateVoiceBinding(binding({ direction: DIRECTION, messageProbability: 0.5 }));
  for (const bad of [
    '',
    '   ',
    '好'.repeat(41),
    '[好]',
    '好]',
    '[好',
    '<好>',
    '好<',
    '好>',
    '好\n好',
    '好\r',
    '好 好',
    ' 好',
    7,
    null,
  ])
    assert.throws(() => validateVoiceBinding(binding({ direction: bad })), /INVALID_VOICE_BINDING/, String(bad));
  // Unknown keys are still refused.
  assert.throws(() => validateVoiceBinding(binding({ directions: 'x' })), /INVALID_VOICE_PROFILE/);
  // Counted in characters, not bytes or UTF-16 units.
  validateVoiceBinding(binding({ direction: '😀'.repeat(40) }));
  assert.throws(() => validateVoiceBinding(binding({ direction: '😀'.repeat(41) })), /INVALID_VOICE_BINDING/);
});

test('template: a direction rides in template.voice; a template without one validates and hashes as before', () => {
  const plain = { ...emptyCharacter().template, id: 'x', name: 'n', persona: 'p' };
  const voiced = (extra: Record<string, unknown>) => ({ ...plain, voice: binding(extra) });
  assert.equal(validatedTemplate(voiced({ direction: DIRECTION })).voice?.direction, DIRECTION);
  assert.equal('direction' in validatedTemplate(voiced({})).voice!, false);
  assert.throws(() => validatedTemplate(voiced({ direction: '[x]' })), /INVALID_VOICE_BINDING/);
  const base = emptyCharacter();
  base.template.id = 'x';
  base.template.voice = { profileId: 'p', version: 1, speed: 1 };
  const withDirection = structuredClone(base);
  withDirection.template.voice!.direction = DIRECTION;
  assert.notEqual(characterProfileHash(withDirection), characterProfileHash(base), 'versioned with the profile');
  assert.equal(characterProfileHash(base), characterProfileHash(structuredClone(base)));
  assert.equal(
    contentHash(JSON.parse(JSON.stringify(base))),
    contentHash(base),
    'no direction key appears anywhere in a profile that has none',
  );
  assert.equal(JSON.stringify(base).includes('direction'), false);
});

test('editor: sets, clears and leaves the direction alone; an untouched profile is unchanged', () => {
  const values = (voice: Record<string, unknown> | null) => ({
    id: 'x',
    name: 'n',
    birthDate: '',
    persona: 'p',
    displayName: 'd',
    publicDescription: '',
    welcomeText: 'w',
    welcomeVersion: 'welcome-v1',
    canon: '{}',
    voice: voice as never,
  });
  const base = emptyCharacter();
  const bound = editedCharacter(base, values({ profileId: 'p', version: 1, speed: 1 }));
  assert.equal('direction' in bound.template.voice!, false);
  const set = editedCharacter(bound, values({ profileId: 'p', version: 1, speed: 1, direction: DIRECTION }));
  assert.equal(set.template.voice!.direction, DIRECTION);
  const cleared = editedCharacter(set, values({ profileId: 'p', version: 1, speed: 1 }));
  assert.equal('direction' in cleared.template.voice!, false);
  assert.equal(characterProfileHash(cleared), characterProfileHash(bound), 'cleared = never set');
  assert.equal('voice' in editedCharacter(set, values(null)).template, false);
});
