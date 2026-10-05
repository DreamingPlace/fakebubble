import { createHash } from 'node:crypto';
import { verifySelectedVoiceSetup, type SelectedCharacterId } from '../../../apps/server/web-provider-materials.ts';
import { textRequest } from '../../text-fixtures.ts';
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

/** Synthetic stand-in for the private selected-voices record; same checks, test-computed digests. */
export function syntheticSelection() {
  const ids: SelectedCharacterId[] = ['chen-jimi', 'wei-guagua', 'jojo'];
  const base = textRequest().character;
  const characters = Object.fromEntries(ids.map(id => [id, {
    voice: bytes({ profile: { id: `${id}-fish`, kind: 'custom', provider: 'fish', model: 's2.1-pro',
      name: 'synthetic', qualityGuard: true, referenceId: `synthetic-${id}`, version: 1 },
    approvedAt: 1, createdAt: 1 }),
    draft: bytes({ revision: 1, baseVersion: 1, template: { ...base, id, name: `合成${id}`, version: 2,
      fictional: true, voice: { profileId: `${id}-fish`, version: 1, speed: 1 } } }),
    published: bytes({ characterId: id, version: 2, previewId: `preview-${id}` }) }])) as
    Record<SelectedCharacterId, { voice: Buffer; draft: Buffer; published: Buffer }>;
  const files = { selection: bytes({ authorization: '合成授权', cases: ids.map(id => ({ id })) }),
    publication: bytes({ cloudVoicesCreated: 0, uploads: 0, receipts: ids.map(id => ({
      characterId: id, version: 2, previewId: `preview-${id}` })) }), characters };
  return verifySelectedVoiceSetup(files, { directory: 'synthetic', selectionSHA256: sha(files.selection),
    publicationSHA256: sha(files.publication), characters: Object.fromEntries(ids.map(id => [id, {
      voiceSHA256: sha(characters[id].voice), draftSHA256: sha(characters[id].draft),
      publishedSHA256: sha(characters[id].published) }])) } as any);
}
