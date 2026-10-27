import {
  CAST_KNOWLEDGE,
  type CastDoc,
  type CastGroup,
  type CastGroupStory,
  type CastKnowledge,
  type CastStory,
} from '../../../../../../packages/contracts/web-cast.ts';

/**
 * The cast document as the 关系与故事 page edits it. Everything here works on a plain CastDoc and changes it in place
 * (the page owns one working copy); nothing touches the network. The rules mirror apps/server/cast/: a rating is one-way and
 * on a 0.5 grid, "not set" is the ABSENCE of an entry (not 0), and knowledge defaults follow castKnowledge().
 */
export const RATING_STEP = 0.5;
/** A character rated at least this much toward a participant has heard of the story (the 24a rule, CAST_HEARD_RATING). */
export const HEARD_RATING = 3;

export const ratingOf = (doc: CastDoc, from: string, to: string): number | null => doc.ratings[from]?.[to] ?? null;

/** Sets how `from` feels about `to`; null removes the entry (not set). A row left empty is removed as well. */
export function setRating(doc: CastDoc, from: string, to: string, value: number | null) {
  if (from === to) return;
  if (value === null) {
    const row = doc.ratings[from];
    if (!row) return;
    delete row[to];
    if (!Object.keys(row).length) delete doc.ratings[from];
    return;
  }
  const snapped = Math.min(5, Math.max(0, Math.round(value / RATING_STEP) * RATING_STEP));
  (doc.ratings[from] ??= {})[to] = snapped;
}

/** 0-5 in 0.5 steps → 0-10, the index into the heat scale. Not set has no index. */
export const heatIndex = (value: number | null) => (value === null ? null : Math.round(value * 2));

/** How much of star n (1-5) is filled by a rating: 1, 0.5 or 0. */
export const starFill = (value: number | null, n: number): 0 | 0.5 | 1 =>
  value === null ? 0 : value >= n ? 1 : value >= n - 0.5 ? 0.5 : 0;

/** The value a click on the left (half) or right (whole) of star n sets. */
export const starValue = (n: number, half: boolean) => (half ? n - 0.5 : n);

export const ratingText = (value: number | null) => (value === null ? '未设置' : value === 0 ? '0' : value.toFixed(1));

export function nameOf(doc: CastDoc, id: string): string {
  const character = doc.characters.find((c) => c.characterId === id);
  if (character) return character.identity.names[0]?.text ?? id;
  return doc.people.find((p) => p.id === id)?.names[0]?.text ?? id;
}

/** What a character knows of a story when nobody has overridden it: participants lived it, a rating >= 3 toward one has heard of it. */
export function defaultKnowledge(doc: CastDoc, story: CastStory, characterId: string): CastKnowledge {
  if (story.participants.includes(characterId)) return 'lived';
  const row = doc.ratings[characterId] ?? {};
  return story.participants.some((id) => id !== characterId && (row[id] ?? -1) >= HEARD_RATING) ? 'heard' : 'unknown';
}
export function knowledgeOf(doc: CastDoc, story: CastStory, characterId: string) {
  const override = story.overrides.find((o) => o.characterId === characterId);
  return override
    ? { level: override.level, fromOverride: true }
    : { level: defaultKnowledge(doc, story, characterId), fromOverride: false };
}
/** The next level when a cell is clicked: 亲历 → 听说 → 不知道 → 亲历. */
export const nextKnowledge = (level: CastKnowledge): CastKnowledge =>
  CAST_KNOWLEDGE[(CAST_KNOWLEDGE.indexOf(level) + 1) % CAST_KNOWLEDGE.length]!;

/** Overrides the level for one character; choosing what the default already is just clears the override. */
export function setKnowledge(doc: CastDoc, story: CastStory, characterId: string, level: CastKnowledge) {
  const index = story.overrides.findIndex((o) => o.characterId === characterId);
  if (level === defaultKnowledge(doc, story, characterId)) {
    if (index >= 0) story.overrides.splice(index, 1);
    return;
  }
  if (index >= 0) story.overrides[index]!.level = level;
  else story.overrides.push({ id: '', characterId, level });
}
/** Back to the computed default. */
export function clearKnowledge(story: CastStory, characterId: string) {
  const index = story.overrides.findIndex((o) => o.characterId === characterId);
  if (index >= 0) story.overrides.splice(index, 1);
}

