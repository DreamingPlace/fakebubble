import type { JsonValue } from '../../../../../packages/contracts/index.ts';
import { h } from '../cocreation/h.ts';
import { markDirty } from './ui/unsaved.ts';
import { growBox, shortInput, type GrowKind } from './ui/grow-box.ts';
import { sentenceList, type SentenceList } from './ui/sentence-list.ts';
import { dragOrder } from './ui/drag-order.ts';
import { dragHandle, liveRegion, movedSentence, removeButton } from './ui/item-controls.ts';

/**
 * Part 24b-6: structured editors over the EXISTING authorCanon.settings keys (no schema change).
 *   说话方式 = speechStyle, dialogueStyle (one text or a list of short items) and dialogueExamples ({situation, player, reply[]}),
 *   经历     = background (a list of text or {title, text}),
 *   其余设定 = a JSON editor of every other key.
 * A key whose value has a shape this file does not recognise falls back to the JSON editor, and an edited key is only re-built
 * from the fields when it was touched: an untouched one is re-emitted as it came in, so open → save is deep-equal to the input
 * (same key order, nothing dropped, no type change).
 */
type Settings = Record<string, JsonValue>;
type Piece = { node: HTMLElement; changed: () => boolean; read: () => JsonValue | undefined };

const PAST_KEY = 'background';
const FACTS_KEY = 'profileFacts';
const BOUNDARIES_KEY = 'boundaries';
/** The four fixed 边界与隐藏设定 items of the 24j template, in the template's order (always shown, even when empty). */
export const BOUNDARY_LABELS = [
  '知道但不会说出口的事',
  '不可改变的核心设定',
  '不应擅自补充的事实',
  '不符合角色的行为·表达',
] as const;
const KEY_LABEL: Record<string, string> = {
  speechStyle: '说话风格',
  dialogueStyle: '对话风格',
  dialogueExamples: '对话样例',
  background: '经历',
  [FACTS_KEY]: '个人资料',
  [BOUNDARIES_KEY]: '边界与隐藏设定',
};

const isObject = (value: unknown): value is Record<string, JsonValue> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const isExamples = (value: unknown) =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      isObject(item) &&
      onlyKeys(item, ['situation', 'player', 'reply']) &&
      (item.situation === undefined || typeof item.situation === 'string') &&
      (item.player === undefined || typeof item.player === 'string') &&
      (item.reply === undefined || isStrings(item.reply)),
  );
const isStringMap = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((item) => typeof item === 'string');
const isPast = (value: unknown) =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      typeof item === 'string' ||
      (isObject(item) &&
        onlyKeys(item, ['title', 'text']) &&
        (item.title === undefined || typeof item.title === 'string') &&
        (item.text === undefined || typeof item.text === 'string')),
  );
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** A one-line value (a title): a single-line input as wide as its limit says, wider when the text is. */
const input = (value: string, label: string, onEdit: () => void, limit: number, extra = '') => {
  const node = h('input', {
    class: extra,
    attrs: { type: 'text', 'aria-label': label, placeholder: label, 'data-was': value, autocomplete: 'off' },
  });
  node.value = value;
  shortInput(node, limit);
  node.addEventListener('input', () => {
    markDirty(node, node.value !== node.getAttribute('data-was'));
    onEdit();
  });
  return node;
};
/** A growing box: 'one' starts at a line, 'para' at four; both grow with the text. */
const area = (value: string, label: string, onEdit: () => void, kind: GrowKind, multiline = false) => {
  const node = growBox(
    h('textarea', { attrs: { 'aria-label': label, placeholder: label, 'data-was': value } }),
    kind,
    multiline ? { multiline } : {},
  );
  node.value = value;
  node.addEventListener('input', () => {
    markDirty(node, node.value !== node.getAttribute('data-was'));
    onEdit();
  });
  return node;
};
const adder = (text: string, onClick: () => void, className = 'cn-add') => {
  const node = h('button', { class: className, text, attrs: { type: 'button' } });
  node.addEventListener('click', onClick);
  return node;
};

/**
 * A short text. A string is one growing box (a sentence); a list is a SENTENCE LIST, one growing row per item (items can be 40–100
 * characters, so never chips). An empty list shows one empty row to type into.
 */
