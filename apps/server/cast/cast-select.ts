import { CAST_LIMITS, type CastView } from '../../../packages/contracts/web-cast.ts';

/**
 * Part 37c-1: the per-reply cast context of 新+档案+梗. With a cast of hundreds of stories and inside jokes a reply cannot carry them
 * all, so it SELECTS, deterministically and without a model call, from everything the character knows (compileFullView):
 *
 *   relevant = the item's parties / participants include someone the player's recent messages mention (by name or alias), OR a
 *              trigger word of the item (an inside joke's key and trigger, a story's title) appears in them;
 *   always-on = the character's two most recent lived stories (by period start; an undated one counts as the oldest);
 *   a group (its name, members, background) is kept when one of its stories was selected, another member is mentioned or its name
 *   appears in the messages.
 *
 * The items together stay within CAST_SELECT_BUDGET characters (JSON length). Order of picking: always-on first, then by score
 * (3 per mentioned party, +4 for a trigger word), 亲历 before 听说, then the document's own order; an item that does not fit with its
 * details is tried as its summary alone, else skipped. The result keeps the document's order (stable): the same input gives the same
 * view, byte for byte. The fixed part of the view (name cards, 称呼 / 相处, the world background) is not selected: it is what the
 * 24a view always carried, and the whole view still never exceeds CAST_LIMITS.viewMax.
 */
export const CAST_SELECT_BUDGET = 4_000;
export const CAST_ALWAYS_ON = 2;
/** The player's last messages scanned for names and trigger words (the latest and the two before it). */
export const CAST_SELECT_TURNS = 3;
export const CAST_SCORE_MENTION = 3;
export const CAST_SCORE_TRIGGER = 4;
/** A trigger word / title segment shorter than this (code points) is not searched for. */
export const CAST_TRIGGER_MIN = 2;

export const castSelectFingerprint = () => [
  SPLIT.source,
  CAST_SELECT_BUDGET,
  CAST_ALWAYS_ON,
  CAST_SELECT_TURNS,
  CAST_SCORE_MENTION,
  CAST_SCORE_TRIGGER,
  CAST_TRIGGER_MIN,
  CAST_LIMITS.viewMax,
];

