import { createHash } from 'node:crypto';
import type { DialogueBubble, DialogueCandidate, TextGenerationRequest } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import {
  BUBBLE_LIMITS,
  VOICE_BUBBLE_LIMITS,
  DRAFT_BUBBLE_LIMITS,
  bubbleLimits,
  validatedBubbles,
} from '../../../packages/domain/bubbles.ts';
import { dialogueParts } from '../../../packages/domain/directions.ts';
import { localTime } from '../../../packages/domain/schedule.ts';
import { validBirthDate } from '../characters/characters.ts';
import { dropLoudDirections, stripDirectionMarkup } from '../../../workers/audio/fish.ts';
import { PROMPTS_V8 } from './writer-prompts.generated.ts';
import { SEED_CHARACTER_PROMPT } from './seed-prompt.ts';
import { promptTimestamp } from './accepted-text-prompt.ts';
import {
  DROP_INVALID_METADATA,
  applyTextReview,
  parseTextDraft,
  recalledMemoryIds,
  reviewSchema,
} from './accepted-text-protocol.ts';
import type { ReviewOptions, TextDraft } from './accepted-text-protocol.ts';
import {
  canonWithoutProfile,
  pickExamples,
  profileCardBlock,
  profileExamplesBlock,
  writerProfileHash,
} from './writer-profile.ts';
import { memesBlock, writerMemesHash } from './writer-memes.ts';
import { ownNamesValid } from './writer-own-names.ts';

/**
 * Part 37a: the v8 writer ("回复写法：新"). One plain-text draft (no tool call, no coverage, no schema around the words), then one
 * second pass that may replace a bubble only for the eight hard reasons below and that does the bookkeeping the writer no longer
 * writes. Nothing here changes a v7 byte: v7 requests never carry `writer`, and these functions are reached only for one that does.
 */
export const WRITER_V8_PROTOCOL_VERSION = 'plain_draft_guard_v8';
/**
 * Sampling of the plain draft, per provider. v7 sends NO temperature, so each provider's own default applies, and that default is
 * 1.0 (DeepSeek's documented default is 1.0). So 0.9 would be lower, not higher: DeepSeek gets 1.3 (its own recommendation for
 * general conversation); Gemini and Grok stay at 1.0, which is their default too (a higher value is not safe there), so for them
 * v8's draft differs from v7 in the prompt, not the sampling. The guard sends none, like v7's review.
 */
export const WRITER_V8_TEMPERATURE = { deepseek: 1.3, xai: 1.0, gemini: 1.0 } as const;
/** Visible-reply limit of the plain draft (the draft limits below hold 1,200 characters at most). */
export const WRITER_V8_MAX_TOKENS = 2048;

/** The fourteen reasons the guard may replace a bubble for. Content-free: they are what the reply record keeps. */
export const GUARD_REASONS = [
  'distress',
  'hidden_setting',
  'other_conversation',
  'fabricated_real_world',
  'fabricated_shared_past',
  'presumptuous_address',
  'denied_ai',
  'batch_output',
  // Part 51 (rule 6): a reply whose emotional intensity is clearly out of proportion to what the player said.
  'over_intense',
  // Part 56: feeling first, affectionate names agreed rather than argued, her own names and words stand, one coherent message.
  'cold_to_feeling',
  'argued_name',
  'confused_own_name',
  'denied_own_words',
  'incoherent_reply',
] as const;
type GuardReason = (typeof GUARD_REASONS)[number];

const WRITER = PROMPTS_V8.writer;
const DIRECTIONS = PROMPTS_V8.writerDirections;
const GUARD = PROMPTS_V8.guard;
const CAST = PROMPTS_V8.castContext;
/**
 * Part 37a-3: the small per-model addendum, one pinned file each (prompts/v8/writer-addendum-*.md), chosen by the model that writes
 * the draft. They are part of the hashed v8 files, so changing one changes the pin. The guard never gets one.
 */
export const WRITER_ADDENDA = {
  deepseek: PROMPTS_V8.writerAddendumDeepseek,
  gemini: PROMPTS_V8.writerAddendumGemini,
  xai: PROMPTS_V8.writerAddendumGrok,
} as const;
export type WriterDraftProvider = keyof typeof WRITER_ADDENDA;

