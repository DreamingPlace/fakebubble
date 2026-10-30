import type { JsonValue } from '../../../../../packages/contracts/index.ts';
import { h } from '../cocreation/h.ts';
import { markDirty } from './ui/unsaved.ts';

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
const KEY_LABEL: Record<string, string> = {
  speechStyle: '说话风格',
  dialogueStyle: '对话风格',
  dialogueExamples: '对话样例',
  background: '经历',
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
const input = (value: string, label: string, onEdit: () => void, extra = '') => {
  const node = h('input', { class: extra, attrs: { type: 'text', 'aria-label': label, 'data-was': value } });
  node.value = value;
  node.addEventListener('input', () => {
    markDirty(node, node.value !== node.getAttribute('data-was'));
    onEdit();
  });
  return node;
};
const area = (value: string, label: string, onEdit: () => void, rows = 3) => {
  const node = h('textarea', { attrs: { rows: String(rows), 'aria-label': label, 'data-was': value } });
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

/** A short text: one text box, or a list of chips (each editable in place, × removes it, + adds one). */
function textOrChips(key: string, original: JsonValue | undefined, onEdit: () => void): Piece {
  const label = KEY_LABEL[key] ?? key;
  const box = h('div', { class: 'cn-field' }, h('span', { class: 'cn-label', text: label }));
  if (typeof original === 'string') {
    const text = area(original, label, onEdit, 3);
    box.append(text);
    return {
      node: box,
      changed: () => text.value !== original,
      read: () => (text.value !== original ? text.value : original),
    };
  }
  let items: string[] = Array.isArray(original) ? [...(original as string[])] : [];
  const chips = h('div', { class: 'cn-chips' });
  const fields: HTMLInputElement[] = [];
  const paint = () => {
    chips.replaceChildren();
    fields.length = 0;
    items.forEach((item, index) => {
      const field = input(
        item,
        label,
        () => {
          items[index] = field.value;
          onEdit();
        },
        'cn-chip-input',
      );
      field.size = Math.max(4, [...field.value].length + 1);
      field.addEventListener('input', () => {
        field.size = Math.max(4, [...field.value].length + 1);
      });
      fields.push(field);
      const remove = h('button', { class: 'cn-x', text: '×', attrs: { type: 'button', 'aria-label': '去掉' } });
      remove.addEventListener('click', () => {
        items = items.filter((_, at) => at !== index);
        paint();
        onEdit();
      });
      chips.append(h('span', { class: 'cn-chip' }, field, remove));
    });
    chips.append(
      adder(
        '+',
        () => {
          items = [...items, ''];
          paint();
          fields[fields.length - 1]?.focus();
          onEdit();
        },
        'cn-chip cn-add',
      ),
    );
  };
  paint();
  box.append(chips);
  const changed = () => !same(items, original ?? []);
  return {
    node: box,
    changed,
    read: () =>
      original === undefined && !items.length
        ? undefined
        : changed()
          ? items.filter((item) => item.trim() !== '')
          : (original as JsonValue),
  };
}

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
  const list = h('div', { class: 'cn-pairs' });
  const paint = () => {
    list.replaceChildren();
    rows.forEach((row, index) => {
      const player = input(row.player, '玩家说', () => {
        row.player = player.value;
        onEdit();
      });
      const reply = area(
        row.reply,
        '他回',
        () => {
          row.reply = reply.value;
          onEdit();
        },
        2,
      );
      reply.className = 'cn-reply';
      const remove = h('button', { class: 'cn-x', text: '×', attrs: { type: 'button', 'aria-label': '去掉' } });
      remove.addEventListener('click', () => {
        rows = rows.filter((_, at) => at !== index);
        paint();
        onEdit();
      });
      const parts: HTMLElement[] = [];
      if (row.situation !== undefined) {
        const situation = input(
          row.situation,
          '场景',
          () => {
            row.situation = situation.value;
            onEdit();
          },
          'cn-situation',
        );
        parts.push(situation);
      }
      list.append(h('div', { class: 'cn-pair' }, ...parts, player, reply, remove));
    });
    list.append(
      adder(
        '+ 样例',
        () => {
          rows = [...rows, { player: '', reply: '' }];
          paint();
          onEdit();
        },
        'cn-add cn-add-wide',
      ),
    );
  };
  paint();
  box.append(list);
  const emit = (): JsonValue =>
    rows.map((row) => ({
      ...(row.situation !== undefined ? { situation: row.situation } : {}),
      player: row.player,
      reply: row.reply === '' ? [] : row.reply.split('\n'),
    }));
  const changed = () => !same(rows, toRows());
  return {
    node: box,
    changed,
    read: () => (original === undefined && !rows.length ? undefined : changed() ? emit() : (original as JsonValue)),
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
  const cards = h('div', { class: 'cn-cards' });
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
          'cn-title',
        );
        parts.push(title);
      }
      const text = area(
        row.text,
        '经历',
        () => {
          row.text = text.value;
          onEdit();
        },
        4,
      );
      const remove = h('button', { class: 'cn-x', text: '×', attrs: { type: 'button', 'aria-label': '去掉' } });
      remove.addEventListener('click', () => {
        rows = rows.filter((_, at) => at !== index);
        paint();
        onEdit();
      });
      cards.append(h('div', { class: 'cn-card' }, ...parts, text, remove));
    });
    cards.append(
      adder(
        '+ 经历',
        () => {
          rows = [...rows, { title: '', text: '', shape: 'object' }];
          paint();
          onEdit();
        },
        'cn-add cn-card cn-add-card',
      ),
    );
  };
  paint();
  box.append(cards);
  const emit = (): JsonValue =>
    rows.map((row) =>
      row.shape === 'string' ? row.text : { ...(row.title !== undefined ? { title: row.title } : {}), text: row.text },
    );
  const changed = () => !same(rows, toRows());
  return {
    node: box,
    changed,
    read: () => (original === undefined && !rows.length ? undefined : changed() ? emit() : (original as JsonValue)),
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
  speech.append(h('legend', { text: '说话方式' }));
  pastPane.append(h('legend', { text: '经历' }));
  const grid = h('div', { class: 'cn-grid' });
  speech.append(grid);
  for (const key of ['speechStyle', 'dialogueStyle'] as const) {
    const value = settings[key];
    if (value === undefined || typeof value === 'string' || isStrings(value)) {
      const piece = textOrChips(key, value, onEdit);
      pieces.set(key, piece);
      grid.append(piece.node);
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
    /** The JSON text of the keys no structured editor owns. */
    rest: JSON.stringify(rest, null, 2),
    assemble,
  };
}
