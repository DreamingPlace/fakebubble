import { changedGroups, describeChange } from '../../../packages/contracts/web-character-history.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { upgradedProfile, type StoredWebCharacterProfile, type WebCharacterProfile } from './web-character-catalog.ts';

/**
 * Part 24b-7: 草稿记录. Every draft save is already an immutable row (web_character_revisions: the exact profile, when, and the
 * admin session that saved it). This reads the revisions of the CURRENT draft line (the ones written on the same live version the
 * draft stands on), newest first, and says who saved each one as a MARK: the member's place in the 管理员与权限 order (the same colour
 * and initial) and the label the owner gave them. Never an id, an email or a session id. Pure reads; nothing is written.
 */
export const DRAFT_HISTORY_SHOWN = 20;
/** How far back the per-group "last changed by" looks (the newest revisions of the line). */
const WALK = 200;
export const REMOVED_ADMIN = '已移除的管理员';

export type DraftHistoryBy = { index: number | null; initial: string; label: string };
export type DraftHistory = {
  characterId: string;
  draftRevision: number | null;
  revisions: { revision: number; savedAt: number; by: DraftHistoryBy; summary: string; profile: WebCharacterProfile }[];
  /** The profile just before the oldest listed revision (the live version it was based on, or the revision before it); null = none. */
  earlier: WebCharacterProfile | null;
  /** Per group in which the draft differs from live: the mark of the admin who last changed it. */
  groups: { group: string; by: DraftHistoryBy }[];
};

type Row = {
  revision: number;
  base_version: number | null;
  profile_json: string;
  created_at: number;
  session_id: string;
};
const parse = (json: string) => upgradedProfile(JSON.parse(json) as StoredWebCharacterProfile);

export function draftHistory(store: BusinessStore, id: string): DraftHistory {
  const head = store.get<{ revision: number; base_version: number | null }>(
    `SELECT r.revision,r.base_version FROM web_character_drafts d JOIN web_character_revisions r
      ON r.character_id=d.character_id AND r.revision=d.revision WHERE d.character_id=?`,
    id,
  );
  if (!head) return { characterId: id, draftRevision: null, revisions: [], earlier: null, groups: [] };
  // A discard ends a line (its revisions stay, as history, but are not part of the draft that follows).
  const discarded =
    store.get<{ n: number | null }>(
      `SELECT max(CAST(substr(action,length('character-draft-discarded:')+1) AS INTEGER)) n FROM web_admin_audit
        WHERE target_id=? AND action LIKE 'character-draft-discarded:%'`,
      id,
    )?.n ?? 0;
  const rows = store.all<Row>(
    `SELECT revision,base_version,profile_json,created_at,session_id FROM web_character_revisions
      WHERE character_id=? AND base_version IS ? AND revision>? AND revision<=? ORDER BY revision DESC LIMIT ?`,
    id,
    head.base_version,
    discarded,
    head.revision,
    WALK + 1,
  );
  const liveRow =
    head.base_version === null
      ? null
      : store.get<{ profile_json: string }>(
          'SELECT profile_json FROM web_character_versions WHERE character_id=? AND version=?',
          id,
          head.base_version,
        );
  const live = liveRow ? parse(liveRow.profile_json) : null;
  // The members in the order of the 管理员与权限 table; a session whose member is gone is 已移除的管理员.
  const members = store.all<{ id: string; label: string }>(
    'SELECT id,label FROM web_admin_members ORDER BY created_at,id',
  );
  const bySession = new Map(
    store
      .all<{ session_id: string; member_id: string }>('SELECT session_id,member_id FROM web_admin_session_members')
      .map((row) => [row.session_id, row.member_id]),
  );
  const markOf = (sessionId: string): DraftHistoryBy => {
    const memberId = bySession.get(sessionId),
      index = members.findIndex((member) => member.id === memberId);
    if (index < 0) return { index: null, initial: '·', label: REMOVED_ADMIN };
    const label = members[index]!.label;
    return { index, initial: [...label][0] ?? '·', label };
  };
  const walked = rows.slice(0, WALK);
  const profiles = rows.map((row) => parse(row.profile_json));
  // The profile each revision is compared with: the one before it in the line, and for the first of the line the live version.
  const before = (i: number) => (i + 1 < rows.length ? profiles[i + 1]! : live);
  const groups: DraftHistory['groups'] = [];
  const headProfile = profiles[0]!;
  const wanted = live ? changedGroups(live, headProfile) : changedGroups(emptyLike(headProfile), headProfile);
  for (const group of wanted) {
    for (let i = 0; i < walked.length; i++) {
      const prior = before(i);
      const changed = changedGroups(prior ?? emptyLike(profiles[i]!), profiles[i]!);
      if (changed.includes(group)) {
        groups.push({ group, by: markOf(walked[i]!.session_id) });
        break;
      }
    }
  }
  const shown = rows.slice(0, DRAFT_HISTORY_SHOWN);
  return {
    characterId: id,
    draftRevision: head.revision,
    revisions: shown.map((row, i) => ({
      revision: row.revision,
      savedAt: row.created_at,
      by: markOf(row.session_id),
      summary: describeChange(before(i), profiles[i]!),
      profile: profiles[i]!,
    })),
    earlier: before(shown.length - 1),
    groups,
  };
}
/** What "nothing yet" looks like to the group comparison: every group differs from it. */
const emptyLike = (profile: WebCharacterProfile): WebCharacterProfile => ({
  template: {
    ...profile.template,
    id: '',
    name: '',
    persona: '',
    seed: undefined,
    authorCanon: undefined,
    voice: undefined,
    birthDate: undefined,
  } as never,
  presentation: { displayName: '', publicDescription: '', welcomes: [] } as never,
});