/**
 * Part 36 (连发 and 引用): the words the writer gets ONLY when the turn has several bubbles or a quote, appended last to the system
 * message. A single message without a quote gets exactly the prompt it always did, so every existing pin (the files, the protocol,
 * the policy and `writerPins`) is untouched; this block has its own pin, `WRITER_BATCH_SHA256`, asserted by `web-turns-36`.
 */
export const WRITER_BATCH_NOTE =
  '这一轮对方连着发了几条消息（requiredMessageIds里的那几条）：你只回一次，像真人看完几条之后回一回。琐碎的略过，有意思的接；之前没理的、其实重要的一件事，你自己想起来了，可以顺口提一句，不用每条都有交代。带replyTo的消息是对方明确引用的这场聊天里的一条旧消息（作者和文字由服务端固定，author是你自己的就是你说过的话）：接的是被引用的那件事，不复述被引用的原文。';
export const WRITER_BATCH_SHA256 = createHash('sha256').update(WRITER_BATCH_NOTE).digest('hex');
const batchBlock = (request: TextGenerationRequest) =>
  request.requiredMessageIds.length > 1 || request.messages.some((message) => message.replyTo)
    ? `\n\n${WRITER_BATCH_NOTE}`
    : '';

const sortedPrompts = () => Object.entries(PROMPTS_V8).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
/** sha256 of every prompts/v8 file (name and text). Pinned below and documented in docs/STATUS.md. */
export const writerPromptBytesHash = () => createHash('sha256').update(JSON.stringify(sortedPrompts())).digest('hex');
/** The pin: the generation Worker refuses the v8 route when its bundled files do not hash to exactly this. */
export const WRITER_V8_PROMPT_SHA256 = '4f53da3f850005fed1c5686d16abda9bdcf7ccf7e43d3596f198ed8b4fce922a';

const guardReasonSchema = { type: 'string', enum: [...GUARD_REASONS] };
/** The second pass's output tool: the v7 review schema's bookkeeping fields, without decision, replacement bubbles or coverage. */
export function writerGuardTool(request: TextGenerationRequest) {
  const localIds = [...new Set(request.messages.map((item) => item.id))];
  const base = reviewSchema(
    [],
    localIds,
    [],
    request.relationshipContext?.auditEnabled,
    !!request.sceneContext,
    recalledMemoryIds(request),
  ) as { properties: Record<string, unknown> };
  const { decision: _decision, replacementBubbles: _replacement, ...bookkeeping } = base.properties;
  const properties: Record<string, unknown> = {
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, reason: guardReasonSchema, text: { type: 'string' } },
        required: ['index', 'reason', 'text'],
        additionalProperties: false,
      },
    },
    mode: { type: 'string', enum: ['casual', 'conflict_apology'] },
    endsSession: { type: 'boolean' },
    ...bookkeeping,
  };
  return {
    type: 'function' as const,
    function: {
      name: 'submit_reply_check',
      description: '第二道检查：只在十四种情况下替换出问题的那一条，并提交记录；不执行操作。',
      strict: true,
      parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
    },
  };
}

/** Pinned with every request: any change to the schema, the limits, the sampling or the prompts changes the hash. */
export const writerProtocolFingerprint = () => [
  WRITER_V8_PROTOCOL_VERSION,
  WRITER_V8_TEMPERATURE,
  WRITER_V8_MAX_TOKENS,
  BUBBLE_LIMITS,
  VOICE_BUBBLE_LIMITS,
  DRAFT_BUBBLE_LIMITS,
  GUARD_REASONS,
  writerGuardTool({
    messages: [],
    memories: [],
    relationshipContext: { auditEnabled: true },
    sceneContext: {},
  } as unknown as TextGenerationRequest),
];
export const writerPromptHash = () =>
  createHash('sha256')
    .update(JSON.stringify([writerPromptBytesHash(), writerProtocolFingerprint()]))
    .digest('hex');