function textOrRows(
  key: string,
  original: JsonValue | undefined,
  onEdit: () => void,
): Piece & { lists: SentenceList[] } {
  const label = KEY_LABEL[key] ?? key;
  const box = h('div', { class: 'cn-field' }, h('span', { class: 'cn-label', text: label }));
  if (typeof original === 'string') {
    const text = area(original, label, onEdit, 'one', original.includes('\n'));
    box.append(text);
    return {
      node: box,
      lists: [],
      changed: () => text.value !== original,
      read: () => (text.value !== original ? text.value : original),
    };
  }
  const items: string[] = Array.isArray(original) ? [...(original as string[])] : [];
  const rows = sentenceList(items, { label, onChange: onEdit, limit: 100 });
  box.append(rows.node);
  const changed = () => rows.changed();
  return {
    node: box,
    lists: [rows],
    changed,
    read: () =>
      original === undefined && !rows.read().length ? undefined : changed() ? rows.read() : (original as JsonValue),
  };
}

/** A row of a card list keeps one id for as long as it lives (the drag order and the live announcements name rows by it). */
const rowIds = new WeakMap<object, number>();
let rowSeq = 0;
const idOf = (row: object) => {
  let id = rowIds.get(row);
  if (!id) {
    id = ++rowSeq;
    rowIds.set(row, id);
  }
  return id;
};
/** The shared drag order (handle, Alt+↑ / Alt+↓, live announcement) over a list that repaints itself from its rows. */
function orderable<T extends object>(
  list: HTMLElement,
  selector: string,
  name: string,
  live: { say: (message: string) => void },
  access: { get: () => T[]; set: (rows: T[]) => void; paint: () => void; edit: () => void },
) {
  dragOrder(list, {
    rows: () => Array.from(list.querySelectorAll(selector)) as HTMLElement[],
    idOf: (row) => row.dataset.id!,
    onOrder: (ids) => {
      const now = access.get();
      access.set(ids.map((id) => now.find((r) => String(idOf(r)) === id)!));
      access.paint();
      access.edit();
    },
    handle: '.ad-handle',
    announce: (_row, to, total) => live.say(movedSentence(name, to, total)),
  });
}
const cardAttrs = (row: object) => ({ role: 'listitem', 'data-drag-row': '', 'data-id': String(idOf(row)) });

type Example = { situation?: string; player: string; reply: string };
function examples(original: JsonValue | undefined, onEdit: () => void): Piece {
  const label = KEY_LABEL.dialogueExamples!;
  const box = h('div', { class: 'cn-field cn-wide' }, h('span', { class: 'cn-label', text: label }));
  const toRows = (): Example[] =>
    (Array.isArray(original) ? (original as Record<string, JsonValue>[]) : []).map((item) => ({
      ...(item.situation !== undefined ? { situation: String(item.situation) } : {}),
      player: String(item.player ?? ''),
      reply: ((item.reply as string[] | undefined) ?? []).join('\n'),
    }));
  let rows = toRows();
  // An empty list shows one empty example to type into; it is not data until it has text (the same rule as a new 经历 card).
  const blank = new WeakSet<Example>();
  const newExample = (): Example => {
    const row: Example = { player: '', reply: '' };
    blank.add(row);
    return row;
  };
  if (!rows.length) rows = [newExample()];
  const kept = () => rows.filter((row) => !(blank.has(row) && row.player.trim() === '' && row.reply.trim() === ''));
  const list = h('div', { class: 'cn-pairs', attrs: { role: 'list' } });
  const live = liveRegion();
  const paint = () => {
    list.replaceChildren();
    rows.forEach((row, index) => {
      const player = area(
        row.player,
        '玩家说',
        () => {
          row.player = player.value;
          onEdit();
        },
        'one',
      );
      // 他回: one box; a line break inside it separates the replies, so it keeps its Enter
      const reply = area(
        row.reply,
        '他回',
        () => {
          row.reply = reply.value;
          onEdit();
        },
        'one',
        true,
      );
      reply.className = `${reply.className} cn-reply`;
      const remove = removeButton(`删除${label}第 ${index + 1} 个`, 'ad-remove cn-x');
      remove.addEventListener('click', () => {
        rows = rows.filter((_, at) => at !== index);
        if (!rows.length) rows = [newExample()];
        paint();
        onEdit();
      });
      const parts: HTMLElement[] = [];
      if (row.situation !== undefined) {
        const situation = area(
          row.situation,
          '情境',
          () => {
            row.situation = situation.value;
            onEdit();
          },
          'one',
        );
        parts.push(situation);
      }
      const lab = (text: string, node: HTMLElement, extra = '') =>
        h('label', { class: `cn-lab${extra}` }, h('span', { text }), node);
      list.append(
        h(
          'div',
          { class: 'cn-pair', attrs: cardAttrs(row) },
          dragHandle(`${label}第 ${index + 1} 个`, 'ad-handle cn-handle'),
          h(
            'div',
            { class: 'cn-pair-fields' },
            ...parts.map((part) => lab('情境', part, ' cn-situation-lab')),
            lab('玩家说', player),
            lab('他回', reply),
          ),
          remove,
        ),
      );
    });
    list.append(
      adder(
        '＋ 样例',
        () => {
          rows = [...rows, newExample()];
          paint();
          onEdit();
        },
        'cn-add cn-add-wide',
      ),
    );
  };
  paint();
  orderable(list, '.cn-pair', label, live, { get: () => rows, set: (next) => (rows = next), paint, edit: onEdit });
  box.append(list, live.node);
  const emit = (): JsonValue =>
    kept().map((row) => ({
      ...(row.situation !== undefined ? { situation: row.situation } : {}),
      player: row.player,
      reply: row.reply === '' ? [] : row.reply.split('\n'),
    }));
  const changed = () => !same(kept(), toRows());
  return {
    node: box,
    changed,
    read: () => (original === undefined && !kept().length ? undefined : changed() ? emit() : (original as JsonValue)),
  };
}

