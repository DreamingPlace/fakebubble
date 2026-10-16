import { createHash } from 'node:crypto';
import {
  DEFAULT_MODEL_SETTINGS,
  MODEL_LIMITS,
  emptyTiers,
  tierAllowed,
  type ModelAdminView,
  type ModelChangeView,
  type ModelSaveInput,
  type ModelSetting,
  type ModelTier,
  type SettingField,
} from '../../../packages/contracts/model-settings.ts';
import {
  DEFAULT_PLAYER_MODEL,
  PLAYER_MODELS,
  PLAYER_MODEL_IDS,
  POINTS,
  isPlayerModelId,
  type PlayerModelId,
} from '../../../packages/contracts/player-models.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { hasSignupBonus } from './web-free-tier.ts';

/**
 * Owner-controlled reply models and prices (Part 21g, migration 124).
 *
 * The rules, in one place:
 *  - PLAYER_MODEL_CHOICE_ENABLED stays the master flag. PLAYER_TEXT_MODELS (and the provider key) is a CEILING: a model the
 *    environment does not list, or has no key for, is never offered whatever web_model_settings says.
 *  - A model is offered to a tier when it is inside the ceiling, globally enabled, and allowed for that tier.
 *  - DeepSeek stays the internal backup and the house reviewer even when it is hidden from a tier (routing never consults the
 *    table for it).
 *  - Every tier keeps at least one allowed + enabled model: a save that would leave a tier empty is refused.
 *  - A price change appends a new price version; an operation keeps the model and the price version it was admitted under.
 *
 * The business object is the only writer of these tables. Nothing here holds player data.
 */
type Reader = Pick<BusinessStore, 'get' | 'all'>;
type Writer = Pick<BusinessStore, 'get' | 'all' | 'run' | 'transaction'>;
export type ModelFlags = {
  playerModelChoice?: readonly PlayerModelId[];
  /**
   * Which provider keys exist, when the deployment can tell (the Cloudflare business object asks the generation Worker, which
   * holds the keys). Absent = not checked (local runs and tests): the PLAYER_TEXT_MODELS list alone is the ceiling.
   */
  playerModelKeys?: Readonly<Partial<Record<'gemini' | 'xai', boolean>>>;
  publicFreeTier?: boolean;
};

