import type { BusinessStore as Store } from './store-contract.ts';

const activePlayers = `SELECT w.owner_id playerId FROM text_attempts a
  JOIN jobs j ON j.id=a.job_id AND j.world_id=a.world_id AND j.conversation_id=a.conversation_id AND j.character_id=a.character_id
  JOIN worlds w ON w.id=a.world_id
  WHERE a.status='running' AND j.status='leased' AND j.lease_until>?
    AND NOT EXISTS (SELECT 1 FROM beta_reviewed_replies r WHERE r.job_id=a.job_id
      AND r.world_id=a.world_id AND r.conversation_id=a.conversation_id AND r.character_id=a.character_id)
    AND NOT EXISTS (SELECT 1 FROM dialogue_deliveries d WHERE d.job_id=a.job_id
      AND d.world_id=a.world_id AND d.conversation_id=a.conversation_id AND d.character_id=a.character_id)`;

/** Caller checks and claims in one SQLite write transaction, including admin previews. */
export function canStartBetaText(store: Store, now: number, playerId?: string): boolean {
  if (!store.beta) return true;
  const active = store.all<{ playerId: string }>(activePlayers, now);
  const previews = store.get<{ n: number }>("SELECT count(*) n FROM admin_previews WHERE status='generating' AND lease_until>?", now)!.n;
  return active.length + previews < 2 && (playerId === undefined ? previews === 0 : !active.some(row => row.playerId === playerId));
}

/** Internal SQL only: candidates expose queuedAt and a complete CharacterScope. */
export function textQueueSQL(store: Store, candidates: string, order: string): string {
  if (!store.beta) return `${candidates} ORDER BY ${order} LIMIT 64`;
  // Rank before LIMIT so one account's old backlog cannot hide the other accounts.
  // Attempt rowids provide a persistent admission order even with equal injected timestamps.
  return `WITH candidates AS (${candidates}), served AS (
    SELECT w.owner_id playerId,max(a.rowid) lastTurn FROM text_attempts a JOIN worlds w ON w.id=a.world_id GROUP BY w.owner_id
  ), ranked AS (
    SELECT candidates.*,row_number() OVER (PARTITION BY playerId ORDER BY ${order}) queueRank FROM candidates
    WHERE NOT EXISTS (SELECT 1 FROM beta_accounts a WHERE a.player_id=candidates.playerId AND a.status='suspended')
  ) SELECT ranked.* FROM ranked LEFT JOIN served USING(playerId)
    ORDER BY queueRank,coalesce(lastTurn,0),queuedAt,worldId,conversationId,characterId LIMIT 64`;
}
