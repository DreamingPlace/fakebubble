import {
  CAST_KNOWLEDGE_LABEL,
  CAST_LIMITS,
  type CastCharacter,
  type CastDoc,
  type CastKnowledge,
  type CastPeriod,
  type CastView,
  type CastViewStory,
} from '../../../packages/contracts/web-cast.ts';
import { DomainError } from '../../../packages/domain/errors.ts';

/**
 * compileCastView (Part 24a): the one function that turns the cast document into what ONE character is told. Pure and
 * deterministic (no clock, no randomness, a fixed key order), and called by both the production prompt and the 预演.
 *
 * What the character gets: his own sections in full (including his hidden settings, marked "known to you, never state directly");
 * a compact card (names, aliases, one-liner) of every other character and person - never their hidden settings, 演绎说明 or
 * speech samples; his OUTGOING ratings, 称呼 and 相处 (nobody's feelings toward him); the groups he belongs to with their stories;
 * and only the stories he lived (亲历) or heard of (听说) - a 听说 story is its summary alone; the memes he is a party to.
 *
 * Knowledge rule for a story and a character (an override always wins):
 *   participant → 亲历; rating toward at least one participant >= 3 → 听说; otherwise 不知道 (the story is not in his view at all).
 * Group stories: every member lived them.
 */
export const CAST_HEARD_RATING = 3;

/** The documented order in which a view that is over CAST_LIMITS.viewMax gives things up, one item at a time. */
export const CAST_DROP_ORDER = [
  'memes: the last-listed first',
  'heard stories (听说): the oldest first (an undated one counts as the oldest)',
  'group stories: the oldest first',
  'lived stories (亲历): the oldest first',
  'relation texts (称呼 / 相处): of the lowest rating first (not set counts lowest), the later-listed first; the rating itself stays',
] as const;
/** Never dropped: the world background, the character's own sections, the cards of everyone else, the groups themselves, ratings. */

export interface CastKnowledgeRow {
  storyId: string;
  level: CastKnowledge;
  /** The level came from an override, not from the default rule. */
  fromOverride: boolean;
}

const find = (doc: CastDoc, characterId: string): CastCharacter => {
  const character = doc.characters.find((c) => c.characterId === characterId);
  if (!character) throw new DomainError('CAST_CHARACTER_NOT_IN_CAST');
  return character;
};

/** What this character knows of every story (all of them, 不知道 included): the console's table and the compiler's input. */
export function castKnowledge(doc: CastDoc, characterId: string): CastKnowledgeRow[] {
  find(doc, characterId);
  const row = doc.ratings[characterId] ?? {};
  return doc.stories.map((story) => {
    const override = story.overrides.find((o) => o.characterId === characterId);
    if (override) return { storyId: story.id, level: override.level, fromOverride: true };
    if (story.participants.includes(characterId)) return { storyId: story.id, level: 'lived', fromOverride: false };
    const heard = story.participants.some((id) => id !== characterId && (row[id] ?? -1) >= CAST_HEARD_RATING);
    return { storyId: story.id, level: heard ? 'heard' : 'unknown', fromOverride: false };
  });
}

const HIDDEN_RULE = '你知道这些设定，但绝不直接说出口。';

/** Oldest first: by period start (an undated story first), then by its place in the document. */
const byAge = <T extends { period: CastPeriod; index: number }>(a: T, b: T) =>
  a.period.start < b.period.start ? -1 : a.period.start > b.period.start ? 1 : a.index - b.index;

interface Parts {
  view: CastView;
  /** Parallel to view.stories / view.memes, for dropping. */
  storyAges: { period: CastPeriod; index: number }[];
  groupStoryAges: { period: CastPeriod; index: number; group: number; at: number }[];
  ratings: (number | null)[];
}

