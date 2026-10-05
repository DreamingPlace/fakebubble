import { migrations as base } from '../cloudflare/migrations.ts';
import m100 from '../../apps/server/web-migrations/100_web_instance.sql';
import m101 from '../../apps/server/web-migrations/101_stage_queue.sql';
import m102 from '../../apps/server/web-migrations/102_admission_order.sql';
import m103 from '../../apps/server/web-migrations/103_identity.sql';
import m104 from '../../apps/server/web-migrations/104_dispatch_ledger.sql';
import m105 from '../../apps/server/web-migrations/105_synthetic_voice_queue.sql';
import m106 from '../../apps/server/web-migrations/106_input_snapshot.sql';
import m107 from '../../apps/server/web-migrations/107_synthetic_private_audio.sql';
import m108 from '../../apps/server/web-migrations/108_vertical_candidate.sql';
import m109 from '../../apps/server/web-migrations/109_local_transport.sql';
import m110 from '../../apps/server/web-migrations/110_data_lifecycle.sql';
import m111 from '../../apps/server/web-migrations/111_invite_core.sql';
import m112 from '../../apps/server/web-migrations/112_invite_identity.sql';
import m113 from '../../apps/server/web-migrations/113_provider_offline.sql';
import retention from './retention.sql';
import { ensure } from '../../packages/domain/errors.ts';

function replaceOnce(source: string, from: string, to: string) {
  ensure(source.split(from).length === 2, 'WEB_CLOUD_MIGRATION_SOURCE_CHANGED');
  return source.replace(from, to);
}

// workerd's SQLite lacks ALTER COLUMN ... DROP NOT NULL. For EMPTY initialization only,
// create these columns nullable from the start; final table/index/FK metadata is compared to Node.
const cloud100 = replaceOnce(replaceOnce(m100,
  'input_message_id TEXT NOT NULL UNIQUE', 'input_message_id TEXT UNIQUE'),
  'ip_window_id TEXT NOT NULL REFERENCES', 'ip_window_id TEXT REFERENCES');
const cloud108 = replaceOnce(m108,
  'ALTER TABLE web_operations ALTER COLUMN ip_window_id DROP NOT NULL;', '');
const cloud110 = replaceOnce(m110,
  'ALTER TABLE web_operations ALTER COLUMN input_message_id DROP NOT NULL;', '');

/** Only for a new, empty web authority. Never upgrade/adopt the old beta DO. */
export const webMigrations = [
  ...base.slice(0, 24),
  ...[cloud100, m101, m102, m103, m104, m105, m106, m107, cloud108, m109, cloud110, m111, m112, m113]
    .map((sql, i) => ({ version: 100 + i, sql: i === 5 ? sql + `
      DROP TABLE web_external_attempts;
      ALTER TABLE web_external_attempts_next RENAME TO web_external_attempts;
      CREATE INDEX web_external_attempts_state ON web_external_attempts(dispatch_state,operation_id);
    ` : sql })),
];

// Separate EMPTY R2 authority. Keep Node113 and the inline workerd comparison fixture intact.
// R2 mode never writes audio blobs into SQL (including welcome/footer and known outputs).
let cloud113 = m113;
// Only the new cloud R2 store supports explicitly authorized uncapped production accounting.
cloud113 = replaceOnce(cloud113, 'limit_micros INTEGER NOT NULL CHECK(limit_micros>0 AND limit_micros<=3000000)',
  'limit_micros INTEGER CHECK(limit_micros IS NULL OR (limit_micros>0 AND limit_micros<=3000000))');
for (const table of ['web_provider_outputs','web_provider_media_assets','web_provider_footer_assets','web_provider_welcome_assets']) {
  const start = cloud113.indexOf(`CREATE TABLE ${table} (`);
  const end = cloud113.indexOf(') STRICT;', start) + ') STRICT;'.length;
  ensure(start >= 0 && end > start, 'WEB_CLOUD_MIGRATION_SOURCE_CHANGED');
  const source = cloud113.slice(start, end);
  let result = replaceOnce(source, 'audio_bytes BLOB', 'audio_ref_json TEXT CHECK(audio_ref_json IS NULL OR json_valid(audio_ref_json)), audio_bytes BLOB');
  if (table === 'web_provider_outputs') {
    result = replaceOnce(result, 'audio_bytes IS NULL AND spoken_text IS NULL', 'audio_bytes IS NULL AND audio_ref_json IS NULL AND spoken_text IS NULL');
    result = replaceOnce(result, 'audio_bytes IS NOT NULL AND spoken_text IS NOT NULL',
      "audio_bytes IS NULL AND audio_ref_json IS NOT NULL AND json_extract(audio_ref_json,'$.sha256')=sha256 AND spoken_text IS NOT NULL");
  } else {
    result = replaceOnce(result, 'audio_bytes BLOB NOT NULL', 'audio_bytes BLOB');
    result = replaceOnce(result, 'CHECK(length(audio_bytes)=byte_length)',
      "CHECK(audio_bytes IS NULL AND audio_ref_json IS NOT NULL AND json_extract(audio_ref_json,'$.byteLength')=byte_length AND json_extract(audio_ref_json,'$.sha256')=sha256)");
  }
  cloud113 = replaceOnce(cloud113, source, result);
}
cloud113 += `
CREATE TABLE cf_http_rates(key TEXT PRIMARY KEY,until_ms INTEGER NOT NULL,count INTEGER NOT NULL CHECK(count>0)) STRICT;
CREATE INDEX cf_http_rates_expiry ON cf_http_rates(until_ms);
`;
export const webR2Migrations = webMigrations.map(m => m.version === 113 ? { ...m, sql: cloud113 + retention } : m);
