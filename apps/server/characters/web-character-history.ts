import { createHash } from 'node:crypto';
import {
  describeChange,
  type RestoreProblem,
  type VersionActor,
  type VersionHistory,
  type VersionOrigin,
  type VersionRow,
} from '../../../packages/contracts/web-character-history.ts';
import { DetailedError, ensure } from '../../../packages/domain/errors.ts';
import { contentHash } from './admin-content-hash.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { characterProfileHash, publishedWebCharacters, type WebCharacterProfile } from './web-character-catalog.ts';
import { withVoiceBindingGuardLifted } from './web-character-material-schema.ts';
import { identifier, keys, record, validatedTemplate } from './template-validation.ts';
import { webCharacterDeleted } from './web-character-deleted.ts';

/**
 * 版本历史 and 恢复此版本 (Part 24f). Every published version is already an immutable row (web_character_versions: the exact
 * profile_json); who published it and how is in web_admin_audit and web_character_restores. A restore never edits any of it: it
 * publishes the old profile as the NEXT version and makes that version's approved voice bundle current again.
 */
type VersionRecord = { version: number; profile_json: string; content_hash: string; created_at: number | null };
const has = (store: BusinessStore, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
const parse = (row: VersionRecord) => JSON.parse(row.profile_json) as WebCharacterProfile;

/**
 * The profile with the number it is published under taken out. A restored version must carry its own number inside the profile
 * (the catalog checks template.version against the version row), so "the same profile as v1" means: equal in everything else.
 */
export const profileContentKey = (profile: WebCharacterProfile) =>
  createHash('sha256')
    .update(JSON.stringify({ template: { ...profile.template, version: 0 }, presentation: profile.presentation }))
    .digest('hex');

function versionRows(store: BusinessStore, id: string) {
  return store.all<VersionRecord>(
    'SELECT version,profile_json,content_hash,created_at FROM web_character_versions WHERE character_id=? ORDER BY version',
    id,
  );
}

type Clip = Record<string, unknown> & { voice_version: string };
const clipIntact = (row: Record<string, unknown>, deep: boolean) => {
  // A clip kept in object storage is a reference (checked when it is played); an inline one is checked byte for byte on a restore.
  if (typeof row.audio_ref_json === 'string' && row.audio_ref_json) return true;
  if (!('audio_bytes' in row)) return true; // metadata-only double
  const raw = row.audio_bytes as Uint8Array | ArrayBuffer | null;
  if (!raw) return false;
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
  if (bytes.byteLength !== row.byte_length) return false;
  return !deep || createHash('sha256').update(bytes).digest('hex') === row.sha256;
};

export type RestorePlan = { ok: true; profile: WebCharacterProfile; voiceVersion: string; switchBinding: boolean };
/**
 * What it takes to make version `version` current again, or the first thing that is missing. Pure reads. `deep` also hashes the
 * clip bytes (a restore does; the list only checks that they exist and have their length).
 */
export function restorePlan(
  store: BusinessStore,
  id: string,
  row: VersionRecord,
  deep: boolean,
): RestorePlan | { ok: false; problem: RestoreProblem } {
  const bad = (problem: RestoreProblem) => ({ ok: false as const, problem });
  let profile: WebCharacterProfile;
  try {
    profile = parse(row);
    if (characterProfileHash(profile) !== row.content_hash || profile.template.id !== id) return bad('PROFILE_INVALID');
    validatedTemplate(profile.template);
  } catch {
    return bad('PROFILE_INVALID');
  }
  const voice = profile.template.voice;
  if (!voice) return bad('VOICE_BINDING_MISSING');
  const welcome = store.all<Clip>(
    `SELECT * FROM web_provider_welcome_assets WHERE character_id=? AND body=? AND text_version=? AND origin='operator_approved'`,
    id,
    profile.presentation.welcome.text,
    profile.presentation.welcome.version,
  );
  if (!welcome.length) return bad('CLIP_MISSING');
  const history = has(store, 'web_character_voice_history'),
    materials = has(store, 'web_character_materials'),
    current = store.get<{ voice_version: string }>(
      `SELECT voice_version FROM web_provider_voice_bindings WHERE character_id=? AND source='user_selected' AND approved=1`,
      id,
    );
  // The newest bundle that was current at or before this version first; a bundle promoted later is a last resort.
  const promotedAt = (voiceVersion: string) =>
    materials && has(store, 'web_character_material_promotions')
      ? (store.get<{ version: number }>(
          `SELECT p.version FROM web_character_material_promotions p JOIN web_character_materials m ON m.id=p.material_id
          WHERE m.character_id=? AND m.voice_version=?`,
          id,
          voiceVersion,
        )?.version ?? null)
      : null;
  const ranked = welcome
    .map((w) => ({ w, promoted: promotedAt(w.voice_version) }))
    .sort((a, b) => {
      const key = (p: number | null) => (p === null ? -1 : p > row.version ? 1_000_000 + p : p);
      return key(b.promoted) - key(a.promoted) || (a.w.voice_version < b.w.voice_version ? -1 : 1);
    });
  let first: RestoreProblem | null = null;
  for (const { w } of ranked) {
    const problem = ((): RestoreProblem | null => {
      const bound = history
        ? store.get(
            `SELECT 1 FROM web_character_voice_history WHERE character_id=? AND voice_version=? AND profile_id=?
            AND voice_revision=? AND approved=1 AND source='user_selected'`,
            id,
            w.voice_version,
            voice.profileId,
            voice.version,
          )
        : current?.voice_version === w.voice_version &&
          store.get(
            'SELECT 1 FROM web_provider_voice_bindings WHERE character_id=? AND profile_id=? AND voice_revision=?',
            id,
            voice.profileId,
            voice.version,
          );
      if (!bound) return 'VOICE_BINDING_MISSING';
      const footer = store.get<Record<string, unknown>>(
        `SELECT * FROM web_provider_footer_assets WHERE character_id=? AND voice_version=? AND origin='operator_approved'`,
        id,
        w.voice_version,
      );
      if (!footer || !clipIntact(w, deep) || !clipIntact(footer, deep)) return 'CLIP_MISSING';
      if (materials) {
        const material = store.get<{ id: string }>(
          'SELECT id FROM web_character_materials WHERE character_id=? AND voice_version=?',
          id,
          w.voice_version,
        );
        if (
          material &&
          !(
            store.get('SELECT 1 FROM web_character_material_approvals WHERE material_id=?', material.id) &&
            store.get<{ n: number }>(
              'SELECT count(*) n FROM web_character_material_assets WHERE material_id=?',
              material.id,
            )!.n === 2
          )
        )
          return 'MATERIAL_MISSING';
      }
      return null;
    })();
    if (!problem)
      return {
        ok: true,
        profile,
        voiceVersion: w.voice_version,
        switchBinding: current?.voice_version !== w.voice_version,
      };
    first ??= problem;
  }
  return bad(first!);
}

type Audit = { actor_id: string | null; action: string };
/** Who published which version, from the audit lines the publication and the restore wrote. Roles only. */
function actors(store: BusinessStore, id: string) {
  const result = new Map<number, { by: VersionActor; colour: boolean }>();
  const rows = store.all<Audit & { role: string | null }>(
    `SELECT a.actor_id,a.action,m.role FROM web_admin_audit a LEFT JOIN web_admin_members m ON m.id=a.actor_id
    WHERE a.target_id=? AND (a.action LIKE 'character-published:%' OR a.action LIKE 'restore:v%') ORDER BY a.seq`,
    id,
  );
  for (const row of rows) {
    const published = /^character-published:(\d+)(:colour-only)?$/.exec(row.action),
      restored = /^restore:v\d+->v(\d+)$/.exec(row.action);
    const version = Number(published?.[1] ?? restored?.[1]);
    if (!Number.isSafeInteger(version)) continue;
    result.set(version, {
      by: row.role === 'owner' ? 'owner' : row.role === 'admin' ? 'admin' : 'system',
      colour: !!published?.[2],
    });
  }
  return result;
}

function originOf(version: number, colour: boolean, restores: Map<number, number>): VersionOrigin {
  const from = restores.get(version);
  if (from !== undefined) return { kind: 'restore', from };
  return colour ? { kind: 'colour' } : { kind: 'publish' };
}

const restoreMap = (store: BusinessStore, id: string) =>
  new Map(
    has(store, 'web_character_restores')
      ? store
          .all<{ version: number; from_version: number }>(
            'SELECT version,from_version FROM web_character_restores WHERE character_id=?',
            id,
          )
          .map((r) => [r.version, r.from_version] as const)
      : [],
  );

/** Every published version, newest first. */
export function characterHistory(store: BusinessStore, id: string): VersionHistory {
  identifier(id);
  ensure(!webCharacterDeleted(store, id), 'CHARACTER_DELETED');
  const rows = versionRows(store, id);
  ensure(rows.length > 0, 'NOT_FOUND');
  const liveVersion = publishedWebCharacters(store).find((c) => c.characterId === id)?.version ?? null,
    who = actors(store, id),
    restores = restoreMap(store, id);
  const versions: VersionRow[] = rows.map((row, i) => {
    const note = who.get(row.version),
      live = row.version === liveVersion,
      plan = live || liveVersion === null ? null : restorePlan(store, id, row, false);
    return {
      version: row.version,
      publishedAt: row.created_at,
      by: note?.by ?? 'system',
      origin: originOf(row.version, note?.colour ?? false, restores),
      summary: describeChange(i > 0 ? parse(rows[i - 1]!) : null, parse(row)),
      live,
      restorable: plan?.ok === true,
      problem: plan && !plan.ok ? plan.problem : null,
    };
  });
  return { characterId: id, live: liveVersion, versions: versions.reverse() };
}

/** One snapshot, read-only: exactly the stored profile_json. */
export function characterVersion(store: BusinessStore, id: string, version: unknown) {
  identifier(id);
  ensure(Number.isSafeInteger(version) && Number(version) > 0, 'INVALID_ADMIN_REQUEST');
  ensure(!webCharacterDeleted(store, id), 'CHARACTER_DELETED');
  const row = versionRows(store, id).find((r) => r.version === version);
  ensure(row, 'NOT_FOUND');
  const list = characterHistory(store, id),
    entry = list.versions.find((v) => v.version === version)!,
    live = publishedWebCharacters(store).find((c) => c.characterId === id);
  return {
    ...entry,
    characterId: id,
    profile: parse(row),
    profileHash: row.content_hash,
    contentKey: profileContentKey(parse(row)),
    liveProfile: live ? { template: live.template, presentation: live.presentation } : null,
  };
}

type Restore = {
  character_id: string;
  version: number;
  from_version: number;
  profile_hash: string;
  created_at: number;
  request_hash: string;
};
const dto = (row: Restore) => ({
  characterId: row.character_id,
  version: row.version,
  restoredFrom: row.from_version,
  profileHash: row.profile_hash,
  publishedAt: row.created_at,
});

/**
 * 恢复此版本. One synchronous transaction, owner-checked by the caller. It writes only history and the live pointers; it calls
 * no provider, imports no material, never touches a draft and never cancels or reprices an in-flight player operation.
 */
export function restoreWebCharacter(
  store: BusinessStore,
  now: number,
  actor: { memberId: string; sessionId: string },
  id: string,
  input: unknown,
) {
  identifier(id);
  record(input);
  keys(input, ['requestId', 'version', 'liveVersion']);
  identifier(input.requestId);
  ensure(Number.isSafeInteger(input.version) && Number(input.version) > 0, 'INVALID_ADMIN_REQUEST');
  ensure(Number.isSafeInteger(input.liveVersion) && Number(input.liveVersion) > 0, 'INVALID_ADMIN_REQUEST');
  ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
  const requestId = input.requestId,
    from = input.version as number,
    requestHash = contentHash([actor.memberId, id, input]);
  return store.transaction(() => {
    ensure(!webCharacterDeleted(store, id), 'CHARACTER_DELETED');
    const prior = store.get<Restore>('SELECT * FROM web_character_restores WHERE request_id=?', requestId);
    if (prior) {
      ensure(prior.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT');
      return dto(prior);
    }
    const live = publishedWebCharacters(store).find((c) => c.characterId === id);
    ensure(live, 'NOT_FOUND');
    // The dialog named v(live)+1; if the live version moved meanwhile, nothing is published under a number nobody agreed to.
    ensure(live.version === input.liveVersion, 'LIVE_VERSION_CONFLICT');
    ensure(from !== live.version, 'CHARACTER_VERSION_IS_LIVE');
    const row = versionRows(store, id).find((r) => r.version === from);
    ensure(row && from < live.version, 'NOT_FOUND');
    const plan = restorePlan(store, id, row, true);
    if (!plan.ok) throw new DetailedError('CHARACTER_VERSION_NOT_RESTORABLE', { problem: plan.problem });
    // The same fence as a publication: no unfinished player task of this character; nothing is cancelled, resent or repriced.
    ensure(
      !store.get(
        `SELECT 1 FROM web_operations WHERE character_id=? AND status NOT IN ('published','cancelled','failed') LIMIT 1`,
        id,
      ),
      'CHARACTER_PUBLICATION_BUSY',
    );
    const version = live.version + 1,
      profile = structuredClone(plan.profile);
    profile.template.version = version;
    const json = JSON.stringify(profile),
      hash = characterProfileHash(profile),
      config = JSON.stringify(profile.template);
    store.run('INSERT INTO character_template_versions VALUES (?,?,?,?)', id, version, config, now);
    store.run('UPDATE character_templates SET version=?,config_json=? WHERE id=?', version, config, id);
    store.run('INSERT INTO web_character_versions VALUES (?,?,?,?,?)', id, version, json, hash, now);
    store.run('UPDATE web_character_catalog SET version=? WHERE character_id=?', version, id);
    if (plan.switchBinding) {
      const bundle = store.get<Record<string, unknown>>(
        'SELECT * FROM web_character_voice_history WHERE character_id=? AND voice_version=?',
        id,
        plan.voiceVersion,
      );
      if (!bundle) throw new DetailedError('CHARACTER_VERSION_NOT_RESTORABLE', { problem: 'VOICE_BINDING_MISSING' });
      withVoiceBindingGuardLifted(store, () =>
        store.run(
          `UPDATE web_provider_voice_bindings SET voice_version=?,voice_revision=?,profile_id=?,reference_id=?,model=?,
          source=?,approved=?,evidence_json=? WHERE character_id=?`,
          bundle.voice_version as string,
          bundle.voice_revision as number,
          bundle.profile_id as string,
          bundle.reference_id as string,
          bundle.model as string,
          bundle.source as string,
          bundle.approved as number,
          bundle.evidence_json as string | null,
          id,
        ),
      );
    }
    store.run(
      'INSERT INTO web_character_restores VALUES (?,?,?,?,?,?,?,?,?,?)',
      requestId,
      requestHash,
      id,
      version,
      from,
      hash,
      plan.voiceVersion,
      actor.memberId,
      actor.sessionId,
      now,
    );
    // A draft is left exactly as it is: its base version is now older than the live one, which the existing stale-base checks report.
    store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      actor.memberId,
      `restore:v${from}->v${version}`,
      id,
      now,
    );
    return dto(store.get<Restore>('SELECT * FROM web_character_restores WHERE request_id=?', requestId)!);
  });
}