const fold = (text: string) => text.normalize('NFKC').toLowerCase();
const size = (value: unknown) => JSON.stringify(value).length;
/** Trigger text is free prose (「下雨或有人没带伞时」): it is cut at punctuation and at these common joining characters into words. */
const SPLIT =
  /[\s，。、；：:;,.!?！？/|·（）()「」『』"'“”‘’…~～-]+|[或和与及时的了在是有没不就都也被把让对给向从到当]/u;
const words = (text: string) =>
  [...new Set(text.split(SPLIT).map((part) => fold(part)))].filter(
    (part) => [...part].length >= CAST_TRIGGER_MIN && [...part].length <= 14,
  );

type Kind = 'story' | 'groupStory' | 'meme';
interface Item {
  kind: Kind;
  /** Position in the document order (story / meme index; for a group story: group index then story index). */
  order: number;
  group: number;
  at: number;
  cost: number;
  summaryCost: number;
  score: number;
  lived: boolean;
  start: string;
}

/** Which items of a full view were picked: indexes into its stories / groups / memes, and whether a story keeps its details. */
export interface CastPicked {
  stories: Map<number, 'full' | 'summary'>;
  /** group index -> its picked stories (an entry with no stories is a header kept on its own) */
  groups: Map<number, Map<number, 'full' | 'summary'>>;
  memes: Set<number>;
}

/** Everything of two picks: an item picked in either, with its details when either kept them. */
export function unionPicked(a: CastPicked, b: CastPicked): CastPicked {
  const how = (x?: 'full' | 'summary', y?: 'full' | 'summary') => (x === 'full' || y === 'full' ? 'full' : 'summary');
  const stories = new Map(a.stories);
  for (const [at, h] of b.stories) stories.set(at, how(stories.get(at), h));
  const groups = new Map([...a.groups].map(([g, m]) => [g, new Map(m)] as const));
  for (const [g, m] of b.groups) {
    const into = groups.get(g) ?? new Map<number, 'full' | 'summary'>();
    for (const [at, h] of m) into.set(at, how(into.get(at), h));
    groups.set(g, into);
  }
  return { stories, groups, memes: new Set([...a.memes, ...b.memes]) };
}

export const emptyPicked = (): CastPicked => ({ stories: new Map(), groups: new Map(), memes: new Set() });

/** The view holding exactly `picked`, in the document's order. */
export function castViewOf(full: CastView, picked: CastPicked): CastView {
  const stripped = <T extends { details?: string }>(story: T, how: 'full' | 'summary'): T => {
    if (how === 'full') return story;
    const { details: _details, ...rest } = story;
    return rest as T;
  };
  return {
    ...full,
    stories: full.stories.flatMap((story, at) =>
      picked.stories.has(at) ? [stripped(story, picked.stories.get(at)!)] : [],
    ),
    groups: full.groups.flatMap((group, g) => {
      const mine = picked.groups.get(g);
      if (!mine) return [];
      return [
        {
          ...group,
          stories: group.stories.flatMap((story, at) => (mine.has(at) ? [stripped(story, mine.get(at)!)] : [])),
        },
      ];
    }),
    memes: full.memes.filter((_, at) => picked.memes.has(at)),
  };
}

export const selectCastView = (
  full: CastView,
  messages: readonly string[],
  budget: number = CAST_SELECT_BUDGET,
): CastView => castViewOf(full, pickCastItems(full, messages, budget));

export function pickCastItems(
  full: CastView,
  /** The player's messages, latest first (more than CAST_SELECT_TURNS are ignored). */
  messages: readonly string[],
  budget: number = CAST_SELECT_BUDGET,
): CastPicked {
  const text = messages.slice(0, CAST_SELECT_TURNS).map(fold).join('\n');
  const self = full.self.name;
  // Everyone the messages mention, as the display name the view uses for them.
  const mentioned = new Set<string>();
  for (const card of full.others) {
    const handles = [card.name, ...card.names, ...card.aliases].map(fold).filter((h) => [...h].length >= 2);
    if (handles.some((handle) => text.includes(handle))) mentioned.add(card.name);
  }
  mentioned.delete(self);
  const hit = (parties: readonly string[]) => parties.filter((party) => mentioned.has(party)).length;
  const trigger = (parts: readonly string[]) => parts.some((part) => text.includes(part));

  const items: Item[] = [];
  const stories = full.stories;
  stories.forEach((story, order) =>
    items.push({
      kind: 'story',
      order,
      group: -1,
      at: order,
      cost: size(story),
      summaryCost: size({ ...story, details: undefined }),
      score: CAST_SCORE_MENTION * hit(story.participants) + (trigger(words(story.title)) ? CAST_SCORE_TRIGGER : 0),
      lived: story.level === '亲历',
      start: story.period.start,
    }),
  );
  full.groups.forEach((group, g) => {
    const groupHit = hit(group.members) + (trigger(words(group.name)) ? 1 : 0);
    group.stories.forEach((story, at) =>
      items.push({
        kind: 'groupStory',
        order: stories.length + g * 1000 + at,
        group: g,
        at,
        cost: size(story),
        summaryCost: size({ ...story, details: undefined }),
        score: CAST_SCORE_MENTION * groupHit + (trigger(words(story.title)) ? CAST_SCORE_TRIGGER : 0),
        lived: true,
        start: story.period.start,
      }),
    );
  });
  full.memes.forEach((meme, order) =>
    items.push({
      kind: 'meme',
      order: stories.length + 1_000_000 + order,
      group: -1,
      at: order,
      cost: size(meme),
      summaryCost: size(meme),
      score:
        CAST_SCORE_MENTION * hit(meme.parties) +
        (trigger([...words(meme.trigger), ...words(meme.key)]) ? CAST_SCORE_TRIGGER : 0),
      lived: true,
      start: '',
    }),
  );

  const fixed = { ...full, groups: [], stories: [], memes: [] } as CastView;
  let room = Math.max(0, Math.min(budget, CAST_LIMITS.viewMax - size(fixed)));
  const chosen = new Map<Item, 'full' | 'summary'>();
  const take = (item: Item) => {
    if (chosen.has(item)) return;
    // A group story also pays for its group's header the first time the group is used.
    const header = item.kind === 'groupStory' && !headerPaid.has(item.group) ? headerCost(item.group) : 0;
    if (item.cost + header <= room) {
      chosen.set(item, 'full');
      room -= item.cost + header;
      if (header) headerPaid.add(item.group);
    } else if (item.kind !== 'meme' && item.summaryCost + header <= room) {
      chosen.set(item, 'summary');
      room -= item.summaryCost + header;
      if (header) headerPaid.add(item.group);
    }
  };
  const headerPaid = new Set<number>();
  const headerCost = (g: number) => size({ ...full.groups[g]!, stories: [] });

  // 1. always-on: the two most recent lived stories.
  [...items]
    .filter((item) => item.kind === 'story' && item.lived)
    .sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : a.order - b.order))
    .slice(0, CAST_ALWAYS_ON)
    .forEach(take);
  // 2. relevant items, best first.
  [...items]
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.lived) - Number(a.lived) || a.order - b.order)
    .forEach(take);
  // 3. a group header alone, when it is relevant by itself (another member mentioned / its name in the messages) and room is left.
  full.groups.forEach((group, g) => {
    if (headerPaid.has(g)) return;
    const relevant = hit(group.members) > 0 || trigger(words(group.name));
    if (relevant && headerCost(g) <= room) {
      room -= headerCost(g);
      headerPaid.add(g);
    }
  });

  const picked: CastPicked = emptyPicked();
  for (const [item, how] of chosen) {
    if (item.kind === 'story') picked.stories.set(item.at, how);
    else if (item.kind === 'meme') picked.memes.add(item.at);
  }
  for (const [item, how] of chosen)
    if (item.kind === 'groupStory') {
      const mine = picked.groups.get(item.group) ?? new Map<number, 'full' | 'summary'>();
      mine.set(item.at, how);
      picked.groups.set(item.group, mine);
    }
  for (const g of headerPaid) if (!picked.groups.has(g)) picked.groups.set(g, new Map());
  return picked;
}
