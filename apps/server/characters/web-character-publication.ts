import { webCharacterDeleted } from './web-character-deleted.ts';
import type { TextGenerationRequest, TextGenerationResult } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { dialogueCandidate, dialogueWire } from '../../../packages/domain/dialogue.ts';
import { contentHash } from './admin-content-hash.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { textPolicyHash } from '../generation/text-generation-policy.ts';
import { characterProfileHash, publishedWebCharacters, type WebCharacterProfile } from './web-character-catalog.ts';
import { identifier, keys, record, validatedTemplate } from './template-validation.ts';

import { approvedCharacterMaterial, promoteCharacterMaterial } from './web-character-materials.ts';

type Publication = {
  character_id: string;
  version: number;
  revision: number;
  profile_hash: string;
  preview_id: string;
  created_at: number;
  request_hash: string;
};
const dto = (row: Publication) => ({
  characterId: row.character_id,
  version: row.version,
  draftRevision: row.revision,
  profileHash: row.profile_hash,
  previewId: row.preview_id,
  publishedAt: row.created_at,
});

/** Pure business transaction: no generation, material import, player-content mutation or implicit retry. */
export function publishWebCharacter(
  store: BusinessStore,
  now: number,
  actor: { memberId: string; sessionId: string },
  id: string,
  input: unknown,
) {
  record(input);
  keys(input, ['requestId', 'draftRevision', 'profileHash', 'previewId', 'acknowledgeReview', 'materialId']);
  identifier(input.requestId);
  identifier(input.previewId);
  ensure(input.acknowledgeReview === true, 'REVIEW_ACKNOWLEDGEMENT_REQUIRED');
  ensure(Number.isSafeInteger(input.draftRevision) && Number(input.draftRevision) > 0, 'INVALID_DRAFT_REVISION');
  ensure(typeof input.profileHash === 'string' && /^[a-f0-9]{64}$/.test(input.profileHash), 'INVALID_PROFILE_HASH');
  ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
  const requestId = input.requestId,
    previewId = input.previewId;
  const requestHash = contentHash([actor.memberId, id, input]);
  return store.transaction(() => {
    ensure(!webCharacterDeleted(store, id), 'CHARACTER_DELETED');
    const prior = store.get<Publication>('SELECT * FROM web_character_publications WHERE request_id=?', requestId);
    if (prior) {
      ensure(prior.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT');
      return dto(prior);
    }
    const draft = store.get<{
      revision: number;
      base_version: number | null;
      profile_json: string;
      content_hash: string;
    }>(
      `SELECT r.* FROM web_character_drafts d JOIN web_character_revisions r
      ON r.character_id=d.character_id AND r.revision=d.revision WHERE d.character_id=?`,
      id,
    );
    ensure(draft && draft.revision === input.draftRevision, 'DRAFT_CONFLICT');
    const profile = JSON.parse(draft.profile_json) as WebCharacterProfile;
    ensure(
      characterProfileHash(profile) === draft.content_hash && draft.content_hash === input.profileHash,
      'DRAFT_CONFLICT',
    );
    const template = validatedTemplate(profile.template),
      catalog = publishedWebCharacters(store);
    const live = catalog.find((row) => row.characterId === id);
    ensure(template.id === id && template.version === (draft.base_version ?? 0) + 1, 'INVALID_DRAFT_VERSION');
    ensure((live?.version ?? null) === draft.base_version, 'LIVE_VERSION_CONFLICT');

    // Reuse only a completed real v7 review of these exact template bytes, not a UI/static preview.
    // Publication itself cannot enqueue or regenerate proof.
    const review = store.get<{
      content_hash: string;
      prompt_hash: string;
      request_json: string;
      result_json: string;
      template_json: string;
      finished_at: number;
      error_code: string | null;
    }>(
      `SELECT p.content_hash,p.prompt_hash,p.request_json,p.result_json,p.finished_at,p.error_code,r.template_json
      FROM admin_previews p JOIN character_draft_revisions r ON r.character_id=p.character_id AND r.revision=p.draft_revision
      WHERE p.id=? AND p.character_id=? AND p.status='succeeded' AND p.evidence_kind='deepseek'`,
      previewId,
      id,
    );
    ensure(
      review?.result_json &&
        review.finished_at !== null &&
        review.finished_at <= now &&
        review.error_code === null &&
        review.prompt_hash === textPolicyHash() &&
        review.content_hash === contentHash(template) &&
        contentHash(JSON.parse(review.template_json)) === contentHash(template),
      'VALID_PREVIEW_REQUIRED',
    );
    if (store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_preview_jobs'")) {
      const proof = store.get<{ revision: number; profile_hash: string }>(
        'SELECT revision,profile_hash FROM web_character_preview_jobs WHERE preview_id=? AND character_id=?',
        previewId,
        id,
      );
      ensure(
        proof &&
          proof.revision === draft.revision &&
          proof.profile_hash === draft.content_hash &&
          store.get<{ n: number }>(
            `SELECT count(*) n FROM web_character_preview_attempts WHERE preview_id=?
          AND state='known' AND outcome='succeeded' AND shared_settled=1`,
            previewId,
          )!.n === 2,
        'VALID_PREVIEW_REQUIRED',
      );
    }
    const request = JSON.parse(review.request_json) as TextGenerationRequest;
    const result = JSON.parse(review.result_json) as TextGenerationResult;
    ensure(
      request.jobId === input.previewId &&
        request.scope.characterId === id &&
        request.scope.worldId === 'admin-preview-' + input.previewId &&
        request.scope.conversationId === input.previewId &&
        contentHash(request.character) === contentHash(template) &&
        result.provider === 'deepseek' &&
        result.reply,
      'VALID_PREVIEW_REQUIRED',
    );
    ensure(
      result.stages?.length === 2 &&
        ['draft', 'review'].every(
          (stage) =>
            result.stages!.filter(
              (item) =>
                item.stage === stage &&
                item.status === 'succeeded' &&
                item.usage &&
                [item.usage.inputTokens, item.usage.outputTokens, item.usage.totalTokens].every(
                  (n) => Number.isSafeInteger(n) && n >= 0,
                ) &&
                item.usage.totalTokens === item.usage.inputTokens + item.usage.outputTokens,
            ).length === 1,
        ),
      'VALID_PREVIEW_REQUIRED',
    );
    try {
      dialogueCandidate(
        dialogueWire(result.reply),
        request.requiredMessageIds,
        request.mustClose,
        request.deliveryMode,
      );
    } catch {
      ensure(false, 'VALID_PREVIEW_REQUIRED');
    }

    if (input.materialId !== undefined && input.materialId !== null) identifier(input.materialId);
    const material =
      input.materialId === undefined || input.materialId === null
        ? null
        : approvedCharacterMaterial(store, id, input.materialId as string, draft.revision, draft.content_hash);
    if (material)
      ensure(
        template.voice &&
          template.voice.profileId === material.profile_id &&
          template.voice.version === material.voice_revision,
        'CHARACTER_MATERIALS_REQUIRED',
      );
    else {
      // Unchanged voice and welcome can reuse existing approval; changes require an exact bundle.
      const binding = store.get<{ voice_version: string; profile_id: string; voice_revision: number }>(
        `SELECT * FROM web_provider_voice_bindings WHERE character_id=? AND source='user_selected' AND approved=1`,
        id,
      );
      ensure(
        live &&
          live.template.voice &&
          binding &&
          template.voice &&
          template.voice.profileId === binding.profile_id &&
          template.voice.version === binding.voice_revision &&
          contentHash(template.voice) === contentHash(live.template.voice),
        'CHARACTER_MATERIALS_REQUIRED',
      );
      ensure(
        store.get(
          `SELECT 1 FROM web_provider_welcome_assets WHERE character_id=? AND voice_version=?
        AND body=? AND text_version=? AND origin='operator_approved'`,
          id,
          binding.voice_version,
          profile.presentation.welcome.text,
          profile.presentation.welcome.version,
        ) &&
          store.get(
            `SELECT 1 FROM web_provider_footer_assets WHERE character_id=? AND voice_version=? AND origin='operator_approved'`,
            id,
            binding.voice_version,
          ),
        'CHARACTER_MATERIALS_REQUIRED',
      );
    }
    // Status metadata only: do not read any player's private content. A single synchronous
    // transaction fences new admissions; never cancel, mutate or reprice an in-flight operation.
    ensure(
      !store.get(
        `SELECT 1 FROM web_operations WHERE character_id=?
      AND status NOT IN ('published','cancelled','failed') LIMIT 1`,
        id,
      ),
      'CHARACTER_PUBLICATION_BUSY',
    );
    const position =
      live?.position ?? Array.from({ length: 15 }, (_, i) => i).find((i) => !catalog.some((c) => c.position === i));
    ensure(position !== undefined, 'CHARACTER_CATALOG_FULL');
    const config = JSON.stringify(template);
    store.run('INSERT INTO character_template_versions VALUES (?,?,?,?)', id, template.version, config, now);
    if (live)
      store.run('UPDATE character_templates SET version=?,config_json=? WHERE id=?', template.version, config, id);
    else store.run('INSERT INTO character_templates VALUES (?,?,?)', id, template.version, config);
    store.run(
      'INSERT INTO web_character_versions VALUES (?,?,?,?,?)',
      id,
      template.version,
      draft.profile_json,
      draft.content_hash,
      now,
    );
    if (live) store.run('UPDATE web_character_catalog SET version=? WHERE character_id=?', template.version, id);
    else store.run('INSERT INTO web_character_catalog VALUES (?,?,?)', id, template.version, position);
    store.run(
      'INSERT INTO web_character_publications VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      requestId,
      requestHash,
      id,
      template.version,
      draft.revision,
      draft.content_hash,
      previewId,
      contentHash(review),
      actor.memberId,
      actor.sessionId,
      now,
    );
    if (material) promoteCharacterMaterial(store, material, template.version);
    store.run('DELETE FROM web_character_drafts WHERE character_id=?', id);
    store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      actor.memberId,
      `character-published:${template.version}`,
      id,
      now,
    );
    return dto(store.get<Publication>('SELECT * FROM web_character_publications WHERE request_id=?', requestId)!);
  });
}
