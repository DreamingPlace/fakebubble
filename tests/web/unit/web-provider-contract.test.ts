import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseWebProviderBootstrap,
  syntheticProviderBootstrap,
  WEB_PROVIDER_CHARACTER_IDS,
} from '../../../packages/contracts/web-provider.ts';

test('provider bootstrap is separately versioned and keeps twelve previews non-sendable', () => {
  const fixture = syntheticProviderBootstrap();
  assert.deepEqual(parseWebProviderBootstrap(fixture), fixture);
  assert.deepEqual(
    fixture.characters.map((item) => item.characterId),
    WEB_PROVIDER_CHARACTER_IDS,
  );
  assert.equal(fixture.slots.filter((item) => item.kind === 'preview').length, 12);
  assert.ok(fixture.characters.every((item) => item.welcome.audio.state === 'unavailable'));
  assert.equal(fixture.access.canSend, false);
});

test('version two admits a dynamic bounded roster, never dangling slots or conversations', () => {
  const fixture = syntheticProviderBootstrap();
  fixture.characters.push({ ...fixture.characters[0]!, characterId: 'new-character' });
  fixture.slots.splice(3, 1, { kind: 'character', characterId: 'new-character' });
  assert.deepEqual(parseWebProviderBootstrap(fixture), fixture);
  assert.throws(
    () => parseWebProviderBootstrap({ ...fixture, contractVersion: 'web-v1-provider-1' }),
    /PROTOCOL_INVALID/,
  );
  const dangling = structuredClone(fixture);
  dangling.slots[0] = { kind: 'character', characterId: 'not-in-roster' };
  assert.throws(() => parseWebProviderBootstrap(dangling), /PROTOCOL_INVALID/);
  fixture.conversations.push({
    conversationId: 'c',
    characterId: 'not-in-roster',
    lastMessageId: null,
    unreadCount: 0,
  });
  assert.throws(() => parseWebProviderBootstrap(fixture), /PROTOCOL_INVALID/);
  const empty = syntheticProviderBootstrap();
  empty.characters = [];
  empty.slots = Array.from({ length: 15 }, (_, n) => ({ kind: 'preview', slotId: `p-${n}`, label: '敬请期待' }));
  assert.deepEqual(parseWebProviderBootstrap(empty), empty);
  const full = syntheticProviderBootstrap();
  full.characters = Array.from({ length: 16 }, (_, n) => ({ ...full.characters[0]!, characterId: `c-${n}` }));
  assert.throws(() => parseWebProviderBootstrap(full), /PROTOCOL_INVALID/);
});

test('provider cloud metadata is explicit and cannot advertise a fixture as the public runtime', () => {
  const cloud = { ...syntheticProviderBootstrap(), mode: 'provider-cloud', region: 'public', fixture: false };
  assert.deepEqual(parseWebProviderBootstrap(cloud), cloud);
  for (const invalid of [
    { ...cloud, fixture: true },
    { ...cloud, region: 'local-test' },
    { ...cloud, mode: 'provider-local' },
  ])
    assert.throws(() => parseWebProviderBootstrap(invalid), /WEB_PROVIDER_PROTOCOL_INVALID/);
});

test('provider parser rejects local-3, duplicate person, private IDs and pretend media', () => {
  const fixture = syntheticProviderBootstrap();
  assert.throws(
    () => parseWebProviderBootstrap({ ...fixture, contractVersion: 'web-v1-local-3' }),
    /WEB_PROVIDER_PROTOCOL_INVALID/,
  );
  assert.throws(
    () =>
      parseWebProviderBootstrap({
        ...fixture,
        characters: [fixture.characters[0], fixture.characters[0], fixture.characters[2]],
      }),
    /WEB_PROVIDER_PROTOCOL_INVALID/,
  );
  assert.throws(
    () =>
      parseWebProviderBootstrap({
        ...fixture,
        characters: [{ ...fixture.characters[0], referenceId: 'private' }, ...fixture.characters.slice(1)],
      }),
    /WEB_PROVIDER_PROTOCOL_INVALID/,
  );
  assert.throws(
    () =>
      parseWebProviderBootstrap({
        ...fixture,
        characters: [
          {
            ...fixture.characters[0],
            welcome: {
              text: 'fake',
              version: 'v1',
              audio: {
                state: 'available',
                mediaId: 'fake',
                url: '/api/web/provider/public-audio/fake',
                version: 'v1',
                sha256: 'a'.repeat(64),
                durationMs: 100,
              },
            },
          },
          ...fixture.characters.slice(1),
        ],
      }),
    /WEB_PROVIDER_PROTOCOL_INVALID/,
  );
});

test('provider parser validates nested unions and fixture cannot gain send/audio', () => {
  const fixture = syntheticProviderBootstrap();
  const first = fixture.characters[0]!;
  const mutate = (character: unknown) => ({ ...fixture, characters: [character, ...fixture.characters.slice(1)] });
  assert.throws(
    () => parseWebProviderBootstrap(mutate({ ...first, welcome: { ...first.welcome, text: 42 } })),
    /WEB_PROVIDER_PROTOCOL_INVALID/,
  );
  assert.throws(
    () =>
      parseWebProviderBootstrap(
        mutate({
          ...first,
          welcome: { ...first.welcome, audio: { ...first.welcome.audio, referenceId: 'synthetic-private-id' } },
        }),
      ),
    /WEB_PROVIDER_PROTOCOL_INVALID/,
  );
  assert.throws(() => parseWebProviderBootstrap(mutate({ ...first, theme: [] })), /WEB_PROVIDER_PROTOCOL_INVALID/);
  assert.throws(
    () => parseWebProviderBootstrap({ ...fixture, access: { ...fixture.access, canSend: true } }),
    /WEB_PROVIDER_PROTOCOL_INVALID/,
  );
});

test('provider parser accepts a scoped approved ready catalog entry and rejects cross-origin URLs', () => {
  const fixture = syntheticProviderBootstrap();
  const first = fixture.characters[0]!;
  const ready = {
    ...fixture,
    fixture: false,
    access: { ...fixture.access, canSend: true },
    characters: [
      {
        ...first,
        publicDescription: '公开简介',
        portraitUrl: '/api/web/provider/public-image/portrait-01',
        availability: { state: 'available', personaVersion: 3 },
        welcome: {
          text: '你好。',
          version: 'welcome-v1',
          audio: {
            state: 'available',
            mediaId: 'welcome-01',
            url: '/api/web/provider/public-audio/welcome-01',
            version: 'voice-v1',
            sha256: 'a'.repeat(64),
            durationMs: 1200,
          },
        },
      },
      ...fixture.characters.slice(1),
    ],
  };
  assert.deepEqual(parseWebProviderBootstrap(ready), ready);
  assert.throws(
    () =>
      parseWebProviderBootstrap({
        ...ready,
        characters: [{ ...ready.characters[0], portraitUrl: 'https://evil.example/a' }, ...ready.characters.slice(1)],
      }),
    /WEB_PROVIDER_PROTOCOL_INVALID/,
  );
  assert.throws(
    () =>
      parseWebProviderBootstrap({
        ...ready,
        characters: [
          {
            ...ready.characters[0],
            welcome: {
              ...ready.characters[0]!.welcome,
              audio: { ...ready.characters[0]!.welcome.audio, url: 'javascript:alert(1)' },
            },
          },
          ...ready.characters.slice(1),
        ],
      }),
    /WEB_PROVIDER_PROTOCOL_INVALID/,
  );
});