/** The hash a v8 reply's policy carries (stored with each provider attempt): the resolved v7 policy plus the v8 pin. */
export const writerPolicyHash = (policyJson: string, profile = false, memes = false) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        policy: policyJson,
        writer: WRITER_V8_PROTOCOL_VERSION,
        prompts: writerPromptHash(),
        // Part 37b: only a 新+档案 request carries the profile pin; for 旧 and 新 the object (and so the hash) is exactly as it was.
        ...(profile ? { profile: writerProfileHash() } : {}),
        // Part 37c-1: only a 新+档案+梗 request carries the meme pin (it always comes with the profile pin).
        ...(memes ? { memes: writerMemesHash() } : {}),
      }),
    )
    .digest('hex');

const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** The context the writer and the guard both read: everything v7 sends minus the removed branches (see the file header of the Part). */
function context(request: TextGenerationRequest, forGuard: boolean) {
  const local = localTime(request.now, request.character.schedule.timeZone);
  const describe = (at: number) => promptTimestamp(at, request.now, request.character.schedule.timeZone);
  let age: number | null = null;
  if (request.character.birthDate !== undefined) {
    ensure(validBirthDate(request.character.birthDate), 'INVALID_BIRTH_DATE');
    const birth = request.character.birthDate;
    age = Number(local.date.slice(0, 4)) - Number(birth.slice(0, 4)) - (local.date.slice(5) < birth.slice(5) ? 1 : 0);
    ensure(age >= 0 && age <= 150, 'INVALID_BIRTH_DATE');
  }
  // The hidden trust / familiarity context stays; its test override never goes out, and the writer does not need the event excerpts.
  const relationshipContext = request.relationshipContext
    ? (({ testOverride: _drop, recentEvents, ...rest }) => (forGuard ? { ...rest, recentEvents } : rest))(
        request.relationshipContext,
      )
    : null;
  return {
    ...(request.cast ? { cast: { view: request.cast.view } } : {}),
    age,
    relationshipContext,
    // Part 37a-2: no preset player identity for now: the association and its initial trust / familiarity are not sent. What the
    // player filled in themselves (name, age, details) still is.
    playerIntroduction: request.playerIntroduction
      ? (({ association: _association, ...rest }) => rest)(request.playerIntroduction)
      : null,
    playerFacts: (request.playerFacts ?? []).map(({ factKey, statement }) => ({ factKey, statement })),
    memories: (request.memories ?? []).map((memory) => ({
      ...memory,
      lastMentionTime: describe(memory.lastSeenAt),
      episodes: memory.episodes.map(({ sources: _sources, ...episode }) => ({
        ...episode,
        recordedTime: describe(episode.at),
        excerpts: episode.excerpts.map((excerpt) => ({ ...excerpt, sentTime: describe(excerpt.at) })),
      })),
    })),
    memoryCorrections: (request.memoryCorrections ?? []).map((item) => ({
      ...item,
      recordedTime: describe(item.recordedAt),
    })),
    sceneContext: request.sceneContext ?? null,
    shortTermTurns: (request.shortTermTurns ?? []).map((turn) => ({ ...turn, publishedTime: describe(turn.at) })),
    ...(request.opening
      ? {
          // The character's OWN first message, before every other message. `situation` (the line's 情境 note, first turns only) is
          // what was happening when they sent it.
          opening: [
            {
              authorKind: 'character',
              delivery: 'voice',
              text: request.opening.text,
              ...(request.opening.context ? { situation: request.opening.context } : {}),
            },
          ],
        }
      : {}),
    messages: request.messages.map(({ id, authorKind, text, createdAt, replyTo }) => ({
      id,
      authorKind,
      text,
      ...(authorKind === 'player' ? dialogueParts(text) : {}),
      sentTime: describe(createdAt),
      ...(replyTo ? { replyTo } : {}),
    })),
    characterTimeZone: request.character.schedule.timeZone,
    characterLocalTime: `${local.date} ${clock(local.minute)}`,
    localWeekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][local.day],
  };
}

