CREATE TABLE job_evidence_snapshots (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  job_id TEXT NOT NULL PRIMARY KEY, evidence_json TEXT NOT NULL,
  FOREIGN KEY(world_id,conversation_id,job_id) REFERENCES jobs(world_id,conversation_id,id),
  FOREIGN KEY(world_id,conversation_id,character_id) REFERENCES contacts(world_id,conversation_id,character_id)
) STRICT;
CREATE TABLE memory_episode_sources (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  topic_key TEXT NOT NULL, job_id TEXT NOT NULL, evidence_ids_json TEXT NOT NULL,
  PRIMARY KEY(world_id,conversation_id,character_id,topic_key,job_id),
  FOREIGN KEY(world_id,conversation_id,character_id,topic_key,job_id) REFERENCES memory_episodes(world_id,conversation_id,character_id,topic_key,job_id),
  FOREIGN KEY(job_id) REFERENCES job_evidence_snapshots(job_id)
) STRICT;
