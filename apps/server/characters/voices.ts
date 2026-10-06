import type { Clock } from '../../../packages/contracts/index.ts';
import type { VoiceBinding, VoiceProfile, VoiceProfileRecord } from '../../../packages/contracts/media.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore as Store } from '../platform/store-contract.ts';

function id(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'INVALID_VOICE_ID');
}
function object(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  ensure(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === fields.length &&
      Object.keys(value).every((key) => fields.includes(key)),
    'INVALID_VOICE_PROFILE',
  );
}
export function validateVoiceBinding(value: unknown): asserts value is VoiceBinding {
  const optional =
    value && typeof value === 'object' && Object.hasOwn(value, 'messageProbability') ? ['messageProbability'] : [];
  object(value, ['profileId', 'version', 'speed', ...optional]);
  id(value.profileId);
  ensure(
    value.messageProbability === undefined ||
      (typeof value.messageProbability === 'number' &&
        Number.isFinite(value.messageProbability) &&
        value.messageProbability >= 0 &&
        value.messageProbability <= 1),
    'INVALID_VOICE_BINDING',
  );
  ensure(
    Number.isSafeInteger(value.version) &&
      Number(value.version) > 0 &&
      typeof value.speed === 'number' &&
      Number.isFinite(value.speed) &&
      value.speed >= 0.5 &&
      value.speed <= 2,
    'INVALID_VOICE_BINDING',
  );
}
export function validateVoiceProfile(value: unknown): asserts value is VoiceProfile {
  const optional = value && typeof value === 'object' && Object.hasOwn(value, 'qualityGuard') ? ['qualityGuard'] : [];
  object(value, ['id', 'version', 'name', 'kind', 'provider', 'model', 'referenceId', ...optional]);
  id(value.id);
  id(value.referenceId);
  ensure(value.qualityGuard === undefined || typeof value.qualityGuard === 'boolean', 'INVALID_VOICE_PROFILE');
  ensure(
    Number.isSafeInteger(value.version) &&
      Number(value.version) > 0 &&
      typeof value.name === 'string' &&
      value.name.trim().length > 0 &&
      value.name.length <= 100 &&
      typeof value.kind === 'string' &&
      ['custom', 'preset'].includes(value.kind) &&
      value.provider === 'fish' &&
      typeof value.model === 'string' &&
      ['s2.1-pro', 's2-pro'].includes(value.model),
    'INVALID_VOICE_PROFILE',
  );
}
interface Row {
  profile_json: string;
  created_at: number;
  approved_at: number | null;
  approval_note: string | null;
}
const dto = (row: Row): VoiceProfileRecord => ({
  profile: JSON.parse(row.profile_json),
  createdAt: row.created_at,
  approvedAt: row.approved_at,
  approvalNote: row.approval_note,
});

/** Local administration only. This registry never uploads, clones or scans a provider account. */
export class VoiceCatalog {
  readonly store: Store;
  readonly clock: Clock;
  constructor(store: Store, clock: Clock) {
    this.store = store;
    this.clock = clock;
  }
  list(): VoiceProfileRecord[] {
    return this.store.all<Row>('SELECT * FROM voice_profiles ORDER BY id,version DESC LIMIT 256').map(dto);
  }
  get(idValue: string, version: number): VoiceProfileRecord {
    id(idValue);
    ensure(Number.isSafeInteger(version) && version > 0, 'INVALID_VOICE_VERSION');
    const row = this.store.get<Row>('SELECT * FROM voice_profiles WHERE id=? AND version=?', idValue, version);
    ensure(row, 'VOICE_NOT_FOUND');
    return dto(row);
  }
  save(input: unknown): VoiceProfileRecord {
    validateVoiceProfile(input);
    const profile: VoiceProfile = {
      id: input.id,
      version: input.version,
      name: input.name,
      kind: input.kind,
      provider: input.provider,
      model: input.model,
      referenceId: input.referenceId,
      ...(input.qualityGuard === undefined ? {} : { qualityGuard: input.qualityGuard }),
    };
    return this.store.transaction(() => {
      const existing = this.store.get<Row>(
        'SELECT * FROM voice_profiles WHERE id=? AND version=?',
        profile.id,
        profile.version,
      );
      if (existing) {
        ensure(
          JSON.stringify(JSON.parse(existing.profile_json)) === JSON.stringify(profile),
          'VOICE_VERSION_IMMUTABLE',
        );
        return dto(existing);
      }
      const latest = this.store.get<{ version: number | null }>(
        'SELECT max(version) version FROM voice_profiles WHERE id=?',
        profile.id,
      )!.version;
      ensure(latest === null ? profile.version === 1 : profile.version === latest + 1, 'VOICE_VERSION_MUST_INCREASE');
      ensure(this.store.get<{ n: number }>('SELECT count(*) n FROM voice_profiles')!.n < 256, 'VOICE_CATALOG_FULL');
      this.store.run(
        'INSERT INTO voice_profiles VALUES (?,?,?,?,NULL,NULL)',
        profile.id,
        profile.version,
        JSON.stringify(profile),
        this.clock.now(),
      );
      return this.get(profile.id, profile.version);
    });
  }
  approve(idValue: string, version: number, input: unknown): VoiceProfileRecord {
    object(input, ['acknowledgeListening', 'acknowledgeRights', 'note']);
    ensure(
      input.acknowledgeListening === true &&
        input.acknowledgeRights === true &&
        typeof input.note === 'string' &&
        input.note.trim().length > 0 &&
        input.note.length <= 1000,
      'VOICE_APPROVAL_REQUIRED',
    );
    const note = input.note;
    return this.store.transaction(() => {
      const record = this.get(idValue, version);
      if (record.approvedAt !== null) {
        ensure(record.approvalNote === note, 'VOICE_APPROVAL_IMMUTABLE');
        return record;
      }
      this.store.run(
        'UPDATE voice_profiles SET approved_at=?,approval_note=? WHERE id=? AND version=? AND approved_at IS NULL',
        this.clock.now(),
        note,
        idValue,
        version,
      );
      return this.get(idValue, version);
    });
  }
  resolve(binding: VoiceBinding): VoiceProfile {
    validateVoiceBinding(binding);
    const value = this.get(binding.profileId, binding.version);
    ensure(value.approvedAt !== null, 'VOICE_APPROVAL_REQUIRED');
    return value.profile;
  }
}
