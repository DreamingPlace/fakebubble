/**
 * Part 39 / 39b / 47: co-creation about the shared world, opened FROM one character (A, the anchor). Part 47: the LAST card of the deck IS
 * the first step, shown directly: 「A和[X]之间有什么故事？」. A is fixed text and can never be changed; X (a random OTHER character when the
 * deck is built; the order of the catalog plays no part) is a tappable slot that opens the list of every other character, and 🎲 right
 * beside it picks another at random. ＋ below adds more people INTO the sentence (「A、B和C之间…」), each removable while two remain, up to
 * eight in all. 下一步 on the card opens the screen: exactly two members (a pair): rate A 对 X and X 对 A in WHOLE stars 0–5 (a small light label under the stars shows the meaning of the value,
 * crossfading), a reason, their story. Three to eight (a group): choose, then the story or running joke. The name of a character is a
 * button that inserts it at the cursor of the text box. Drafts live in memory only. Shared canon: it never creates a player-private
 * story, and the stars are opinions the administrators read.
 */
import {
  RELATION_MAX_MEMBERS,
  RELATION_MIN_MEMBERS,
  RELATION_REASON_MAX,
  RELATION_STAR_LABELS,
  RELATION_TEXT_MAX,
} from '../../../../../packages/contracts/cocreation-relations.ts';
import { h, length } from './h.ts';

export type RelationPerson = { characterId: string; name: string };
export type RelationSend = {
  requestId: string;
  characterIds: string[];
  ratings: { from: string; to: string; stars: number }[] | null;
  reason: string | null;
  text: string;
};
export const relationCopy = {
  dice: '🎲',
  rollMore: '随机换一位',
  change: '换一位',
  add: '再加一位',
  remove: '去掉',
  next: '下一步',
  back: '上一步',
  send: '发送',
  sending: '正在发送…',
  vs: '对',
  /** What each step asks, in the player's words (Part 39b). */
  sentenceEnd: '之间有什么故事？',
  rateTitle: '他们彼此怎么看？',
  rateHint: (low: string, high: string) => `0 星是「${low}」，5 星是「${high}」，点星星打分。`,
  looks: '怎么看',
  reasonHint: '写一句：你为什么这样打分？比如他们平时怎么相处。',
  storyHint: '写下他们之间发生过的事。好的故事可能被制作组采纳，成为角色们共同的设定。',
  groupHint: '写下这几位一起发生过的事，或者只属于他们的梗。好的故事可能被制作组采纳，成为角色们共同的设定。',
  reasonPrompt: '为什么这样打分？',
  pairStory: '他们的故事',
  groupStory: '这几位的故事，或者只属于他们的梗',
  stars: (n: number) => `${n} 星`,
  members: (n: number) => `${n} 位`,
  errors: {
    COCREATION_DAILY_LIMIT: '这几位今天已经写过了，明天再来吧',
    COCREATION_IP_LIMIT: '今天的共创次数用完了，明天再来吧',
    COCREATION_TEXT_INVALID: '故事的内容不太合适，检查一下长度再试试。',
    COCREATION_REASON_INVALID: '理由的内容不太合适，检查一下长度再试试。',
    COCREATION_RATING_INVALID: '评分没有选好，再看一下。',
    NOT_FOUND: '有的角色暂时不能共创。',
    COCREATION_UNAVAILABLE: '暂时不能写这个，稍后再试试。',
    unknown: '没能发出去，稍后再试一次。写的内容还在这里。',
  } as Record<string, string>,
};

type Step = 'choose' | 'rate' | 'reason' | 'story';
const STEPS: readonly Step[] = ['choose', 'rate', 'reason', 'story'];
type Draft = {
  /** The character the screen was opened from: a member for good. A draft of another character is never carried over. */
  anchor: string;
  members: string[];
  step: Step;
  /** `${from}>${to}` → whole stars; absent = not chosen yet. */
  stars: Map<string, number>;
  reason: string;
  story: string;
  pending: { requestId: string; fingerprint: string } | null;
};
const fresh = (anchor = ''): Draft => ({
  anchor,
  members: [],
  step: 'choose',
  stars: new Map(),
  reason: '',
  story: '',
  pending: null,
});
let draft: Draft = fresh();
/** Test hook and sign-out: drafts are memory only. */
export const resetRelationDraft = () => {
  draft = fresh();
};
/** Same rule as chat input: control characters become a space. */
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/gu, ' ');

