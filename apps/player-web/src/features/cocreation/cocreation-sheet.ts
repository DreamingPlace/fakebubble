/**
 * 共创 sheet: a swipeable deck of inspiration cards for one official character. The player writes what they like,
 * skips the rest, and hands everything written so far over in one go. Nothing is reviewed or answered; the only
 * feedback is a thank-you. Drafts live in memory only (never localStorage), so they survive closing the sheet but
 * not a page reload.
 */
import {
  COCREATION_CARDS,
  COCREATION_LIMITS,
  COCREATION_NOTE_MAX,
  COCREATION_PAIR_CARD,
  COCREATION_PAIR_NOTE_MAX,
  cocreationPrompt,
  validateCocreationAnswers,
  type CocreationAnswer,
  type CocreationCard,
} from '../../../../../packages/contracts/cocreation-cards.ts';
import { h, length } from './h.ts';

export interface CocreationApi {
  submitCocreation(input: {
    characterId: string;
    requestId: string;
    answers: CocreationAnswer[];
  }): Promise<{ submissionId: string; answered: number; duplicate: boolean }>;
  /** Has today's entry for this character been used? Best effort: without it the sheet simply does not say. */
  cocreationToday?(characterId: string): Promise<{ cardIds: string[] }>;
  /** Part 24c: a note to the production team (留言条). Without it the sheet has no such entry. */
  submitMemo?(input: {
    requestId: string;
    text: string;
  }): Promise<{ submissionId: string; duplicate: boolean; earned?: number }>;
  /** Part 24c: the story between this character and another. Without it the sheet has no pair card. */
  submitPair?(input: {
    requestId: string;
    characterId: string;
    partnerId: string;
    text: string;
  }): Promise<{ submissionId: string; duplicate: boolean; earned?: number }>;
}
export type CocreationSheetOptions = {
  api: CocreationApi;
  characterId: string;
  /** Display name, used in every prompt and in the thank-you. */
  name: string;
  /** Avatar letter and colours of the character card, so the sheet feels like theirs. */
  mark?: string;
  color?: string;
  ink?: string;
  /** Part 25a: the character's aura (three cloud colours) and accent; the sheet is painted in them. */
  aura?: readonly [string, string, string, string];
  say?: (message: string) => void;
  /** Part 24c: the other live characters, for the pair story card (id and display name). */
  others?: readonly { characterId: string; name: string }[];
  /** Where the sheet is mounted; defaults to document.body. */
  mount?: HTMLElement;
  random?: () => number;
  newRequestId?: () => string;
  /** How long the thank-you stays before the sheet closes. */
  thanksMs?: number;
  /** Part 25c: a guest (no signed-up account, not unlimited): the thank-you hints that signing up earns points. */
  guest?: boolean;
};

export const BATCH_SIZE = 5;
export const cocreationCopy = {
  /** The chat ⋯ menu's entry. */
  title: (_name: string) => '一起共创角色',
  /** Part 25a: the sheet's own header. */
  heading: (name: string) => `让${name}更像${name}`,
  sub: (name: string) => `写下你心中的${name}`,
  /** One answer per player per character per card per UTC day: the card is spent until 00:00 UTC. */
  cardUsed: '今天已回答，明天再来',
  /** Every card of this character has been answered today. */
  allUsed: '今天的问题都回答过了，明天再来',
  /** Part 25a: "written / cards on offer". */
  progress: (n: number, total: number) => `${n} / ${total}`,
  shuffle: '换一批',
  send: (name: string) => `交给${name}`,
  sending: '正在交出去…',
  thanks: (name: string) => `${name}收到了你的小纸条`,
  thanksSub: '谢谢你，这份心意已经交到了。',
  /** Part 24c: shown under the thank-you when the notes earned points. */
  earned: (points: number) => `共创奖励 +${points} 点`,
  /** Part 25c: the guest's version of the line above, in the same place: a guest earns nothing, a signed-up player does. */
  guestHint: '注册后，共创还能得点数～',
  /** The pair story card: "{name} 和 [select] [🎲] 之间的故事". */
  pairWith: (name: string) => `${name} 和`,
  pairBetween: '之间的故事',
  pairSelect: '选一个角色',
  pairRoll: '随机换一个',
  pairPlaceholder: (name: string, other: string) => `${name}和${other}之间发生过什么？`,
  /** The 留言条 entry: a note to the production team, never rewarded. */
  memoOpen: '给制作组的留言条',
  memoPlaceholder: '想对制作组说点什么',
  memoSend: '递给制作组',
  memoSending: '正在递出去…',
  memoThanks: '留言条递到了，谢谢',
  written: '已写',
  write: '写下来',
  done: '写好了',
  skip: '跳过',
  clear: '清除这张',
  addReply: '再回一句',
  dropReply: '去掉这句',
  halfDialogue: '两边都写上才算一张哦',
  you: '你说：',
  reply: (name: string) => `${name}会回：`,
  close: '关闭',
  errors: {
    COCREATION_DAILY_LIMIT: '有的问题今天已经回答过了，明天再来吧',
    COCREATION_IP_LIMIT: '今天的共创次数用完了，明天再来吧',
    COCREATION_TEXT_INVALID: '有一张的内容不太合适，检查一下长度再试试。',
    COCREATION_EMPTY: '先写一张再交出去吧。',
    NOT_FOUND: '这个人物暂时不能共创。',
    COCREATION_UNAVAILABLE: '暂时不能写这个，稍后再试试。',
    unknown: '没能交出去，稍后再试一次。写的内容还在这里。',
  } as Record<string, string>,
};

