import { dragOrder } from "./drag-order.js";
import { growBox } from "./grow-box.js";
import { markDirty } from "./unsaved.js";
const node = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className)
        n.className = className;
    if (text !== undefined)
        n.textContent = text;
    return n;
};
export function sentenceList(initial, options) {
    const root = node('div', 'sl');
    const list = node('div', 'sl-rows');
    list.setAttribute?.('role', 'list');
    const add = node('button', 'sl-add', options.addText ?? '＋ 添加一条');
    add.type = 'button';
    root.append(list, add);
    // Empty items of the incoming data are not rows to show; `changed` compares what is typed with the non-empty ones.
    const original = initial.filter((text) => text.trim() !== '');
    let rows = [];
    let seq = 0;
    let locked = false;
    const read = () => rows.map((r) => r.box.value).filter((text) => text.trim() !== '');
    const changed = () => JSON.stringify(read()) !== JSON.stringify(original);
    const paint = () => {
        rows.forEach((r, i) => {
            r.row.dataset.index = String(i + 1);
            r.box.setAttribute?.('aria-label', `${options.label} 第 ${i + 1} 条`);
            // the one row of an empty list is only a place to type: it has nothing to delete
            r.del.disabled = locked || (rows.length === 1 && r.box.value === '');
        });
        add.disabled = locked;
    };
    const touched = () => {
        paint();
        options.onChange();
    };
    const make = (text, enter) => {
        const row = node('div', 'sl-row');
        row.setAttribute?.('role', 'listitem');
        const id = ++seq;
        row.dataset.dragRow = '';
        row.dataset.id = String(id);
        const grip = node('span', 'sl-grip', '⋮⋮');
        grip.setAttribute?.('aria-hidden', 'true');
        const box = growBox(node('textarea'), 'one');
        box.value = text;
        if (options.limit)
            box.maxLength = options.limit;
        box.setAttribute?.('data-was', text);
        const del = node('button', 'sl-del', '删除');
        del.type = 'button';
        row.append(grip, box, del);
        const record = { id, row, box, del };
        box.addEventListener('input', () => {
            markDirty(box, box.value !== box.getAttribute('data-was'));
            touched();
        });
        del.addEventListener('click', () => {
            if (locked)
                return;
            rows = rows.filter((r) => r !== record);
            row.remove();
            // the last row is never removed from the page: an empty list shows one empty row
            if (!rows.length) {
                const blank = make('', false);
                rows.push(blank);
                list.append(blank.row);
            }
            touched();
        });
        if (enter)
            row.classList.add('is-entering');
        return record;
    };
    for (const text of original.length ? original : ['']) {
        const r = make(text, false);
        rows.push(r);
        list.append(r.row);
    }
    add.addEventListener('click', () => {
        if (locked)
            return;
        const r = make('', true);
        rows.push(r);
        list.append(r.row);
        touched();
        r.box.focus?.();
    });
    dragOrder(list, {
        rows: () => rows.map((r) => r.row),
        idOf: (row) => row.dataset.id,
        onOrder: (ids) => {
            rows = ids.map((id) => rows.find((r) => String(r.id) === id));
            touched();
        },
        ignore: 'textarea,input,button',
    });
    paint();
    return {
        node: root,
        read,
        changed,
        setDisabled: (disabled) => {
            locked = disabled;
            for (const c of root.querySelectorAll('textarea,button')) {
                c.dataset.locked = String(disabled);
                c.disabled = disabled;
            }
            if (!disabled)
                paint();
        },
    };
}