type Past = { title?: string; text: string; shape: 'string' | 'object' };
function past(original: JsonValue | undefined, onEdit: () => void): Piece {
  const label = KEY_LABEL[PAST_KEY]!;
  const box = h('div', { class: 'cn-field cn-wide' }, h('span', { class: 'cn-label', text: label }));
  const toRows = (): Past[] =>
    (Array.isArray(original) ? (original as (string | Record<string, JsonValue>)[]) : []).map((item) =>
      typeof item === 'string'
        ? { text: item, shape: 'string' as const }
        : {
            ...(item.title !== undefined ? { title: String(item.title) } : {}),
            text: String(item.text ?? ''),
            shape: 'object' as const,
          },
    );
  let rows = toRows();
  // Part 24b-6b: a card the administrator has not written in yet (the one shown for a character with none, or one added with
  // "+ 经历") is not part of the data until it has text: an empty untouched card is never saved. Kept out of the rows themselves,
  // so a card that came in with the data is compared and re-emitted exactly as before.
  const blank = new WeakSet<Past>();
  const newCard = (): Past => {
    const row: Past = { title: '', text: '', shape: 'object' };
    blank.add(row);
    return row;
  };
  if (!rows.length) rows = [newCard()];
  const kept = () =>
    rows.filter((row) => !(blank.has(row) && row.text.trim() === '' && (row.title ?? '').trim() === ''));
  const cards = h('div', { class: 'cn-cards', attrs: { role: 'list' } });
  const live = liveRegion();
  const paint = () => {
    cards.replaceChildren();
    rows.forEach((row, index) => {
      const parts: HTMLElement[] = [];
      if (row.title !== undefined) {
        const title = input(
          row.title,
          '标题',
          () => {
            row.title = title.value;
            onEdit();
          },
          24,
          'cn-title',
        );
        parts.push(title);
      }
      // 经历 text: a paragraph (a card is up to 2,000 characters across several paragraphs): four lines at first, then the text's own height
      const text = area(
        row.text,
        '经历',
        () => {
          row.text = text.value;
          onEdit();
        },
        'para',
        true,
      );
      const remove = removeButton(`删除${label}第 ${index + 1} 张`, 'ad-remove cn-x');
      remove.addEventListener('click', () => {
        rows = rows.filter((_, at) => at !== index);
        if (!rows.length) rows = [newCard()];
        paint();
        onEdit();
      });
      cards.append(
        h(
          'div',
          { class: 'cn-card', attrs: cardAttrs(row) },
          dragHandle(`${label}第 ${index + 1} 张`, 'ad-handle cn-handle'),
          h('div', { class: 'cn-card-fields' }, ...parts, text),
          remove,
        ),
      );
    });
    cards.append(
      adder(
        '＋ 经历',
        () => {
          rows = [...rows, newCard()];
          paint();
          onEdit();
        },
        'cn-add cn-add-card',
      ),
    );
  };
  paint();
  orderable(cards, '.cn-card', label, live, { get: () => rows, set: (next) => (rows = next), paint, edit: onEdit });
  box.append(cards, live.node);
  const emit = (): JsonValue =>
    kept().map((row) =>
      row.shape === 'string' ? row.text : { ...(row.title !== undefined ? { title: row.title } : {}), text: row.text },
    );
  const changed = () => !same(kept(), toRows());
  return {
    node: box,
    changed,
    read: () => (original === undefined && !kept().length ? undefined : changed() ? emit() : (original as JsonValue)),
  };
}

