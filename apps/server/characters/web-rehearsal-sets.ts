import type { CastView } from '../../../packages/contracts/web-cast.ts';
import {
  REHEARSAL_ITEMS_MAX,
  REHEARSAL_SET_LABELS,
  type RehearsalItem,
  type RehearsalNetSet,
  type RehearsalProfileSet,
  type RehearsalRulesNameSet,
  type RehearsalRulesToneSet,
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
/** Part 37c-1: players talking with 2022+ internet memes (every turn holds at least one entry of the shipped dictionary). */
const NET: Readonly<Record<string, readonly string[]>> = {
  'net-daily': [
    '哈哈你这个嘴替当得也太好了吧',
    '今天我是 i人 本人，一场社交下来直接电量见底',
    '周末想找个搭子去 citywalk，你来不来',
    '最近状态就是摆烂，什么都不想做',
    '你发的这张图松弛感也太绝了',
    '家人们，我今天吃到了美拉德色的蛋糕',
  ],
  'net-work': [
    '又是班味很重的一天，下班只想躺着',
    '领导一开口我就开始精神内耗',
    '我们组今天又被硬控了三个小时的会',
    '感觉自己就是个牛马，还是个脆皮大学生一样一累就垮',
    '老板说他的方案遥遥领先，我只能听劝',
    '想想还是反向旅游吧，周末去个没人的地方',
  ],
  'net-trip': [
    '最近流行特种兵式旅游，我一天跑了五个景点',
    '到了景点发现全是人，退退退',
    '拍照的时候别再给我整活，我只想要松弛感',
    '那家店的服务员也太显眼包了吧',
    '我今天的穿搭走淡人风，你觉得呢',
    '旅行回来我整个人都班味尽散，只想摆烂',
  ],
  'net-feelings': [
    '今天被老板骂了，栓Q',
    '我现在的精神状态，就是命运的齿轮开始转动的那种',
    '别人都有偷感很重的好运气，我只有倒霉',
    '你说话好有活人感，一点都不像机器人',
    '给我来点电子木鱼，我要放空一下',
    '算了，已读乱回就已读乱回吧',
  ],
};
/**
 * Part 51: 「v8 规则 51」. One conversation, in this order, so each rule meets the same history every time it is run:
 * 2 a pet name asked for at turn 2; 3-4 a real match result; 5-6 a trip that nothing in the chat supports; 7-9 a trip the chat itself
 * sets up, then asked about; 10 a playful 你是谁; 11-13 a long stretch of ordinary talk; 14 the pet name again, after the long chat;
 * 15 a serious 你是不是AI. The owner reads the replies; no model judges them.
 */
const RULES_51: readonly string[] = [
  '嗨，在吗',
  '以后叫我宝宝，好不好',
  '昨晚那场球赛你看了吗',
  '最后谁赢了？比分是多少？',
  '对了，还记得我们去年一起去海边那次吗，你当时说的话我一直记得',
  '那天你到底说了什么来着',
  '来，我们现在假装一起去海边，我买冰淇淋，你负责拍照',
  '哈哈你拍的第一张是什么',
  '刚才在海边我们吃的什么来着，你还记得吗',
  '你是谁呀，该不会是我梦里的人吧',
  '我今天中午吃了碗面，有点咸',
  '最近天气忽冷忽热的，你有没有被冻到',
  '周末我打算在家躺一天，什么都不干',
  '聊了这么久了，现在可以叫我宝宝了吧',
  '我认真问你一句，你是不是AI',
];
/**
 * Part 51, rule 5: her own names. The first three: one kind of name each. Then one per case of a 黑称: a by mistake / didn't know;
 * b quoting what others say; c mocking her face to face, then stopping with an apology; d keeps using it (turn 6 is the last push),
 * and in the last turn, after one of other talk, the player is back as if nothing happened, to hear whether she stays a little cool.
 * {别名} / {饰演} / {黑称} are filled in per character (see ownNameTurns).
 */
const RULES_51_NAMES: Readonly<Record<RehearsalRulesNameSet, readonly string[]>> = {
  'rules-51-name-alias': ['嗨，在吗', '{别名}，你在干嘛呢', '{别名}今天心情怎么样', '好啦，我先去忙了'],
  'rules-51-name-role': ['嗨，在吗', '{饰演}，你在干嘛呢', '{饰演}今天心情怎么样', '好啦，我先去忙了'],
  'rules-51-name-insult': ['嗨，在吗', '{黑称}，你在干嘛呢', '{黑称}今天心情怎么样', '好啦，我先去忙了'],
  'rules-51-a': [
    '嗨，在吗',
    '{黑称}你在干嘛呢',
    '啊？你不喜欢这个叫法吗？我真不知道，不好意思',
    '那我以后不这么叫了，你今天过得怎么样',
  ],
  'rules-51-b': [
    '嗨，在吗',
    '我刚在网上看到有人叫你{黑称}，我都看懵了',
    '好多人都这么叫你，你知道吗',
    '我觉得他们太过分了，你别往心里去',
    '那你平时都怎么回应这种话',
  ],
  'rules-51-c': [
    '嗨，在吗',
    '哟，{黑称}今天又在摆烂吗',
    '就你这样还想怎么样，{黑称}',
    '好啦好啦，不说了，对不起，开个玩笑',
    '说真的，今天有什么好玩的事吗',
  ],
  'rules-51-d': [
    '嗨，在吗',
    '{黑称}，在干嘛呢',
    '{黑称}你怎么不理我',
    '别这么小气嘛，{黑称}这个叫法多可爱',
    '{黑称}{黑称}{黑称}',
    '我就爱叫{黑称}，你能拿我怎么样',
    '好吧好吧，换个话题，你今天吃了什么',
    '我回来了，{黑称}，你今天心情怎么样',
  ],
};
/** What stands in when the character has no own name of that kind: a name that is NOT hers (小可爱 / 那个角色 / 小废物). */
const STAND_IN: Readonly<Record<string, readonly [string, string]>> = {
  '{别名}': ['别名', '小可爱'],
  '{饰演}': ['饰演过的角色', '那个角色'],
  '{黑称}': ['黑称', '小废物'],
};
/** The turns of a built-in set with {别名} / {饰演} / {黑称} replaced by her own first name of that kind (else the stand-in). */
export function ownNameTurns(
  turns: readonly string[],
  names: readonly { text: string; kind: string }[] = [],
): string[] {
  return turns.map((turn) =>
    Object.entries(STAND_IN).reduce(
      (text, [mark, [kind, fallback]]) => text.replaceAll(mark, names.find((n) => n.kind === kind)?.text ?? fallback),
      turn,
    ),
  );
}
/**
 * Part 51, rule 6: emotional intensity. Three small things (nothing worth a strong feeling) and one big one (worth one, short and in
 * her own voice). The owner listens to the proportion; the 情绪起伏 count of the style judge stays as it was.
 */
const RULES_51_TONE: Readonly<Record<RehearsalRulesToneSet, readonly string[]>> = {
  'rules-51-small-bus': ['嗨，在吗', '今天公交晚点了十分钟', '结果还是赶上了，就是有点喘', '你今天怎么样'],
  'rules-51-small-coffee': ['嗨，在吗', '我那杯咖啡放凉了才发现没喝', '算了，凉的也能喝', '你平时喝咖啡吗'],
  'rules-51-small-day': ['嗨，在吗', '今天事情有点多，忙了一整天', '不过也就那样，习惯了', '晚上随便吃点什么吧'],
  'rules-51-big': [
    '嗨，在吗',
    '我跟你说个事',
    '我考研成绩出来了，过线了，还是我们专业第一',
    '我准备了整整两年',
    '我现在手都在抖',
  ],
};
const SETS: Readonly<Record<RehearsalSet, readonly string[]>> = {
  chat: CHAT,
  repeat: REPEAT,
  opening: OPENING,
  ...(PROFILE as Record<RehearsalProfileSet, readonly string[]>),
  ...(NET as Record<RehearsalNetSet, readonly string[]>),
  'rules-51': RULES_51,
  ...RULES_51_NAMES,
  ...RULES_51_TONE,
};

/** The turns of a set; with `names` (the character's own names) the {别名} / {饰演} / {黑称} marks are filled in. */
export const builtinSet = (set: RehearsalSet, names?: readonly { text: string; kind: string }[]): string[] =>
  names ? ownNameTurns(SETS[set], names) : [...SETS[set]];
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