function build(doc: CastDoc, characterId: string): Parts {
  const self = find(doc, characterId);
  const label = new Map<string, string>();
  for (const c of doc.characters) label.set(c.characterId, c.identity.names[0]!.text);
  for (const p of doc.people) label.set(p.id, p.names[0]!.text);
  const nameOf = (id: string) => label.get(id) ?? id;

  const others: CastView['others'] = [
    ...doc.characters
      .filter((c) => c.characterId !== characterId)
      .map((c) => ({
        name: nameOf(c.characterId),
        names: c.identity.names.map((n) => n.text),
        aliases: c.identity.aliases.map((a) => a.text),
        oneLiner: c.identity.oneLiner,
      })),
    ...doc.people.map((p) => ({
      name: nameOf(p.id),
      names: p.names.map((n) => n.text),
      aliases: [] as string[],
      oneLiner: p.oneLiner,
    })),
  ];

  const targets = [
    ...doc.characters.map((c) => c.characterId).filter((id) => id !== characterId),
    ...doc.people.map((p) => p.id),
  ];
  const ratingRow = doc.ratings[characterId] ?? {};
  const ratings: (number | null)[] = [];
  const relations: CastView['relations'] = [];
  for (const id of targets) {
    const direction = doc.directions.find((d) => d.from === characterId && d.to === id);
    const rating = ratingRow[id];
    if (rating === undefined && !direction) continue;
    relations.push({
      to: nameOf(id),
      ...(rating === undefined ? {} : { rating }),
      ...(direction?.address ? { address: direction.address } : {}),
      ...(direction?.treatment ? { treatment: direction.treatment } : {}),
    });
    ratings.push(rating ?? null);
  }

  const groupStoryAges: Parts['groupStoryAges'] = [];
  const groups: CastView['groups'] = [];
  doc.groups.forEach((group, groupIndex) => {
    if (!group.members.includes(characterId)) return;
    const at = groups.length;
    group.stories.forEach((story, index) =>
      groupStoryAges.push({ period: story.period, index: groupIndex * 1000 + index, group: at, at: index }),
    );
    groups.push({
      name: group.name,
      members: group.members.map(nameOf),
      background: group.background,
      stories: group.stories.map((story) => ({
        title: story.title,
        level: CAST_KNOWLEDGE_LABEL.lived as '亲历',
        period: story.period,
        narrationBoundary: story.boundary,
        summary: story.summary,
        ...(story.details ? { details: story.details } : {}),
      })),
    });
  });

  const knowledge = castKnowledge(doc, characterId);
  const stories: CastViewStory[] = [];
  const storyAges: Parts['storyAges'] = [];
  doc.stories.forEach((story, index) => {
    const known = knowledge[index]!;
    if (known.level === 'unknown') return;
    stories.push({
      title: story.title,
      level: CAST_KNOWLEDGE_LABEL[known.level] as '亲历' | '听说',
      fromOverride: known.fromOverride,
      period: story.period,
      participants: story.participants.map(nameOf),
      narrationBoundary: story.boundary,
      summary: story.summary,
      ...(known.level === 'lived' && story.details ? { details: story.details } : {}),
    });
    storyAges.push({ period: story.period, index });
  });

  const memes: CastView['memes'] = doc.memes
    .filter((meme) => meme.parties.includes(characterId))
    .map((meme) => ({
      key: meme.key,
      parties: meme.parties.map(nameOf),
      meaning: meme.meaning,
      trigger: meme.trigger,
      prohibited: meme.prohibited,
    }));

  const prototype = self.identity.prototype;
  const view: CastView = {
    world: { background: doc.world.background },
    self: {
      name: nameOf(characterId),
      oneLiner: self.identity.oneLiner,
      names: self.identity.names.map((n) => n.text),
      aliases: self.identity.aliases.map((a) => ({ text: a.text, attitude: a.attitude })),
      selfConcept: self.identity.selfConcept,
      prototype: prototype
        ? { name: nameOf(prototype.personId), inherited: prototype.inherited, notInherited: prototype.notInherited }
        : null,
      profile: self.profile,
      personality: self.personality,
      speech: {
        catchphrases: self.speech.catchphrases.map((t) => t.text),
        samples: self.speech.samples.map((t) => t.text),
        avoid: self.speech.avoid.map((t) => t.text),
      },
      experiences: self.experiences.map((e) => ({ title: e.title, text: e.text })),
      performance: self.performance,
      hiddenSettings: { rule: HIDDEN_RULE, items: self.hidden.map((t) => t.text) },
    },
    others,
    relations,
    groups,
    stories,
    memes,
  };
  return { view, storyAges, groupStoryAges, ratings };
}

const size = (view: CastView) => JSON.stringify(view).length;

export interface CastCompiled {
  view: CastView;
  /** What the cap made the compiler leave out (counts only). */
  dropped: { memes: number; heardStories: number; groupStories: number; livedStories: number; relationTexts: number };
}

/** `max` is the cap (CAST_LIMITS.viewMax); a smaller one is for tests that exercise each step of the drop order. */
export function compileCastViewDetailed(
  doc: CastDoc,
  characterId: string,
  max: number = CAST_LIMITS.viewMax,
): CastCompiled {
  const { view, storyAges, groupStoryAges, ratings } = build(doc, characterId);
  const dropped = { memes: 0, heardStories: 0, groupStories: 0, livedStories: 0, relationTexts: 0 };
  // The oldest-first queues of what may still be dropped (indexes into view.stories / the groups' stories).
  const ageOf = (level: '听说' | '亲历') =>
    view.stories
      .map((story, at) => ({ story, at, ...storyAges[at]! }))
      .filter((item) => item.story.level === level)
      .sort(byAge)
      .map((item) => item.story);
  const heard = ageOf('听说'),
    lived = ageOf('亲历');
  const groupQueue = [...groupStoryAges].sort(byAge).map((item) => view.groups[item.group]!.stories[item.at]!);
  const withTexts = view.relations
    .map((relation, at) => ({ relation, at, rating: ratings[at] ?? -1 }))
    .filter((item) => item.relation.address !== undefined || item.relation.treatment !== undefined)
    .sort((a, b) => a.rating - b.rating || b.at - a.at);
  const remove = <T>(list: T[], item: T) => list.splice(list.indexOf(item), 1);
  while (size(view) > max) {
    if (view.memes.length) {
      view.memes.pop();
      dropped.memes++;
    } else if (heard.length) {
      remove(view.stories, heard.shift()!);
      dropped.heardStories++;
    } else if (groupQueue.length) {
      const story = groupQueue.shift()!;
      for (const group of view.groups) if (group.stories.includes(story)) remove(group.stories, story);
      dropped.groupStories++;
    } else if (lived.length) {
      remove(view.stories, lived.shift()!);
      dropped.livedStories++;
    } else if (withTexts.length) {
      const { relation } = withTexts.shift()!;
      delete relation.address;
      delete relation.treatment;
      dropped.relationTexts++;
    } else break;
  }
  return { view, dropped };
}

export const compileCastView = (doc: CastDoc, characterId: string): CastView =>
  compileCastViewDetailed(doc, characterId).view;

/** The size of a character's view with every droppable part gone: publishing requires it to fit. */
export function minimalViewSize(doc: CastDoc, characterId: string): number {
  const { view } = build(doc, characterId);
  view.memes = [];
  view.stories = [];
  for (const group of view.groups) group.stories = [];
  for (const relation of view.relations) {
    delete relation.address;
    delete relation.treatment;
  }
  return size(view);
}
