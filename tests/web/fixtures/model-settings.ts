import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import {
  migrateWebProviderInviteTiers,
  migrateWebProviderLegacyInvites,
  migrateWebProviderModelSettings,
} from '../../../apps/server/generation/web-provider-migration.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import type { PlayerModelId } from '../../../packages/contracts/player-models.ts';
import type { ModelSaveInput, ModelSetting } from '../../../packages/contracts/model-settings.ts';
import { DEFAULT_MODEL_SETTINGS } from '../../../packages/contracts/model-settings.ts';
import { enableModelChoice, schema123 } from './model-choice.ts';
import type { TestContext } from 'node:test';

export const origin = 'https://fixture.invalid';
export const T0 = 1_800_000_000_000;
const ip = (digit: string) => digit.repeat(64);
export const characterId = 'fixture-character';

/** The real schema through migration 124 on an in-memory Node database. */
export function schema124() {
  const store = schema123();
  migrateWebProviderModelSettings(store);
  return store;
}

/** A signed-up player holding an unlimited entitlement: the "invited" tier since Part 22a. */
export function grantUnlimited(
  store: ReturnType<typeof schema124>,
  principalId: string,
  id: string,
  now: number,
  login = true,
) {
  if (login && !store.get('SELECT 1 FROM web_player_logins WHERE principal_id=?', principalId))
    store.run(
      'INSERT INTO web_player_logins(principal_id,email_norm,password_hash,created_at,password_changed_at,last_seen_at) VALUES (?,?,?,?,?,?)',
      principalId,
      `${id}@example.com`,
      'x',
      now,
      now,
      now,
    );
  store.run(
    "INSERT INTO web_entitlements(id,principal_id,source,invite_id,batch_id,kind,starts_at,expires_at,created_at) VALUES (?,?,'admin',NULL,NULL,'unlimited',?,NULL,?)",
    id,
    principalId,
    now - 1,
    now - 1,
  );
}

export type SettingsPatch = Partial<Record<PlayerModelId, Partial<Omit<ModelSetting, 'model'>>>>;

/**
 * A schema-124 store with the Part 21b feature on, an admission, an owner session and a way to add administrators and players of
 * each tier (guest, registered = guest holding the signup bonus, invited = an invite principal).
 */
export function modelSettingsFixture(
  t: TestContext,
  options: { models?: readonly PlayerModelId[]; keys?: { gemini?: boolean; xai?: boolean } } = {},
) {
  const store = schema124();
  migrateWebProviderInviteTiers(store);
  migrateWebProviderLegacyInvites(store);
  t.after(() => store.close());
  Object.assign(store, { webIpKeyFingerprint: () => 'f'.repeat(64) });
  enableModelChoice(store, options.models);
  if (options.keys) Object.assign(store, { playerModelKeys: options.keys });
  let now = T0,
    seq = 0,
    ids = 0;
  const clock = { now: () => now };
  const admission = new WebAdmission(store as WebStore, clock, () => `id-${++seq}`);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', characterId, 1, '{}');
  const accounts = new WebAccountAdmin(store, clock, origin);
  const owner = accounts.login(accounts.issueLoginGrant().token, origin);
  const ownerAuth = { cookie: owner.cookie, csrf: owner.csrf, origin };
  const member = (permissions: string[], label = 'Reader') => {
    const grant = accounts.issueMember(owner.cookie, owner.csrf, origin, {
      requestId: `issue-${label}-${++ids}`,
      label,
      memberId: null,
      permissions,
    });
    const login = accounts.login(grant.token, origin);
    return { cookie: login.cookie, csrf: login.csrf, origin };
  };

  const guest = (name: string, tier: 'guest' | 'registered' | 'invited' = 'guest') => {
    const playerId = `player-${name}`,
      worldId = `world-${name}`,
      principalId = `principal-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'Asia/Singapore', '{}');
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, characterId);
    });
    admission.registerGuest({ principalId, playerId, worldId });
    if (tier === 'registered')
      store.run('INSERT INTO web_signup_bonus(principal_id,granted_at) VALUES (?,?)', principalId, now);
    // Named exception (Part 22x): the invited tier is an unlimited entitlement held by a signed-up player (the legacy invite
    // principal kind no longer exists); the fixture store is the schema through migration 126.
    if (tier === 'invited') grantUnlimited(store, principalId, `entitlement-${name}`, now);
    return principalId;
  };
  const admit = (principalId: string, requestId: string, hashDigit = 'a') =>
    admission.admit({ principalId, requestId, characterId, text: '你好', ipHash: ip(hashDigit) });
  const finish = (operationId: string, status: string) =>
    store.run(
      'UPDATE web_operations SET status=?,quota_state=?,stage_version=stage_version+1 WHERE id=?',
      status,
      status === 'published' ? 'used' : 'released',
      operationId,
    );
  const rows = (): ModelSetting[] =>
    store
      .all<{
        model: PlayerModelId;
        enabled: number;
        allowed_guest: number;
        allowed_registered: number;
        allowed_invited: number;
        points_per_reply: number;
      }>('SELECT * FROM web_model_settings ORDER BY rowid')
      .map((row) => ({
        model: row.model,
        enabled: row.enabled === 1,
        guest: row.allowed_guest === 1,
        registered: row.allowed_registered === 1,
        invited: row.allowed_invited === 1,
        points: row.points_per_reply,
      }));
  /** The whole table as the page would send it, with `patch` applied; revision defaults to the live one. */
  const draft = (patch: SettingsPatch = {}, voicePoints?: number, expectedRevision?: number): ModelSaveInput => ({
    requestId: `request-${++ids}-${seq}`,
    expectedRevision:
      expectedRevision ?? store.get<{ revision: number }>('SELECT revision FROM web_model_voice')!.revision,
    models: rows().map((row) => ({ ...row, ...(patch[row.model] ?? {}) })),
    voicePoints:
      voicePoints ?? store.get<{ voice_points: number }>('SELECT voice_points FROM web_model_voice')!.voice_points,
  });
  const save = (auth: { cookie: string; csrf: string; origin: string }, input: ModelSaveInput) =>
    accounts.saveModelSettings(auth.cookie, auth.csrf, auth.origin, input);
  const read = (auth: { cookie: string; csrf: string; origin: string }) =>
    accounts.modelSettings(auth.cookie, auth.csrf, auth.origin);
  return {
    store,
    admission,
    accounts,
    owner: ownerAuth,
    member,
    guest,
    admit,
    finish,
    rows,
    draft,
    save,
    read,
    defaults: DEFAULT_MODEL_SETTINGS,
    advance: (ms: number) => {
      now += ms;
    },
    clock: () => now,
  };
}
