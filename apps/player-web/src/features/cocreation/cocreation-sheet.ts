/**
 * 共创 sheet: a swipeable deck of inspiration cards for one official character. The player writes what they like,
 * skips the rest, and hands everything written so far over in one go. Nothing is reviewed or answered; the only
 * feedback is a thank-you. Drafts live in memory only (never localStorage), so they survive closing the sheet but
 * not a page reload.
 */
import {
  COCREATION_CARDS,
  COCREATION_LIMITS,
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
  say?: (message: string) => void;
  /** Where the sheet is mounted; defaults to document.body. */
  mount?: HTMLElement;
  random?: () => number;
  newRequestId?: () => string;
  /** How long the thank-you stays before the sheet closes. */
  thanksMs?: number;
};

export const BATCH_SIZE = 5;
export const cocreationCopy = {
  title: (name: string) => `共创 · 让${name}更像${name}`,
  sub: (name: string) => `写下你心中的${name}`,
  guestSub: '受邀后可参与',
  progress: (n: number) => (n === 0 ? '写几张都行，不用写完' : `已写 ${n} 张`),
  shuffle: '换一批',
  send: (name: string) => `交给${name}`,
  sending: '正在交出去…',
  thanks: (name: string) => `${name}收到了你的小纸条`,
  thanksSub: '谢谢你，这份心意已经交到了。',
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
    COCREATION_RATE_LIMITED: '今天已经交过好几张小纸条啦，明天再来吧。写的内容还在这里。',
    COCREATION_INVITE_REQUIRED: '受邀后才能参与共创。',
    COCREATION_TEXT_INVALID: '有一张的内容不太合适，检查一下长度再试试。',
    COCREATION_EMPTY: '先写一张再交出去吧。',
    NOT_FOUND: '这个人物暂时不能共创。',
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
};
const drafts = new Map<string, Draft>();
/** Test hook and sign-out: drafts are memory only and can be dropped at any time. */
export const resetCocreationDrafts = () => drafts.clear();

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
  };
  drafts.set(characterId, draft);

  const dialogueDone = () => draft.dialogue.player.trim() !== '' && draft.dialogue.replies.some((r) => r.trim() !== '');
  const dialogueTouched = () =>
    draft.dialogue.player.trim() !== '' || draft.dialogue.replies.some((r) => r.trim() !== '');
  const isWritten = (id: string) => (id === 'dialogue' ? dialogueDone() : (draft.text.get(id) ?? '').trim() !== '');
  const unwrittenPool = () =>
    COCREATION_CARDS.filter((card) => card.id !== 'free' && !isWritten(card.id)).map((card) => card.id);
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
    ...(isWritten('free') ? [] : ['free']),
  ];

  // ---- DOM ------------------------------------------------------------------------------------------------------
  const title = h('strong', { class: 'cc-title', text: cocreationCopy.title(name), attrs: { id: 'cc-title' } });
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
  const sendButton = h('button', { class: 'cc-send', attrs: { type: 'button' }, text: cocreationCopy.send(name) });
  const thanks = h(
    'div',
    { class: 'cc-thanks', attrs: { role: 'status', 'aria-live': 'polite' }, hidden: true },
    h('div', { class: 'cc-note-art', attrs: { 'aria-hidden': 'true' } }, h('i'), h('i'), h('i')),
    h('strong', { class: 'cc-thanks-title', text: cocreationCopy.thanks(name) }),
    h('p', { class: 'cc-thanks-sub', text: cocreationCopy.thanksSub }),
  );
  const sheet = h(
    'div',
    { class: 'cc-sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cc-title' } },
    h('header', { class: 'cc-head' }, closeButton, h('div', { class: 'cc-heading' }, title, progress), shuffleButton),
    deck,
    dots,
    h('footer', { class: 'cc-foot' }, notice, sendButton),
    thanks,
  );
  if (options.color)
    sheet.setAttribute(
      'style',
      `--cc-color:${options.color};--cc-ink:${options.ink ?? '#29423b'};--avatar-bg:${options.color};--avatar-ink:${options.ink ?? '#29423b'}`,
    );

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
    ref.editor.hidden = openId !== id;
    ref.open.setAttribute('aria-expanded', String(openId === id));
    ref.skip.textContent =
      written || (id === 'dialogue' && dialogueTouched()) ? cocreationCopy.clear : cocreationCopy.skip;
    if (ref.hint) ref.hint.hidden = !(id === 'dialogue' && dialogueTouched() && !dialogueDone());
    if (ref.secondReply) ref.secondReply.hidden = draft.dialogue.replies.length < 2;
    if (ref.addReply) ref.addReply.hidden = draft.dialogue.replies.length >= 2;
  };
  const refresh = () => {
    const n = writtenCount();
    progress.textContent = cocreationCopy.progress(n);
    sendButton.disabled = busy || n === 0;
    shuffleButton.disabled = busy;
    for (const id of refs.keys()) refreshRefs(id);
  };

  const buildCard = (card: CocreationCard): CardRefs => {
    const prompt = cocreationPrompt(card, name);
    const badge = h('span', { class: 'cc-badge', text: cocreationCopy.written });
    const face = h(
      'button',
      { class: 'cc-face', attrs: { type: 'button', 'aria-expanded': 'false' } },
      h('span', { class: 'cc-prompt', text: prompt }),
      badge,
      h('span', { class: 'cc-cta', text: cocreationCopy.write }),
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

  const renderDeck = () => {
    refs.clear();
    const ids = deckIds();
    const cards = ids.map((id) => {
      const ref = buildCard(COCREATION_CARDS.find((card) => card.id === id)!);
      refs.set(id, ref);
      return ref.root;
    });
    deck.replaceChildren(...cards);
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

  sendButton.addEventListener('click', async () => {
    if (busy || closed) return;
    const payload = answers();
    const checked = validateCocreationAnswers(payload);
    if (!checked.ok) {
      show(cocreationCopy.errors[checked.code] ?? cocreationCopy.errors.unknown!);
      return;
    }
    busy = true;
    show('');
    sendButton.textContent = cocreationCopy.sending;
    refresh();
    // The same content keeps the same request id, so retrying an uncertain send can never submit it twice.
    const fingerprint = JSON.stringify(payload);
    if (draft.pending?.fingerprint !== fingerprint) draft.pending = { requestId: newRequestId(), fingerprint };
    try {
      await api.submitCocreation({ characterId, requestId: draft.pending.requestId, answers: payload });
    } catch (error) {
      busy = false;
      sendButton.textContent = cocreationCopy.send(name);
      const code = (error as { code?: string }).code ?? '';
      show(cocreationCopy.errors[code] ?? cocreationCopy.errors.unknown!);
      if (!closed) refresh();
      return;
    }
    // Handed over: the draft is spent. A new sheet starts fresh.
    drafts.delete(characterId);
    busy = false;
    if (closed) return;
    thanks.hidden = false;
    sheet.className = 'cc-sheet is-thanked';
    sendButton.disabled = true;
    timer = setTimeout(() => close(), options.thanksMs ?? 1800);
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

  renderDeck();
  mountPoint.append(sheet);
  deck.focus?.();
  return { close, element: sheet, isOpen: () => !closed };
}
