import { h } from "../cocreation/h.js";
import { markDirty } from "./ui/unsaved.js";
import { growBox, shortInput } from "./ui/grow-box.js";
import { sentenceList } from "./ui/sentence-list.js";
const PAST_KEY = 'background';
const KEY_LABEL = {
    speechStyle: '说话风格',
    dialogueStyle: '对话风格',
    dialogueExamples: '对话样例',
    background: '经历',
};
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const isExamples = (value) => Array.isArray(value) &&
    value.every((item) => isObject(item) &&
        onlyKeys(item, ['situation', 'player', 'reply']) &&
        (item.situation === undefined || typeof item.situation === 'string') &&
        (item.player === undefined || typeof item.player === 'string') &&
        (item.reply === undefined || isStrings(item.reply)));
const isPast = (value) => Array.isArray(value) &&
    value.every((item) => typeof item === 'string' ||
        (isObject(item) &&
            onlyKeys(item, ['title', 'text']) &&
            (item.title === undefined || typeof item.title === 'string') &&
            (item.text === undefined || typeof item.text === 'string')));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** A one-line value (a title): a single-line input as wide as its limit says, wider when the text is. */
const input = (value, label, onEdit, limit, extra = '') => {
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
const area = (value, label, onEdit, kind, multiline = false) => {
    const node = growBox(h('textarea', { attrs: { 'aria-label': label, placeholder: label, 'data-was': value } }), kind, multiline ? { multiline } : {});
    node.value = value;
    node.addEventListener('input', () => {
        markDirty(node, node.value !== node.getAttribute('data-was'));
        onEdit();
    });
    return node;
};
const adder = (text, onClick, className = 'cn-add') => {
    const node = h('button', { class: className, text, attrs: { type: 'button' } });
    node.addEventListener('click', onClick);
    return node;
};
/**
 * A short text. A string is one growing box (a sentence); a list is a SENTENCE LIST, one growing row per item (items can be 40–100
 * characters, so never chips). An empty list shows one empty row to type into.
 */
function textOrRows(key, original, onEdit) {
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
    const items = Array.isArray(original) ? [...original] : [];
    const rows = sentenceList(items, { label, onChange: onEdit, limit: 100 });
    box.append(rows.node);
    const changed = () => rows.changed();
    return {
        node: box,
        lists: [rows],
        changed,
        read: () => original === undefined && !rows.read().length ? undefined : changed() ? rows.read() : original,
    };
}
function examples(original, onEdit) {
    const label = KEY_LABEL.dialogueExamples;
    const box = h('div', { class: 'cn-field cn-wide' }, h('span', { class: 'cn-label', text: label }));
    const toRows = () => (Array.isArray(original) ? original : []).map((item) => ({
        ...(item.situation !== undefined ? { situation: String(item.situation) } : {}),
        player: String(item.player ?? ''),
        reply: (item.reply ?? []).join('\n'),
    }));
    let rows = toRows();
    // An empty list shows one empty example to type into; it is not data until it has text (the same rule as a new 经历 card).
    const blank = new WeakSet();
    const newExample = () => {
        const row = { player: '', reply: '' };
        blank.add(row);
        return row;
    };
    if (!rows.length)
        rows = [newExample()];
    const kept = () => rows.filter((row) => !(blank.has(row) && row.player.trim() === '' && row.reply.trim() === ''));
    const list = h('div', { class: 'cn-pairs' });
    const paint = () => {
        list.replaceChildren();
        rows.forEach((row, index) => {
            const player = area(row.player, '玩家说', () => {
                row.player = player.value;
                onEdit();
            }, 'one');
            // 他回: one box; a line break inside it separates the replies, so it keeps its Enter
            const reply = area(row.reply, '他回', () => {
                row.reply = reply.value;
                onEdit();
            }, 'one', true);
            reply.className = `${reply.className} cn-reply`;
            const remove = h('button', { class: 'cn-x', text: '×', attrs: { type: 'button', 'aria-label': '去掉' } });
            remove.addEventListener('click', () => {
                rows = rows.filter((_, at) => at !== index);
                if (!rows.length)
                    rows = [newExample()];
                paint();
                onEdit();
            });
            const parts = [];
            if (row.situation !== undefined) {
                const situation = area(row.situation, '情境', () => {
                    row.situation = situation.value;
                    onEdit();
                }, 'one');
                parts.push(situation);
            }
            const lab = (text, node, extra = '') => h('label', { class: `cn-lab${extra}` }, h('span', { text }), node);
            list.append(h('div', { class: 'cn-pair' }, ...parts.map((part) => lab('情境', part, ' cn-situation-lab')), lab('玩家说', player), lab('他回', reply), remove));
        });
        list.append(adder('＋ 样例', () => {
            rows = [...rows, newExample()];
            paint();
            onEdit();
        }, 'cn-add cn-add-wide'));
    };
    paint();
    box.append(list);
    const emit = () => kept().map((row) => ({
        ...(row.situation !== undefined ? { situation: row.situation } : {}),
        player: row.player,
        reply: row.reply === '' ? [] : row.reply.split('\n'),
    }));
    const changed = () => !same(kept(), toRows());
    return {
        node: box,
        changed,
        read: () => (original === undefined && !kept().length ? undefined : changed() ? emit() : original),
    };
}
function past(original, onEdit) {
    const label = KEY_LABEL[PAST_KEY];
    const box = h('div', { class: 'cn-field cn-wide' }, h('span', { class: 'cn-label', text: label }));
    const toRows = () => (Array.isArray(original) ? original : []).map((item) => typeof item === 'string'
        ? { text: item, shape: 'string' }
        : {
            ...(item.title !== undefined ? { title: String(item.title) } : {}),
            text: String(item.text ?? ''),
            shape: 'object',
        });
    let rows = toRows();
    // Part 24b-6b: a card the administrator has not written in yet (the one shown for a character with none, or one added with
    // "+ 经历") is not part of the data until it has text: an empty untouched card is never saved. Kept out of the rows themselves,
    // so a card that came in with the data is compared and re-emitted exactly as before.
    const blank = new WeakSet();
    const newCard = () => {
        const row = { title: '', text: '', shape: 'object' };
        blank.add(row);
        return row;
    };
    if (!rows.length)
        rows = [newCard()];
    const kept = () => rows.filter((row) => !(blank.has(row) && row.text.trim() === '' && (row.title ?? '').trim() === ''));
    const cards = h('div', { class: 'cn-cards' });
    const paint = () => {
        cards.replaceChildren();
        rows.forEach((row, index) => {
            const parts = [];
            if (row.title !== undefined) {
                const title = input(row.title, '标题', () => {
                    row.title = title.value;
                    onEdit();
                }, 24, 'cn-title');
                parts.push(title);
            }
            // 经历 text: a paragraph (a card is up to 2,000 characters across several paragraphs): four lines at first, then the text's own height
            const text = area(row.text, '经历', () => {
                row.text = text.value;
                onEdit();
            }, 'para', true);
            const remove = h('button', { class: 'cn-x', text: '×', attrs: { type: 'button', 'aria-label': '去掉' } });
            remove.addEventListener('click', () => {
                rows = rows.filter((_, at) => at !== index);
                if (!rows.length)
                    rows = [newCard()];
                paint();
                onEdit();
            });
            cards.append(h('div', { class: 'cn-card' }, ...parts, text, remove));
        });
        cards.append(adder('＋ 经历', () => {
            rows = [...rows, newCard()];
            paint();
            onEdit();
        }, 'cn-add cn-card cn-add-card'));
    };
    paint();
    box.append(cards);
    const emit = () => kept().map((row) => row.shape === 'string' ? row.text : { ...(row.title !== undefined ? { title: row.title } : {}), text: row.text });
    const changed = () => !same(kept(), toRows());
    return {
        node: box,
        changed,
        read: () => (original === undefined && !kept().length ? undefined : changed() ? emit() : original),
    };
}
export class CanonError extends Error {
}
/**
 * The three editor panes over one settings object. `claimed` are the keys a structured editor owns (a shape it recognises);
 * everything else is in the JSON text. `assemble()` puts the object back together in the original key order.
 */
export function canonEditors(settings, onEdit) {
    const pieces = new Map();
    const speech = h('fieldset', { class: 'cn-pane' });
    const pastPane = h('fieldset', { class: 'cn-pane' });
    speech.append(h('legend', { text: '说话方式' }));
    pastPane.append(h('legend', { text: '经历' }));
    const lists = [];
    // One column: 说话风格, 对话风格, then 对话样例 share the form's reading measure (no side-by-side halves).
    for (const key of ['speechStyle', 'dialogueStyle']) {
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
    const rest = {};
    for (const [key, value] of Object.entries(settings))
        if (!pieces.has(key))
            rest[key] = value;
    const originalOrder = Object.keys(settings);
    const assemble = (raw) => {
        let parsed;
        try {
            parsed = JSON.parse(raw);
            if (!isObject(parsed))
                throw Error();
        }
        catch {
            throw new CanonError('结构化设定必须是有效的 JSON 对象；原资料尚未修改。');
        }
        const other = parsed;
        for (const key of Object.keys(other))
            if (pieces.has(key))
                throw new CanonError(`“${KEY_LABEL[key] ?? key}”请在它自己的分区里改，不要写进其余设定。`);
        const values = new Map();
        for (const [key, piece] of pieces) {
            const value = piece.read();
            if (value !== undefined)
                values.set(key, value);
        }
        const out = {};
        for (const key of originalOrder) {
            if (values.has(key))
                out[key] = values.get(key);
            else if (key in other)
                out[key] = other[key];
        }
        for (const [key, value] of values)
            if (!(key in out))
                out[key] = value;
        for (const [key, value] of Object.entries(other))
            if (!(key in out))
                out[key] = value;
        return out;
    };
    return {
        speech,
        past: pastPane,
        /** The JSON text of the keys no structured editor owns. */
        rest: JSON.stringify(rest, null, 2),
        assemble,
        /** The lists keep their own limits (a delete button on a lone empty row stays off) when the form is enabled again. */
        setDisabled: (disabled) => {
            for (const list of lists)
                list.setDisabled(disabled);
        },
    };
}
