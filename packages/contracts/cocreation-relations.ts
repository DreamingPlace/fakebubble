/**
 * Part 39: co-creation for the shared world. A player picks two to eight characters; a pair rates A 对 B and B 对 A in whole stars and
 * says why; every submission carries a story. Everything here is shared canon: it never becomes a player-private story. The stars are
 * OPINIONS collected for the administrators: they are never written into the cast's ratings grid (only an administrator sets stars).
 */
export const RELATION_MIN_MEMBERS = 2;
export const RELATION_MAX_MEMBERS = 8;
export const RELATION_TEXT_MAX = 600;
export const RELATION_REASON_MAX = 200;
/** Exactly these words, one line each, the same length on purpose (the label under the stars of the sheet). */
export const RELATION_STAR_LABELS: readonly string[] = Object.freeze([
  '水火不容',
  '话不投机',
  '点头之交',
  '结伴同行',
  '形影不离',
  '暗生情愫',
]);
export type RelationRating = { from: string; to: string; stars: number };

/** What the cast limits can refuse when an adoption writes into the cast draft (each has its own code and sentence). */
export const RELATION_ADOPT_ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  COCREATION_GROUP_STORIES_FULL: '这个组合的故事已满 8 条，不能再采纳。',
  COCREATION_GROUPS_FULL: '组合已满 120 个，不能新建组合。',
  COCREATION_STORY_TOO_LONG: '故事超过 600 字，请先删减再采纳。',
  COCREATION_GROUP_NAME_INVALID: '组合名需要 1–30 个字，不能换行。',
  COCREATION_CAST_DOC_FULL: '世界设定草稿已达到大小上限，不能再加入。',
  COCREATION_ALREADY_DECIDED: '这条已经采纳或不采纳过了。',
  COCREATION_NOT_RELATION: '这条不是关系与故事的投稿。',
  COCREATION_TEXT_INVALID: '故事不能为空，也不能含控制字符。',
  CAST_REVISION_CONFLICT: '世界设定草稿刚刚有了新的保存，请重新打开后再采纳。',
});
