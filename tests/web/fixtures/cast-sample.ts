import { CAST_LIMITS, type CastDoc } from '../../../packages/contracts/web-cast.ts';
import { normalizeCastDoc } from '../../../apps/server/cast/cast-validation.ts';

/** Deterministic ids for fixtures: e1, e2, … in document order (the server uses random ones). */
export const counterIds = () => {
  let n = 0;
  return () => `e${++n}`;
};
export const normalize = (raw: unknown, known: ReadonlySet<string> = new Set()) =>
  normalizeCastDoc(raw, { known, fresh: counterIds() });

export const SAMPLE_NAMES = [
  '林小满',
  '陈阿杰',
  '苏念',
  '周屿',
  '许知意',
  '顾北',
  '江月',
  '唐小棠',
  '沈烬',
  '叶初晴',
  '秦川',
  '白露',
  '温言',
  '陆远',
  '宋青',
];
export const sampleId = (index: number) => `c${String(index + 1).padStart(2, '0')}`;

const text = (value: string) => ({ text: value });

/**
 * A cast of 15 chat characters, 6 people, 3 groups and 6 stories. c05 (顾北... see SAMPLE_NAMES[4]) hears "雨夜的告白" only because
 * she rates c01 at 3.5; c01 has an override on "校庆演出" (lived, though not a participant); c07 is told by an override
 * that he does NOT know "旧照片" although he is a participant.
 */
