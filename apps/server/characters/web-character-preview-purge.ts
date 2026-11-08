import type { BusinessStore } from '../platform/store-contract.ts';
import { purgeAdminSpeechAudio } from './web-admin-speech-schema.ts';

/**
 * Character deletion (schema 119): the admin-only workbench data of the character goes with it, in the deletion's own
 * transaction: the 试听 audio of the admin speech path (Part 24k-1), rejected model output, simulated-time marks, run items and runs. The previews themselves and their
 * billing ledger are not touched here (the ledger rows are immutable by design). Eval sets are global and not
 * per character, so they stay. A database older than 119 has none of these tables.
 */
export function purgePreviewWorkbench(store: BusinessStore, characterId: string) {
  // Part 24k-1: the admin-only audio of the character's 试听 and generated clips goes with them (the ledger keeps the bills).
  purgeAdminSpeechAudio(store, { characterId });
  if (!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_preview_rejected'")) return;
  const mine = 'SELECT id FROM admin_previews WHERE character_id=?';
  store.run(`DELETE FROM web_preview_rejected WHERE preview_id IN (${mine})`, characterId);
  store.run(`DELETE FROM web_preview_marks WHERE preview_id IN (${mine})`, characterId);
  store.run(`DELETE FROM web_preview_run_items WHERE preview_id IN (${mine})`, characterId);
  store.run('DELETE FROM web_preview_runs WHERE character_id=?', characterId);
}
