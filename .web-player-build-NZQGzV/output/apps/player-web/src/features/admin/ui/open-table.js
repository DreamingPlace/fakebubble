import { h } from "../../cocreation/h.js";
import { hoverValue } from "./hover-value.js";
export function openTable(options) {
    const hasDetail = !!options.detail;
    const tracks = [
        ...(options.tick ? ['28px'] : []),
        ...(hasDetail ? ['20px'] : []),
        ...options.columns.map((c) => c.width ?? 'minmax(0, 1fr)'),
    ].join(' ');
    const root = h('div', {
        class: `ot${options.className ? ` ${options.className}` : ''}`,
        attrs: { role: 'table', 'aria-label': options.label },
    });
    root.style?.setProperty('--cols', tracks);
    const head = h('div', { class: 'ot-head', attrs: { role: 'row' } });
    if (options.tick)
        head.append(h('span', { attrs: { role: 'columnheader', 'aria-label': options.tick.label } }));
    if (hasDetail)
        head.append(h('span', { attrs: { role: 'columnheader', 'aria-hidden': 'true' } }));
    let sort = null;
    const sortButtons = new Map();
    for (const column of options.columns) {
        const cell = h('span', {
            class: column.align === 'end' ? 'ot-cell is-end' : 'ot-cell',
            attrs: { role: 'columnheader' },
        });
        if (column.sortValue) {
            const button = h('button', {
                class: 'ot-sort',
                text: column.label,
                attrs: { type: 'button', 'data-sort': column.key },
            });
            cell.className = `${cell.className} is-head-sort`;
            cell.setAttribute('aria-sort', 'none');
            cell.append(button);
            sortButtons.set(column.key, { cell, button });
            button.addEventListener('click', () => {
                sort =
                    sort?.key === column.key && sort.dir === 'asc'
                        ? { key: column.key, dir: 'desc' }
                        : { key: column.key, dir: 'asc' };
                paintSort();
                paint();
            });
        }
        else
            cell.textContent = column.label;
        if (column.headTip)
            hoverValue(cell, column.headTip);
        head.append(cell);
    }
    const paintSort = () => {
        for (const [key, entry] of sortButtons) {
            const on = sort?.key === key;
            entry.cell.setAttribute('aria-sort', on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
            if (on)
                entry.button.dataset.dir = sort.dir;
            else
                delete entry.button.dataset.dir;
        }
    };
    const body = h('div', { class: 'ot-body', attrs: { role: 'rowgroup' } });
    const empty = h('p', { class: 'ot-empty', text: options.emptyText, hidden: true });
    root.append(head, body, empty);
    let rows = [];
    let openKey = null;
    const ticked = new Set();
    const items = new Map();
    const settle = (panel) => {
        // Once opened the panel stops clipping, so a hover bubble inside it can reach past its edge.
        setTimeout(() => {
            if (panel.dataset.state === 'open')
                panel.dataset.settled = 'true';
        }, 280);
    };
    const close = (key) => {
        const entry = items.get(key);
        if (!entry)
            return;
        entry.item.dataset.open = 'false';
        entry.row.setAttribute('aria-expanded', 'false');
        entry.panel.dataset.settled = 'false';
        entry.panel.dataset.state = 'closed';
        // The content leaves after the collapse so it can fade with it.
        setTimeout(() => {
            if (entry.panel.dataset.state === 'closed')
                entry.inner.replaceChildren();
        }, 280);
    };
    const open = async (key, row) => {
        if (openKey && openKey !== key)
            close(openKey);
        openKey = key;
        options.onToggle?.(key);
        const entry = items.get(key);
        if (!entry || !options.detail)
            return;
        entry.item.dataset.open = 'true';
        entry.row.setAttribute('aria-expanded', 'true');
        const content = await options.detail(row, () => toggle(key, row, false));
        if (openKey !== key)
            return;
        entry.inner.replaceChildren(content);
        entry.panel.dataset.state = 'open';
        settle(entry.panel);
    };
    const toggle = (key, row, want) => {
        const isOpen = openKey === key;
        if (want === true && isOpen)
            return;
        if (isOpen) {
            close(key);
            openKey = null;
            options.onToggle?.(null);
        }
        else
            void open(key, row);
    };
    const ordered = () => {
        const column = sort ? options.columns.find((c) => c.key === sort.key) : null;
        if (!sort || !column?.sortValue)
            return rows;
        const pinned = options.pinLast ? rows.filter(options.pinLast) : [];
        const free = options.pinLast ? rows.filter((r) => !options.pinLast(r)) : rows;
        const sign = sort.dir === 'asc' ? 1 : -1;
        const value = column.sortValue;
        const sorted = [...free].sort((a, b) => {
            const x = value(a), y = value(b);
            if (x === y)
                return 0;
            if (x === null)
                return 1;
            if (y === null)
                return -1;
            return ((typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-CN')) * sign);
        });
        return [...sorted, ...pinned];
    };
    const paint = () => {
        body.replaceChildren();
        items.clear();
        empty.hidden = rows.length > 0;
        head.hidden = rows.length === 0;
        for (const row of ordered()) {
            const key = options.rowKey(row);
            const item = h('div', { class: 'ot-item', attrs: { role: 'rowgroup', 'data-key': key, 'data-open': 'false' } });
            const line = h('div', {
                class: `ot-row${hasDetail ? ' is-pickable' : ''} ${options.rowClass?.(row) ?? ''}`.trim(),
                attrs: { role: 'row', ...(hasDetail ? { 'aria-expanded': 'false', tabindex: '0' } : {}) },
            });
            if (options.tick) {
                const box = h('input', { attrs: { type: 'checkbox', 'aria-label': options.tick.label } });
                box.checked = ticked.has(key);
                box.addEventListener('click', (event) => event.stopPropagation());
                box.addEventListener('change', () => {
                    if (box.checked) {
                        if (options.tick.max && ticked.size >= options.tick.max) {
                            box.checked = false;
                            return;
                        }
                        ticked.add(key);
                    }
                    else
                        ticked.delete(key);
                    options.tick.onChange([...ticked]);
                });
                line.append(h('span', { class: 'ot-tick', attrs: { role: 'cell' } }, box));
            }
            if (hasDetail)
                line.append(h('span', { class: 'ot-chev', attrs: { role: 'cell', 'aria-hidden': 'true' } }, chevron()));
            for (const column of options.columns) {
                const value = column.cell(row);
                const cell = h('span', {
                    class: `ot-cell${column.align === 'end' ? ' is-end' : ''}${column.mono ? ' is-mono' : ''}`,
                    attrs: { role: 'cell' },
                });
                if (typeof value === 'string')
                    cell.textContent = value;
                else
                    cell.append(value);
                const tip = column.tip?.(row);
                if (tip)
                    hoverValue(cell, tip);
                line.append(cell);
            }
            const inner = h('div', { class: 'ot-inner' });
            const panel = h('div', { class: 'ot-panel', attrs: { 'data-state': 'closed' } }, inner);
            if (options.hover) {
                line.addEventListener('mouseenter', () => options.hover(row));
                line.addEventListener('mouseleave', () => options.hover(null));
                line.addEventListener('focus', () => options.hover(row));
                line.addEventListener('blur', () => options.hover(null));
            }
            if (hasDetail) {
                const go = (event) => {
                    const target = event.target;
                    if (target?.closest?.('button, a, input, select, textarea, .ad-tip'))
                        return;
                    toggle(key, row);
                };
                line.addEventListener('click', go);
                line.addEventListener('keydown', (event) => {
                    const key2 = event.key;
                    if ((key2 === 'Enter' || key2 === ' ') && event.target === line) {
                        event.preventDefault();
                        toggle(key, row);
                    }
                });
            }
            item.append(line, panel);
            items.set(key, { item, row: line, panel, inner });
            body.append(item);
        }
        // A reload keeps the open row open.
        if (openKey && items.has(openKey)) {
            const row = rows.find((r) => options.rowKey(r) === openKey);
            const key = openKey;
            openKey = null;
            void open(key, row);
        }
        else
            openKey = null;
    };
    const api = {
        root,
        setRows(next) {
            rows = [...next];
            for (const key of [...ticked])
                if (!rows.some((r) => options.rowKey(r) === key))
                    ticked.delete(key);
            paint();
        },
        get openKey() {
            return openKey;
        },
        /** Opens a row by key (used by deep links and the "only one" case). */
        open(key) {
            const row = rows.find((r) => options.rowKey(r) === key);
            if (row && openKey !== key)
                toggle(key, row, true);
        },
        closeAll() {
            if (openKey) {
                close(openKey);
                openKey = null;
            }
        },
        ticked: () => [...ticked],
        clearTicks() {
            ticked.clear();
            for (const box of root.querySelectorAll?.('.ot-tick input') ?? [])
                box.checked = false;
            options.tick?.onChange([]);
        },
    };
    paint();
    return api;
}
const NS = 'http://www.w3.org/2000/svg';
/** The chevron of an open-below row: turns 90° when the row opens (240 ms, CSS). */
export function chevron() {
    const svg = (typeof document.createElementNS === 'function'
        ? document.createElementNS(NS, 'svg')
        : document.createElement('svg'));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ot-chevron');
    const path = (typeof document.createElementNS === 'function'
        ? document.createElementNS(NS, 'path')
        : document.createElement('path'));
    path.setAttribute('d', 'm9 6 6 6-6 6');
    svg.append(path);
    return svg;
}