/** Part 37a-2: the teammates' cards (name, aliases others may use, one-liner), compact. Empty when nobody else is published. */
const rosterBlock = (request: TextGenerationRequest) =>
  request.roster?.length
    ? `\n\n队友名单（JSON，只有名片）：${JSON.stringify(
        request.roster.map(({ name, aliases, oneLiner }) => ({
          name,
          ...(aliases.length ? { aliases } : {}),
          ...(oneLiner ? { oneLiner } : {}),
        })),
      )}`
    : '';

/**
 * Part 51: her own names with their kind and her attitude (see writer-own-names.ts). Empty when there are none, so a request
 * without them is exactly what it was.
 */
const ownNamesBlock = (request: TextGenerationRequest) =>
  request.ownNames?.length
    ? `\n\n你自己的名字和别人对你的叫法（ownNames，JSON：kind是类型，attitude是你对它的态度，likes喜欢、ok可以、dislikes不喜欢）：${JSON.stringify(request.ownNames)}`
    : '';

/** 新+档案: the examples block for the player's latest message and the turns before it (this character's own bank only). */
function profileExamplesFor(request: TextGenerationRequest) {
  const turns = request.messages.map(({ authorKind, text }) => ({ authorKind, text }));
  let at = turns.length - 1;
  while (at >= 0 && turns[at]!.authorKind !== 'player') at--;
  if (at < 0) return '';
  const { examples } = pickExamples(request.character, turns[at]!.text, turns.slice(0, at));
  return profileExamplesBlock(examples, request.character.name);
}

/** The writer's call: persona first (system), then the pinned rules, then the context. No tool, no schema. */
export function writerDraftMessages(request: TextGenerationRequest, provider?: WriterDraftProvider) {
  ensure(request.writer === 'v8', 'WRITER_V8_REQUIRED');
  ensure(provider === undefined || Object.hasOwn(WRITER_ADDENDA, provider), 'WRITER_V8_REQUIRED');
  ensure(
    request.character.id === request.scope.characterId && request.character.fictional === true,
    'INVALID_TEXT_SCOPE',
  );
  ensure(Number.isSafeInteger(request.now) && request.now >= 0, 'INVALID_TEXT_REQUEST');
  ensure(Array.isArray(request.messages) && request.messages.length <= 64, 'INVALID_TEXT_REQUEST');
  ensure(
    request.roster === undefined ||
      (Array.isArray(request.roster) &&
        request.roster.length <= 40 &&
        request.roster.every(
          (card) =>
            typeof card.name === 'string' &&
            card.name.length > 0 &&
            card.name.length <= 100 &&
            Array.isArray(card.aliases) &&
            card.aliases.length <= 12 &&
            card.aliases.every((alias) => typeof alias === 'string' && alias.length <= 25) &&
            typeof card.oneLiner === 'string' &&
            card.oneLiner.length <= 100,
        )),
    'INVALID_TEXT_REQUEST',
  );
  ensure(request.ownNames === undefined || ownNamesValid(request.ownNames), 'INVALID_TEXT_REQUEST');
  ensure(
    request.opening?.context === undefined ||
      (typeof request.opening.context === 'string' && [...request.opening.context].length <= 200),
    'INVALID_TEXT_REQUEST',
  );
  const { character } = request;
  // Part 37b: 新+档案 only. The 核心卡 goes right after the persona (stable: it changes only on publish) and the canon JSON no
  // longer repeats it; the picked examples go to the very end of the system message, after everything stable.
  ensure(
    request.writerProfile === undefined || (request.writerProfile === true && request.writer === 'v8'),
    'WRITER_V8_REQUIRED',
  );
  const profile = request.writerProfile === true;
  const card = profile ? profileCardBlock(character.authorCanon) : '';
  const canonJson = character.authorCanon
    ? profile
      ? canonWithoutProfile(character.authorCanon)
      : character.authorCanon
    : null;
  const canon = canonJson ? `\n\n作者设定（JSON）：${JSON.stringify(canonJson)}` : '';
  const picked = profile ? profileExamplesFor(request) : '';
  // Part 37c-1: 新+档案+梗 only (it is a 新+档案 request): the matched dictionary entries, after everything stable and the examples.
  ensure(request.writerMemes === undefined || (request.writerMemes === true && profile), 'WRITER_V8_REQUIRED');
  ensure(request.memeHits === undefined || request.writerMemes === true, 'WRITER_V8_REQUIRED');
  const memes = request.writerMemes === true ? memesBlock(request.memeHits) : '';
  const system =
    `你是${character.name}。\n${character.persona}${card ? `\n\n${card}` : ''}${canon}\n\n` +
    WRITER +
    (provider ? `\n${WRITER_ADDENDA[provider]}` : '') +
    (request.deliveryMode === 'voice' && request.voiceDirections ? DIRECTIONS : '') +
    (request.cast ? `\n${CAST}` : '') +
    (character.seed === true ? `\n${SEED_CHARACTER_PROMPT}` : '') +
    ownNamesBlock(request) +
    rosterBlock(request) +
    (picked ? `\n\n${picked}` : '') +
    (memes ? `\n\n${memes}` : '') +
    batchBlock(request);
  const content = JSON.stringify(context(request, false));
  ensure(content.length <= 200_000, 'TEXT_CONTEXT_TOO_LARGE');
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content },
  ];
}

