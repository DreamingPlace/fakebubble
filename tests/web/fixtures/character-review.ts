import { randomUUID } from 'node:crypto';
import type { BusinessStore } from '../../../apps/server/store-contract.ts';
import { contentHash } from '../../../apps/server/admin-content-hash.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/deepseek.ts';
import { acceptedAuditEnvelope, draftEnvelope, textRequest } from '../../text-fixtures.ts';
import type { WebCharacterProfile } from '../../../apps/server/web-character-catalog.ts';

/** Simulated trusted preview evidence. Never in a deployment graph; no real provider or budget claim. */
export async function syntheticCharacterReview(store: BusinessStore, now: number, id: string) {
  const draft = store.get<{ profile_json: string; session_id: string; base_version: number | null }>(
    `SELECT r.* FROM web_character_drafts d JOIN web_character_revisions r
      ON r.character_id=d.character_id AND r.revision=d.revision WHERE d.character_id=?`,
    id,
  )!;
  const profile = JSON.parse(draft.profile_json) as WebCharacterProfile;
  const previewId = randomUUID(),
    request = textRequest();
  request.jobId = previewId;
  request.now = now;
  request.character = profile.template;
  request.scope = { worldId: 'admin-preview-' + previewId, conversationId: previewId, characterId: id };
  request.messages = request.messages.map((message) => ({
    ...message,
    worldId: request.scope.worldId,
    conversationId: previewId,
  }));
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    textProtocol: 'accepted-v7',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      return Response.json(
        body.tools[0].function.name === 'submit_dialogue_draft'
          ? draftEnvelope(request)
          : acceptedAuditEnvelope(request),
      );
    },
  });
  const result = await generator.generate(request, new AbortController().signal);
  store.transaction(() => {
    const revision = store.get<{ n: number }>(
      'SELECT coalesce(max(revision),0)+1 n FROM character_draft_revisions WHERE character_id=?',
      id,
    )!.n;
    store.run(
      'INSERT INTO character_draft_revisions VALUES (?,?,?,?,?,?,?)',
      id,
      revision,
      draft.base_version,
      JSON.stringify(profile.template),
      contentHash(profile.template),
      now,
      draft.session_id,
    );
    store.run(
      `INSERT INTO admin_previews(id,character_id,draft_revision,content_hash,prompt_hash,request_id,request_hash,
      status,evidence_kind,request_json,created_at,finished_at,result_json)
      VALUES (?,?,?,?,?,?,?,'succeeded','deepseek',?,?,?,?)`,
      previewId,
      id,
      revision,
      contentHash(profile.template),
      generator.policyHash,
      previewId,
      contentHash(request),
      JSON.stringify(request),
      now,
      now,
      JSON.stringify(result),
    );
  });
  return previewId;
}