export function sampleCastRaw() {
  const characters = SAMPLE_NAMES.map((name, index) => ({
    characterId: sampleId(index),
    identity: {
      oneLiner: `${name}，高二（${(index % 4) + 1}）班`,
      names: [text(name), text(`小${name.slice(-1)}`)],
      aliases: [
        { text: `${name.slice(-1)}${name.slice(-1)}`, attitude: 'likes' },
        { text: `${name.slice(0, 1)}同学`, attitude: index % 2 ? 'ok' : 'dislikes' },
      ],
      selfConcept: `${name}觉得自己是个${index % 2 ? '慢热但靠谱' : '外向爱热闹'}的人。`,
      prototype:
        index === 0 ? { personId: 'new-idol', inherited: '舞台上的自信', notInherited: '真实经历与家庭' } : null,
    },
    profile: `${name}，生日${(index % 12) + 1}月${(index % 27) + 1}日，家住老城区。`,
    personality: `${name}说话直接，熟了以后爱开玩笑，被夸会嘴硬。`,
    speech: {
      catchphrases: [text('真的假的'), text('行吧行吧')],
      samples: [text('你先说，我听着呢。'), text('这事儿我可记着了啊。')],
      avoid: [text('不用书面腔'), text('不说“亲”')],
    },
    experiences: [
      { title: '初三那年', text: `${name}在初三转学来到这座城市，第一次交到朋友是在天台。` },
      { title: '去年夏天', text: `${name}和朋友一起去海边，忘了带伞被淋成落汤鸡。` },
    ],
    performance: `演绎${name}时语气随意，不要过度撒娇。`,
    hidden: [text(`${name}其实怕黑，从没告诉过别人。`)],
    unmapped: '',
  }));
  const ratings: Record<string, Record<string, number>> = {};
  SAMPLE_NAMES.forEach((_, index) => {
    const from = sampleId(index);
    ratings[from] = {};
    for (const step of [1, 2, 3]) ratings[from]![sampleId((index + step) % 15)] = [4, 3, 1.5][step - 1]!;
  });
  // c05 rates c01 at 3.5; nobody else among the participants of story 1 is rated that high by her
  ratings.c05 = { c01: 3.5, c06: 2, c07: 1 };
  return {
    schema: 1,
    world: { background: '一座南方小城的高中，学生们在同一条老街上长大。' },
    characters,
    people: [
      { id: 'new-mom', kind: 'person', names: [text('林妈妈')], oneLiner: '小满的妈妈，开早餐店' },
      { id: 'new-teacher', kind: 'person', names: [text('老周')], oneLiner: '班主任，教语文' },
      { id: 'new-idol', kind: 'prototype', names: [text('舞台上的她')], oneLiner: '小满喜欢的歌手' },
      { id: 'new-dog', kind: 'person', names: [text('大黄')], oneLiner: '老街上的流浪狗' },
      { id: 'new-shop', kind: 'person', names: [text('书店老板')], oneLiner: '开旧书店的中年人' },
      { id: 'new-coach', kind: 'person', names: [text('教练')], oneLiner: '篮球队教练' },
    ],
    ratings,
    directions: [
      { from: 'c01', to: 'c02', address: '阿杰', treatment: '嘴上互怼，其实最信任他' },
      { from: 'c02', to: 'c01', address: '小满', treatment: '嘴硬，会替她出头' },
      { from: 'c05', to: 'c01', address: '林同学', treatment: '客气，保持距离' },
      { from: 'c01', to: 'new-mom', address: '妈', treatment: '撒娇，报喜不报忧' },
    ],
    groups: [
      {
        name: '文学社',
        members: ['c01', 'c02', 'c03', 'c04'],
        background: '周四放学后在旧书店二楼聚会。',
        stories: [
          {
            title: '社刊创刊',
            summary: '四个人熬夜印出了第一期社刊。',
            details: '封面是苏念画的，错了两个字。',
            period: { start: '2025-09', end: '2025-10' },
            boundary: '可以当玩笑提，不要说具体错字。',
          },
        ],
      },
      {
        name: '篮球队',
        members: ['c05', 'c06', 'c07', 'c08', 'c09'],
        background: '校队，训练在周二周五。',
        stories: [],
      },
      {
        name: '宿舍',
        members: ['c10', 'c11', 'c12'],
        background: '三人同一间寝室。',
        stories: [
          {
            title: '停电夜',
            summary: '整栋楼停电，三个人在走廊打牌。',
            details: '',
            period: { start: '2026-03', end: '' },
            boundary: '',
          },
        ],
      },
    ],
    stories: [
      {
        title: '雨夜的告白',
        summary: '小满在雨夜向阿杰说出了心里话。',
        details: '在公交站台，伞只有一把，两个人都没提回家。',
        period: { start: '2026-04-12', end: '' },
        participants: ['c01', 'c02'],
        boundary: '只能点到为止，不能复述原话。',
        overrides: [],
      },
      {
        title: '校庆演出',
        summary: '校庆晚会上苏念、周屿和陆远合唱。',
        details: '中途话筒坏了，全场跟着一起唱完。',
        period: { start: '2025-12-20', end: '' },
        participants: ['c03', 'c04', 'c14'],
        boundary: '',
        overrides: [{ characterId: 'c01', level: 'lived' }],
      },
      {
        title: '旧照片',
        summary: '书店老板翻出一张十年前的合影。',
        details: '照片里有三个人，其中一个后来搬走了。',
        period: { start: '2024', end: '' },
        participants: ['c07', 'new-shop'],
        boundary: '不要猜照片里是谁。',
        overrides: [{ characterId: 'c07', level: 'unknown' }],
      },
      {
        title: '决赛前夜',
        summary: '篮球队决赛前一晚全队没睡。',
        details: '教练给每人发了一张纸条。',
        period: { start: '2026-05-30', end: '2026-05-31' },
        participants: ['c05', 'c06', 'c08', 'new-coach'],
        boundary: '',
        overrides: [],
      },
      {
        title: '大黄走丢',
        summary: '大黄走丢了三天，全街的人都在找。',
        details: '',
        period: { start: '', end: '' },
        participants: ['new-dog', 'c15'],
        boundary: '',
        overrides: [],
      },
      {
        title: '天台的约定',
        summary: '几个人在天台约好毕业后再来。',
        details: '',
        period: { start: '2025-06', end: '' },
        participants: ['c01', 'c13'],
        boundary: '',
        overrides: [{ characterId: 'c10', level: 'heard' }],
      },
    ],
    memes: [
      {
        key: '落汤鸡',
        parties: ['c01', 'c02'],
        meaning: '指去年夏天海边那次淋雨。',
        trigger: '下雨或有人没带伞时。',
        prohibited: '对方情绪低落时不要用。',
      },
      {
        key: '行吧行吧',
        parties: ['c05'],
        meaning: '无可奈何地答应。',
        trigger: '被劝服的时候。',
        prohibited: '',
      },
    ],
  };
}

export const sampleCast = (): CastDoc => normalize(sampleCastRaw());

/**
 * Every chat character at the maximum of every field and every count (people, groups, stories, memes, ratings and directions
 * to everyone) - except where the 300,000-character cap of the whole document says otherwise. The fixture the size tests use.
 */
