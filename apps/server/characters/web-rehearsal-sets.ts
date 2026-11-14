import type { CastView } from '../../../packages/contracts/web-cast.ts';
import {
  REHEARSAL_ITEMS_MAX,
  REHEARSAL_SET_LABELS,
  type RehearsalItem,
  type RehearsalSet,
  type RehearsalSetView,
} from '../../../packages/contracts/web-rehearsal.ts';

/**
 * Part 35: the built-in sets. Plain player lines, written once here; the administrator's own scripts live in the database.
 * There is no 连发 set: a turn carries one message (see packages/contracts/web-rehearsal.ts).
 */
const CHAT: readonly string[] = [
  '嗨，在干嘛呢',
  '今天有点无聊，你呢',
  '刚吃完饭，你吃了吗',
  '我最近在追一部剧，你有在看什么吗',
  '周末你一般怎么过',
  '突然想吃火锅了',
  '今天下班路上堵死了',
  '好啦我要去洗碗了，回头聊',
];
/** A long conversation that keeps coming back to one topic (the cat), with other talk in between. */
const REPEAT: readonly string[] = [
  '我家猫今天又把杯子推下桌了',
  '对了你平时喜欢做什么',
  '说回猫，它最近特别爱半夜跑酷',
  '你今天忙不忙',
  '它昨晚三点又在客厅狂奔',
  '你觉得猫为什么总爱推东西',
  '我在想要不要给它买个新玩具',
  '周末有什么打算吗',
  '我还是觉得猫半夜跑酷是在向我示威',
  '你有养过什么吗',
  '所以猫到底为什么半夜发疯',
  '算了不聊猫了……不过它又去推杯子了',
];
const SETS: Readonly<Record<RehearsalSet, readonly string[]>> = { chat: CHAT, repeat: REPEAT };

export const builtinSet = (set: RehearsalSet): string[] => [...SETS[set]];
export const builtinSets = (): RehearsalSetView[] =>
  (Object.keys(SETS) as RehearsalSet[]).map((set) => ({
    set,
    label: REHEARSAL_SET_LABELS[set],
    turns: builtinSet(set),
  }));

const MEME = 'meme:';
const STORY = 'story:';
/** The memes and stories the character knows in a cast view: every meme he is a party to, every story he lived or heard of. */
export function memeItems(view: CastView): RehearsalItem[] {
  return [
    ...view.memes.map((m) => ({ key: `${MEME}${m.key}`, kind: 'meme' as const, label: m.key })),
    ...view.stories.map((s) => ({ key: `${STORY}${s.title}`, kind: 'story' as const, label: s.title })),
  ];
}

/** What the hint writer and the judge are told about one item (the data the cast view holds, nothing else). */
export function itemSpec(view: CastView, key: string): Record<string, unknown> | null {
  if (key.startsWith(MEME)) {
    const meme = view.memes.find((m) => `${MEME}${m.key}` === key);
    return meme
      ? { kind: '梗', key: meme.key, meaning: meme.meaning, when: meme.trigger, avoid: meme.prohibited }
      : null;
  }
  const story = view.stories.find((s) => `${STORY}${s.title}` === key);
  return story
    ? {
        kind: '故事',
        title: story.title,
        identity: story.level,
        summary: story.summary,
        boundary: story.narrationBoundary,
      }
    : null;
}
/** Words a hint must not contain: the item's own name and every name the view gives to people. */
export function forbiddenWords(view: CastView, key: string): string[] {
  const own = key.startsWith(MEME) ? key.slice(MEME.length) : key.slice(STORY.length);
  const names = [view.self.name, ...view.self.names, ...view.self.aliases.map((a) => a.text)];
  for (const other of view.others) names.push(other.name, ...other.names, ...other.aliases);
  return [own, ...names].filter((word) => typeof word === 'string' && word.trim().length > 0);
}

/**
 * The order of the turns of a 梗与故事 run: every item's first hint, then every look-alike, then every second hint, so the same
 * item is never asked twice in a row. `items` are at most REHEARSAL_ITEMS_MAX.
 */
export function memeTurnPlan(
  items: readonly string[],
): Array<{ item: string; role: 'hint' | 'negative'; index: 0 | 1 }> {
  const plan: Array<{ item: string; role: 'hint' | 'negative'; index: 0 | 1 }> = [];
  for (const item of items) plan.push({ item, role: 'hint', index: 0 });
  for (const item of items) plan.push({ item, role: 'negative', index: 0 });
  for (const item of items) plan.push({ item, role: 'hint', index: 1 });
  return plan;
}
export const memeItemsAllowed = (count: number) => count >= 2 && count <= REHEARSAL_ITEMS_MAX;
