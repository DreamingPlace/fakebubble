/**
 * Part 24l: drag to order, with motion (never a jump). A vertical list: press a row and move; the row follows the pointer, the rows
 * it passes slide out of the way (transform only, 180 ms), and on release it settles into its place before anything is saved.
 * The keyboard does the same with Alt+↑ / Alt+↓ on the focused row. Reduced motion: no slide, the row is simply put in place.
 */
export const DRAG_SLIDE_MS = 180;
/** Pointer travel before a press becomes a drag (a plain click on a row still opens it). */
export const DRAG_START_PX = 5;
/** `ids` with the one at `from` moved to `to` (both indexes of `ids`). */
export function moved(ids, from, to) {
    const next = [...ids];
    const [one] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, to)), 0, one);
    return next;
}
/** Where a dragged row ends up: the index whose slot centre is nearest to the dragged row's centre. */
export function slotAt(centres, from, dragCentre) {
    let best = from;
    let bestGap = Infinity;
    centres.forEach((centre, index) => {
        const gap = Math.abs(centre - dragCentre);
        if (gap < bestGap) {
            best = index;
            bestGap = gap;
        }
    });
    return best;
}
const frame = (work) => typeof requestAnimationFrame === 'function' ? requestAnimationFrame(work) : setTimeout(work, 0);
const reduced = () => typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Returns a function that removes every listener it added. */
export function dragOrder(list, options) {
    const slide = reduced() ? 'none' : `transform ${DRAG_SLIDE_MS}ms cubic-bezier(0.2, 0.7, 0.2, 1)`;
    let drag = null;
    let swallow = false;
    const place = (state) => {
        const { rows, from, to, height } = state;
        rows.forEach((row, index) => {
            if (row === state.row)
                return;
            const shift = from < to && index > from && index <= to ? -height : from > to && index >= to && index < from ? height : 0;
            row.style.transition = slide;
            row.style.transform = shift ? `translateY(${shift}px)` : '';
        });
    };
    const onDown = (event) => {
        const row = event.target?.closest?.('[data-drag-row]');
        if (!row || !list.contains(row) || event.button !== 0 || drag)
            return;
        if (options.ignore && event.target.closest(options.ignore))
            return;
        const rows = options.rows();
        const rects = rows.map((r) => r.getBoundingClientRect());
        const from = rows.indexOf(row);
        if (from < 0 || rows.length < 2)
            return;
        const height = rects[from].height + (rows[1] ? Math.max(0, rects[1].top - rects[0].bottom) : 0);
        drag = {
            row,
            pointer: event.pointerId,
            startY: event.clientY,
            from,
            to: from,
            rows,
            centres: rects.map((r) => r.top + r.height / 2),
            height,
            live: false,
        };
    };
    const onMove = (event) => {
        if (!drag || event.pointerId !== drag.pointer)
            return;
        const dy = event.clientY - drag.startY;
        if (!drag.live) {
            if (Math.abs(dy) < DRAG_START_PX)
                return;
            drag.live = true;
            drag.row.classList.add('is-dragging');
            drag.row.setPointerCapture?.(event.pointerId);
            drag.row.style.transition = 'none';
        }
        drag.row.style.transform = `translateY(${dy}px)`;
        const to = slotAt(drag.centres, drag.from, drag.centres[drag.from] + dy);
        if (to !== drag.to) {
            drag.to = to;
            place(drag);
        }
    };
    const settle = (state) => {
        // The dragged row glides to the slot it was dropped on; then the DOM takes the new order and every transform is cleared at once.
        const { row, rows, from, to } = state;
        const offset = state.centres[to] - state.centres[from];
        row.style.transition = slide;
        row.style.transform = `translateY(${offset}px)`;
        const done = () => {
            row.removeEventListener('transitionend', done);
            for (const r of rows) {
                r.style.transition = 'none';
                r.style.transform = '';
            }
            row.classList.remove('is-dragging');
            if (to !== from) {
                const order = moved(rows, from, to);
                for (const r of order)
                    list.append(r);
                options.onOrder(order.map(options.idOf));
            }
            // One frame later the rows may animate again.
            frame(() => {
                for (const r of rows)
                    r.style.transition = '';
            });
        };
        if (slide === 'none' || offset === 0)
            done();
        else {
            row.addEventListener('transitionend', done);
            setTimeout(() => {
                if (row.classList.contains('is-dragging'))
                    done();
            }, DRAG_SLIDE_MS + 60);
        }
    };
    const onUp = (event) => {
        if (!drag || event.pointerId !== drag.pointer)
            return;
        const state = drag;
        drag = null;
        if (!state.live)
            return;
        // The click that follows the release must not open the row.
        swallow = true;
        setTimeout(() => {
            swallow = false;
        }, 0);
        state.row.releasePointerCapture?.(event.pointerId);
        settle(state);
    };
    const onClick = (event) => {
        if (!swallow)
            return;
        event.preventDefault();
        event.stopPropagation();
        swallow = false;
    };
    const onKey = (event) => {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown'))
            return;
        const row = event.target?.closest?.('[data-drag-row]');
        if (!row || !list.contains(row))
            return;
        const rows = options.rows();
        const from = rows.indexOf(row);
        const to = from + (event.key === 'ArrowUp' ? -1 : 1);
        if (from < 0 || to < 0 || to >= rows.length)
            return;
        event.preventDefault();
        const order = moved(rows, from, to);
        // The neighbour swaps places with a slide: both rows start where they were and glide.
        const a = rows[from].getBoundingClientRect(), b = rows[to].getBoundingClientRect();
        for (const r of order)
            list.append(r);
        if (slide !== 'none') {
            rows[from].style.transition = 'none';
            rows[to].style.transition = 'none';
            rows[from].style.transform = `translateY(${a.top - b.top}px)`;
            rows[to].style.transform = `translateY(${b.top - a.top}px)`;
            frame(() => {
                for (const r of [rows[from], rows[to]]) {
                    r.style.transition = slide;
                    r.style.transform = '';
                }
            });
        }
        (row.querySelector('button') ?? row).focus?.();
        options.onOrder(order.map(options.idOf));
    };
    list.addEventListener('pointerdown', onDown);
    list.addEventListener('pointermove', onMove);
    list.addEventListener('pointerup', onUp);
    list.addEventListener('pointercancel', onUp);
    list.addEventListener('click', onClick, true);
    list.addEventListener('keydown', onKey);
    return () => {
        list.removeEventListener('pointerdown', onDown);
        list.removeEventListener('pointermove', onMove);
        list.removeEventListener('pointerup', onUp);
        list.removeEventListener('pointercancel', onUp);
        list.removeEventListener('click', onClick, true);
        list.removeEventListener('keydown', onKey);
    };
}