type Draft = {
  text: Map<string, string>;
  dialogue: { player: string; replies: string[] };
  /** Cards in the order they were first written: written cards stay at the front of the deck. */
  order: string[];
  queue: string[];
  batch: string[];
  pending: { requestId: string; fingerprint: string } | null;
  /** Part 24c: the pair story card: the chosen other character ('' = none yet), its text and the request id of an uncertain send. */
  pair: { partnerId: string; text: string; pending: { requestId: string; fingerprint: string } | null };
};
const drafts = new Map<string, Draft>();
/** The 留言条 text and the request id of an uncertain send (one for the whole page, as a memo is about no character). */
const memoDraft: { text: string; pending: { requestId: string; fingerprint: string } | null } = {
  text: '',
  pending: null,
};
/** Test hook and sign-out: drafts are memory only and can be dropped at any time. */
export const resetCocreationDrafts = () => {
  drafts.clear();
  memoDraft.text = '';
  memoDraft.pending = null;
};

const cardMax = (card: CocreationCard) => (card.id === 'free' ? COCREATION_LIMITS.free : COCREATION_LIMITS.text);
/** Same rule as chat input: line breaks and other control characters become a space. */
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/gu, ' ');
const shuffle = <T>(items: readonly T[], random: () => number) => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
};

