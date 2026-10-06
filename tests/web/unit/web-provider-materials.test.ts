import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  verifySelectedVoiceSetup,
  verifyVoiceMaterialEvidence,
  type SelectedCharacterId,
} from '../../../apps/server/generation/web-provider-materials.ts';

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

test('strict material evidence binds person, versions, exact JSON bytes and decisions without granting quality', () => {
  const personaBytes = bytes({ id: 'character-01', version: 3, reviewRevision: 3 });
  const selectionBytes = bytes({
    schemaVersion: 1,
    characterId: 'character-01',
    status: 'approved_voice_choice_pending_integration',
    provider: 'fish',
    decisionRecord: 'fish-choice.json',
    approval: { acknowledgeListening: true, acknowledgeRights: true },
    userSelection: { answer: 'fish' },
    profile: {
      provider: 'fish',
      kind: 'custom',
      id: 'private-profile',
      referenceId: 'private-reference',
      version: 1,
      model: 's2.1-pro',
    },
    referenceSHA256: 'a'.repeat(64),
    boundaries: { newUpload: false, automaticallyBindOtherCharacters: false },
  });
  const expected = {
    characterId: 'character-01',
    personaVersion: 3,
    reviewRevision: 3,
    personaSHA256: sha(personaBytes),
    selectionSHA256: sha(selectionBytes),
    selectionDecisionRecord: 'fish-choice.json',
    webUseDecisionId: 'DEC-WEB-ASSET-001' as const,
  };
  const input = { personaBytes, selectionBytes, expected };
  const verified = verifyVoiceMaterialEvidence(input);
  assert.equal(verified.voice.model, 's2.1-pro');
  assert.equal(verified.qualityApproved, false);
  assert.equal(verified.providerValidityVerified, false);
  assert.throws(
    () =>
      verifyVoiceMaterialEvidence({
        ...input,
        expected: {
          ...expected,
          characterId: 'character-02',
        },
      }),
    /WEB_PROVIDER_MATERIAL_NOT_APPROVED/,
  );
  assert.throws(
    () =>
      verifyVoiceMaterialEvidence({
        ...input,
        expected: {
          ...expected,
          selectionSHA256: 'b'.repeat(64),
        },
      }),
    /WEB_PROVIDER_MATERIAL_DIGEST_MISMATCH/,
  );
  assert.throws(
    () =>
      verifyVoiceMaterialEvidence({
        ...input,
        selectionBytes: bytes({
          ...JSON.parse(selectionBytes.toString()),
          approval: { acknowledgeListening: true, acknowledgeRights: false },
        }),
        expected: {
          ...expected,
          selectionSHA256: sha(
            bytes({
              ...JSON.parse(selectionBytes.toString()),
              approval: { acknowledgeListening: true, acknowledgeRights: false },
            }),
          ),
        },
      }),
    /WEB_PROVIDER_MATERIAL_NOT_APPROVED/,
  );
});

function selectedSetup() {
  const ids: SelectedCharacterId[] = ['chen-jimi', 'wei-guagua', 'jojo'];
  const profile = (id: string, version: number) => ({
    id: `${id}-fish`,
    kind: 'custom',
    provider: 'fish',
    model: 's2.1-pro',
    name: 'synthetic',
    qualityGuard: true,
    referenceId: `private-${id}`,
    version,
  });
  const characters = Object.fromEntries(
    ids.map((id, index) => {
      const version = index === 0 ? 6 : 5,
        voiceVersion = index === 0 ? 3 : 4;
      return [
        id,
        {
          voice: bytes({ profile: profile(id, voiceVersion), approvedAt: 1, createdAt: 1 }),
          draft: bytes({
            revision: 1,
            baseVersion: version - 1,
            template: {
              id,
              name: `合成${id}`,
              version,
              fictional: true,
              persona: '合成测试设定',
              schedule: {},
              voice: { profileId: `${id}-fish`, version: voiceVersion },
            },
          }),
          published: bytes({ characterId: id, version, previewId: `preview-${id}` }),
        },
      ];
    }),
  ) as Record<SelectedCharacterId, { voice: Buffer; draft: Buffer; published: Buffer }>;
  const files = {
    selection: bytes({ authorization: '合成授权', cases: ids.map((id) => ({ id })) }),
    publication: bytes({
      cloudVoicesCreated: 0,
      uploads: 0,
      receipts: ids.map((id, index) => ({
        characterId: id,
        version: index === 0 ? 6 : 5,
        previewId: `preview-${id}`,
      })),
    }),
    characters,
  };
  const pinned = {
    directory: 'synthetic-setup',
    selectionSHA256: sha(files.selection),
    publicationSHA256: sha(files.publication),
    characters: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          voiceSHA256: sha(characters[id].voice),
          draftSHA256: sha(characters[id].draft),
          publishedSHA256: sha(characters[id].published),
        },
      ]),
    ),
  } as any;
  return { files, pinned, ids };
}

test('selected voice setup binds each character to its own published template and voice profile', () => {
  const { files, pinned } = selectedSetup();
  const verified = verifySelectedVoiceSetup(files, pinned);
  assert.deepEqual(
    verified.map((item) => [item.characterId, item.voice.voiceVersion, item.personaVersion]),
    [
      ['chen-jimi', 'chen-jimi-fish:v3', 6],
      ['wei-guagua', 'wei-guagua-fish:v4', 5],
      ['jojo', 'jojo-fish:v4', 5],
    ],
  );
  assert.equal(verified[1]!.evidence.webUseDecisionId, 'DEC-WEB-ASSET-001');
  assert.equal(JSON.stringify(verified.map((item) => item.evidence)).includes('private-'), false);
});

test('selected voice setup rejects altered bytes, swapped voices, uploads and missing selection', () => {
  const { files, pinned } = selectedSetup();
  const repin = (next: typeof files) => ({
    ...pinned,
    selectionSHA256: sha(next.selection),
    publicationSHA256: sha(next.publication),
    characters: Object.fromEntries(
      Object.entries(next.characters).map(([id, item]) => [
        id,
        { voiceSHA256: sha(item.voice), draftSHA256: sha(item.draft), publishedSHA256: sha(item.published) },
      ]),
    ),
  });
  assert.throws(
    () => verifySelectedVoiceSetup({ ...files, selection: bytes({ changed: true }) }, pinned),
    /WEB_PROVIDER_MATERIAL_DIGEST_MISMATCH/,
  );
  const swapped = {
    ...files,
    characters: {
      ...files.characters,
      jojo: { ...files.characters.jojo, voice: files.characters['wei-guagua'].voice },
    },
  };
  assert.throws(() => verifySelectedVoiceSetup(swapped, repin(swapped)), /WEB_PROVIDER_MATERIAL_NOT_APPROVED/);
  const uploaded = { ...files, publication: bytes({ ...JSON.parse(files.publication.toString()), uploads: 1 }) };
  assert.throws(() => verifySelectedVoiceSetup(uploaded, repin(uploaded)), /WEB_PROVIDER_MATERIAL_NOT_APPROVED/);
  const unselected = { ...files, selection: bytes({ authorization: '合成授权', cases: [{ id: 'chen-jimi' }] }) };
  assert.throws(() => verifySelectedVoiceSetup(unselected, repin(unselected)), /WEB_PROVIDER_MATERIAL_NOT_APPROVED/);
});
