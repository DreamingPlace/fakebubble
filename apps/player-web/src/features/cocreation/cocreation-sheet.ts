/**
 * 共创 sheet: five theme cards for one official character, then the relationship card (🎲). Each theme shows ONE question picked at
 * random from the character's ONLINE wording pool, a new pick each time the sheet opens (and on ↻); a theme with no online wording has no card
 * (Part 44; the plain default of a theme is only for a pool that could not be read).
 * The player writes what they like, skips the rest, and hands everything written so far over in one go; the note records the theme and the
 * exact question shown. Nothing is reviewed or answered; the only feedback is a thank-you. Drafts live in memory only (never
 * localStorage), so they survive closing the sheet but not a page reload.
 */
import {
  COCREATION_LIMITS,
  COCREATION_NOTE_MAX,
  validateCocreationAnswers,
  type CocreationAnswer,
} from '../../../../../packages/contracts/cocreation-cards.ts';
import {
  COCREATION_THEMES,
  cocreationWordingOk,
  pickOnlineWording,
  pickWording,
  type CocreationTheme,
} from '../../../../../packages/contracts/cocreation-wordings.ts';
import { h, length } from './h.ts';
import { relationFlow, resetRelationDraft, type RelationSend } from './relation-flow.ts';

export interface CocreationApi {
  submitCocreation(input: {
    characterId: string;
    requestId: string;
    answers: CocreationAnswer[];
  }): Promise<{ submissionId: string; answered: number; duplicate: boolean }>;
  /** Has today's entry for this character been used? Best effort: without it the sheet simply does not say. */
  cocreationToday?(characterId: string): Promise<{ cardIds: string[] }>;
  /** Part 39b: the character's ENABLED wordings per theme (text only). Best effort: without it every theme shows its plain default. */
  cocreationWordings?(characterId: string): Promise<{ themes: Record<string, string[]> }>;
  /** Part 24c: a note to the production team (留言条). Without it the sheet has no such entry. */
  submitMemo?(input: {
    requestId: string;
    text: string;
  }): Promise<{ submissionId: string; duplicate: boolean; earned?: number }>;
  /** Part 39: two to eight characters, a pair's ratings and reason, the story. Without it the sheet has no relationship card. */
  submitRelation?(input: RelationSend): Promise<{ submissionId: string; duplicate: boolean; earned?: number }>;
  /** Part 39: the world background of the latest saved cast draft (plain text), or null. Best effort. */
  worldBackground?(): Promise<{ background: string | null }>;
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
  /** Part 39: every live character (this one too) in the console order of the home page; the dice and the ＋ pick from it. */
  everyone?: readonly { characterId: string; name: string }[];
  /** Where the sheet is mounted; defaults to document.body. */
  mount?: HTMLElement;
  random?: () => number;
  newRequestId?: () => string;
  /** How long the thank-you stays before the sheet closes. */
  thanksMs?: number;
  /** Part 25c: a guest (no signed-up account, not unlimited): the thank-you hints that signing up earns points. */
  guest?: boolean;
};

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
  /** Part 39b: ↻ shows another question for every theme that has not been written yet. */
  refresh: '换一换',
  send: (name: string) => `交给${name}`,
  sending: '正在交出去…',
  thanks: (name: string) => `${name}收到了你的小纸条`,
  thanksSub: '谢谢你，这份心意已经交到了。',
  /** Part 24c: shown under the thank-you when the notes earned points. */
  earned: (points: number) => `共创奖励 +${points} 点`,
  /** Part 25c: the guest's version of the line above, in the same place: a guest earns nothing, a signed-up player does. */
  guestHint: '注册后，共创还能得点数～',
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
  close: '关闭',
  errors: {
    COCREATION_DAILY_LIMIT: '有的问题今天已经回答过了，明天再来吧',
    COCREATION_IP_LIMIT: '今天的共创次数用完了，明天再来吧',
    COCREATION_TEXT_INVALID: '有一张的内容不太合适，检查一下长度再试试。',
    COCREATION_WORDING_INVALID: '这次的问题没能记下来，换一换再试试。',
    COCREATION_EMPTY: '先写一张再交出去吧。',
    NOT_FOUND: '这个人物暂时不能共创。',
    COCREATION_UNAVAILABLE: '暂时不能写这个，稍后再试试。',
    unknown: '没能交出去，稍后再试一次。写的内容还在这里。',
  } as Record<string, string>,
};

