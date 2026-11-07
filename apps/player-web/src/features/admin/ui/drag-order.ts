/**
 * Part 24l: drag to order, with motion (never a jump). A vertical list: press a row and move; the row follows the pointer, the rows
 * it passes slide out of the way (transform only, 180 ms), and on release it settles into its place before anything is saved.
 * The keyboard does the same with Alt+↑ / Alt+↓ on the focused row. Reduced motion: no slide, the row is simply put in place.
 */
export const DRAG_SLIDE_MS = 180;
/** Pointer travel before a press becomes a drag (a plain click on a row still opens it). */
export const DRAG_START_PX = 5;

/** `ids` with the one at `from` moved to `to` (both indexes of `ids`). */
export function moved<T>(ids: readonly T[], from: number, to: number): T[] {
  const next = [...ids];
  const [one] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, one as T);
  return next;
}

/** Where a dragged row ends up: the index whose slot centre is nearest to the dragged row's centre. */
export function slotAt(centres: readonly number[], from: number, dragCentre: number): number {
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

export type DragOrderOptions = {
  /** The rows of this list, in order. */
  rows: () => HTMLElement[];
  /** The id of a row. */
  idOf: (row: HTMLElement) => string;
  /** The new order, after a drop or a keyboard move (every id of the list). The DOM is already in that order. */
  onOrder: (ids: string[]) => void;
  /** A press that starts on one of these (a link, a count badge) is never a drag. */
  ignore?: string;
};

const frame = (work: () => void) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(work) : setTimeout(work, 0);
const reduced = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Returns a function that removes every listener it added. */
export function dragOrder(list: HTMLElement, options: DragOrderOptions): () => void {
  const slide = reduced() ? 'none' : `transform ${DRAG_SLIDE_MS}ms cubic-bezier(0.2, 0.7, 0.2, 1)`;
  let drag: {
    row: HTMLElement;
    pointer: number;
    startY: number;
    from: number;
    to: number;
    rows: HTMLElement[];
    centres: number[];
    height: number;
    live: boolean;
  } | null = null;
  let swallow = false;

  const place = (state: NonNullable<typeof drag>) => {
    const { rows, from, to, height } = state;
    rows.forEach((row, index) => {
      if (row === state.row) return;
      const shift =
        from < to && index > from && index <= to ? -height : from > to && index >= to && index < from ? height : 0;
      row.style.transition = slide;
      row.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };

  const onDown = (event: PointerEvent) => {
    const row = (event.target as HTMLElement | null)?.closest?.('[data-drag-row]') as HTMLElement | null;
    if (!row || !list.contains(row) || event.button !== 0 || drag) return;
    if (options.ignore && (event.target as HTMLElement).closest(options.ignore)) return;
    const rows = options.rows();
    const rects = rows.map((r) => r.getBoundingClientRect());
    const from = rows.indexOf(row);
    if (from < 0 || rows.length < 2) return;
    const height = rects[from]!.height + (rows[1] ? Math.max(0, rects[1]!.top - rects[0]!.bottom) : 0);
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

  const onMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const dy = event.clientY - drag.startY;
    if (!drag.live) {
      if (Math.abs(dy) < DRAG_START_PX) return;
      drag.live = true;
      drag.row.classList.add('is-dragging');
      drag.row.setPointerCapture?.(event.pointerId);
      drag.row.style.transition = 'none';
    }
    drag.row.style.transform = `translateY(${dy}px)`;
    const to = slotAt(drag.centres, drag.from, drag.centres[drag.from]! + dy);
    if (to !== drag.to) {
      drag.to = to;
      place(drag);
    }
  };

  const settle = (state: NonNullable<typeof drag>) => {
    // The dragged row glides to the slot it was dropped on; then the DOM takes the new order and every transform is cleared at once.
    const { row, rows, from, to } = state;
    const offset = state.centres[to]! - state.centres[from]!;
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
        for (const r of order) list.append(r);
        options.onOrder(order.map(options.idOf));
      }
      // One frame later the rows may animate again.
      frame(() => {
        for (const r of rows) r.style.transition = '';
      });
    };
    if (slide === 'none' || offset === 0) done();
    else {
      row.addEventListener('transitionend', done);
      setTimeout(() => {
        if (row.classList.contains('is-dragging')) done();
      }, DRAG_SLIDE_MS + 60);
    }
  };

  const onUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const state = drag;
    drag = null;
    if (!state.live) return;
    // The click that follows the release must not open the row.
    swallow = true;
    setTimeout(() => {
      swallow = false;
    }, 0);
    state.row.releasePointerCapture?.(event.pointerId);
    settle(state);
  };

  const onClick = (event: MouseEvent) => {
    if (!swallow) return;
    event.preventDefault();
    event.stopPropagation();
    swallow = false;
  };

  const onKey = (event: KeyboardEvent) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    const row = (event.target as HTMLElement | null)?.closest?.('[data-drag-row]') as HTMLElement | null;
    if (!row || !list.contains(row)) return;
    const rows = options.rows();
    const from = rows.indexOf(row);
    const to = from + (event.key === 'ArrowUp' ? -1 : 1);
    if (from < 0 || to < 0 || to >= rows.length) return;
    event.preventDefault();
    const order = moved(rows, from, to);
    // The neighbour swaps places with a slide: both rows start where they were and glide.
    const a = rows[from]!.getBoundingClientRect(),
      b = rows[to]!.getBoundingClientRect();
    for (const r of order) list.append(r);
    if (slide !== 'none') {
      rows[from]!.style.transition = 'none';
      rows[to]!.style.transition = 'none';
      rows[from]!.style.transform = `translateY(${a.top - b.top}px)`;
      rows[to]!.style.transform = `translateY(${b.top - a.top}px)`;
      frame(() => {
        for (const r of [rows[from]!, rows[to]!]) {
          r.style.transition = slide;
          r.style.transform = '';
        }
      });
    }
    (row.querySelector('button') ?? row).focus?.();
    options.onOrder(order.map(options.idOf));
  };

  list.addEventListener('pointerdown', onDown as EventListener);
  list.addEventListener('pointermove', onMove as EventListener);
  list.addEventListener('pointerup', onUp as EventListener);
  list.addEventListener('pointercancel', onUp as EventListener);
  list.addEventListener('click', onClick as EventListener, true);
  list.addEventListener('keydown', onKey as EventListener);
  return () => {
    list.removeEventListener('pointerdown', onDown as EventListener);
    list.removeEventListener('pointermove', onMove as EventListener);
    list.removeEventListener('pointerup', onUp as EventListener);
    list.removeEventListener('pointercancel', onUp as EventListener);
    list.removeEventListener('click', onClick as EventListener, true);
    list.removeEventListener('keydown', onKey as EventListener);
  };
}
