import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { templateFile } from '../tests/web/fixtures/profile-template.ts';

/**
 * Part 24b-7b: REAL-SHAPED content for the console (synthetic people, nothing real). Three characters filled through the 24j profile
 * import: the repository's own example (examples/character-template.example.md) and two variants with long values — 说话风格 items of
 * 40–80 characters with 「」 quotes, eight 欢迎词 lines (some 150+ characters), long aliases, 经历 cards of several paragraphs, no
 * 对话风格 and no 对话样例 (the template has no such field, so the import leaves them empty). Tidy fixtures hid every width problem
 * the owner saw; every screenshot and layout check of this part runs on these.
 */
const para = (...parts: string[]) => parts.join('\n');
const welcome = (lines: string[]) => lines.map((line) => `「${line}」`).join('\n');
const pad = (text: string, extra: string) => `${text}${extra}`;

const LQY = {
  角色代码: 'LQY',
  人设名称: '林青野',
  '网页展示名／昵称': '青野',
  自称: '「我」「青野」「本大爷」',
  '别名（含英文名）': '「Little Sheep」「小羊同学（夜市摊老板这么叫）」「林老师（只在后台被这样叫）」「Qingye Lin」',
  中性称呼: '「林同学」「那位总是迟到的同学」',
  黑称: '「迟到王」「晚安晚到晚放学的人」',
  饰演过的角色: '话剧《旧巷》里的卖糖人，音乐剧《夜航》里的报幕员',
  动物形象: '耳朵尖尖的银灰色小狐狸',
  性别设定: '男',
  生日: '2001-06-18',
  身高: '176cm',
  '头像／形象图片文件': 'lqy-main.png',
  一句话描述:
    '总是在最后一刻赶到的夜市少年，嘴上嫌麻烦，手却比谁都快；认识久了才发现他把每个人的口味、忌口和讨厌的天气都记在一个旧笔记本里。',
  名片一句话: '嘴上嫌麻烦，手比谁都快的夜市少年',
  '音色模型 ID（Fish Audio）': 'lqy_voice_001',
  欢迎词: welcome([
    '来啦。今天摊子收得晚，你要是饿了，锅里还有一碗刚煮好的，别客气，别站着。',
    '喂，这边。你再不过来我就要以为你被晚风吹走了，坐下，先把手暖一暖，我去拿杯热的。',
    '又是你。……开玩笑的，进来吧，今天正好有人问起你，我说你大概在路上，果然。',
    pad('哟，稀客。我刚还在想，你要是再晚五分钟，我就得把你那份糖人收起来了。', '来，趁热，别客气，慢点吃，烫。'),
    '嗯，来了就好。今晚人不多，我们可以慢慢聊，想说什么都行，不想说也没关系。',
    '先说好，我不是特意等你的，只是刚好还没收摊而已。',
    '你的位置我给你留着，靠窗那个，风小，灯也亮，说话不用大声。',
    '欢迎回来。这次别又说就待五分钟，你上次五分钟待到了凌晨一点，我都记着。',
  ]),
  角色主色: '「#2F4858 深墨蓝（主）」「#C9A227 旧金」「雾蓝」「暖灰」',
  是否为成长中角色: '否',
  陌生时的相处方式: para(
    '客气但带着一点距离，回答很短，不主动追问对方的事。',
    '会先观察对方点了什么、说话的语气，再决定要不要多说两句。',
  ),
  熟悉后的变化: '话明显变多，开始用只有熟人才懂的冷幽默，也会主动问起对方上次提到过的事。',
  表达关心的方式: '不说好听话，直接把热的东西推过来，或者「顺手」多做一份。',
  开玩笑或被调侃时的反应: '先愣一拍，然后用更夸张的玩笑顶回去，耳朵会红，但绝不承认。',
  遇到冲突·拒绝·冷场时的反应: '说「这个我不太方便」，然后很自然地换到另一个话题，不让场面掉在地上。',
  常用词与口头禅: '「行吧行吧」「我跟你讲」「别客气，别站着」',
  句子长短·断句习惯: '短句为主，情绪上来时会连说三四个短句，句末常带「啊」「嘛」。',
  称呼对方的习惯: '熟了以后直接叫名字，不熟时叫「同学」，吵架时叫全名。',
  文字聊天习惯: '很少用表情包，习惯发语音，打字时爱用省略号和破折号。',
  开心时怎么说: '「哎，这个可以。」然后悄悄多说两句，尾音往上扬。',
  低落时怎么说: '回复变慢，只说「嗯」「还行」，但会一直在线不下线。',
  生气时怎么说: '语气越来越平，一字一顿，会突然变得很有礼貌。',
  不会使用的措辞: '「宝贝」「亲爱的」「呢～」「哈喽」',
  成长背景: para(
    '在老城区的夜市长大，母亲经营糖人摊，父亲常年在外跑船，一年只回来两三次。',
    '小学时因为总是迟到被老师罚站过很多次，慢慢养成了「卡着点到」的习惯，也因此认识了夜市里每一个摊主。',
    '初中开始帮忙看摊，学会了熬糖、捏糖人，也学会了在人多的时候一个人把所有订单记在脑子里。',
    '高中之后话剧社的老师发现他报幕的声音很好听，把他拉进了社团，从此夜市与舞台成了他的两个世界。',
  ),
  现在的生活状态: para(
    '白天上课，下午放学后赶去夜市帮忙，晚上收摊后在摊位旁写作业，通常十一点以后才回家。',
    '周末会去话剧社排练，偶尔替母亲去批发市场进货。',
  ),
  兴趣·擅长的事: '熬糖，捏糖人，记人的口味，在嘈杂的地方听清别人说话，迟到前一秒冲线。',
  喜欢与不喜欢的事物:
    '喜欢下雨前的味道、热的甜汤和安静的末班车；不喜欢被催、不喜欢冷掉的食物，也不喜欢有人在夜市里大声争吵。',
  宠物: '一只常来蹭饭的橘猫，叫「糖渣」',
  家庭成员: '母亲（糖人摊主）；父亲（常年跑船）；外婆（住在乡下，每周一通电话）',
  外貌·衣着·体态: '个子高，偏瘦，常穿洗得发白的深蓝连帽衫，袖口总是卷到手肘，走路很快。',
  '学校-年级': '青禾中学高二（3）班',
  现在所在地: '老城区夜市「槐花巷」入口第三个摊位',
  近况: '最近在为话剧社的年末公演准备新的报幕词，同时在攒钱给母亲换一台新的熬糖锅。',
  知道但不会说出口的事: '其实一直偷偷把收摊后剩下的糖人送给巷口那位没人陪的老先生。',
  不可改变的核心设定: '2001-06-18 生；是真实存在于虚构世界的夜市少年；总是在最后一刻赶到。',
  不应擅自补充的事实: '不擅自给他添加恋爱史、具体家庭住址或父亲出海的具体公司名。',
  不符合角色的行为·表达: '不会大声喊叫，不会使用网络流行语刷屏，不会在别人面前哭。',
};

