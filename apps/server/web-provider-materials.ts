import { createHash } from 'node:crypto';
import { ensure } from '../../packages/domain/errors.ts';
import type { FishModel } from '../../packages/contracts/audio.ts';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' &&
  /^[A-Za-z0-9_-]{1,128}$/.test(value);

export interface VoiceMaterialEvidence {
  characterId: string;
  personaVersion: number;
  reviewRevision: number;
  personaSHA256: string;
  selectionSHA256: string;
  selectionDecisionRecord: string;
  webUseDecisionId: 'DEC-WEB-ASSET-001';
}

/** Read-only parsing. A selected voice is not proof of final quality or provider validity. */
export function verifyVoiceMaterialEvidence(input: {
  personaBytes: Uint8Array; selectionBytes: Uint8Array; expected: VoiceMaterialEvidence;
}) {
  const { expected } = input;
  ensure(expected.webUseDecisionId === 'DEC-WEB-ASSET-001' &&
    /^[a-f0-9]{64}$/.test(expected.personaSHA256) &&
    /^[a-f0-9]{64}$/.test(expected.selectionSHA256) &&
    digest(input.personaBytes) === expected.personaSHA256 &&
    digest(input.selectionBytes) === expected.selectionSHA256,
  'WEB_PROVIDER_MATERIAL_DIGEST_MISMATCH');
  let persona: any, selection: any;
  try {
    persona = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.personaBytes));
    selection = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.selectionBytes));
  } catch { ensure(false, 'WEB_PROVIDER_MATERIAL_INVALID'); }
  ensure(id(expected.characterId) && persona?.id === expected.characterId &&
    persona.version === expected.personaVersion &&
    persona.reviewRevision === expected.reviewRevision &&
    selection?.characterId === expected.characterId && selection.schemaVersion === 1 &&
    selection.status === 'approved_voice_choice_pending_integration' &&
    selection.provider === 'fish' &&
    selection.decisionRecord === expected.selectionDecisionRecord &&
    selection.approval?.acknowledgeListening === true &&
    selection.approval?.acknowledgeRights === true &&
    selection.userSelection?.answer === 'fish' &&
    selection.profile?.provider === 'fish' && selection.profile.kind === 'custom' &&
    id(selection.profile.id) && id(selection.profile.referenceId) &&
    Number.isSafeInteger(selection.profile.version) && selection.profile.version > 0 &&
    ['s2.1-pro','s2-pro'].includes(selection.profile.model) &&
    /^[a-f0-9]{64}$/.test(selection.referenceSHA256) &&
    selection.boundaries?.newUpload === false &&
    selection.boundaries?.automaticallyBindOtherCharacters === false,
  'WEB_PROVIDER_MATERIAL_NOT_APPROVED');
  return { characterId: expected.characterId, personaVersion: expected.personaVersion,
    reviewRevision: expected.reviewRevision, personaSHA256: expected.personaSHA256,
    selectionSHA256: expected.selectionSHA256,
    selectionDecisionRecord: expected.selectionDecisionRecord,
    webUseDecisionId: expected.webUseDecisionId,
    voice: { profileId: selection.profile.id as string,
      referenceId: selection.profile.referenceId as string,
      revision: selection.profile.version as number,
      model: selection.profile.model as FishModel,
      referenceSHA256: selection.referenceSHA256 as string },
    qualityApproved: false as const, providerValidityVerified: false as const };
}

