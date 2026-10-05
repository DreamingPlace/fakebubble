-- Original beta_feedback rows and submission receipts remain immutable.
CREATE TABLE beta_feedback_issues (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  admin_session_id TEXT NOT NULL REFERENCES admin_sessions(id)
) STRICT;
CREATE TABLE beta_feedback_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  feedback_id TEXT NOT NULL REFERENCES beta_feedback(id),
  revision INTEGER NOT NULL CHECK(revision>0),
  action TEXT NOT NULL CHECK(action IN ('triage','reply','transition','supplement','confirm','reopen')),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('administrator','player')),
  actor_id TEXT NOT NULL,
  admin_session_id TEXT REFERENCES admin_sessions(id),
  note TEXT NOT NULL,
  progress_json TEXT NOT NULL CHECK(json_valid(progress_json)),
  triage_json TEXT NOT NULL CHECK(json_valid(triage_json)),
  UNIQUE(feedback_id,revision),
  UNIQUE(feedback_id,id),
  CHECK((actor_kind='administrator' AND admin_session_id IS NOT NULL) OR (actor_kind='player' AND admin_session_id IS NULL))
) STRICT;
CREATE TABLE beta_feedback_workflows (
  feedback_id TEXT PRIMARY KEY REFERENCES beta_feedback(id),
  revision INTEGER NOT NULL CHECK(revision>0),
  category TEXT CHECK(category IN ('function','copy','voice','character','other')),
  status TEXT NOT NULL CHECK(status IN ('untriaged','needs_information','confirmed','fixing','retest','resolved')),
  updated_at INTEGER NOT NULL,
  repair_json TEXT CHECK(repair_json IS NULL OR json_valid(repair_json)),
  resolution TEXT CHECK(resolution IN ('administrator_closed','player_confirmed')),
  priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
  tags_json TEXT NOT NULL CHECK(json_valid(tags_json)),
  issue_id TEXT REFERENCES beta_feedback_issues(id),
  CHECK((status='resolved' AND resolution IS NOT NULL AND repair_json IS NOT NULL) OR (status!='resolved' AND resolution IS NULL)),
  CHECK(status!='retest' OR repair_json IS NOT NULL),
  FOREIGN KEY(feedback_id,revision) REFERENCES beta_feedback_events(feedback_id,revision)
) STRICT;
CREATE INDEX beta_feedback_workflow_issue ON beta_feedback_workflows(issue_id,feedback_id);
CREATE TABLE beta_feedback_action_receipts (
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('administrator','player')),
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  feedback_id TEXT NOT NULL REFERENCES beta_feedback(id),
  event_id TEXT NOT NULL UNIQUE,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  PRIMARY KEY(actor_kind,actor_id,request_id),
  FOREIGN KEY(feedback_id,event_id) REFERENCES beta_feedback_events(feedback_id,id)
) STRICT;