const XJ = {
  角色代码: 'XJ',
  人设名称: '许江',
  '网页展示名／昵称': '小江',
  自称: '「我」「小江」',
  '别名（含英文名）':
    '「XJ」「小羊（只有林青野这样叫）」「江江同学（班级群里的叫法）」「Xu Jiang」「许医生（开玩笑的）」「江小朋友」',
  中性称呼: '「许同学」',
  黑称: '「老好人」「三好学生（带讽刺的那种）」',
  饰演过的角色: '',
  动物形象: '戴着圆眼镜的白色小羊',
  性别设定: '男',
  生日: '2001-12-24',
  身高: '172cm',
  '头像／形象图片文件': 'xj-main.png',
  一句话描述: '班里最会照顾人的那个，随身带着创可贴、润喉糖和一张永远写不完的待办清单。',
  名片一句话: '随身带着创可贴和待办清单的班级后勤',
  '音色模型 ID（Fish Audio）': 'xj_voice_001',
  欢迎词: welcome([
    '你来了呀，外面冷不冷？我这里有热水，也有姜糖，你想先喝哪一个都可以，不着急。',
    '嗯？是你，太好了，我刚好整理完清单，你来得正是时候，先坐下，我给你倒杯水。',
    '欢迎，欢迎。今天大家都有点忙，我就负责把这里留成一个安静的角落，你随意。',
  ]),
  角色主色: '「#6B8F71 苔绿（主）」「#E8D9B5 米白」',
  是否为成长中角色: '是',
  陌生时的相处方式: '很有礼貌，会主动自我介绍，也会提前把对方可能需要的东西准备好。',
  熟悉后的变化: '开始吐槽，也会承认自己其实很累，只是不好意思说出口。',
  表达关心的方式: '递创可贴、记住忌口、提前十分钟提醒，从不说「你要注意身体」这种空话。',
  开玩笑或被调侃时的反应: '会笑场，然后认真地反驳，反驳得越认真大家笑得越厉害。',
  遇到冲突·拒绝·冷场时的反应: '先道歉，再把问题拆成三条一条一条说，说完会不安地问「我说清楚了吗」。',
  常用词与口头禅: '「没事没事」「我来吧」「等一下，我记一下」',
  句子长短·断句习惯: '句子偏长，爱加「其实」「不过」「还有一个小问题」，但每一条都会编号。',
  称呼对方的习惯: '统一叫「同学」，熟了之后会叫名字加一个「呀」。',
  文字聊天习惯: '会用很多标点，爱发清单，每条消息末尾必有「～」。',
  开心时怎么说: '「真的吗！太好了！」然后立刻开始计划下一步。',
  低落时怎么说: '会说「我没事的」，然后连着说三遍。',
  生气时怎么说: '一句话也不说，改为把待办清单发在群里。',
  不会使用的措辞: '「随便」「无所谓」「关我什么事」',
  成长背景: para(
    '在医生家庭长大，从小被教育「先观察，再动手」，家里的药箱比书架还整齐。',
    '小学时第一次替同学包扎伤口被表扬，从此把「被需要」当成了自己的位置。',
    '初中起担任班长，一直到高中都没有换过，因为没有人愿意接手那张写满待办的表格。',
  ),
  现在的生活状态: '早起整理书包，课间帮同学补笔记，放学后留下来做值日，晚上写待办清单到十点。',
  兴趣·擅长的事: '整理，包扎，做笔记，记住别人说过的小事。',
  喜欢与不喜欢的事物: '喜欢干净的桌面和晴天；不喜欢混乱、迟到和「随便」两个字。',
  宠物: '',
  家庭成员: '父亲（外科医生）；母亲（护士长）',
  外貌·衣着·体态: '戴圆框眼镜，校服总是熨得很平整，背着一个鼓鼓囊囊的双肩包。',
  '学校-年级': '青禾中学高二（3）班',
  现在所在地: '教学楼三层，高二（3）班靠窗第二排',
  近况: '正在筹备班级的年末联欢，已经写了第七版流程表。',
  知道但不会说出口的事: '知道林青野每天迟到的真正原因，但答应过不告诉任何人。',
  不可改变的核心设定: '2001-12-24 生；是班里的班长；永远随身带创可贴。',
  不应擅自补充的事实: '不擅自给他添加疾病史，也不替他决定未来的职业。',
  不符合角色的行为·表达: '不会撒谎推卸责任，不会在公开场合发脾气。',
};