export function maxCastRaw(options: { directionTargets?: number; groupStories?: number; stories?: number } = {}) {
  const L = CAST_LIMITS;
  // Counts that, with every character at the maximum of every field, still leave the whole document under its own cap.
  const directionTargets = options.directionTargets ?? 12;
  const groupStories = options.groupStories ?? 2;
  const storyCount = options.stories ?? 30;
  const fill = (length: number, seed: string) => (seed.repeat(Math.ceil(length / seed.length)) + '').slice(0, length);
  const ids = SAMPLE_NAMES.map((_, i) => sampleId(i));
  const peopleIds = Array.from({ length: L.people }, (_, i) => `new-p${String(i).padStart(2, '0')}`);
  const names = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => text(fill(L.name, `${prefix}${i}名`)));
  const characters = ids.map((id, index) => ({
    characterId: id,
    identity: {
      oneLiner: fill(L.oneLiner, `${index}句`),
      names: names(`人${index}`, L.names),
      aliases: Array.from({ length: L.aliases }, (_, i) => ({ text: fill(L.alias, `别${i}`), attitude: 'ok' })),
      selfConcept: fill(L.selfConcept, '自我认知'),
      prototype: {
        personId: peopleIds[0]!,
        inherited: fill(L.prototypeText, '继承'),
        notInherited: fill(L.prototypeText, '不继承'),
      },
    },
    profile: fill(L.profile, '档案'),
    personality: fill(L.personality, '性格'),
    speech: {
      catchphrases: Array.from({ length: L.catchphrases }, () => text(fill(L.catchphrase, '口头禅'))),
      samples: Array.from({ length: L.samples }, () => text(fill(L.sample, '示例'))),
      avoid: Array.from({ length: L.avoid }, () => text(fill(L.avoidText, '避免'))),
    },
    experiences: Array.from({ length: L.experiences }, () => ({
      title: fill(L.experienceTitle, '经历'),
      text: fill(L.experienceText, '经历内容'),
    })),
    performance: fill(L.performance, '演绎'),
    hidden: Array.from({ length: L.hidden }, () => text(fill(L.hiddenText, '隐藏设定'))),
    unmapped: '',
  }));
  const everyone = [...ids, ...peopleIds];
  const ratings: Record<string, Record<string, number>> = {};
  for (const from of ids) {
    ratings[from] = {};
    for (const to of everyone) if (to !== from) ratings[from]![to] = 3.5;
  }
  const directions = ids.flatMap((from) =>
    everyone
      .filter((to) => to !== from)
      .slice(0, directionTargets)
      .map((to) => ({ from, to, address: fill(L.address, '称'), treatment: fill(L.treatment, '相处') })),
  );
  return {
    schema: 1,
    world: { background: fill(L.worldBackground, '世界') },
    characters,
    people: peopleIds.map((id, i) => ({
      id,
      kind: i === 0 ? 'prototype' : 'person',
      names: names(`人物${i}`, L.peopleNames),
      oneLiner: fill(L.oneLiner, `人物${i}`),
    })),
    ratings,
    directions,
    groups: Array.from({ length: L.groups }, (_, g) => ({
      name: fill(L.groupName, `组合${g}`),
      members: ids.slice(0, L.groupMembers),
      background: fill(L.groupBackground, '组合背景'),
      stories: Array.from({ length: groupStories }, (_, s) => ({
        title: fill(L.storyTitle, `组故事${s}`),
        summary: fill(L.storySummary, '组故事摘要'),
        details: fill(L.storyDetails, '组故事细节'),
        period: { start: `2025-${String((s % 12) + 1).padStart(2, '0')}`, end: '' },
        boundary: fill(L.storyBoundary, '边界'),
      })),
    })),
    stories: Array.from({ length: storyCount }, (_, s) => ({
      title: fill(L.storyTitle, `故事${s}`),
      summary: fill(L.storySummary, '故事摘要'),
      details: fill(L.storyDetails, '故事细节'),
      period: { start: `20${String(10 + (s % 15)).padStart(2, '0')}-01`, end: '' },
      participants: [ids[s % 15]!, peopleIds[s % L.people]!],
      boundary: fill(L.storyBoundary, '叙述边界'),
      overrides: [],
    })),
    memes: Array.from({ length: L.memes }, (_, m) => ({
      key: fill(L.memeKey, `梗${m}`),
      parties: ids.slice(0, L.memeParties),
      meaning: fill(L.memeMeaning, '含义'),
      trigger: fill(L.memeTrigger, '触发'),
      prohibited: fill(L.memeProhibited, '禁用'),
    })),
  };
}