/** Deployment-specific material fingerprints stay in a private operator-supplied manifest. */
export type SelectedCharacterId = 'chen-jimi' | 'wei-guagua' | 'jojo';
export interface SelectedVoicePins {
  directory: string; selectionSHA256: string; publicationSHA256: string;
  characters: Record<SelectedCharacterId, { voiceSHA256: string; draftSHA256: string; publishedSHA256: string }>;
}
export function validateSelectedVoicePins(value: unknown): asserts value is SelectedVoicePins {
  const p = value as SelectedVoicePins | null;
  ensure(p && typeof p.directory === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(p.directory) &&
    p.characters && Object.keys(p.characters).sort().join(',') === 'chen-jimi,jojo,wei-guagua' &&
    [p.selectionSHA256,p.publicationSHA256,...Object.values(p.characters).flatMap(c =>
      c ? [c.voiceSHA256,c.draftSHA256,c.publishedSHA256] : [undefined])]
      .every(h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h)), 'WEB_PROVIDER_MATERIAL_PINS_REQUIRED');
}
export type SelectedVoiceFiles = { selection: Uint8Array; publication: Uint8Array;
  characters: Record<SelectedCharacterId, { voice: Uint8Array; draft: Uint8Array; published: Uint8Array }> };

const parseJSON = (bytes: Uint8Array): any => {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return ensure(false, 'WEB_PROVIDER_MATERIAL_INVALID'); }
};

/**
 * Read-only verification of the user's final voice selection. The returned referenceId is private:
 * callers store it only in the provider database and never log or serve it.
 */
export function verifySelectedVoiceSetup(files: SelectedVoiceFiles, pinned: SelectedVoicePins) {
  validateSelectedVoicePins(pinned);
  ensure(digest(files.selection) === pinned.selectionSHA256 &&
    digest(files.publication) === pinned.publicationSHA256, 'WEB_PROVIDER_MATERIAL_DIGEST_MISMATCH');
  const selection = parseJSON(files.selection), publication = parseJSON(files.publication);
  const ids = Object.keys(pinned.characters) as SelectedCharacterId[];
  ensure(typeof selection?.authorization === 'string' && selection.authorization.length > 0 &&
    Array.isArray(selection.cases) &&
    ids.every(characterId => selection.cases.filter((item: any) => item?.id === characterId).length === 1) &&
    publication?.cloudVoicesCreated === 0 && publication.uploads === 0 &&
    Array.isArray(publication.receipts), 'WEB_PROVIDER_MATERIAL_NOT_APPROVED');
  return ids.map(characterId => {
    const expected = pinned.characters[characterId], raw = files.characters[characterId];
    ensure(raw && digest(raw.voice) === expected.voiceSHA256 &&
      digest(raw.draft) === expected.draftSHA256 && digest(raw.published) === expected.publishedSHA256,
    'WEB_PROVIDER_MATERIAL_DIGEST_MISMATCH');
    const voice = parseJSON(raw.voice), draft = parseJSON(raw.draft), published = parseJSON(raw.published);
    const receipt = publication.receipts.filter((item: any) => item?.characterId === characterId);
    const profile = voice?.profile, template = draft?.template;
    ensure(receipt.length === 1 && receipt[0].version === published?.version &&
      receipt[0].previewId === published.previewId && published.characterId === characterId &&
      profile?.provider === 'fish' && profile.kind === 'custom' && profile.qualityGuard === true &&
      id(profile.id) && id(profile.referenceId) && Number.isSafeInteger(profile.version) &&
      profile.version > 0 && ['s2.1-pro','s2-pro'].includes(profile.model) &&
      Number.isSafeInteger(voice.approvedAt) &&
      template?.id === characterId && template.version === published.version &&
      template.fictional === true && typeof template.persona === 'string' && template.persona &&
      typeof template.name === 'string' && template.name && template.schedule &&
      template.voice?.profileId === profile.id && template.voice.version === profile.version,
    'WEB_PROVIDER_MATERIAL_NOT_APPROVED');
    return { characterId, displayName: template.name as string,
      template: template as Record<string, unknown>, personaVersion: template.version as number,
      voice: { voiceVersion: `${profile.id}:v${profile.version}`, profileId: profile.id as string,
        referenceId: profile.referenceId as string, revision: profile.version as number,
        model: profile.model as FishModel },
      evidence: { directory: pinned.directory, selectionSHA256: pinned.selectionSHA256,
        publicationSHA256: pinned.publicationSHA256, ...expected,
        webUseDecisionId: 'DEC-WEB-ASSET-001' as const, voiceAcceptanceDecisionId: 'ASSET-002' as const } };
  });
}