const tableExists = (store: Pick<BusinessStore, 'get'>, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
/** Tables of 124_model_settings.sql. An older database keeps Part 21b's behaviour: the PLAYER_TEXT_MODELS list, the constant prices. */
export const modelSettingsTablesExist = (store: Pick<BusinessStore, 'get'>) =>
  tableExists(store, 'web_model_settings') &&
  tableExists(store, 'web_model_voice') &&
  tableExists(store, 'web_price_versions');

type SettingRow = {
  model: string;
  enabled: number;
  allowed_guest: number;
  allowed_registered: number;
  allowed_invited: number;
  points_per_reply: number;
};
const fromRow = (row: SettingRow): ModelSetting => ({
  model: row.model as PlayerModelId,
  enabled: row.enabled === 1,
  guest: row.allowed_guest === 1,
  registered: row.allowed_registered === 1,
  invited: row.allowed_invited === 1,
  points: row.points_per_reply,
});

/** The settings in catalogue order, or null on a database without migration 124. */
export function readSettings(store: Reader): ModelSetting[] | null {
  if (!modelSettingsTablesExist(store)) return null;
  const rows = store.all<SettingRow>('SELECT * FROM web_model_settings');
  return PLAYER_MODEL_IDS.map((id) => rows.find((row) => row.model === id)).map((row, i) =>
    row ? fromRow(row) : { ...DEFAULT_MODEL_SETTINGS.models[i]!, enabled: false },
  );
}

/**
 * The environment ceiling: PLAYER_TEXT_MODELS ∩ the models whose key is present. DeepSeek is the house model and always inside.
 * Null while the master flag is off.
 */
export function ceilingModels(store: ModelFlags): readonly PlayerModelId[] | null {
  const list = store.playerModelChoice;
  if (!list || list.length === 0) return null;
  const keys = store.playerModelKeys;
  return PLAYER_MODEL_IDS.filter(
    (id) => id === 'deepseek' || (list.includes(id) && (keys === undefined || keys[id as 'gemini' | 'xai'] === true)),
  );
}
/**
 * Ask the generation Worker which optional keys it holds (booleans only). Fails CLOSED: a Worker that cannot answer, has no such
 * method (an older deploy) or answers anything but `true` counts as "no key", so xAI/Gemini are simply not offered until it can.
 * `ok` says whether the answer is real (the caller retries sooner when it is not).
 */
export async function probeModelKeys(binding: {
  modelKeys?: () => Promise<{ xai?: unknown; gemini?: unknown }>;
}): Promise<{ keys: { gemini: boolean; xai: boolean }; ok: boolean }> {
  try {
    if (typeof binding.modelKeys !== 'function') return { keys: { gemini: false, xai: false }, ok: false };
    const answer = await binding.modelKeys();
    return { keys: { gemini: answer?.gemini === true, xai: answer?.xai === true }, ok: true };
  } catch {
    return { keys: { gemini: false, xai: false }, ok: false };
  }
}

/** Inside the ceiling? (The admin page's 未配置 is the opposite.) */
export const modelConfigured = (store: ModelFlags, id: PlayerModelId) => !!ceilingModels(store)?.includes(id);

/**
 * Prices in force. `version` names the table (web_price_versions); an operation and its points events are stamped with the
 * version they were made under. A database without migration 124 uses Part 21b's constants.
 */
export interface PriceTable {
  version: number;
  perReply: Readonly<Record<PlayerModelId, number>>;
  voice: number;
}
const constantPrices = (): PriceTable => ({ version: POINTS.version, perReply: POINTS.perReply, voice: POINTS.voice });
export function currentPrices(store: Reader): PriceTable {
  const settings = readSettings(store);
  if (!settings) return constantPrices();
  return {
    version: store.get<{ v: number }>('SELECT max(version) v FROM web_price_versions')!.v,
    perReply: Object.fromEntries(settings.map((s) => [s.model, s.points])) as Record<PlayerModelId, number>,
    voice: store.get<{ voice_points: number }>('SELECT voice_points FROM web_model_voice WHERE singleton=1')!
      .voice_points,
  };
}
/** The table a past operation was admitted under (its frozen price). Undefined for a version this database never had. */
export function pricesAt(store: Reader, version: number): PriceTable | undefined {
  if (!modelSettingsTablesExist(store)) return version === POINTS.version ? constantPrices() : undefined;
  const row = store.get<{
    deepseek_points: number;
    gemini_points: number;
    xai_points: number;
    voice_points: number;
  }>('SELECT * FROM web_price_versions WHERE version=?', version);
  return row
    ? {
        version,
        perReply: { deepseek: row.deepseek_points, gemini: row.gemini_points, xai: row.xai_points },
        voice: row.voice_points,
      }
    : undefined;
}
/** What one reply by `model` costs now, voice included. */
export const replyPointsNow = (store: Reader, model: PlayerModelId, voice = true) => {
  const prices = currentPrices(store);
  return prices.perReply[model] + (voice ? prices.voice : 0);
};

/**
 * THE tier resolution. Part 22 splits `invited` into unlimited / daily-refill here and nowhere else.
 *  - guest: a trial guest; registered: a guest that signed up and holds the signup bonus (points); invited: kind invite or account.
 * Null for a principal that is none of these.
 */
export function playerTier(store: Reader & ModelFlags, principalId: string): ModelTier | null {
  const kind = store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', principalId)?.kind;
  if (kind === 'invite' || kind === 'account') return 'invited';
  if (kind === 'guest') return hasSignupBonus(store, principalId) ? 'registered' : 'guest';
  return null;
}

/** The models offered at all right now (ceiling ∩ globally enabled), in catalogue order; null while the feature is off. */
export function offeredGlobally(store: Reader & ModelFlags): readonly PlayerModelId[] | null {
  const ceiling = ceilingModels(store);
  if (!ceiling) return null;
  const settings = readSettings(store);
  if (!settings) return ceiling;
  return ceiling.filter((id) => settings.find((s) => s.model === id)?.enabled);
}
/** The models offered to one tier, in catalogue order. A database without migration 124 offers guests nothing (no picker). */
export function tierModels(store: Reader & ModelFlags, tier: ModelTier): readonly PlayerModelId[] {
  const offered = offeredGlobally(store);
  if (!offered) return [];
  const settings = readSettings(store);
  if (!settings) return tier === 'guest' ? [] : offered;
  return offered.filter((id) => {
    const setting = settings.find((s) => s.model === id);
    return !!setting && tierAllowed(setting, tier);
  });
}
/** The model a player lands on when theirs is withdrawn: their tier's first allowed model (DeepSeek when the tier has none left). */
export const firstTierModel = (store: Reader & ModelFlags, tier: ModelTier | null): PlayerModelId =>
  (tier ? tierModels(store, tier)[0] : undefined) ?? DEFAULT_PLAYER_MODEL;

// ---- the admin page ---------------------------------------------------------------------------------------------------

type ChangeRow = {
  created_at: number;
  admin_id: string;
  label: string | null;
  model: string | null;
  field: SettingField;
  old_value: number;
  new_value: number;
};
export function readAdminView(store: Reader & ModelFlags, canManage: boolean): ModelAdminView | null {
  const settings = readSettings(store);
  if (!settings) return null;
  const prices = currentPrices(store);
  const hasMembers = tableExists(store, 'web_admin_members');
  const recent = store
    .all<ChangeRow>(
      `SELECT c.created_at,c.admin_id,${hasMembers ? 'm.label' : 'NULL'} label,c.model,c.field,c.old_value,c.new_value
      FROM web_model_changes c ${hasMembers ? 'LEFT JOIN web_admin_members m ON m.id=c.admin_id' : ''}
      ORDER BY c.id DESC LIMIT ?`,
      MODEL_LIMITS.recentChanges,
    )
    .map(
      (row): ModelChangeView => ({
        at: row.created_at,
        admin: row.label ?? '已移除的管理员',
        model: isPlayerModelId(row.model) ? row.model : null,
        field: row.field,
        from: row.old_value,
        to: row.new_value,
      }),
    );
  return {
    featureOn: ceilingModelsFlag(store),
    revision: store.get<{ revision: number }>('SELECT revision FROM web_model_voice WHERE singleton=1')!.revision,
    priceVersion: prices.version,
    models: settings.map((s) => ({
      ...s,
      configured: modelConfigured(store, s.model),
      label: PLAYER_MODELS[s.model].label,
    })),
    voicePoints: prices.voice,
    canManage,
    recent,
  };
}
const ceilingModelsFlag = (store: ModelFlags) => ceilingModels(store) !== null;

// ---- the only writer --------------------------------------------------------------------------------------------------

const FIELD_OF: Record<string, SettingField> = {
  enabled: 'enabled',
  guest: 'allowed_guest',
  registered: 'allowed_registered',
  invited: 'allowed_invited',
  points: 'points_per_reply',
};
export interface ModelSaveResult {
  revision: number;
  priceVersion: number;
  changes: number;
  duplicate: boolean;
}

/**
 * Save the whole table in one transaction. Idempotent per requestId (a replay answers what the first save did; the same id with
 * other content is IDEMPOTENCY_CONFLICT), optimistic on `expectedRevision` (MODEL_SETTINGS_CONFLICT), and refused when a tier
 * would be left with no allowed + enabled model (MODEL_TIER_EMPTY). A price change appends a price version.
 */
export function saveModelSettings(
  store: Writer & ModelFlags,
  now: number,
  adminId: string,
  input: ModelSaveInput,
): ModelSaveResult {
  ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
  const hash = createHash('sha256')
    .update(JSON.stringify([input.expectedRevision, input.models, input.voicePoints]))
    .digest('hex');
  return store.transaction(() => {
    const current = readSettings(store);
    ensure(current, 'MODEL_SETTINGS_UNAVAILABLE');
    const prior = store.get<{ request_hash: string; revision: number }>(
      'SELECT request_hash,revision FROM web_model_save_requests WHERE request_id=?',
      input.requestId,
    );
    if (prior) {
      ensure(prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
      return { revision: prior.revision, priceVersion: currentPrices(store).version, changes: 0, duplicate: true };
    }
    const voice = store.get<{ voice_points: number; revision: number }>(
      'SELECT voice_points,revision FROM web_model_voice WHERE singleton=1',
    )!;
    ensure(voice.revision === input.expectedRevision, 'MODEL_SETTINGS_CONFLICT');
    ensure(emptyTiers(input.models).length === 0, 'MODEL_TIER_EMPTY');

    const diffs: { model: PlayerModelId | null; field: SettingField; from: number; to: number }[] = [];
    const bit = (value: boolean) => (value ? 1 : 0);
    for (const next of input.models) {
      const before = current.find((s) => s.model === next.model)!;
      for (const key of ['enabled', 'guest', 'registered', 'invited'] as const)
        if (before[key] !== next[key])
          diffs.push({ model: next.model, field: FIELD_OF[key]!, from: bit(before[key]), to: bit(next[key]) });
      if (before.points !== next.points)
        diffs.push({ model: next.model, field: 'points_per_reply', from: before.points, to: next.points });
    }
    if (voice.voice_points !== input.voicePoints)
      diffs.push({ model: null, field: 'voice_points', from: voice.voice_points, to: input.voicePoints });
    if (diffs.length === 0)
      return { revision: voice.revision, priceVersion: currentPrices(store).version, changes: 0, duplicate: false };

    const priced = diffs.some((d) => d.field === 'points_per_reply' || d.field === 'voice_points');
    let version = currentPrices(store).version;
    if (priced) {
      version += 1;
      const points = (id: PlayerModelId) => input.models.find((m) => m.model === id)!.points;
      store.run(
        `INSERT INTO web_price_versions(version,deepseek_points,gemini_points,xai_points,voice_points,created_at,created_by_admin)
        VALUES (?,?,?,?,?,?,?)`,
        version,
        points('deepseek'),
        points('gemini'),
        points('xai'),
        input.voicePoints,
        now,
        adminId,
      );
    }
    for (const next of input.models)
      store.run(
        `UPDATE web_model_settings SET enabled=?,allowed_guest=?,allowed_registered=?,allowed_invited=?,points_per_reply=?,
        updated_at=?,updated_by_admin=? WHERE model=?
        AND (enabled<>? OR allowed_guest<>? OR allowed_registered<>? OR allowed_invited<>? OR points_per_reply<>?)`,
        bit(next.enabled),
        bit(next.guest),
        bit(next.registered),
        bit(next.invited),
        next.points,
        now,
        adminId,
        next.model,
        bit(next.enabled),
        bit(next.guest),
        bit(next.registered),
        bit(next.invited),
        next.points,
      );
    const revision = voice.revision + 1;
    store.run(
      'UPDATE web_model_voice SET voice_points=?,revision=?,updated_at=?,updated_by_admin=? WHERE singleton=1',
      input.voicePoints,
      revision,
      now,
      adminId,
    );
    const saveId = createHash('sha256').update(`web-model-save-v1\0${input.requestId}`).digest('hex').slice(0, 32);
    for (const diff of diffs)
      store.run(
        `INSERT INTO web_model_changes(save_id,admin_id,model,field,old_value,new_value,price_version,created_at)
        VALUES (?,?,?,?,?,?,?,?)`,
        saveId,
        adminId,
        diff.model,
        diff.field,
        diff.from,
        diff.to,
        version,
        now,
      );
    store.run(
      'INSERT INTO web_model_save_requests(request_id,request_hash,save_id,revision,created_at) VALUES (?,?,?,?,?)',
      input.requestId,
      hash,
      saveId,
      revision,
      now,
    );
    return { revision, priceVersion: version, changes: diffs.length, duplicate: false };
  });
}