export function openCocreationSheet(options: CocreationSheetOptions) {
  const { api, characterId, name } = options;
  const random = options.random ?? Math.random;
  const newRequestId = options.newRequestId ?? (() => globalThis.crypto.randomUUID());
  const mountPoint = options.mount ?? document.body;
  const opener = document.activeElement as HTMLElement | null;
  const draft: Draft = drafts.get(characterId) ?? {
    text: new Map(),
    dialogue: { player: '', replies: [''] },
    order: [],
    queue: [],
    batch: [],
    pending: null,
    pair: { partnerId: '', text: '', pending: null },
  };
  drafts.set(characterId, draft);
  const others = api.submitPair ? (options.others ?? []).filter((entry) => entry.characterId !== characterId) : [];
  if (!others.some((entry) => entry.characterId === draft.pair.partnerId))
    draft.pair.partnerId = others[0]?.characterId ?? '';
  const otherName = () => others.find((entry) => entry.characterId === draft.pair.partnerId)?.name ?? '';
  const pairReady = () => draft.pair.partnerId !== '' && draft.pair.text.trim() !== '';

  const dialogueDone = () => draft.dialogue.player.trim() !== '' && draft.dialogue.replies.some((r) => r.trim() !== '');
  const dialogueTouched = () =>
    draft.dialogue.player.trim() !== '' || draft.dialogue.replies.some((r) => r.trim() !== '');
  // Cards this player already answered today (UTC) for this character: shown disabled, never part of an answer.
  const used = new Set<string>();
  const isWritten = (id: string) =>
    !used.has(id) && (id === 'dialogue' ? dialogueDone() : (draft.text.get(id) ?? '').trim() !== '');
  const unwrittenPool = () =>
    COCREATION_CARDS.filter((card) => card.id !== 'free' && !used.has(card.id) && !isWritten(card.id)).map(
      (card) => card.id,
    );
  const writtenIds = () => draft.order.filter(isWritten);
  const writtenCount = () => writtenIds().length;

  const drawBatch = () => {
    const pool = unwrittenPool();
    let queue = draft.queue.filter((id) => pool.includes(id));
    const take: string[] = [];
    while (take.length < BATCH_SIZE && take.length < pool.length) {
      if (queue.length === 0)
        queue = shuffle(
          pool.filter((id) => !take.includes(id)),
          random,
        );
      take.push(queue.shift()!);
    }
    draft.queue = queue;
    draft.batch = take;
  };
  if (draft.batch.length === 0) drawBatch();
  const deckIds = () => [
    ...writtenIds(),
    ...draft.batch.filter((id) => !isWritten(id)),
    ...(isWritten('free') || used.has('free') ? [] : ['free']),
    ...COCREATION_CARDS.filter((card) => used.has(card.id)).map((card) => card.id),
  ];

  // ---- DOM ------------------------------------------------------------------------------------------------------
  const title = h('strong', { class: 'cc-title', text: cocreationCopy.heading(name), attrs: { id: 'cc-title' } });
  const progress = h('span', { class: 'cc-progress', attrs: { role: 'status', 'aria-live': 'polite' } });
  const closeButton = h('button', {
    class: 'cc-close icon-button',
    attrs: { type: 'button', 'aria-label': cocreationCopy.close },
    text: '×',
  });
  const shuffleButton = h('button', { class: 'cc-shuffle', text: cocreationCopy.shuffle, attrs: { type: 'button' } });
  const deck = h('div', {
    class: 'cc-deck',
    attrs: { role: 'list', tabindex: '0', 'aria-label': '灵感卡片，可左右滑动' },
  });
  const dots = h('div', { class: 'cc-dots', attrs: { 'aria-hidden': 'true' } });
  const notice = h('p', { class: 'cc-notice', attrs: { role: 'status', 'aria-live': 'polite' }, hidden: true });
  // Shown when every card of this character has been answered today.
  const usedBanner = h('p', {
    class: 'cc-used',
    text: cocreationCopy.allUsed,
    attrs: { role: 'status', 'aria-live': 'polite' },
    hidden: true,
  });
  const allUsed = () => COCREATION_CARDS.every((card) => used.has(card.id));
  const sendButton = h('button', { class: 'cc-send', attrs: { type: 'button' }, text: cocreationCopy.send(name) });
  const footer = h('footer', { class: 'cc-foot' }, notice, sendButton);
  const thanksSub = h('p', { class: 'cc-thanks-sub', text: cocreationCopy.thanksSub });
  const thanks = h(
    'div',
    { class: 'cc-thanks', attrs: { role: 'status', 'aria-live': 'polite' }, hidden: true },
    h('div', { class: 'cc-note-art', attrs: { 'aria-hidden': 'true' } }, h('i'), h('i'), h('i')),
    h('strong', { class: 'cc-thanks-title', text: cocreationCopy.thanks(name) }),
    thanksSub,
  );
  const sheet = h(
    'div',
    { class: 'cc-sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cc-title' } },
    h('header', { class: 'cc-head' }, closeButton, h('div', { class: 'cc-heading' }, title, progress), shuffleButton),
    usedBanner,
    deck,
    dots,
    footer,
    thanks,
  );
  // The character's colours travel as custom properties set through the CSSOM (an inline style attribute is refused by the CSP).
  const paint = (name: string, value: string | undefined) => {
    if (value) sheet.style.setProperty(name, value);
  };
  if (options.color) {
    paint('--cc-color', options.color);
    paint('--cc-ink', options.ink ?? '#29423b');
    paint('--avatar-bg', options.color);
    paint('--avatar-ink', options.ink ?? '#29423b');
  }
  if (options.aura) {
    paint('--aura-1', options.aura[0]);
    paint('--aura-2', options.aura[1]);
    paint('--aura-3', options.aura[2]);
    paint('--accent', options.aura[3]);
  }

  type CardRefs = {
    card: CocreationCard;
    root: HTMLElement;
    open: HTMLButtonElement;
    editor: HTMLElement;
    areas: HTMLTextAreaElement[];
    counters: HTMLElement[];
    secondReply?: HTMLElement;
    addReply?: HTMLElement;
    hint?: HTMLElement;
    skip: HTMLButtonElement;
    cta: HTMLElement;
  };
  const refs = new Map<string, CardRefs>();
  let openId: string | null = null;
  let busy = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const counter = (value: string, max: number) => `${length(value)}/${max}`;
  const textArea = (
    label: string,
    placeholder: string,
    value: string,
    max: number,
    onInput: (value: string) => void,
    rows = 3,
  ) => {
    const area = h('textarea', {
      class: 'cc-area',
      attrs: { rows: String(rows), maxlength: String(max), placeholder, 'aria-label': label, enterkeyhint: 'done' },
    });
    area.value = value;
    const count = h('span', { class: 'cc-count', text: counter(value, max), attrs: { 'aria-hidden': 'true' } });
    area.addEventListener('input', () => {
      const next = clean(area.value);
      if (next !== area.value) area.value = next;
      count.textContent = counter(next, max);
      onInput(next);
    });
    return { area, count };
  };

  const refreshRefs = (id: string) => {
    const ref = refs.get(id);
    if (!ref) return;
    const written = isWritten(id);
    ref.root.className = `cc-card${written ? ' is-written' : ''}${openId === id ? ' is-open' : ''}${
      id === 'dialogue' ? ' is-dialogue' : ''
    }`;
    const spent = used.has(id);
    if (spent) {
      ref.root.className += ' is-used';
      if (openId === id) openId = null;
    }
    ref.editor.hidden = openId !== id;
    ref.open.disabled = spent;
    ref.cta.textContent = spent ? cocreationCopy.cardUsed : cocreationCopy.write;
    ref.open.setAttribute('aria-expanded', String(openId === id));
    ref.skip.textContent =
      written || (id === 'dialogue' && dialogueTouched()) ? cocreationCopy.clear : cocreationCopy.skip;
    if (ref.hint) ref.hint.hidden = !(id === 'dialogue' && dialogueTouched() && !dialogueDone());
    if (ref.secondReply) ref.secondReply.hidden = draft.dialogue.replies.length < 2;
    if (ref.addReply) ref.addReply.hidden = draft.dialogue.replies.length >= 2;
  };
  const refresh = () => {
    const n = writtenCount();
    progress.textContent = cocreationCopy.progress(n, deckIds().filter((id) => !used.has(id)).length);
    sendButton.disabled = busy || ((n === 0 || allUsed()) && !pairReady());
    usedBanner.hidden = !allUsed();
    shuffleButton.disabled = busy;
    memoRefresh();
    for (const id of refs.keys()) refreshRefs(id);
  };

  const buildCard = (card: CocreationCard): CardRefs => {
    const prompt = cocreationPrompt(card, name);
    const badge = h('span', { class: 'cc-badge', text: cocreationCopy.written });
    const cta = h('span', { class: 'cc-cta', text: cocreationCopy.write });
    const face = h(
      'button',
      { class: 'cc-face', attrs: { type: 'button', 'aria-expanded': 'false' } },
      h('span', { class: 'cc-prompt', text: prompt }),
      badge,
      cta,
    );
    const editor = h('div', { class: 'cc-editor', hidden: true });
    const areas: HTMLTextAreaElement[] = [];
    const counters: HTMLElement[] = [];
    const done = h('button', { class: 'cc-done', text: cocreationCopy.done, attrs: { type: 'button' } });
    const skip = h('button', { class: 'cc-skip', text: cocreationCopy.skip, attrs: { type: 'button' } });
    let secondReply: HTMLElement | undefined;
    let addReply: HTMLElement | undefined;
    let hint: HTMLElement | undefined;

    if (card.kind === 'text') {
      const max = cardMax(card);
      const { area, count } = textArea(prompt, '写在这里…', draft.text.get(card.id) ?? '', max, (value) => {
        draft.text.set(card.id, value);
        noteWritten(card.id);
        refresh();
      });
      areas.push(area);
      counters.push(count);
      editor.append(area, h('div', { class: 'cc-meta' }, count));
    } else {
      // The dialogue card renders like the real chat: the player's bubble on the right, the character's on the left.
      const mark = options.mark ?? name.slice(0, 1);
      const you = textArea(
        cocreationCopy.you,
        '你想对' + name + '说什么',
        draft.dialogue.player,
        COCREATION_LIMITS.dialoguePlayer,
        (v) => {
          draft.dialogue.player = v;
          noteWritten('dialogue');
          refresh();
        },
        2,
      );
      const reply = (index: number) =>
        textArea(
          `${cocreationCopy.reply(name)}${index + 1}`,
          index === 0 ? `${name}会怎么回` : '再补一句',
          draft.dialogue.replies[index] ?? '',
          COCREATION_LIMITS.dialogueReply,
          (v) => {
            draft.dialogue.replies[index] = v;
            noteWritten('dialogue');
            refresh();
          },
          2,
        );
      const first = reply(0),
        second = reply(1);
      areas.push(you.area, first.area, second.area);
      counters.push(you.count, first.count, second.count);
      const dropReply = h('button', { class: 'cc-link', text: cocreationCopy.dropReply, attrs: { type: 'button' } });
      const add = h('button', { class: 'cc-link', text: cocreationCopy.addReply, attrs: { type: 'button' } });
      addReply = add;
      secondReply = h(
        'div',
        { class: 'message-row incoming cc-bubble-row', hidden: true },
        h('span', { class: 'avatar message-avatar', text: mark, attrs: { 'aria-hidden': 'true' } }),
        h(
          'div',
          { class: 'cc-bubble cc-bubble-in' },
          second.area,
          h('div', { class: 'cc-meta' }, second.count, dropReply),
        ),
      );
      hint = h('p', { class: 'cc-hint', text: cocreationCopy.halfDialogue, hidden: true });
      dropReply.addEventListener('click', () => {
        draft.dialogue.replies = draft.dialogue.replies.slice(0, 1);
        second.area.value = '';
        second.count.textContent = counter('', COCREATION_LIMITS.dialogueReply);
        refresh();
        first.area.focus?.();
      });
      add.addEventListener('click', () => {
        if (draft.dialogue.replies.length >= COCREATION_LIMITS.dialogueReplies) return;
        draft.dialogue.replies = [...draft.dialogue.replies, ''];
        refresh();
        second.area.focus?.();
      });
      editor.append(
        h(
          'div',
          { class: 'message-row outgoing cc-bubble-row' },
          h('div', { class: 'cc-bubble cc-bubble-out' }, you.area, h('div', { class: 'cc-meta' }, you.count)),
        ),
        h(
          'div',
          { class: 'message-row incoming cc-bubble-row' },
          h('span', { class: 'avatar message-avatar', text: mark, attrs: { 'aria-hidden': 'true' } }),
          h('div', { class: 'cc-bubble cc-bubble-in' }, first.area, h('div', { class: 'cc-meta' }, first.count, add)),
        ),
        secondReply,
        hint,
      );
    }
    editor.append(h('div', { class: 'cc-actions' }, skip, done));

    const root = h('article', { class: 'cc-card', attrs: { role: 'listitem', 'data-card': card.id } }, face, editor);
    const ref: CardRefs = {
      card,
      root,
      open: face,
      editor,
      areas,
      counters,
      skip,
      cta,
      ...(secondReply ? { secondReply } : {}),
      ...(addReply ? { addReply } : {}),
      ...(hint ? { hint } : {}),
    };

    face.addEventListener('click', () => toggle(card.id));
    done.addEventListener('click', () => toggle(card.id, false));
    skip.addEventListener('click', () => {
      if (card.kind === 'text') {
        draft.text.delete(card.id);
        areas[0]!.value = '';
        counters[0]!.textContent = counter('', cardMax(card));
      } else {
        draft.dialogue = { player: '', replies: [''] };
        for (const [i, area] of areas.entries()) {
          area.value = '';
          counters[i]!.textContent = counter(
            '',
            i === 0 ? COCREATION_LIMITS.dialoguePlayer : COCREATION_LIMITS.dialogueReply,
          );
        }
      }
      toggle(card.id, false);
    });
    for (const area of areas)
      area.addEventListener('keydown', (event) => {
        const key = event as unknown as { key: string; isComposing?: boolean; shiftKey?: boolean };
        // Enter would put a line break into the text, which chat input does not allow: it finishes the card instead.
        if (key.key === 'Enter' && !key.isComposing) {
          event.preventDefault();
          toggle(card.id, false);
        }
      });
    return ref;
  };
  const noteWritten = (id: string) => {
    if (isWritten(id) && !draft.order.includes(id)) draft.order.push(id);
  };

  function toggle(id: string, force?: boolean) {
    const open = force ?? openId !== id;
    openId = open ? id : openId === id ? null : openId;
    refresh();
    if (open) {
      const ref = refs.get(id);
      (ref?.root as unknown as { scrollIntoView?: (o: unknown) => void })?.scrollIntoView?.({
        inline: 'center',
        block: 'nearest',
        behavior: 'smooth',
      });
      ref?.areas[0]?.focus?.();
    } else refs.get(id)?.open.focus?.();
  }

  // ---- Part 24c: the pair story card (design/burbur-v2 Cocreate board): "{name} 和 [select] [🎲] 之间的故事" -------------------
  const buildPairCard = () => {
    const select = h('select', { class: 'cc-pair-select', attrs: { 'aria-label': cocreationCopy.pairSelect } });
    for (const entry of others) {
      const option = h('option', { text: entry.name, attrs: { value: entry.characterId } });
      select.append(option);
    }
    select.value = draft.pair.partnerId;
    const roll = h('button', {
      class: 'cc-pair-roll',
      text: '🎲',
      attrs: { type: 'button', 'aria-label': cocreationCopy.pairRoll },
    });
    const { area, count } = textArea(
      cocreationCopy.pairWith(name),
      cocreationCopy.pairPlaceholder(name, otherName()),
      draft.pair.text,
      COCREATION_PAIR_NOTE_MAX,
      (value) => {
        draft.pair.text = value;
        refresh();
      },
      3,
    );
    const setPartner = (id: string) => {
      draft.pair.partnerId = id;
      select.value = id;
      area.setAttribute('placeholder', cocreationCopy.pairPlaceholder(name, otherName()));
      refresh();
    };
    select.addEventListener('change', () => setPartner(select.value));
    // Tap again to re-roll: any OTHER character than the one showing (when there is more than one to pick from).
    roll.addEventListener('click', () => {
      const pool = others.filter((entry) => entry.characterId !== draft.pair.partnerId);
      const pick = (pool.length ? pool : others)[Math.floor(random() * (pool.length ? pool.length : others.length))];
      if (pick) setPartner(pick.characterId);
    });
    area.addEventListener('keydown', (event) => {
      if ((event as unknown as { key: string }).key === 'Enter') event.preventDefault();
    });
    const root = h(
      'article',
      { class: 'cc-card cc-pair', attrs: { role: 'listitem', 'data-card': COCREATION_PAIR_CARD } },
      h(
        'div',
        { class: 'cc-face cc-pair-face' },
        h(
          'div',
          { class: 'cc-pair-line' },
          h('span', { text: cocreationCopy.pairWith(name) }),
          select,
          roll,
          h('span', { text: cocreationCopy.pairBetween }),
        ),
      ),
      h('div', { class: 'cc-editor' }, area, h('div', { class: 'cc-meta' }, count)),
    );
    return { root, area, count };
  };
  const pairCard = others.length > 0 ? buildPairCard() : null;

  // ---- Part 24c: 给制作组的留言条 (a note to the production team; stored and typed as a memo, never rewarded) --------------------
  const memoOpen = h('button', {
    class: 'cc-memo-open',
    text: cocreationCopy.memoOpen,
    attrs: { type: 'button', 'aria-expanded': 'false' },
  });
  const memoArea = h('textarea', {
    class: 'cc-area cc-memo-area',
    attrs: {
      rows: '3',
      maxlength: String(COCREATION_NOTE_MAX),
      placeholder: cocreationCopy.memoPlaceholder,
      'aria-label': cocreationCopy.memoOpen,
    },
  });
  memoArea.value = memoDraft.text;
  const memoSend = h('button', { class: 'cc-memo-send', text: cocreationCopy.memoSend, attrs: { type: 'button' } });
  const memoPanel = h('div', { class: 'cc-memo', hidden: true }, memoArea, memoSend);
  const memoRefresh = () => {
    memoSend.disabled = busy || memoDraft.text.trim() === '';
  };
  memoOpen.addEventListener('click', () => {
    memoPanel.hidden = !memoPanel.hidden;
    memoOpen.setAttribute('aria-expanded', String(!memoPanel.hidden));
    if (!memoPanel.hidden) memoArea.focus?.();
  });
  memoArea.addEventListener('input', () => {
    const next = clean(memoArea.value);
    if (next !== memoArea.value) memoArea.value = next;
    memoDraft.text = next;
    memoRefresh();
  });
  const memoEntry = api.submitMemo ? h('div', { class: 'cc-memo-entry' }, memoOpen, memoPanel) : null;
  if (memoEntry) footer.replaceChildren(memoEntry, notice, sendButton);
  memoRefresh();

  const renderDeck = () => {
    refs.clear();
    const ids = deckIds();
    const cards = ids.map((id) => {
      const ref = buildCard(COCREATION_CARDS.find((card) => card.id === id)!);
      refs.set(id, ref);
      return ref.root;
    });
    deck.replaceChildren(...cards, ...(pairCard ? [pairCard.root] : []));
    dots.replaceChildren(...ids.map((id) => h('i', { class: id === ids[0] ? 'on' : '', attrs: { 'data-dot': id } })));
    refresh();
  };

  shuffleButton.addEventListener('click', () => {
    if (busy) return;
    openId = null;
    drawBatch();
    renderDeck();
    (deck as unknown as { scrollTo?: (o: unknown) => void }).scrollTo?.({ left: 0, behavior: 'smooth' });
    deck.focus?.();
  });

  const answers = (): CocreationAnswer[] => {
    const out: CocreationAnswer[] = [];
    for (const id of writtenIds()) {
      if (id === 'dialogue')
        out.push({
          cardId: id,
          player: draft.dialogue.player.trim(),
          replies: draft.dialogue.replies.map((r) => r.trim()).filter(Boolean),
        });
      else out.push({ cardId: id, text: (draft.text.get(id) ?? '').trim() });
    }
    return out;
  };
  const show = (message: string) => {
    notice.textContent = message;
    notice.hidden = message === '';
  };

  /** The cards in `sent` were handed over while the pair note was not: they are spent for today and leave the draft. */
  const spendCards = (sent: CocreationAnswer[]) => {
    for (const answer of sent) {
      used.add(answer.cardId);
      draft.text.delete(answer.cardId);
      if (answer.cardId === 'dialogue') draft.dialogue = { player: '', replies: [''] };
    }
    draft.order = draft.order.filter((id) => !used.has(id));
    draft.pending = null;
    draft.batch = [];
    drawBatch();
    renderDeck();
  };

  sendButton.addEventListener('click', async () => {
    if (busy || closed) return;
    const payload = answers();
    const sendCards = payload.length > 0 && !allUsed();
    if (sendCards) {
      const checked = validateCocreationAnswers(payload);
      if (!checked.ok) {
        show(cocreationCopy.errors[checked.code] ?? cocreationCopy.errors.unknown!);
        return;
      }
    } else if (!pairReady()) return;
    busy = true;
    show('');
    sendButton.textContent = cocreationCopy.sending;
    refresh();
    const fail = (error: unknown) => {
      busy = false;
      sendButton.textContent = cocreationCopy.send(name);
      const code = (error as { code?: string }).code ?? '';
      show(cocreationCopy.errors[code] ?? cocreationCopy.errors.unknown!);
      return code;
    };
    let earned = 0;
    if (sendCards) {
      // The same content keeps the same request id, so retrying an uncertain send can never submit it twice.
      const fingerprint = JSON.stringify(payload);
      if (draft.pending?.fingerprint !== fingerprint) draft.pending = { requestId: newRequestId(), fingerprint };
      try {
        const handed = await api.submitCocreation({
          characterId,
          requestId: draft.pending.requestId,
          answers: payload,
        });
        earned += (handed as { earned?: number }).earned ?? 0;
      } catch (error) {
        const code = fail(error);
        // Refused whole: learn which cards are spent so they can be disabled; the rest of the draft stays.
        if (code === 'COCREATION_DAILY_LIMIT') loadUsed();
        if (!closed) refresh();
        return;
      }
    }
    if (pairReady() && api.submitPair) {
      const text = draft.pair.text.trim();
      const fingerprint = JSON.stringify([draft.pair.partnerId, text]);
      if (draft.pair.pending?.fingerprint !== fingerprint)
        draft.pair.pending = { requestId: newRequestId(), fingerprint };
      try {
        const handed = await api.submitPair({
          requestId: draft.pair.pending.requestId,
          characterId,
          partnerId: draft.pair.partnerId,
          text,
        });
        earned += handed.earned ?? 0;
      } catch (error) {
        fail(error);
        // The cards went through: they are spent, and only the pair note is left to send.
        if (sendCards && !closed) spendCards(payload);
        if (!closed) refresh();
        return;
      }
    }
    // Handed over: the draft is spent. A new sheet starts fresh.
    drafts.delete(characterId);
    busy = false;
    if (closed) return;
    if (earned > 0) thanksSub.textContent = `${cocreationCopy.thanksSub} ${cocreationCopy.earned(earned)}`;
    else if (options.guest === true) thanksSub.textContent = `${cocreationCopy.thanksSub}\n${cocreationCopy.guestHint}`;
    thanks.hidden = false;
    sheet.className = 'cc-sheet is-thanked';
    sendButton.disabled = true;
    timer = setTimeout(() => close(), options.thanksMs ?? 1800);
  });

  memoSend.addEventListener('click', async () => {
    if (busy || closed || !api.submitMemo || memoDraft.text.trim() === '') return;
    const text = memoDraft.text.trim();
    busy = true;
    memoSend.textContent = cocreationCopy.memoSending;
    refresh();
    memoRefresh();
    const fingerprint = JSON.stringify(text);
    if (memoDraft.pending?.fingerprint !== fingerprint) memoDraft.pending = { requestId: newRequestId(), fingerprint };
    try {
      await api.submitMemo({ requestId: memoDraft.pending.requestId, text });
    } catch (error) {
      busy = false;
      memoSend.textContent = cocreationCopy.memoSend;
      show(cocreationCopy.errors[(error as { code?: string }).code ?? ''] ?? cocreationCopy.errors.unknown!);
      if (!closed) {
        refresh();
        memoRefresh();
      }
      return;
    }
    busy = false;
    memoDraft.text = '';
    memoDraft.pending = null;
    if (closed) return;
    memoArea.value = '';
    memoSend.textContent = cocreationCopy.memoSend;
    memoPanel.hidden = true;
    memoOpen.setAttribute('aria-expanded', 'false');
    show(cocreationCopy.memoThanks);
    refresh();
    memoRefresh();
  });

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    document.removeEventListener?.('keydown', onKey);
    document.documentElement?.classList?.remove('cc-open');
    sheet.remove();
    opener?.focus?.();
  }
  const onKey = (event: Event) => {
    if ((event as KeyboardEvent).key === 'Escape' && !busy) close();
  };
  closeButton.addEventListener('click', () => {
    if (!busy) close();
  });
  document.addEventListener?.('keydown', onKey);
  document.documentElement?.classList?.add('cc-open');

  // The dots follow the card nearest the middle of the deck while swiping.
  deck.addEventListener('scroll', () => {
    const el = deck as unknown as { scrollLeft: number; clientWidth: number; scrollWidth: number };
    const ids = deckIds();
    if (!el.clientWidth || ids.length === 0) return;
    const index = Math.round((el.scrollLeft / Math.max(1, el.scrollWidth - el.clientWidth)) * (ids.length - 1));
    Array.from(dots.children).forEach((dot, i) => (dot.className = i === index ? 'on' : ''));
  });

  function loadUsed() {
    void api.cocreationToday?.(characterId).then(
      (today) => {
        if (closed) return;
        for (const id of today.cardIds) used.add(id);
        // The unspent cards are drawn again, so a spent card never takes a place in the batch.
        const kept = draft.batch.filter((id) => !used.has(id));
        draft.batch = [
          ...kept,
          ...unwrittenPool()
            .filter((id) => !kept.includes(id))
            .slice(0, BATCH_SIZE - kept.length),
        ];
        renderDeck();
      },
      () => {},
    );
  }

  renderDeck();
  mountPoint.append(sheet);
  deck.focus?.();
  loadUsed();
  return { close, element: sheet, isOpen: () => !closed };
}
