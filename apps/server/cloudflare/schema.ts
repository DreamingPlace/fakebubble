/** Cloud-only extension. Original Node migrations and original instances are unchanged. */
export const cloudScreenshotSchema = `
DROP TABLE beta_feedback_screenshots;
CREATE TABLE beta_feedback_screenshots (
  feedback_id TEXT NOT NULL REFERENCES beta_feedback(id),
  id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<3),
  width INTEGER NOT NULL CHECK(width>0 AND width<=4096),
  height INTEGER NOT NULL CHECK(height>0 AND height<=4096 AND width*height<=8388608),
  byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=5242880),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  object_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(feedback_id,id),
  UNIQUE(feedback_id,ordinal)
) STRICT;
`;

export const cloudRateSchema = `
CREATE TABLE cf_http_rates(key TEXT PRIMARY KEY,until_ms INTEGER NOT NULL,count INTEGER NOT NULL CHECK(count>0)) STRICT;
CREATE INDEX cf_http_rates_expiry ON cf_http_rates(until_ms);
`;
export const cloudAdminIdentitySchema = `
CREATE TABLE cf_admin_identities(
  session_id TEXT PRIMARY KEY REFERENCES admin_sessions(id),
  identity_hash TEXT NOT NULL CHECK(length(identity_hash)=64)
) STRICT;
`;
export const cloudAccessCoordinatorSchema = `
CREATE TABLE cf_access_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1),fence_json TEXT NOT NULL,tombstones_json TEXT NOT NULL,pending_id TEXT) STRICT;
CREATE TABLE cf_access_operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,plan_json TEXT NOT NULL,plan_hash TEXT NOT NULL,
  before_json TEXT NOT NULL,proof_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('staged','applied','confirmed'))) STRICT;
`;
export const cloudCostOutboxSchema = `
CREATE TABLE cf_cost_outbox(call_id TEXT NOT NULL,event_id TEXT NOT NULL,identity_json TEXT NOT NULL,
  observation_json TEXT NOT NULL,payload_hash TEXT NOT NULL,delivered INTEGER NOT NULL CHECK(delivered IN (0,1)),
  PRIMARY KEY(call_id,event_id)) STRICT;
CREATE INDEX cf_cost_outbox_pending ON cf_cost_outbox(delivered) WHERE delivered=0;
`;
export const cloudReconciliationOutboxSchema = `
CREATE TABLE cf_reconciliation_outbox(call_id TEXT NOT NULL,event_id TEXT NOT NULL,identity_json TEXT NOT NULL,
  value_json TEXT NOT NULL,payload_hash TEXT NOT NULL,delivered INTEGER NOT NULL CHECK(delivered IN (0,1)),PRIMARY KEY(call_id,event_id)) STRICT;
`;
export const cloudRetentionSchema = `
CREATE TABLE cf_retention_objects(id TEXT PRIMARY KEY,reference_json TEXT NOT NULL) STRICT;
CREATE TABLE cf_retired_feedback(player_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,retired_at INTEGER NOT NULL,
 PRIMARY KEY(player_id,request_id)) STRICT;
`;
export const cloudAlertSchema = `
CREATE TABLE cf_alert_state(code TEXT PRIMARY KEY,severity TEXT,delivery_id TEXT,event_json TEXT,
 attempts INTEGER NOT NULL,next_at INTEGER,failed INTEGER NOT NULL CHECK(failed IN (0,1))) STRICT;
`;
export const cloudWorkerHealthSchema = `
CREATE TABLE cf_worker_errors(code TEXT PRIMARY KEY,at INTEGER NOT NULL CHECK(at>=0)) STRICT;
`;
export const cloudBackupCatalogSchema = `
CREATE TABLE cf_backup_catalog(snapshot_id TEXT PRIMARY KEY,identity_json TEXT NOT NULL,snapshot_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('writing','complete','deleting','deleted')),receipt_json TEXT) STRICT;
`;
export const cloudPlatformMigrations = [cloudScreenshotSchema, cloudRateSchema, cloudAdminIdentitySchema, cloudAccessCoordinatorSchema, cloudCostOutboxSchema, cloudReconciliationOutboxSchema, cloudRetentionSchema, cloudAlertSchema, cloudWorkerHealthSchema, cloudBackupCatalogSchema] as const;
