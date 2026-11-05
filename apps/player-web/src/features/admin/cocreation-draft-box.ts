import { ADOPT_ERROR_TEXT, type AdoptField } from '../../../../../packages/contracts/cocreation-adopt.ts';
import { COCREATION_LIMITS } from '../../../../../packages/contracts/cocreation-cards.ts';
import { h } from '../cocreation/h.ts';

/**
 * Part 24b-6b: the right side of 共创收件箱. It shows the CURRENT draft text of the target field as ONE editable box, and 加入草稿
 * inserts the player's note INTO that text: at the caret (or, when the administrator never clicked in the box, at the end on its own
 * line). The inserted passage is highlighted for a moment and stays ordinary text: it can be moved, cut or rewritten before 保存草稿.
 * A list-shaped field (示例对话, and the lists of short items) is a column of cards; the note goes into the card that holds the caret,
 * else the last card, and never adds a card of its own. Saving builds the field's new value from the boxes (a card nobody touched is
 * re-emitted exactly as it came in) and hands it to the page, which uses the existing compare-and-swap draft save.
 */
type Template = { persona?: string; authorCanon?: { settings?: Record<string, unknown> } } & Record<string, unknown>;
export type NoteSource = { text: string } | { player: string; replies: string[] };
type Example = { situation?: string; player?: string; reply?: string[] };

/** text: one box. strings / examples: cards. unsupported: the field holds something this box cannot show (nothing is changed). */
export type BoxKind = 'text' | 'strings' | 'examples' | 'unsupported';
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isExamples = (value: unknown): value is Example[] =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      isObject(item) &&
      Object.keys(item).every((key) => key === 'situation' || key === 'player' || key === 'reply') &&
      (item.situation === undefined || typeof item.situation === 'string') &&
      (item.player === undefined || typeof item.player === 'string') &&
      (item.reply === undefined || isStrings(item.reply)),
  );

const TEXT_ONLY = new Set<AdoptField>(['persona']);
const LISTS = new Set<AdoptField>(['interests', 'boundaries', 'personalityLayers', 'fictionalPeople']);
const raw = (template: Template | null, field: AdoptField): unknown =>
  field === 'persona' ? template?.persona : template?.authorCanon?.settings?.[field];

export function boxKind(template: Template | null, field: AdoptField): BoxKind {
  const value = raw(template, field);
  if (field === 'dialogueExamples') return value === undefined || isExamples(value) ? 'examples' : 'unsupported';
  if (TEXT_ONLY.has(field)) return typeof value === 'string' || value === undefined ? 'text' : 'unsupported';
  if (LISTS.has(field)) return value === undefined || isStrings(value) ? 'strings' : 'unsupported';
  // speechStyle, dialogueStyle: one text, or a list of short items.
  if (value === undefined || typeof value === 'string') return 'text';
  return isStrings(value) ? 'strings' : 'unsupported';
}

/** The template with ONE field replaced by what the boxes hold. Pure: nothing else in the template is touched. */
export function withField<T extends object>(template: T, field: AdoptField, next: unknown): T {
  const copy = structuredClone(template) as unknown as Template;
  if (field === 'persona') {
    copy.persona = String(next);
    return copy as unknown as T;
  }
  // Nothing to write and no canon yet: the template stays exactly as it came in.
  if (next === undefined && !copy.authorCanon) return copy as unknown as T;
  const canon = (copy.authorCanon ??= { kind: 'author_canon', settings: {} } as unknown as NonNullable<
    Template['authorCanon']
  >);
  const settings = (canon.settings ??= {});
  if (next === undefined) delete settings[field];
  else settings[field] = next;
  return copy as unknown as T;
}

export const DRAFT_BOX_ERROR = {
  EXAMPLE_INVALID: '对话示例需要情境、玩家的话，以及一到两句角色的回复，且每句不超过限制长度。',
  UNSUPPORTED: ADOPT_ERROR_TEXT.ADOPT_FIELD_SHAPE_UNSUPPORTED!,
} as const;

