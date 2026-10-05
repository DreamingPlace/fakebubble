import type { BusinessStore as Store } from './store-contract.ts';
import { runningAudioCount } from './audio-validation.ts';

/** Called in the same write transaction as claiming; normal synthesis and retries share the queue. */
export function betaAudioQueue(store: Store): string[] {
  const available = Math.max(0, 2 - runningAudioCount(store));
  if (!available) return [];
  return store
    .all<{ media_id: string }>(
      `WITH served AS (
    SELECT w.owner_id playerId,max(t.dispatch_seq) lastTurn FROM speech_tasks t JOIN worlds w ON w.id=t.world_id GROUP BY w.owner_id
  ), candidates AS (
    SELECT t.media_id,t.created_at,t.rowid enqueueOrder,w.owner_id playerId,
      row_number() OVER (PARTITION BY w.owner_id ORDER BY t.created_at,t.rowid) queueRank
    FROM speech_tasks t JOIN worlds w ON w.id=t.world_id
    WHERE t.state='queued'
      AND NOT EXISTS (SELECT 1 FROM beta_accounts a WHERE a.player_id=w.owner_id AND a.status='suspended')
      AND NOT EXISTS (SELECT 1 FROM speech_tasks active JOIN worlds owner ON owner.id=active.world_id
        WHERE active.state='generating' AND owner.owner_id=w.owner_id)
      AND (t.retry=1 OR NOT EXISTS (SELECT 1 FROM speech_tasks earlier
        WHERE earlier.world_id=t.world_id AND earlier.conversation_id=t.conversation_id AND earlier.character_id=t.character_id
          AND earlier.job_id=t.job_id AND earlier.ordinal<t.ordinal AND earlier.state IN ('queued','generating')))
  ) SELECT media_id FROM candidates LEFT JOIN served USING(playerId) WHERE queueRank=1
    ORDER BY coalesce(lastTurn,0),created_at,enqueueOrder LIMIT ?`,
      available,
    )
    .map((row) => row.media_id);
}
