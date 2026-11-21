import type { CastView } from '../../../packages/contracts/web-cast.ts';
import {
  REHEARSAL_ITEMS_MAX,
  REHEARSAL_SET_LABELS,
  type RehearsalItem,
  type RehearsalProfileSet,
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
/**
 * Part 37a-2: 开场. The run starts from one of the character's welcome lines (with its 情境 note), so these are the player's first
 * five replies to it: who are you, why did you add me, a question about a teammate, small talk, a goodbye. The same five for every
 * character; what is per character is the welcome line (and note) the conversation starts from.
 */
const OPENING: readonly string[] = [
  '你是谁呀？',
  '你为什么加我？',
  '你们团队里是不是还有别人？跟我说说其中一个呗',
  '那你平时都爱干嘛',
  '好啦我先去忙了，下次聊',
];
/**
 * Part 37b: one short script per 说话档案 situation, in the players' own voice (young, trend-aware, casual). Four turns each: enough
 * to see whether the character answers THIS kind of moment in her own way. Written so the situation picker of the 新+档案 writer
 * (writer-profile.ts) reads every turn as the script's situation; a unit test holds that.
 */
const PROFILE: Readonly<Record<string, readonly string[]>> = {
  'profile-daily': ['在吗，随便聊聊呗', '你今天心情怎么样', '最近有什么好玩的事吗', '晚上你一般几点睡'],
  'profile-tease': [
    '哈哈哈你这人也太会了吧',
    '笑死，你是不是又在装',
    '行行行，你最厉害，满意了吧',
    '就这？我还以为你多厉害呢',
  ],
  'profile-complain': [
    '今天又加班到十点，打工人真的破防了',
    '地铁挤死我了，人也太多了',
    '老板又临时加需求，无语了',
    '这个天气热死了，一点都不想出门',
  ],
  'profile-comfort': [
    '今天有点难过，说不上来为什么',
    '我好像又搞砸了一件事',
    '最近老是睡不着，emo 了',
    '被领导说了一顿，有点委屈😭',
  ],
  'profile-fight': ['你够了吧，别再说了', '你凭什么这样说我', '我真的受够了，不想跟你说了', '你再说一遍试试'],
  'profile-share': [
    '今天终于把那本书看完了',
    '刚刚路过一家新开的奶茶店，排了好长的队',
    '周末去爬山了，风景绝绝子',
    '我家猫昨晚又半夜跑酷了',
  ],
  'profile-inside': ['还记得上次那个梗吗', '又来了又来了，老规矩', '你的口头禅我都会背了', '懂的都懂，嘿嘿'],
  'profile-serious': [
    '我想认真问你一件事',
    '你觉得我该不该辞职',
    '说实话我最近有点迷茫，不知道未来该怎么办',
    '谢谢你听我说，这对我很重要',
  ],
};
const SETS: Readonly<Record<RehearsalSet, readonly string[]>> = {
  chat: CHAT,
  repeat: REPEAT,
  opening: OPENING,
  ...(PROFILE as Record<RehearsalProfileSet, readonly string[]>),
};

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