/**
 * Part 24b-7b round 2, 其余设定 · 个人资料 (profileFacts): label → value rows, in the order they came: the label a short single-line
 * input, the value a one-sentence growing box; add / remove / reorder with the shared row controls. The 24j labels (性别, 身高, 学校-年级,
 * 家庭成员 …) are kept as written. A label can only be used once (an object has one value per key): a repeat is refused when the form is read.
 */
function facts(original: Record<string, string> | undefined, onEdit: () => void): Piece {
  const label = KEY_LABEL[FACTS_KEY]!;
  const box = h('div', { class: 'cn-field cn-wide' }, h('span', { class: 'cn-label', text: label }));
  type Fact = { label: string; value: string };
  const toRows = (): Fact[] => Object.entries(original ?? {}).map(([k, v]) => ({ label: k, value: v }));
  let rows = toRows();
  const blank = new WeakSet<Fact>();
  const newFact = (): Fact => {
    const row: Fact = { label: '', value: '' };
    blank.add(row);
    return row;
  };
  if (!rows.length) rows = [newFact()];
  const kept = () => rows.filter((row) => !(blank.has(row) && row.label.trim() === '' && row.value.trim() === ''));
  const list = h('div', { class: 'cn-facts', attrs: { role: 'list' } });
  const live = liveRegion();
  const paint = () => {
    list.replaceChildren();
    rows.forEach((row, index) => {
      const name = input(
        row.label,
        '名称（如 身高）',
        () => {
          row.label = name.value;
          onEdit();
        },
        24,
        'cn-fact-label',
      );
      const value = area(
        row.value,
        `${label}：内容`,
        () => {
          row.value = value.value;
          onEdit();
        },
        'one',
        true,
      );
      const remove = removeButton(`删除${label}第 ${index + 1} 项`, 'ad-remove cn-x');
      remove.addEventListener('click', () => {
        rows = rows.filter((_, at) => at !== index);
        if (!rows.length) rows = [newFact()];
        paint();
        onEdit();
      });
      list.append(
        h(
          'div',
          { class: 'cn-fact', attrs: cardAttrs(row) },
          dragHandle(`${label}第 ${index + 1} 项`, 'ad-handle cn-handle'),
          name,
          value,
          remove,
        ),
      );
    });
    list.append(
      adder(
        '＋ 添加一项',
        () => {
          rows = [...rows, newFact()];
          paint();
          onEdit();
        },
        'cn-add cn-add-wide',
      ),
    );
  };
  paint();
  orderable(list, '.cn-fact', label, live, { get: () => rows, set: (next) => (rows = next), paint, edit: onEdit });
  box.append(list, live.node);
  const changed = () =>
    !same(
      kept().map((r) => [r.label, r.value]),
      toRows().map((r) => [r.label, r.value]),
    );
  const emit = (): JsonValue => {
    const out: Record<string, string> = {};
    kept().forEach((row, at) => {
      if (row.label.trim() === '') throw new CanonError(`${label}第 ${at + 1} 项缺少名称。`);
      if (row.label in out) throw new CanonError(`${label}里“${row.label}”出现了两次；一个名称只能有一项。`);
      out[row.label] = row.value;
    });
    return out;
  };
  return {
    node: box,
    changed,
    read: () => (original === undefined && !kept().length ? undefined : changed() ? emit() : (original as JsonValue)),
  };
}

/**
 * 其余设定 · 边界与隐藏设定 (boundaries): the four fixed items of the 24j template, each a labelled paragraph box (four lines at first,
 * then the text's own height), always shown in the template's order, even when empty. Only an object with those keys and text
 * values is edited here; anything else stays in the JSON box.
 */
function boundaries(original: Record<string, string> | undefined, onEdit: () => void): Piece {
  const label = KEY_LABEL[BOUNDARIES_KEY]!;
  const box = h('div', { class: 'cn-field cn-wide' }, h('span', { class: 'cn-label', text: label }));
  const texts = new Map<string, HTMLTextAreaElement>();
  for (const name of BOUNDARY_LABELS) {
    const text = area(original?.[name] ?? '', name, onEdit, 'para', true);
    texts.set(name, text);
    box.append(h('label', { class: 'cn-lab cn-boundary' }, h('span', { text: name }), text));
  }
  const changed = () => BOUNDARY_LABELS.some((name) => (texts.get(name)!.value ?? '') !== (original?.[name] ?? ''));
  const emit = (): JsonValue => {
    const out: Record<string, string> = {};
    for (const name of BOUNDARY_LABELS) if (texts.get(name)!.value.trim() !== '') out[name] = texts.get(name)!.value;
    return out;
  };
  return {
    node: box,
    changed,
    read: () => (original === undefined && !changed() ? undefined : changed() ? emit() : (original as JsonValue)),
  };
}