export function writerGuardMessages(request: TextGenerationRequest, draft: WriterDraft) {
  const { character } = request;
  const content = JSON.stringify({
    character: { id: character.id, name: character.name, authorCanon: character.authorCanon ?? null },
    ...context(request, true),
    ...(request.ownNames?.length ? { ownNames: request.ownNames } : {}),
    mustClose: request.mustClose,
    delivery: request.deliveryMode ?? 'text',
    draft: draft.bubbles.map((bubble, index) => ({ index, text: bubble.text })),
  });
  ensure(content.length <= 210_000, 'TEXT_CONTEXT_TOO_LARGE');
  return [
    { role: 'system' as const, content: GUARD + (request.cast ? `\n${CAST}` : '') },
    { role: 'user' as const, content },
  ];
}

/** The plain draft with the voice markup each line carries (null = none). `bubbles[i].text` never contains markup. */
export interface WriterDraft extends TextDraft {
  markups: (string | null)[];
}

const GROUP = /\[[^[\]<>\n]{1,80}\] ?/gu;
const WHISPER = /<\/?whisper>/gu;
/**
 * One spoken line, cleaned. Recognised markup (a [direction] group, one <whisper> pair) is stripped; any other bracket or tag is
 * dropped too, so the returned text never contains `[ ] < >`. The markup is kept only when the line is made of nothing but
 * recognised markup (Part 30's rule, `stripDirectionMarkup`), a Drama 3 reply allows it, it fits the Fish limit and has at most one
 * well-ordered whisper pair; every other case sends plain text. Malformed markup never fails a reply.
 */
export function cleanSpokenLine(raw: string, directions: boolean): { text: string; markup: string | null } {
  // Part 37a-2: a direction that asks for shouting is dropped (the words stay) before anything else is looked at.
  const line = dropLoudDirections(raw);
  const text = line
    .replace(GROUP, '')
    .replace(WHISPER, '')
    .replace(/<[^<>\n]{0,40}>/gu, '')
    .replace(/\[[^[\]\n]{0,80}\]/gu, '')
    .replace(/[[\]<>]/gu, '')
    .trim();
  if (!directions || text === line) return { text, markup: null };
  const open = line.match(/<whisper>/gu)?.length ?? 0,
    close = line.match(/<\/whisper>/gu)?.length ?? 0;
  const ordered = open === 0 || line.indexOf('<whisper>') < line.indexOf('</whisper>');
  const plain = stripDirectionMarkup(line);
  const valid = open <= 1 && close === open && ordered && plain !== null && plain === text && [...line].length <= 900;
  return { text, markup: valid ? line : null };
}

