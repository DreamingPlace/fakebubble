import { createHash } from 'node:crypto';
import {
  CORE_FIELDS,
  CORE_FIELD_KEYS,
  CORE_FIELD_LABELS,
  CORE_FIELD_MAX,
  EXAMPLES_PER_SITUATION_MAX,
  SPEECH_SITUATIONS,
  cardText,
  isSpeechSituation,
  readBank,
  type Example,
  type SpeechSituation,
} from '../../../packages/contracts/speech-profile.ts';

/**
 * Part 37b: the 新+档案 writer's two additions to a v8 request. NO model call, NO router, NO embeddings: plain rules over the player's
 * latest message and the recent turns, and ONE character's own settings (the request's `character`). Nothing from another character
 * is ever reachable from here: the only input is the request being built.
 *
 *   1. the 核心卡 goes in the stable system prefix (right after the persona; it changes only when a draft is published);
 *   2. 2–3 of THAT character's examples go AFTER everything stable (end of the system message), chosen by situation.
 *
 * The words below are pinned by `writerProfileHash()` (the pin of 新+档案 only; 旧 and 新 never read this file).
 */
export const PROFILE_CARD_HEAD = '说话档案（你自己说话的方式，每一句都要符合）：';
export const PROFILE_EXAMPLES_HEAD = '你在类似场合说过的话（只学语气和长短，不要照抄，也不要提起它们）：';
export const PROFILE_EXAMPLES_MAX = 3;