export class CanonError extends Error {}

/**
 * The three editor panes over one settings object. `claimed` are the keys a structured editor owns (a shape it recognises);
 * everything else is in the JSON text. `assemble()` puts the object back together in the original key order.
 */
export function canonEditors(settings: Settings, onEdit: () => void) {
  const pieces = new Map<string, Piece>();
  const speech = h('fieldset', { class: 'cn-pane' });
  const pastPane = h('fieldset', { class: 'cn-pane' });
  // Round 2: the facts and the four boundaries of 其余设定 are structured too (the other keys stay in the JSON box).
  const other = h('div', { class: 'cn-pane cn-other' });
  speech.append(h('legend', { text: '说话方式' }));
  pastPane.append(h('legend', { text: '经历' }));
  const lists: SentenceList[] = [];
  // One column: 说话风格, 对话风格, then 对话样例 share the form's reading measure (no side-by-side halves).
  for (const key of ['speechStyle', 'dialogueStyle'] as const) {
    const value = settings[key];
    if (value === undefined || typeof value === 'string' || isStrings(value)) {
      const piece = textOrRows(key, value, onEdit);
      pieces.set(key, piece);
      lists.push(...piece.lists);
      speech.append(piece.node);
    }
  }
  if (settings.dialogueExamples === undefined || isExamples(settings.dialogueExamples)) {
    const piece = examples(settings.dialogueExamples, onEdit);
    pieces.set('dialogueExamples', piece);
    speech.append(piece.node);
  }
  if (settings[PAST_KEY] === undefined || isPast(settings[PAST_KEY])) {
    const piece = past(settings[PAST_KEY], onEdit);
    pieces.set(PAST_KEY, piece);
    pastPane.append(piece.node);
  }
  if (settings[FACTS_KEY] === undefined || isStringMap(settings[FACTS_KEY])) {
    const piece = facts(settings[FACTS_KEY] as Record<string, string> | undefined, onEdit);
    pieces.set(FACTS_KEY, piece);
    other.append(piece.node);
  }
  if (
    settings[BOUNDARIES_KEY] === undefined ||
    (isStringMap(settings[BOUNDARIES_KEY]) && onlyKeys(settings[BOUNDARIES_KEY], BOUNDARY_LABELS))
  ) {
    const piece = boundaries(settings[BOUNDARIES_KEY] as Record<string, string> | undefined, onEdit);
    pieces.set(BOUNDARIES_KEY, piece);
    other.append(piece.node);
  }
  const rest: Settings = {};
  for (const [key, value] of Object.entries(settings)) if (!pieces.has(key)) rest[key] = value;
  const originalOrder = Object.keys(settings);
  const assemble = (raw: string): Settings => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      if (!isObject(parsed)) throw Error();
    } catch {
      throw new CanonError('结构化设定必须是有效的 JSON 对象；原资料尚未修改。');
    }
    const other = parsed as Settings;
    for (const key of Object.keys(other))
      if (pieces.has(key)) throw new CanonError(`“${KEY_LABEL[key] ?? key}”请在它自己的分区里改，不要写进其余设定。`);
    const values = new Map<string, JsonValue>();
    for (const [key, piece] of pieces) {
      const value = piece.read();
      if (value !== undefined) values.set(key, value);
    }
    const out: Settings = {};
    for (const key of originalOrder) {
      if (values.has(key)) out[key] = values.get(key)!;
      else if (key in other) out[key] = other[key]!;
    }
    for (const [key, value] of values) if (!(key in out)) out[key] = value;
    for (const [key, value] of Object.entries(other)) if (!(key in out)) out[key] = value;
    return out;
  };
  return {
    speech,
    past: pastPane,
    other,
    /** Whether any key is left for the JSON box (it is shown, folded, only then). */
    hasRest: Object.keys(rest).length > 0,
    /** The JSON text of the keys no structured editor owns. */
    rest: JSON.stringify(rest, null, 2),
    assemble,
    /** The lists keep their own limits (a delete button on a lone empty row stays off) when the form is enabled again. */
    setDisabled: (disabled: boolean) => {
      for (const list of lists) list.setDisabled(disabled);
    },
  };
}