const HIGHLIGHT_MS = 1500;
const MOTION_MS = 200;

/** A multi-line box that shows where the inserted passage is (a mirror under the text) and grows with its content. */
function textBox(value: string, label: string, readOnly: boolean, onEdit: () => void) {
  const mirror = h('div', { class: 'cc-mirror', attrs: { 'aria-hidden': 'true' } });
  const area = h('textarea', { class: 'cc-area', attrs: { 'aria-label': label, 'data-was': value } });
  area.value = value;
  if (readOnly) area.setAttribute('readonly', '');
  const wrap = h('div', { class: 'cc-area-wrap' }, mirror, area);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const grow = () => {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
  };
  const clearMark = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    mirror.replaceChildren();
  };
  area.addEventListener('input', () => {
    clearMark();
    grow();
    onEdit();
  });
  area.addEventListener('scroll', () => {
    mirror.scrollTop = area.scrollTop;
  });
  const api = {
    wrap,
    area,
    /** Puts `note` into the text at `at` (the caret) and lights it for a moment. */
    insert(note: string, at: number | 'end') {
      const current = area.value;
      let position = typeof at === 'number' ? Math.min(Math.max(at, 0), current.length) : current.length;
      let piece = note;
      if (at === 'end' && current !== '' && !current.endsWith('\n')) piece = `\n${note}`;
      const before = current.slice(0, position);
      const after = current.slice(position);
      area.value = `${before}${piece}${after}`;
      const start = position + (piece.length - note.length);
      const end = start + note.length;
      position = end;
      grow();
      area.focus?.();
      area.setSelectionRange?.(position, position);
      onEdit();
      // The highlight: the same text drawn under the box with the passage in a <mark> (it fades in and out over the select motion).
      const lit = h('mark', { class: 'cc-hit', text: note });
      mirror.replaceChildren(before + piece.slice(0, piece.length - note.length), lit, `${after}​`);
      mirror.scrollTop = area.scrollTop;
      setTimeout(() => lit.classList.add('is-on'), 16);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        lit.classList.remove('is-on');
        timer = setTimeout(clearMark, MOTION_MS + 40);
      }, HIGHLIGHT_MS);
    },
    caret: () => area.selectionStart ?? area.value.length,
  };
  setTimeout(grow, 0);
  return api;
}

export type DraftBox = {
  root: HTMLElement;
  /** Inserts the note; false when this field cannot take it. */
  insert(): boolean;
  dirty(): boolean;
  /** The field's new value (undefined: the field stays as it is / is absent), or an error text. */
  result(): { ok: true; value: unknown } | { ok: false; error: string };
};