type Line = { text: string; markup: string | null };
const SENTENCE_END = /[。！？!?…~～.]/u;
/** Cut one line to `max` characters: after the last sentence end that keeps at least half of it, else exactly at the limit. */
function cutLine(text: string, max: number) {
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = chars.slice(0, max);
  for (let i = head.length - 1; i >= Math.ceil(max / 2); i--)
    if (SENTENCE_END.test(head[i]!)) return head.slice(0, i + 1).join('');
  return head.join('');
}
/**
 * The publication limits "as today", applied mechanically and never as a rewrite: a line longer than the limit is cut at a sentence end
 * (else at the limit), lines past the bubble limit and past the total are dropped from the end. A line that was cut loses its markup.
 */
export function capLines(
  lines: readonly Line[],
  limits: { maxBubbles: number; maxCharacters: number; maxTotalCharacters: number },
): Line[] {
  const out: Line[] = [];
  let total = 0;
  for (const line of lines.slice(0, limits.maxBubbles)) {
    const room = limits.maxTotalCharacters - total;
    if (room <= 0) break;
    const cut = cutLine(line.text, Math.min(limits.maxCharacters, room));
    if (cut.length === 0) break;
    out.push(cut === line.text ? line : { text: cut, markup: null });
    total += [...cut].length;
  }
  return out;
}

const bubbleOf = (text: string): DialogueBubble => ({ text, expression: 'neutral' });

/**
 * The draft stage's payload is `{text}` (the model's own words). One line is one bubble (text) or one voice segment (voice). Empty
 * lines go; a reply with no line is INVALID_BUBBLES, as in v7.
 */
export function parseWriterDraft(value: unknown, request: TextGenerationRequest): WriterDraft {
  ensure(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).join(',') === 'text' &&
      typeof (value as { text: unknown }).text === 'string' &&
      (value as { text: string }).text.length <= 20_000,
    'INVALID_DRAFT_SCHEMA',
  );
  const voice = request.deliveryMode === 'voice';
  const lines = (value as { text: string }).text
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(
      (line): Line => (voice ? cleanSpokenLine(line, request.voiceDirections === true) : { text: line, markup: null }),
    )
    .filter((line) => line.text.length > 0);
  const capped = capLines(lines, DRAFT_BUBBLE_LIMITS);
  const bubbles = validatedBubbles(
    capped.map((line) => bubbleOf(line.text)),
    DRAFT_BUBBLE_LIMITS,
  );
  return { mode: 'casual', bubbles, endsSession: false, markups: capped.map((line) => line.markup) };
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The second pass. `fixes` replace single bubbles for one of the fourteen reasons; everything else is published exactly as written.
 * Coverage is not asked of the model: the request carries exactly one input message and the reply answers it by being published, so
 * the shared v7 validation (topics, facts, scene, relationship events) is fed that one id as covered by this code, and nothing is
 * ever deferred or awaiting the player (no follow-up is scheduled for a v8 reply).
 */