/** The keys of settings the 档案 block carries itself, so the author-canon JSON does not repeat them. */
const CARD_KEYS: readonly string[] = CORE_FIELDS.map((field) => CORE_FIELD_KEYS[field]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The 核心卡 block ('' when the character has no card field with text): one labelled line per field that has text. The text is the
 * character's own settings (speechStyle / dialogueStyle today, humorStyle / neverSay once adopted): until a field is adopted the
 * current settings ARE the card.
 */
export function profileCardBlock(authorCanon: unknown): string {
  const settings = isObject(authorCanon) && isObject(authorCanon.settings) ? authorCanon.settings : {};
  const lines = CORE_FIELDS.map((field) => [field, cardText(settings, field).trim()] as const)
    .filter(([, text]) => text !== '')
    .map(([field, text]) => `- ${CORE_FIELD_LABELS[field]}：${text.replaceAll('\n', '；')}`);
  return lines.length ? `${PROFILE_CARD_HEAD}\n${lines.join('\n')}` : '';
}

/**
 * The authorCanon the profile writer prints as JSON: the card fields (when they are text or a list, so the 档案 block shows them) and
 * the examples that carry one of the eight tags (the bank, chosen per message) are left out. An example with any other situation
 * (未分类) stays in, so nothing the owner wrote is lost before it is tagged.
 */
export function canonWithoutProfile<T extends { settings?: unknown }>(authorCanon: T): T {
  if (!isObject(authorCanon.settings)) return authorCanon;
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(authorCanon.settings)) {
    if (
      CARD_KEYS.includes(key) &&
      (typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string')))
    )
      continue;
    if (key === 'dialogueExamples' && Array.isArray(value)) {
      const kept = value.filter((item) => !(isObject(item) && isSpeechSituation(item.situation)));
      if (kept.length) settings[key] = kept;
      continue;
    }
    settings[key] = value;
  }
  return { ...authorCanon, settings };
}

// ---- the situation ---------------------------------------------------------------------------------------------------------------

type Turn = { authorKind: string; text: string };
const test = (pattern: RegExp, text: string) => pattern.test(text);

/** Highest priority first. A rule is a regular expression over the latest player message (see the table test for real messages). */
const FIGHT =
  /(滚|闭嘴|你有病|你烦不烦|别烦我|别理我|不想理你|不想跟你说|讨厌你|恨你|受够了|够了|你凭什么|你什么意思|吵架|你再说一遍|气死我了|你太过分|拉黑|绝交)/u;
const COMFORT =
  /(难过|想哭|哭了|心情不好|心情很差|不开心|难受|失眠|睡不着|压力好大|压力太大|焦虑|崩溃|委屈|失落|孤独|孤单|没人懂|emo|被骂了|被批评|搞砸|考砸|失败了|分手了|抱抱|安慰|[😭😢🥺😞😔💔])/u;
const COMPLAIN =
  /(烦死|好烦|真烦|累死|好累|太累|气死|倒霉|郁闷|无语|受不了|离谱|坑爹|吐槽|加班|堵死|堵车|老板|领导|甲方|排队|挤死|热死|冷死|被坑|服了)/u;
const SERIOUS =
  /(认真|严肃|正经|说真的|说实话|你怎么看|你怎么想|你觉得我该|该不该|要不要|怎么办|怎么选|给我.{0,2}建议|帮我分析|很重要|人生|职业|offer|面试|考研|考试|辞职|跳槽|搬家|结婚|未来|梦想|意义)/iu;
const INSIDE = /(还记得|记得吗|上次那个|你上次说|老规矩|又来了|经典|那个梗|懂的都懂|暗号|我们的梗|你的口头禅|你又来)/u;
const TEASE_WORD = /(笑死|你这人|就这|笨蛋|傻瓜|臭|行行行|得了吧|吹牛|略略|小样|怕不是|真有你的)/u;
const LAUGH = /(哈哈|嘿嘿|[🤣😂😏😜😝🙄])/u;
const SHARE =
  /(今天|刚刚|刚才|刚|昨天|昨晚|早上|中午|晚上|下班|下课|周末|路上|我去了|我在|我吃了|我买了|我看了|我养了|我家|我最近|最近在|吃完|回家|到家)/u;
const QUESTION_END = /(\?|？|吗|呢|嘛|么)\s*[!！~～.。…]*$/u;
const QUESTION_WORD = /(怎么样|怎样|什么|几点|哪|谁|为啥|为什么|怎么|多少|是不是|有没有)/u;

/** A stretch of at least this many characters shared with the character's own recent line makes the message an 内部梗. */
const REPEAT_RUN = 6;
const sharesRun = (text: string, earlier: readonly string[]) => {
  const chars = [...text.replace(/\s+/gu, '')];
  for (let i = 0; i + REPEAT_RUN <= chars.length; i++) {
    const run = chars.slice(i, i + REPEAT_RUN).join('');
    if (earlier.some((line) => line.replace(/\s+/gu, '').includes(run))) return true;
  }
  return false;
};

/**
 * The situation of the player's latest message: the first rule that matches, else 日常闲聊. `recent` are the turns before it (the
 * character's own recent lines make a repeated phrase an 内部梗). Pure and deterministic.
 */
export function pickSituation(latest: string, recent: readonly Turn[] = []): SpeechSituation {
  const text = latest.normalize('NFKC').trim();
  if (text === '') return '日常闲聊';
  if (test(FIGHT, text)) return '吵架';
  if (test(COMFORT, text)) return '安慰';
  if (test(COMPLAIN, text)) return '抱怨';
  if (test(SERIOUS, text) || [...text].length >= 60) return '认真';
  const mine = recent.filter((turn) => turn.authorKind === 'character').map((turn) => turn.text);
  if (test(INSIDE, text) || sharesRun(text, mine.slice(-6))) return '内部梗';
  if (test(TEASE_WORD, text) || (test(LAUGH, text) && text.includes('你'))) return '调侃';
  if (!test(QUESTION_END, text) && !test(QUESTION_WORD, text) && test(SHARE, text)) return '分享日常';
  return '日常闲聊';
}

// ---- the examples ----------------------------------------------------------------------------------------------------------------

/** FNV-1a over the code points: a small stable number from the player's message, so the start of the pick moves with the message. */
const spin = (text: string) => {
  let hash = 0x811c9dc5;
  for (const ch of text) hash = Math.imul(hash ^ (ch.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  return hash;
};

/**
 * Up to PROFILE_EXAMPLES_MAX examples of the situation of this message, from THIS character's bank. A situation with none uses
 * 日常闲聊's; with none either, nothing. Within a situation the order is the stored order, starting at a point derived from the
 * message (so consecutive messages do not always get the same three), wrapping; no randomness: the same input is the same pick.
 */
export function pickExamples(
  template: unknown,
  latest: string,
  recent: readonly Turn[] = [],
): { situation: SpeechSituation; examples: Example[] } {
  const situation = pickSituation(latest, recent);
  const bank = readBank(template);
  let pool = bank.filter((entry) => entry.situation === situation);
  if (pool.length === 0) pool = bank.filter((entry) => entry.situation === '日常闲聊');
  const count = Math.min(PROFILE_EXAMPLES_MAX, pool.length, EXAMPLES_PER_SITUATION_MAX);
  if (count === 0) return { situation, examples: [] };
  const start = spin(latest) % pool.length;
  return { situation, examples: Array.from({ length: count }, (_, i) => pool[(start + i) % pool.length]!.example) };
}

/** The block after the stable prefix ('' when nothing is picked). */
export function profileExamplesBlock(examples: readonly Example[], name: string): string {
  if (!examples.length) return '';
  const body = examples
    .map((example) =>
      [`玩家：${example.player ?? ''}`, ...(example.reply ?? []).map((line) => `${name}：${line}`)].join('\n'),
    )
    .join('\n\n');
  return `${PROFILE_EXAMPLES_HEAD}\n${body}`;
}

/** The pin of 新+档案: its words, its limits and its rules. Changing any of them changes this hash on purpose. */
export const profileFingerprint = () => [
  PROFILE_CARD_HEAD,
  PROFILE_EXAMPLES_HEAD,
  PROFILE_EXAMPLES_MAX,
  EXAMPLES_PER_SITUATION_MAX,
  CORE_FIELD_MAX,
  SPEECH_SITUATIONS,
  CORE_FIELDS.map((field) => [field, CORE_FIELD_KEYS[field], CORE_FIELD_LABELS[field]]),
  [FIGHT, COMFORT, COMPLAIN, SERIOUS, INSIDE, TEASE_WORD, LAUGH, SHARE, QUESTION_END, QUESTION_WORD].map(
    (rule) => rule.source,
  ),
  REPEAT_RUN,
];
export const writerProfileHash = () => createHash('sha256').update(JSON.stringify(profileFingerprint())).digest('hex');
/** The pin: the generation Worker refuses a 新+档案 request when this file's words and rules do not hash to exactly this. */
export const WRITER_PROFILE_SHA256 = '87839f8f65481e8b24451d0220a3176292ee2226192dd8e8402fb67ec0e8adbf';
