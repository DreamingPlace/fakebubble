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
import { ISSUE_LABEL, humanIssue, nameOf } from '../../../../../../packages/contracts/web-cast-text.ts';

export { ISSUE_LABEL, humanIssue, nameOf };

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