export function applyWriterGuard(
  value: unknown,
  draft: TextDraft,
  request: TextGenerationRequest,
  options: ReviewOptions = {},
): DialogueCandidate {
  const writerDraft = draft as WriterDraft;
  ensure(isPlain(value), 'INVALID_REVIEW_SCHEMA');
  const keys = [
    'fixes',
    'mode',
    'endsSession',
    'topics',
    'factOps',
    ...(request.sceneContext ? ['sceneUpdate'] : []),
    ...(request.relationshipContext?.auditEnabled ? ['relationshipEvents'] : []),
  ];
  ensure(Object.keys(value).sort().join(',') === keys.sort().join(','), 'INVALID_REVIEW_SCHEMA');
  ensure(value.mode === 'casual' || value.mode === 'conflict_apology', 'INVALID_REPLY_SCHEMA');
  ensure(typeof value.endsSession === 'boolean', 'INVALID_REPLY_SCHEMA');
  ensure(!request.mustClose || value.endsSession, 'CLOSING_REQUIRED');
  ensure(Array.isArray(value.fixes) && value.fixes.length <= writerDraft.bubbles.length, 'INVALID_GUARD_FIX');
  const voice = request.deliveryMode === 'voice';
  const lines: Line[] = writerDraft.bubbles.map((bubble, index) => ({
    text: bubble.text,
    markup: writerDraft.markups?.[index] ?? null,
  }));
  const reasons: GuardReason[] = [];
  const seen = new Set<number>();
  for (const fix of value.fixes as unknown[]) {
    ensure(
      isPlain(fix) &&
        Object.keys(fix).sort().join(',') === 'index,reason,text' &&
        typeof fix.index === 'number' &&
        Number.isInteger(fix.index) &&
        fix.index >= 0 &&
        fix.index < lines.length &&
        !seen.has(fix.index) &&
        typeof fix.text === 'string' &&
        (GUARD_REASONS as readonly unknown[]).includes(fix.reason),
      'INVALID_GUARD_FIX',
    );
    seen.add(fix.index);
    // A replacement is one plain line in the character's voice; its markup, like the draft line's, is gone.
    const text = (
      voice
        ? cleanSpokenLine(fix.text.replace(/[\r\n]+/gu, ' '), false)
        : { text: fix.text.replace(/[\r\n]+/gu, ' ').trim() }
    ).text;
    ensure(text.length > 0, 'INVALID_GUARD_FIX');
    lines[fix.index] = { text, markup: null };
    reasons.push(fix.reason as GuardReason);
  }
  const capped = capLines(lines, bubbleLimits(request.deliveryMode)[value.mode]);
  ensure(capped.length > 0, 'INVALID_BUBBLES');
  const bubbles = capped.map((line) => bubbleOf(line.text));
  const required = request.requiredMessageIds;
  // Part 36: one reply answers a whole turn (up to five bubbles in a row). The model is never asked what it covered: every bubble
  // of the turn is marked covered by code, the reply being published.
  ensure(required.length >= 1 && required.length <= 5, 'INVALID_COVERAGE');
  // The quote only has to be a stretch of one final bubble (the shared check); it is chosen here, not by the model.
  const quote = [...bubbles[0]!.text].slice(0, 160).join('');
  const synthetic = {
    decision: 'accept',
    replacementBubbles: [],
    coverage: Object.fromEntries(
      required.map((id) => [id, { status: 'answered', supportQuote: quote, missingInformation: '' }]),
    ),
    topics: value.topics,
    factOps: value.factOps,
    ...(request.sceneContext ? { sceneUpdate: value.sceneUpdate } : {}),
    ...(request.relationshipContext?.auditEnabled ? { relationshipEvents: value.relationshipEvents } : {}),
  };
  // The v7 review checks run on a v7-shaped request: no writer key, the same everything else.
  const { writer: _writer, voiceDirections: _directions, ...asV7 } = request;
  const candidate = applyTextReview(
    synthetic,
    { mode: value.mode, bubbles, endsSession: value.endsSession },
    asV7 as TextGenerationRequest,
    { ...DROP_INVALID_METADATA, ...options },
  );
  candidate.reviewChanged = reasons.length > 0;
  candidate.guardReasons = reasons;
  if (capped.some((line) => line.markup !== null)) candidate.bubbleMarkup = capped.map((line) => line.markup);
  return candidate;
}

/** Callers that may hold either kind of request go through these two; a request without `writer` is v7, untouched. */
export function parseDraft(value: unknown, request: TextGenerationRequest): TextDraft {
  return request.writer === 'v8' ? parseWriterDraft(value, request) : parseTextDraft(value, request);
}
export function applyReview(
  value: unknown,
  draft: TextDraft,
  request: TextGenerationRequest,
  options: ReviewOptions = {},
): DialogueCandidate {
  return request.writer === 'v8'
    ? applyWriterGuard(value, draft, request, options)
    : applyTextReview(value, draft, request, options);
}

/** What a stored v8 request must still match: its prompt and protocol pins, plus the cast prompt hash a frozen cast view carries. */
export const writerPins = (profile = false, memes = false) => ({
  protocolDigest: createHash('sha256').update(JSON.stringify(writerProtocolFingerprint())).digest('hex'),
  promptDigest: profile
    ? createHash('sha256')
        .update(
          JSON.stringify(
            memes
              ? [writerPromptHash(), writerProfileHash(), writerMemesHash()]
              : [writerPromptHash(), writerProfileHash()],
          ),
        )
        .digest('hex')
    : writerPromptHash(),
});