export function draftBox(options: {
  template: Template | null;
  field: AdoptField;
  source: NoteSource;
  character: string;
  readOnly: boolean;
  onEdit: () => void;
}): DraftBox {
  const { template, field, source, onEdit } = options;
  const kind = boxKind(template, field);
  const original = raw(template, field);
  const noteText =
    'text' in source
      ? source.text
      : [`玩家：${source.player}`, ...source.replies.map((r) => `${options.character}：${r}`)].join('\n');
  // Every text control of the box, with the card it belongs to: the caret is looked for here.
  let touched = false;
  let lastFocus: { control: HTMLInputElement | HTMLTextAreaElement; card: number } | null = null;
  const root = h('div', { class: `cc-draft-field is-${kind}` });

  if (kind === 'unsupported') {
    root.append(h('p', { class: 'cc-target-empty', text: DRAFT_BOX_ERROR.UNSUPPORTED }));
    return {
      root,
      insert: () => false,
      dirty: () => false,
      result: () => ({ ok: false, error: DRAFT_BOX_ERROR.UNSUPPORTED }),
    };
  }

  if (kind === 'text') {
    const text = textBox(
      typeof original === 'string' ? original : '',
      '草稿里这个字段的现有内容',
      options.readOnly,
      onEdit,
    );
    for (const type of ['focus', 'click', 'keyup', 'select']) text.area.addEventListener(type, () => (touched = true));
    root.append(text.wrap);
    return {
      root,
      insert() {
        if (options.readOnly) return false;
        text.insert(noteText, touched ? text.caret() : 'end');
        return true;
      },
      dirty: () => text.area.value !== (typeof original === 'string' ? original : ''),
      result: () => ({
        ok: true,
        value: text.area.value === '' && original === undefined ? undefined : text.area.value,
      }),
    };
  }

  type Card = { index: number; boxes: ReturnType<typeof textBox>[]; inputs: HTMLInputElement[]; node: HTMLElement };
  const cards: Card[] = [];
  const track = (control: HTMLInputElement | HTMLTextAreaElement, index: number) => {
    for (const type of ['focus', 'click', 'keyup', 'select'])
      control.addEventListener(type, () => {
        touched = true;
        lastFocus = { control, card: index };
      });
  };

  if (kind === 'strings') {
    const items = (Array.isArray(original) ? original : typeof original === 'string' ? [original] : []) as string[];
    // A character with none still shows one empty card, so there is always a box to write in; an untouched empty card is not saved.
    const shown = items.length ? items : [''];
    shown.forEach((item, index) => {
      const box = textBox(item, `第 ${index + 1} 条`, options.readOnly, onEdit);
      track(box.area, index);
      const node = h('div', { class: 'cc-draft-card' }, box.wrap);
      cards.push({ index, boxes: [box], inputs: [], node });
    });
    root.append(...cards.map((card) => card.node));
    return {
      root,
      insert() {
        if (options.readOnly) return false;
        const card = lastFocus ? cards[lastFocus.card]! : cards[cards.length - 1]!;
        const box = card.boxes[0]!;
        const useCaret = touched && lastFocus?.card === card.index;
        box.insert(noteText, useCaret ? box.caret() : 'end');
        return true;
      },
      dirty: () => cards.some((card, i) => card.boxes[0]!.area.value !== (items[i] ?? '')),
      result() {
        const next: string[] = [];
        cards.forEach((card, i) => {
          const value = card.boxes[0]!.area.value;
          if (i < items.length) {
            if (value === items[i]) next.push(items[i]!);
            else if (value.trim() !== '') next.push(value);
          } else if (value.trim() !== '') next.push(value);
        });
        if (!items.length && !next.length) return { ok: true, value: undefined };
        // A field that was one text and is now a list of one is kept a text.
        if (typeof original === 'string') return { ok: true, value: next.join('\n') };
        return { ok: true, value: next };
      },
    };
  }

  // examples
  const items = (Array.isArray(original) ? original : []) as Example[];
  const shown: Example[] = items.length ? items : [{ player: '', reply: [] }];
  type Row = {
    situation: HTMLInputElement | null;
    player: HTMLInputElement;
    reply: ReturnType<typeof textBox>;
  };
  const rows: Row[] = [];
  const lab = (text: string, node: HTMLElement) => h('label', { class: 'cc-lab' }, h('span', { text }), node);
  shown.forEach((example, index) => {
    const edit = () => onEdit();
    let situation: HTMLInputElement | null = null;
    if (example.situation !== undefined || !items.length) {
      situation = h('input', {
        attrs: { type: 'text', 'aria-label': '情境', maxlength: '100', 'data-was': example.situation ?? '' },
      });
      situation.value = example.situation ?? '';
      situation.addEventListener('input', edit);
      track(situation, index);
    }
    const player = h('input', {
      attrs: {
        type: 'text',
        'aria-label': '玩家说',
        maxlength: String(COCREATION_LIMITS.dialoguePlayer),
        'data-was': example.player ?? '',
      },
    });
    player.value = example.player ?? '';
    player.addEventListener('input', edit);
    track(player, index);
    const reply = textBox(
      (example.reply ?? []).join('\n'),
      `${options.character}回复（一句一行）`,
      options.readOnly,
      onEdit,
    );
    track(reply.area, index);
    if (options.readOnly) {
      situation?.setAttribute('readonly', '');
      player.setAttribute('readonly', '');
    }
    rows.push({ situation, player, reply });
    const node = h(
      'div',
      { class: 'cc-draft-card is-example' },
      situation ? lab('情境', situation) : null,
      lab('玩家说', player),
      lab(`${options.character}回复`, reply.wrap),
    );
    cards.push({ index, boxes: [reply], inputs: [...(situation ? [situation] : []), player], node });
  });
  root.append(...cards.map((card) => card.node));
  const flash = (control: HTMLInputElement) => {
    control.classList.add('is-just-added');
    setTimeout(() => control.classList.remove('is-just-added'), HIGHLIGHT_MS);
  };
  const putInInput = (control: HTMLInputElement, piece: string, caret: boolean) => {
    const current = control.value;
    const at = caret ? Math.min(control.selectionStart ?? current.length, current.length) : current.length;
    const glue = !caret && current !== '' ? ' ' : '';
    control.value = `${current.slice(0, at)}${glue}${piece}${current.slice(at)}`;
    control.focus?.();
    const after = at + glue.length + piece.length;
    control.setSelectionRange?.(after, after);
    flash(control);
    onEdit();
  };
  const rowChanged = (row: Row, i: number) => {
    const was = items[i];
    return (
      (row.situation?.value ?? '') !== (was?.situation ?? '') ||
      row.player.value !== (was?.player ?? '') ||
      row.reply.area.value !== (was?.reply ?? []).join('\n')
    );
  };
  return {
    root,
    insert() {
      if (options.readOnly) return false;
      const index = lastFocus ? lastFocus.card : rows.length - 1;
      const row = rows[index]!;
      const here = lastFocus && lastFocus.card === index && touched ? lastFocus.control : null;
      const player = 'text' in source ? source.text : source.player;
      const replies = 'text' in source ? source.text : source.replies.join('\n');
      if (row.situation && row.situation.value.trim() === '') {
        row.situation.value = '日常聊天';
      }
      if (here === row.player) putInInput(row.player, player, true);
      else if (here === row.reply.area) row.reply.insert(replies, row.reply.caret());
      else if (here === row.situation) putInInput(row.situation!, player, true);
      else if ('text' in source) row.reply.insert(source.text, 'end');
      else {
        // A conversation note fills both: what the player said, and what the character answered.
        putInInput(row.player, source.player, false);
        row.reply.insert(replies, 'end');
      }
      return true;
    },
    dirty: () => rows.some((row, i) => rowChanged(row, i)),
    result() {
      const next: Example[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        if (i < items.length && !rowChanged(row, i)) {
          next.push(items[i]!);
          continue;
        }
        const lines = row.reply.area.value.split('\n').filter((line) => line.trim() !== '');
        const empty = !row.player.value.trim() && !lines.length && !(row.situation?.value ?? '').trim();
        if (empty && i >= items.length) continue;
        const situation = (row.situation?.value ?? '').trim();
        const playerText = row.player.value.trim();
        const valid =
          (row.situation === null || (situation !== '' && [...situation].length <= 100)) &&
          playerText !== '' &&
          [...playerText].length <= COCREATION_LIMITS.dialoguePlayer &&
          lines.length >= 1 &&
          lines.length <= 2 &&
          lines.every((line) => [...line.trim()].length <= COCREATION_LIMITS.dialogueReply);
        if (!valid) return { ok: false, error: DRAFT_BOX_ERROR.EXAMPLE_INVALID };
        next.push({
          ...(row.situation ? { situation } : {}),
          player: playerText,
          reply: lines.map((line) => line.trim()),
        });
      }
      if (!items.length && !next.length) return { ok: true, value: undefined };
      return { ok: true, value: next };
    },
  };
}
