import {
  CAST_KNOWLEDGE,
  type CastCharacter,
  type CastDoc,
  type CastPerson,
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

/**
 * Heat scale for the grid: index 0 (0 stars) to 10 (5 stars). The darkest step is still light enough for the ink (#2B2833) to read
 * on it at 4.5:1, because every cell carries its number.
 */
export const HEAT = [
  '#F7F4F0',
  '#FDEEF4',
  '#FCE0EB',
  '#FAD1E2',
  '#F8C2D8',
  '#F6B3CE',
  '#F4A4C4',
  '#F296BB',
  '#F087B1',
  '#EE78A8',
  '#EC6FA2',
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

const FIELD_LABEL: Record<string, string> = {
  identity: '身份',
  names: '名字',
  aliases: '别名',
  oneLiner: '一句话',
  selfConcept: '自我认知',
  profile: '简介',
  personality: '性格',
  speech: '说话方式',
  catchphrases: '口头禅',
  samples: '说话样例',
  avoid: '不会这样说',
  experiences: '经历',
  performance: '演绎说明',
  hidden: '不公开设定',
  members: '成员',
  participants: '参与者',
  overrides: '手动设置',
  period: '时间段',
  title: '标题',
  summary: '概要',
  details: '细节',
  boundary: '叙述边界',
  background: '背景',
  name: '名称',
  from: '谁',
  to: '对谁',
  address: '称呼',
  treatment: '相处',
};
/**
 * An issue's path ("characters[c01].identity.names", "stories[2].participants[1]") as people read it: ids and indexes become the
 * character's name, the story's title or the group's name. `who` is the character it is about (null: nothing in particular), so
 * the page can group a long list by character.
 */
export function humanIssue(doc: CastDoc, path: string): { who: string | null; where: string } {
  const pick = <T>(list: T[], key: string, idOf: (item: T) => string): T | undefined =>
    list.find((item) => idOf(item) === key) ?? (/^\d+$/.test(key) ? list[Number(key)] : undefined);
  let who: string | null = null;
  const parts: string[] = [];
  for (const [, head, key = '', rest = ''] of path.matchAll(/([A-Za-z]+)(?:\[([^\]]*)\])?((?:\.[A-Za-z]+)*)/g)) {
    if (head === 'characters' || head === 'people') {
      const character = pick(doc.characters, key, (c) => c.characterId);
      const person = pick(doc.people, key, (p) => p.id);
      const label = nameOf(doc, character?.characterId ?? person?.id ?? key);
      if (head === 'characters') who ??= label;
      else parts.push(label);
    } else if (head === 'groups') {
      const group = pick(doc.groups, key, (g) => g.id);
      parts.push(group ? `组合「${group.name}」` : '组合');
    } else if (head === 'stories') {
      const story = pick(doc.stories, key, (g) => g.id);
      parts.push(story ? `故事「${story.title}」` : '故事');
    } else if (head === 'ratings' || head === 'directions') {
      const name = nameOf(doc, key);
      if (key) who ??= name;
      parts.push(head === 'ratings' ? '星级' : '称呼与相处');
    } else if (head) {
      const label = FIELD_LABEL[head];
      if (label) parts.push(label);
      else if (key) parts.push(nameOf(doc, key));
    }
    for (const field of rest.split('.').filter(Boolean)) if (FIELD_LABEL[field]) parts.push(FIELD_LABEL[field]!);
  }
  return { who, where: parts.join(' · ') };
}

/** A rating as it is printed in a grid cell: 4, 3.5, 0. */
export const ratingShort = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

/** A character that joins the cast: an id (from 角色工作台's 新建角色) and a name; everything else starts empty. */
export const blankCharacter = (characterId: string, name: string): CastCharacter => ({
  characterId,
  identity: { oneLiner: '', names: [{ id: '', text: name }], aliases: [], selfConcept: '', prototype: null },
  profile: '',
  personality: '',
  speech: { catchphrases: [], samples: [], avoid: [] },
  experiences: [],
  performance: '',
  hidden: [],
  unmapped: '',
});
/** A person who is not a chat character. The `new-` id is a token the server turns into a real id (and into every reference to it). */
export const blankPerson = (name: string, kind: CastPerson['kind'] = 'person'): CastPerson => ({
  id: `new-${(globalThis.crypto?.randomUUID?.() ?? String(Math.random())).replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`,
  kind,
  names: [{ id: '', text: name }],
  oneLiner: '',
});

/** Takes a character out of the cast and out of everything that mentions them. */
export function removeCharacter(doc: CastDoc, id: string) {
  doc.characters = doc.characters.filter((c) => c.characterId !== id);
  delete doc.ratings[id];
  for (const [from, row] of Object.entries(doc.ratings)) {
    delete row[id];
    if (!Object.keys(row).length) delete doc.ratings[from];
  }
  doc.directions = doc.directions.filter((d) => d.from !== id && d.to !== id);
  for (const group of doc.groups) group.members = group.members.filter((m) => m !== id);
  for (const story of doc.stories) {
    story.participants = story.participants.filter((p) => p !== id);
    story.overrides = story.overrides.filter((o) => o.characterId !== id);
  }
  for (const meme of doc.memes) meme.parties = meme.parties.filter((p) => p !== id);
}
/** Takes a person out of the cast and out of everything that mentions them (a character modelled on them loses that link). */
export function removePerson(doc: CastDoc, id: string) {
  doc.people = doc.people.filter((p) => p.id !== id);
  for (const [from, row] of Object.entries(doc.ratings)) {
    delete row[id];
    if (!Object.keys(row).length) delete doc.ratings[from];
  }
  doc.directions = doc.directions.filter((d) => d.from !== id && d.to !== id);
  for (const story of doc.stories) story.participants = story.participants.filter((p) => p !== id);
  for (const meme of doc.memes) meme.parties = meme.parties.filter((p) => p !== id);
  for (const character of doc.characters)
    if (character.identity.prototype?.personId === id) character.identity.prototype = null;
}