export type RelationFlowOptions = {
  send: (input: RelationSend) => Promise<{ earned?: number }>;
  /** Every live character in the console order of the home page (首页顺序). */
  everyone: readonly RelationPerson[];
  /** The character the sheet was opened from (Part 39b): always a member of the relation. */
  anchor: string;
  random: () => number;
  newRequestId: () => string;
  /** The screen opened, moved or closed: what the sheet's header shows. */
  onHead: (head: { open: boolean; glyph: string; title: string; progress: string }) => void;
  /** Handed over: the sheet's thank-you. */
  onSent: (earned: number) => void;
  /** A text box took the cursor (the sheet's own name button inserts into it). */
  track: (area: HTMLTextAreaElement) => void;
};

export function relationFlow(options: RelationFlowOptions) {
  const people = new Map(options.everyone.map((p) => [p.characterId, p] as const));
  const rank = new Map(options.everyone.map((p, at) => [p.characterId, at] as const));
  const nameOf = (id: string) => people.get(id)?.name ?? '';
  const ordered = (ids: readonly string[]) => [...ids].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
  // A draft of another character's sheet is not this one's; members the live catalog no longer has are dropped.
  if (draft.anchor !== options.anchor) draft = fresh(options.anchor);
  draft.members = ordered(draft.members.filter((id) => people.has(id)));
  if (draft.members.length > 0 && !draft.members.includes(options.anchor)) draft = fresh(options.anchor);
  // Part 47: the card is shown directly, so it always starts with a partner: a random OTHER character (the draft of an earlier opening of
  // this sheet is kept as it was). The screen is closed when the flow is built, so the step starts at the card.
  draft.step = 'choose';
  if (draft.members.length < RELATION_MIN_MEMBERS) {
    const pool = options.everyone.filter(
      (p) => p.characterId !== options.anchor && !draft.members.includes(p.characterId),
    );
    const pick = pool[Math.min(pool.length - 1, Math.floor(options.random() * pool.length))];
    if (pick) draft.members = ordered([...new Set([options.anchor, ...draft.members, pick.characterId])]);
  }
  /** The one other member of a pair (the anchor is the first side of both ratings). */
  const partner = () => draft.members.find((id) => id !== options.anchor) ?? '';
  /** Characters that can still join. */
  const rest = () => options.everyone.filter((p) => !draft.members.includes(p.characterId));
  let open = false;
  let busy = false;
  let focusArea: HTMLTextAreaElement | null = null;

  const group = () => draft.members.length >= RELATION_MIN_MEMBERS + 1;
  const pair = () => draft.members.length === RELATION_MIN_MEMBERS;
  const key = (from: string, to: string) => `${from}>${to}`;
  const ready = () => draft.members.length >= RELATION_MIN_MEMBERS;
  const storyOk = () => draft.story.trim() !== '' && length(draft.story) <= RELATION_TEXT_MAX;
  const ratedBoth = () =>
    pair() && draft.stars.has(key(options.anchor, partner())) && draft.stars.has(key(partner(), options.anchor));
  const reasonOk = () => draft.reason.trim() !== '' && length(draft.reason) <= RELATION_REASON_MAX;

  // ---- the last card of the deck: the first step, shown directly (Part 47) ----------------------------------------------------
  const sentence = h('p', { class: 'cc-prompt is-shown cc-rel-sentence' });
  const pickList = h('ul', {
    class: 'cc-rel-list',
    attrs: { role: 'listbox', 'aria-label': relationCopy.change },
    hidden: true,
  });
  const plusButton = h('button', {
    class: 'cc-rel-plus',
    text: '＋',
    attrs: { type: 'button', 'aria-label': relationCopy.add, 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
  });
  const cardNext = h('button', {
    class: 'cc-rel-card-next',
    text: relationCopy.next,
    attrs: { type: 'button' },
  });
  const entry = h(
    'article',
    { class: 'cc-card cc-rel-entry', attrs: { role: 'listitem', 'data-card': 'relation' } },
    h(
      'div',
      { class: 'cc-face cc-rel-entry-face' },
      sentence,
      pickList,
      h('div', { class: 'cc-rel-entry-foot' }, plusButton, cardNext),
    ),
  );

  // ---- the screen ---------------------------------------------------------------------------------------------------------
  const world = h('div', { class: 'cc-rel-world', hidden: true });
  const bars = h('div', { class: 'cc-rel-bars', attrs: { 'aria-hidden': 'true' } }, ...STEPS.map(() => h('i')));
  const stage = h('div', { class: 'cc-rel-stage' });
  const notice = h('p', { class: 'cc-rel-notice', attrs: { role: 'status', 'aria-live': 'polite' }, hidden: true });
  const backButton = h('button', { class: 'cc-rel-back', text: relationCopy.back, attrs: { type: 'button' } });
  const nextButton = h('button', { class: 'cc-rel-next', text: relationCopy.next, attrs: { type: 'button' } });
  const foot = h('div', { class: 'cc-rel-foot' }, backButton, nextButton);
  const screen = h(
    'section',
    { class: 'cc-rel', attrs: { 'aria-label': '共创角色之间的故事' }, hidden: true },
    h(
      'div',
      { class: 'cc-rel-grid' },
      h('div', { class: 'cc-rel-left' }, world),
      h('div', { class: 'cc-rel-right' }, bars, stage, notice, foot),
    ),
  );
  const showNotice = (message: string) => {
    notice.textContent = message;
    notice.hidden = message === '';
  };

  const area = (
    label: string,
    hint: string,
    value: string,
    max: number,
    onInput: (v: string) => void,
    rows: number,
  ) => {
    const node = h('textarea', {
      class: 'cc-area cc-rel-area',
      attrs: {
        rows: String(rows),
        maxlength: String(max),
        'aria-label': label,
        placeholder: hint,
        enterkeyhint: 'done',
      },
    });
    node.value = value;
    const count = h('span', { class: 'cc-count', text: `${length(value)}/${max}`, attrs: { 'aria-hidden': 'true' } });
    node.addEventListener('input', () => {
      const next = clean(node.value);
      if (next !== node.value) node.value = next;
      count.textContent = `${length(next)}/${max}`;
      showNotice('');
      onInput(next);
      paintFoot();
    });
    node.addEventListener('focus', () => {
      focusArea = node;
      options.track(node);
    });
    node.addEventListener('keydown', (event) => {
      if ((event as unknown as { key: string }).key === 'Enter') event.preventDefault();
    });
    return { node, count };
  };

  /** A character's name: a button that inserts it at the cursor of the text box of this step. */
  const nameButton = (id: string, className = 'cc-rel-name') => {
    const button = h('button', { class: className, text: nameOf(id), attrs: { type: 'button' } });
    // The text box keeps its cursor: a press on the name must not take the focus away from it.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => insert(nameOf(id)));
    return button;
  };

  /**
   * The sentence of the card. `pickFor` is the member whose list is open ('add' for ＋, '' for none). The anchor is plain text; every
   * other member is a slot (tap = the list, to REPLACE that person); with exactly two members the slot carries ▾ and 🎲 sits beside it,
   * with three or more each person carries ✕ (they can go while two remain).
   */
  let pickFor = '';
  const others = () => draft.members.filter((id) => id !== options.anchor);
  const closePick = () => {
    pickFor = '';
  };
  const swapPartner = (from: string, to: string) => {
    draft.members = ordered([...draft.members.filter((id) => id !== from), to]);
    draft.pending = null;
    closePick();
    renderAll();
  };
  const renderChoose = () => {
    const names = others();
    const twoOnly = draft.members.length === RELATION_MIN_MEMBERS;
    const parts: (Node | string)[] = [h('span', { class: 'cc-rel-me', text: nameOf(options.anchor) })];
    names.forEach((id, at) => {
      parts.push(at === names.length - 1 ? '和' : '、');
      const slot = h(
        'button',
        {
          class: `cc-rel-slot${pickFor === id ? ' is-open' : ''}`,
          attrs: {
            type: 'button',
            'data-member': id,
            'aria-haspopup': 'listbox',
            'aria-expanded': String(pickFor === id),
            'aria-label': `${relationCopy.change}：${nameOf(id)}`,
          },
        },
        h('span', { class: 'cc-rel-slot-name', text: nameOf(id) }),
        twoOnly ? h('i', { class: 'cc-rel-caret', text: '▾', attrs: { 'aria-hidden': 'true' } }) : null,
      );
      slot.addEventListener('click', () => {
        pickFor = pickFor === id ? '' : id;
        renderChoose();
      });
      if (twoOnly) {
        parts.push(slot);
        return;
      }
      const x = h('button', {
        class: 'cc-rel-x',
        text: '✕',
        attrs: { type: 'button', 'aria-label': `${relationCopy.remove}${nameOf(id)}` },
      });
      x.addEventListener('click', () => {
        draft.members = draft.members.filter((m) => m !== id);
        draft.pending = null;
        closePick();
        renderAll();
      });
      parts.push(h('span', { class: 'cc-rel-mem', attrs: { role: 'group', 'data-member': id } }, slot, x));
    });
    if (twoOnly) {
      const again = h('button', {
        class: 'cc-rel-dice',
        text: relationCopy.dice,
        attrs: { type: 'button', 'aria-label': relationCopy.rollMore },
      });
      again.addEventListener('click', () => {
        // A uniformly random OTHER character that is not the partner already shown (the order of the catalog plays no part).
        const partnerNow = partner();
        const pool = options.everyone.filter((p) => p.characterId !== options.anchor && p.characterId !== partnerNow);
        const pickFrom = pool.length > 0 ? pool : options.everyone.filter((p) => p.characterId !== options.anchor);
        if (pickFrom.length === 0) return;
        const pick = pickFrom[Math.min(pickFrom.length - 1, Math.floor(options.random() * pickFrom.length))]!;
        swapPartner(partnerNow, pick.characterId);
      });
      parts.push(again);
    }
    parts.push(relationCopy.sentenceEnd);
    sentence.replaceChildren(...parts.map((part) => (typeof part === 'string' ? document.createTextNode(part) : part)));

    // The list: every other character in the console order; the members are faded, the one being replaced is ticked.
    const adding = pickFor === 'add';
    pickList.hidden = pickFor === '';
    plusButton.setAttribute('aria-expanded', String(adding));
    plusButton.hidden = draft.members.length >= RELATION_MAX_MEMBERS || rest().length === 0;
    if (pickFor === '') pickList.replaceChildren();
    else {
      const items = options.everyone
        .filter((person) => person.characterId !== options.anchor)
        .map((person) => {
          const mine = person.characterId === pickFor;
          const taken = draft.members.includes(person.characterId) && !mine;
          const item = h('li', {
            class: `cc-rel-option${taken ? ' is-taken' : ''}${mine ? ' is-mine' : ''}`,
            text: mine ? `${person.name} ✓` : person.name,
            attrs: {
              role: 'option',
              'aria-selected': String(mine),
              'aria-disabled': String(taken),
              'data-option': person.characterId,
              tabindex: taken ? '-1' : '0',
            },
          });
          if (!taken) {
            const pick = () => {
              if (adding) {
                draft.members = ordered([...draft.members, person.characterId]);
                draft.pending = null;
                closePick();
                renderAll();
              } else if (mine) {
                closePick();
                renderChoose();
              } else swapPartner(pickFor, person.characterId);
            };
            item.addEventListener('click', pick);
            item.addEventListener('keydown', (event) => {
              const k = (event as unknown as { key: string }).key;
              if (k === 'Enter' || k === ' ') {
                event.preventDefault();
                pick();
              } else if (k === 'Escape') {
                closePick();
                renderChoose();
              }
            });
          }
          return item;
        });
      pickList.replaceChildren(...items);
    }
    cardNext.disabled = busy || !ready();
  };
  plusButton.addEventListener('click', () => {
    pickFor = pickFor === 'add' ? '' : 'add';
    renderChoose();
  });
  // 下一步 on the card: into the screen, at the first step the members call for (a pair rates, a group tells the story).
  cardNext.addEventListener('click', () => {
    if (busy || !ready()) return;
    closePick();
    draft.step = group() ? 'story' : 'rate';
    showNotice('');
    open = true;
    renderAll();
  });

  // ---- stars --------------------------------------------------------------------------------------------------------------
  const rate = (from: string, to: string) => {
    const label = `${nameOf(from)}${relationCopy.vs}${nameOf(to)}`;
    const words = RELATION_STAR_LABELS.map((word) => h('span', { text: word }));
    const wordBox = h('div', { class: 'cc-word', attrs: { 'aria-hidden': 'true' } }, ...words);
    const zero = h('button', {
      class: 'cc-zero',
      text: '0',
      attrs: { type: 'button', 'data-stars': '0', 'aria-label': relationCopy.stars(0) },
    });
    const stars = [1, 2, 3, 4, 5].map((n) =>
      h('button', {
        class: 'cc-star',
        text: '★',
        attrs: { type: 'button', 'data-stars': String(n), 'aria-label': relationCopy.stars(n) },
      }),
    );
    const buttons = [zero, ...stars];
    const paint = () => {
      const value = draft.stars.get(key(from, to));
      buttons.forEach((button, at) => {
        const on = value !== undefined && (at === 0 ? value === 0 : at <= value && value > 0);
        button.className = `${at === 0 ? 'cc-zero' : 'cc-star'}${on ? ' is-on' : ''}`;
        button.setAttribute('aria-pressed', String(value === at));
      });
      words.forEach((word, at) => {
        word.className = value === at ? 'is-shown' : '';
      });
    };
    buttons.forEach((button, at) =>
      button.addEventListener('click', () => {
        draft.stars.set(key(from, to), at);
        showNotice('');
        paint();
        paintFoot();
      }),
    );
    paint();
    return h(
      'div',
      { class: 'cc-rate', attrs: { role: 'group', 'aria-label': label } },
      h(
        'div',
        { class: 'cc-rate-who' },
        nameButton(from, 'cc-rel-name is-inline'),
        h('em', { text: relationCopy.looks }),
        nameButton(to, 'cc-rel-name is-inline'),
        h('em', { text: '？' }),
      ),
      h('div', { class: 'cc-stars' }, ...buttons),
      wordBox,
    );
  };

  // ---- the steps ----------------------------------------------------------------------------------------------------------
  const storyBox = () => {
    const { node, count } = area(
      group() ? relationCopy.groupStory : relationCopy.pairStory,
      group() ? relationCopy.groupHint : relationCopy.storyHint,
      draft.story,
      RELATION_TEXT_MAX,
      (v) => (draft.story = v),
      6,
    );
    focusArea = node;
    return h(
      'div',
      { class: 'cc-rel-card' },
      // The names again, right over the box (on a wide screen the left column carries them).
      h('div', { class: 'cc-rel-inline-names' }, ...draft.members.map((id) => nameButton(id))),
      h('p', { class: 'cc-rel-prompt', text: group() ? relationCopy.groupStory : relationCopy.pairStory }),
      h('p', { class: 'cc-rel-hint', text: group() ? relationCopy.groupHint : relationCopy.storyHint }),
      node,
      h('div', { class: 'cc-meta' }, count),
    );
  };
  const renderStage = () => {
    focusArea = null;
    if (group()) {
      stage.replaceChildren(storyBox());
      return;
    }
    if (draft.step === 'choose') stage.replaceChildren();
    else if (draft.step === 'rate') {
      const a = options.anchor,
        b = partner();
      stage.replaceChildren(
        h(
          'div',
          { class: 'cc-rel-card cc-rel-rates' },
          h('p', { class: 'cc-rel-prompt', text: relationCopy.rateTitle }),
          h('p', {
            class: 'cc-rel-hint',
            text: relationCopy.rateHint(RELATION_STAR_LABELS[0]!, RELATION_STAR_LABELS[5]!),
          }),
          rate(a, b),
          rate(b, a),
        ),
      );
    } else if (draft.step === 'reason') {
      const { node, count } = area(
        relationCopy.reasonPrompt,
        relationCopy.reasonHint,
        draft.reason,
        RELATION_REASON_MAX,
        (v) => (draft.reason = v),
        4,
      );
      focusArea = node;
      stage.replaceChildren(
        h(
          'div',
          { class: 'cc-rel-card' },
          h('p', { class: 'cc-rel-prompt', text: relationCopy.reasonPrompt }),
          h('p', { class: 'cc-rel-hint', text: relationCopy.reasonHint }),
          node,
          h('div', { class: 'cc-meta' }, count),
        ),
      );
    } else stage.replaceChildren(storyBox());
  };

  const stepIndex = () => STEPS.indexOf(draft.step);
  const paintHead = () => {
    if (!open) return options.onHead({ open: false, glyph: '×', title: '', progress: '' });
    const title = draft.members.map(nameOf).join(' · ');
    options.onHead({
      open: true,
      glyph: draft.step === 'choose' || group() ? '×' : '←',
      title,
      progress: group() ? relationCopy.members(draft.members.length) : `${stepIndex() + 1} / 4`,
    });
  };
  const lastStep = () => group() || draft.step === 'story';
  const paintFoot = () => {
    const sendNow = lastStep();
    backButton.hidden = group() || draft.step === 'choose';
    nextButton.textContent = busy ? relationCopy.sending : sendNow ? relationCopy.send : relationCopy.next;
    nextButton.disabled =
      busy ||
      (group()
        ? !storyOk()
        : draft.step === 'choose'
          ? !ready()
          : draft.step === 'rate'
            ? !ratedBoth()
            : draft.step === 'reason'
              ? !reasonOk()
              : !storyOk() || !ratedBoth() || !reasonOk());
    backButton.disabled = busy;
  };
  const renderAll = (quiet = false) => {
    screen.hidden = !open;
    screen.setAttribute('data-step', group() ? 'group' : draft.step);
    screen.setAttribute('data-mode', group() ? 'group' : 'pair');
    bars.hidden = group();
    Array.from(bars.children).forEach((bar, at) => {
      bar.className = at <= stepIndex() ? 'on' : '';
    });
    renderChoose();
    renderStage();
    paintFoot();
    if (!quiet) paintHead();
  };

  // ---- inserting a name at the cursor ---------------------------------------------------------------------------------------
  function insert(text: string) {
    const target = focusArea;
    if (!target || text === '') return;
    const max = Number(target.getAttribute('maxlength') ?? '0') || Infinity;
    const from = target.selectionStart ?? target.value.length;
    const to = target.selectionEnd ?? from;
    const next = clean(target.value.slice(0, from) + text + target.value.slice(to));
    if (length(next) > max) return;
    target.value = next;
    const at = from + text.length;
    target.setSelectionRange?.(at, at);
    target.focus?.();
    target.dispatchEvent(new Event('input'));
  }

  // ---- moving between the steps ----------------------------------------------------------------------------------------------
  const go = (step: Step) => {
    draft.step = step;
    showNotice('');
    renderAll();
  };
  const back = (): boolean => {
    if (!open) return false;
    // The first step of the screen (a pair's ratings, a group's story) goes back to the card of the deck.
    if (group() || draft.step === 'choose' || draft.step === 'rate') {
      open = false;
      draft.step = 'choose';
      renderAll();
      return true;
    }
    go(STEPS[stepIndex() - 1]!);
    return true;
  };
  backButton.addEventListener('click', () => void back());
  nextButton.addEventListener('click', async () => {
    if (busy || nextButton.disabled) return;
    if (!lastStep()) {
      go(STEPS[stepIndex() + 1]!);
      return;
    }
    const members = [...draft.members];
    const other = partner();
    const ratings = pair()
      ? [
          { from: options.anchor, to: other, stars: draft.stars.get(key(options.anchor, other))! },
          { from: other, to: options.anchor, stars: draft.stars.get(key(other, options.anchor))! },
        ]
      : null;
    const input = {
      characterIds: members,
      ratings,
      reason: pair() ? draft.reason.trim() : null,
      text: draft.story.trim(),
    };
    const fingerprint = JSON.stringify(input);
    if (draft.pending?.fingerprint !== fingerprint) draft.pending = { requestId: options.newRequestId(), fingerprint };
    busy = true;
    paintFoot();
    try {
      const done = await options.send({ requestId: draft.pending.requestId, ...input });
      draft = fresh();
      busy = false;
      open = false;
      renderAll();
      options.onSent(done.earned ?? 0);
    } catch (error) {
      busy = false;
      const code = (error as { code?: string }).code ?? '';
      showNotice(relationCopy.errors[code] ?? relationCopy.errors.unknown!);
      paintFoot();
    }
  });

  renderAll(true);

  return {
    /** The dice card for the end of the deck. */
    entry,
    /** The screen the sheet shows instead of the deck while a relation is being written. */
    screen,
    isOpen: () => open,
    /** The sheet's header button (× / ←): one step back, or out to the deck. Returns false when the screen is not open. */
    back,
    /** The world background (plain text), or null for none. */
    setWorld: (text: string | null) => {
      world.textContent = text ?? '';
      world.hidden = text === null;
    },
    insert,
    /** The entry card is only there when at least two characters are live. */
    available:
      options.everyone.some((p) => p.characterId === options.anchor) && options.everyone.length >= RELATION_MIN_MEMBERS,
  };
}