type Draft = {
  text: Map<string, string>;
  /** Cards in the order they were first written: written cards keep their question (the one the note answers). */
  order: string[];
  /** The exact question shown for a card whose text is written: it travels with the answer. */
  shown: Map<string, string>;
  pending: { requestId: string; fingerprint: string } | null;
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
  resetRelationDraft();
};

/** Same rule as chat input: line breaks and other control characters become a space. */
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/gu, ' ');

export function openCocreationSheet(options: CocreationSheetOptions) {
  const { api, characterId, name } = options;
  const random = options.random ?? Math.random;
  const newRequestId = options.newRequestId ?? (() => globalThis.crypto.randomUUID());
  const mountPoint = options.mount ?? document.body;
  const opener = document.activeElement as HTMLElement | null;
  const draft: Draft = drafts.get(characterId) ?? { text: new Map(), order: [], shown: new Map(), pending: null };
  drafts.set(characterId, draft);

  // Cards this player already answered today (UTC) for this character: shown disabled, never part of an answer.
  const used = new Set<string>();
  const isWritten = (id: string) => !used.has(id) && (draft.text.get(id) ?? '').trim() !== '';
  const writtenIds = () => draft.order.filter(isWritten);
  const writtenCount = () => writtenIds().length;
  // Part 44: with the pool known a theme with no online wording has no card (unless a note for it is already written: the note keeps
  // its wording). Until the pool has answered, and when it could not be read, every theme is on the deck (the plain defaults).
  let poolKnown = false;
  const onCard = (theme: CocreationTheme) =>
    !poolKnown || isWritten(theme.id) || (wordings[theme.id] ?? []).some(cocreationWordingOk);
  const deckThemes = () => COCREATION_THEMES.filter(onCard);
  const deckIds = () => deckThemes().map((theme) => theme.id as string);

  // ---- the questions: one enabled wording per theme, picked at random -------------------------------------------------
  let wordings: Record<string, string[]> = {};
  let ready = false;
  /** What each theme shows now ('' until the pool has been asked). */
  const current = new Map<string, string>();
  const questionOf = (id: string) =>
    isWritten(id) ? (draft.shown.get(id) ?? current.get(id) ?? '') : (current.get(id) ?? '');
  /** A theme with a written answer keeps its question: the note records the one it answered. */
  const pickAll = () => {
    if (!ready) return;
    for (const theme of COCREATION_THEMES) {
      if (isWritten(theme.id)) continue;
      const wording = poolKnown
        ? pickOnlineWording(wordings[theme.id] ?? [], name, random)
        : pickWording(theme, wordings[theme.id] ?? [], name, random);
      if (wording === null) current.delete(theme.id);
      else current.set(theme.id, wording);
    }
    renderDeck();
  };

  // ---- DOM ------------------------------------------------------------------------------------------------------
  const relationOn = !!api.submitRelation && (options.everyone?.length ?? 0) >= 2;
  const title = h('strong', { class: 'cc-title', attrs: { id: 'cc-title' } });
  // Part 39: with the relation flow the title is the character's name, a button that inserts it at the cursor of the text box.
  const nameButton = h('button', { class: 'cc-name-btn', text: name, attrs: { type: 'button' } });
  if (relationOn) title.append(nameButton);
  else title.textContent = cocreationCopy.heading(name);
  const progress = h('span', { class: 'cc-progress', attrs: { role: 'status', 'aria-live': 'polite' } });
  const closeButton = h('button', {
    class: 'cc-close icon-button',
    attrs: { type: 'button', 'aria-label': cocreationCopy.close },
    text: '×',
  });
  const shuffleButton = h('button', {
    class: 'cc-shuffle',
    text: '↻',
    attrs: { type: 'button', 'aria-label': cocreationCopy.refresh },
  });
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
  const allUsed = () => deckThemes().length > 0 && deckThemes().every((theme) => used.has(theme.id));
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
  // Part 39: the world background, plain text, read only (nothing else of the cast).
  const worldBox = h('div', { class: 'cc-world', hidden: true, attrs: { 'aria-label': '世界背景' } });
  let lastArea: HTMLTextAreaElement | null = null;
  const track = (node: HTMLTextAreaElement) => {
    lastArea = node;
  };
  const flow = relationOn
    ? relationFlow({
        send: (input) => api.submitRelation!(input),
        everyone: options.everyone!,
        // Part 39b: the relationship always includes THIS character.
        anchor: characterId,
        random,
        newRequestId,
        track,
        onHead: (head) => {
          sheet.className = `cc-sheet${head.open ? ' is-rel' : ''}${thankedNow ? ' is-thanked' : ''}`;
          closeButton.textContent = head.open ? head.glyph : '×';
          if (head.open) {
            title.textContent = head.title;
            progress.textContent = head.progress;
          } else {
            title.replaceChildren(nameButton);
            refresh();
          }
        },
        onSent: (earned) => showThanks(earned),
      })
    : null;
  let thankedNow = false;
  const sheet = h(
    'div',
    { class: 'cc-sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cc-title' } },
    h('header', { class: 'cc-head' }, closeButton, h('div', { class: 'cc-heading' }, title, progress), shuffleButton),
    usedBanner,
    worldBox,
    deck,
    dots,
    footer,
    ...(flow ? [flow.screen] : []),
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
    theme: CocreationTheme;
    root: HTMLElement;
    open: HTMLButtonElement;
    prompt: HTMLElement;
    editor: HTMLElement;
    area: HTMLTextAreaElement;
    skip: HTMLButtonElement;
    cta: HTMLElement;
  };
  const refs = new Map<string, CardRefs>();
  let openId: string | null = null;
  let busy = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const counter = (value: string, max: number) => `${length(value)}/${max}`;

  const refreshRefs = (id: string) => {
    const ref = refs.get(id);
    if (!ref) return;
    const written = isWritten(id);
    ref.root.className = `cc-card${written ? ' is-written' : ''}${openId === id ? ' is-open' : ''}`;
    const spent = used.has(id);
    if (spent) {
      ref.root.className += ' is-used';
      if (openId === id) openId = null;
    }
    ref.editor.hidden = openId !== id;
    ref.open.disabled = spent;
    ref.cta.textContent = spent ? cocreationCopy.cardUsed : cocreationCopy.write;
    ref.open.setAttribute('aria-expanded', String(openId === id));
    ref.skip.textContent = written ? cocreationCopy.clear : cocreationCopy.skip;
    // The question shown is the one a written answer was given to; until the pool has answered there is none.
    const question = questionOf(id);
    if (ref.prompt.textContent !== question) {
      ref.prompt.textContent = question;
      ref.area.setAttribute('aria-label', question);
    }
    ref.prompt.className = `cc-prompt${question === '' ? '' : ' is-shown'}`;
  };
  const refresh = () => {
    const n = writtenCount();
    progress.textContent = cocreationCopy.progress(n, deckIds().filter((id) => !used.has(id)).length);
    sendButton.disabled = busy || n === 0 || allUsed();
    usedBanner.hidden = !allUsed();
    shuffleButton.disabled = busy;
    memoRefresh();
    for (const id of refs.keys()) refreshRefs(id);
  };

  const buildCard = (theme: CocreationTheme): CardRefs => {
    const badge = h('span', { class: 'cc-badge', text: cocreationCopy.written });
    const cta = h('span', { class: 'cc-cta', text: cocreationCopy.write });
    const prompt = h('span', { class: 'cc-prompt' });
    const face = h(
      'button',
      { class: 'cc-face', attrs: { type: 'button', 'aria-expanded': 'false' } },
      prompt,
      badge,
      cta,
    );
    const editor = h('div', { class: 'cc-editor', hidden: true });
    const done = h('button', { class: 'cc-done', text: cocreationCopy.done, attrs: { type: 'button' } });
    const skip = h('button', { class: 'cc-skip', text: cocreationCopy.skip, attrs: { type: 'button' } });
    const max = COCREATION_LIMITS.text;
    const area = h('textarea', {
      class: 'cc-area',
      attrs: {
        rows: '3',
        maxlength: String(max),
        placeholder: '写在这里…',
        'aria-label': theme.label,
        enterkeyhint: 'done',
      },
    });
    area.value = draft.text.get(theme.id) ?? '';
    const count = h('span', { class: 'cc-count', text: counter(area.value, max), attrs: { 'aria-hidden': 'true' } });
    area.addEventListener('focus', () => track(area));
    area.addEventListener('input', () => {
      const next = clean(area.value);
      if (next !== area.value) area.value = next;
      count.textContent = counter(next, max);
      draft.text.set(theme.id, next);
      // The question on screen when the first word is written is the one this note answers.
      if (next.trim() !== '' && !draft.shown.has(theme.id)) draft.shown.set(theme.id, current.get(theme.id) ?? '');
      noteWritten(theme.id);
      refresh();
    });
    editor.append(area, h('div', { class: 'cc-meta' }, count), h('div', { class: 'cc-actions' }, skip, done));

    const root = h('article', { class: 'cc-card', attrs: { role: 'listitem', 'data-card': theme.id } }, face, editor);
    face.addEventListener('click', () => toggle(theme.id));
    done.addEventListener('click', () => toggle(theme.id, false));
    skip.addEventListener('click', () => {
      draft.text.delete(theme.id);
      draft.shown.delete(theme.id);
      area.value = '';
      count.textContent = counter('', max);
      toggle(theme.id, false);
    });
    area.addEventListener('keydown', (event) => {
      const key = event as unknown as { key: string; isComposing?: boolean };
      // Enter would put a line break into the text, which chat input does not allow: it finishes the card instead.
      if (key.key === 'Enter' && !key.isComposing) {
        event.preventDefault();
        toggle(theme.id, false);
      }
    });
    return { theme, root, open: face, prompt, editor, area, skip, cta };
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
      ref?.area.focus?.();
    } else refs.get(id)?.open.focus?.();
  }

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
    const cards = deckThemes().map((theme) => {
      const ref = buildCard(theme);
      refs.set(theme.id, ref);
      return ref.root;
    });
    deck.replaceChildren(...cards, ...(flow?.available ? [flow.entry] : []));
    dots.replaceChildren(...ids.map((id) => h('i', { class: id === ids[0] ? 'on' : '', attrs: { 'data-dot': id } })));
    refresh();
  };

  // ↻: another question for every theme not written yet; a quiet crossfade of the questions (none under reduced motion).
  shuffleButton.addEventListener('click', () => {
    if (busy || !ready) return;
    openId = null;
    deck.classList.remove('is-swapping');
    pickAll();
    void (deck as unknown as { offsetWidth: number }).offsetWidth;
    deck.classList.add('is-swapping');
    (deck as unknown as { scrollTo?: (o: unknown) => void }).scrollTo?.({ left: 0, behavior: 'smooth' });
    deck.focus?.();
  });

  const answers = (): CocreationAnswer[] =>
    writtenIds().map((id) => ({
      cardId: id,
      text: (draft.text.get(id) ?? '').trim(),
      wording: questionOf(id),
    }));
  const show = (message: string) => {
    notice.textContent = message;
    notice.hidden = message === '';
  };

  sendButton.addEventListener('click', async () => {
    if (busy || closed) return;
    const payload = answers();
    if (payload.length === 0 || allUsed()) return;
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
    let earned = 0;
    try {
      const handed = await api.submitCocreation({
        characterId,
        requestId: draft.pending.requestId,
        answers: payload,
      });
      earned = (handed as { earned?: number }).earned ?? 0;
    } catch (error) {
      busy = false;
      sendButton.textContent = cocreationCopy.send(name);
      const code = (error as { code?: string }).code ?? '';
      show(cocreationCopy.errors[code] ?? cocreationCopy.errors.unknown!);
      // Refused whole: learn which cards are spent so they can be disabled; the rest of the draft stays.
      if (code === 'COCREATION_DAILY_LIMIT') loadUsed();
      if (!closed) refresh();
      return;
    }
    // Handed over: the draft is spent. A new sheet starts fresh.
    drafts.delete(characterId);
    busy = false;
    if (closed) return;
    showThanks(earned);
  });
  function showThanks(earned: number) {
    if (closed) return;
    if (earned > 0) thanksSub.textContent = `${cocreationCopy.thanksSub} ${cocreationCopy.earned(earned)}`;
    else if (options.guest === true) thanksSub.textContent = `${cocreationCopy.thanksSub}\n${cocreationCopy.guestHint}`;
    thanks.hidden = false;
    thankedNow = true;
    sheet.className = 'cc-sheet is-thanked';
    sendButton.disabled = true;
    timer = setTimeout(() => close(), options.thanksMs ?? 1800);
  }

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
    if ((event as KeyboardEvent).key === 'Escape' && !busy) {
      if (flow?.isOpen()) flow.back();
      else close();
    }
  };
  closeButton.addEventListener('click', () => {
    if (busy) return;
    // Part 39: in the relation screen this button is one step back (or out to the deck), not the end of the sheet.
    if (flow?.isOpen()) flow.back();
    else close();
  });
  // Part 39: the character's name inserts itself at the cursor of the text box below (the open card's, else the last one used).
  nameButton.addEventListener('mousedown', (event) => event.preventDefault());
  nameButton.addEventListener('click', () => {
    if (flow?.isOpen()) {
      flow.insert(name);
      return;
    }
    const target = lastArea ?? (openId ? (refs.get(openId)?.area ?? null) : null);
    if (!target) return;
    const max = Number(target.getAttribute('maxlength') ?? '0') || Infinity;
    const from = target.selectionStart ?? target.value.length;
    const to = target.selectionEnd ?? from;
    const next = clean(target.value.slice(0, from) + name + target.value.slice(to));
    if (length(next) > max) return;
    target.value = next;
    target.setSelectionRange?.(from + name.length, from + name.length);
    target.focus?.();
    target.dispatchEvent(new Event('input'));
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
        renderDeck();
      },
      () => {},
    );
  }

  // Part 39b: the character's enabled wordings. Until they are here (or refused) the cards show no question, so a default never flashes
  // before the real one; a failure falls back to the plain default of each theme.
  void api.cocreationWordings?.(characterId).then(
    (pool) => {
      if (closed) return;
      wordings = pool.themes;
      poolKnown = true;
      ready = true;
      pickAll();
    },
    () => {
      if (closed) return;
      ready = true;
      pickAll();
    },
  );
  if (!api.cocreationWordings) {
    ready = true;
    pickAll();
  }

  void api.worldBackground?.().then(
    (world) => {
      if (closed) return;
      const text = world.background;
      worldBox.textContent = text ?? '';
      worldBox.hidden = !text;
      flow?.setWorld(text);
    },
    () => {},
  );
  renderDeck();
  mountPoint.append(sheet);
  deck.focus?.();
  loadUsed();
  return { close, element: sheet, isOpen: () => !closed };
}