export const directionOf = (doc: CastDoc, from: string, to: string) =>
  doc.directions.find((d) => d.from === from && d.to === to) ?? null;
/** 称呼 / 相处 of `from` toward `to`. An entry whose two texts are both empty is not kept. */
export function setDirection(doc: CastDoc, from: string, to: string, field: 'address' | 'treatment', value: string) {
  let entry = directionOf(doc, from, to);
  if (!entry) {
    if (!value) return;
    entry = { id: '', from, to, address: '', treatment: '' };
    doc.directions.push(entry);
  }
  entry[field] = value;
  if (!entry.address && !entry.treatment) doc.directions.splice(doc.directions.indexOf(entry), 1);
}

export const blankPeriod = () => ({ start: '', end: '' });
export const blankStory = (participants: string[] = []): CastStory => ({
  id: '',
  title: '新故事',
  summary: '',
  details: '',
  period: blankPeriod(),
  participants,
  boundary: '',
  overrides: [],
});
export const blankGroupStory = (): CastGroupStory => ({
  id: '',
  title: '新组合故事',
  summary: '',
  details: '',
  period: blankPeriod(),
  boundary: '',
});
export const blankGroup = (members: string[] = []): CastGroup => ({
  id: '',
  name: '新组合',
  members,
  background: '',
  stories: [],
});

export const sharedGroups = (doc: CastDoc, a: string, b: string) =>
  doc.groups.filter((g) => g.members.includes(a) && g.members.includes(b));
export const storiesOfPair = (doc: CastDoc, a: string, b: string) =>
  doc.stories.filter((s) => s.participants.includes(a) && s.participants.includes(b));

/** Heat scale for the grid: index 0 (0 stars) to 10 (5 stars). */
export const HEAT = [
  '#F7F4F0',
  '#FDEBF2',
  '#FBD7E6',
  '#F9C2D9',
  '#F6ADCB',
  '#F398BE',
  '#EF82B0',
  '#E96BA1',
  '#E15492',
  '#D63C82',
  '#C92370',
] as const;
/** Pastel per member, stable by position in the cast (the avatar dots; no character colours are stored in the cast). */
export const DOTS = [
  '#FFB295',
  '#97C8F5',
  '#BBA4FF',
  '#F5C26B',
  '#9ED9B8',
  '#F59EC0',
  '#8FD3E8',
  '#C9B6F2',
  '#FFCF9E',
  '#A7D49B',
  '#F2A6A6',
  '#9DB8F5',
  '#E6C17A',
  '#B5E0D0',
  '#D8A9E8',
] as const;

export const KNOWLEDGE_LABEL: Record<CastKnowledge, string> = { lived: '亲历', heard: '听说', unknown: '不知道' };

/** Friendly spelling of the codes validation returns; a code this table does not know is shown as it is. */
export const ISSUE_LABEL: Record<string, string> = {
  CAST_SHAPE: '内容格式或长度不符',
  CAST_DUPLICATE_ID: '重复的编号',
  CAST_UNKNOWN_CHARACTER: '引用了阵容里没有的角色',
  CAST_UNKNOWN_PERSON: '引用了不存在的人物',
  CAST_SELF_RATING: '不能给自己评分',
  CAST_SELF_RELATION: '不能给自己写称呼和相处',
  CAST_RATING_OUT_OF_GRID: '评分必须在 0–5 星、以半星为单位',
  CAST_DUPLICATE_DIRECTION: '同一个方向写了两份称呼和相处',
  CAST_DUPLICATE_MEMBER: '组合里有重复的成员',
  CAST_DUPLICATE_PARTICIPANT: '故事里有重复的参与者',
  CAST_DUPLICATE_OVERRIDE: '同一个角色有两条手动设置',
  CAST_PERIOD_ORDER: '时间段的开始晚于结束',
  CAST_CHARACTER_MISSING: '角色还没有建立',
  CAST_CHARACTER_DELETED: '角色已被删除',
  CAST_VIEW_TOO_LARGE: '这个角色看到的内容太长',
  CAST_DOC_TOO_LARGE: '整份资料太长',
  CAST_EMPTY: '阵容里还没有角色',
  CAST_GROUP_TOO_SMALL: '组合不足两人',
  CAST_DUPLICATE_NAME: '有角色重名',
};