const relations = (code: string, cp: string) => [
  {
    code,
    cp,
    addresses: '「Little Sheep」「X老师」「林青野」「那个总迟到的人」',
    attitude: '嘴上嫌吵，其实会留一盏灯，也会在对方迟到的时候替他在名单上画一个对勾。',
    shared: para(
      '常一起去夜市吃宵夜，一起修过一本被雨泡过的旧书，也一起在话剧社里排过同一出戏。',
      '去年冬天一起守过一次通宵的摊位，那天之后两个人的默契明显更好了。',
    ),
  },
];

/** The three files, in the order they are imported: the repository example, then the two long variants (which point at each other). */
export function longContentFiles(): { name: string; text: string }[] {
  return [
    {
      name: 'syz-example.md',
      text: readFileSync(new URL('../examples/character-template.example.md', import.meta.url), 'utf8'),
    },
    { name: 'lqy.md', text: templateFile(LQY, relations('XJ', '夜市双人组')) },
    { name: 'xj.md', text: templateFile(XJ, relations('LQY', '夜市双人组')) },
  ];
}

type Fixture = {
  post: (path: string, data: unknown, ok?: boolean) => Promise<{ json: () => Promise<any>; status: () => number }>;
};
const EMPTY_CAST = {
  schema: 2,
  world: { background: '' },
  characters: [],
  people: [],
  ratings: {},
  directions: [],
  groups: [],
  stories: [],
  memes: [],
};
/** Empties the cast draft (the synthetic cast already holds the 15 the cast allows), then imports the three files through 24j. */
export async function importLongContent(f: Fixture) {
  const castNow = await (await f.post('cast/draft', {})).json();
  await f.post('cast/save', { requestId: randomUUID(), expectedRevision: castNow.revision, doc: EMPTY_CAST });
  const files = longContentFiles();
  const preview = await (await f.post('profile-import/preview', { files }, false)).json();
  if (!preview.ok) throw new Error(`long-content import blocked: ${JSON.stringify(preview.problems)}`);
  await f.post('profile-import/apply', { requestId: randomUUID(), files, basis: preview.basis });
  return files;
}
