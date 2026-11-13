import { h } from '../../cocreation/h.ts';

/**
 * Part 24b-7d: the console's one date field. It replaces every native date input. The admin types or picks YYYY-MM-DD; 「UTC」 sits
 * beside it where the value is a UTC date; a small calendar opens below the field (a popover, not a dialog) with keyboard support;
 * it validates as you type with the shared sentence style; quick picks (7 天 / 30 天 / 90 天 / 不限) where they fit.
 *
 * The value is the same string the native input gave (YYYY-MM-DD, or '' when empty), so every handler that read it, and
 * everything sent to the server, is byte-identical for the same chosen date. `value` is read from the text each time (a typed or
 * set value is never cached), and it is '' while the text is not a real date (`invalid` says so).
 */
const DAY_MS = 86_400_000;
export const DATE_PROBLEM = '日期格式不对，请按 2026-01-31 这样填写，并且要是真实存在的日期。';
const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type DateParse = { ok: true; value: string } | { ok: false };
/** A real calendar date in YYYY-MM-DD, nothing else (2026-02-30 is refused). */
export function parseDate(text: string): DateParse {
  const match = SHAPE.exec(text.trim());
  if (!match) return { ok: false };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day)
    return { ok: false };
  return { ok: true, value: text.trim() };
}
export const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);
/** Today (UTC) plus N days. */
export const dayFromToday = (days: number, now = Date.now()) => isoDay(Date.UTC(...ymd(isoDay(now))) + days * DAY_MS);
const ymd = (day: string): [number, number, number] => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return [y, m - 1, d];
};
/** The weeks of a month, Monday first; null pads the edges. */
export function monthGrid(year: number, month: number): (string | null)[][] {
  const first = new Date(Date.UTC(year, month, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: days }, (_, i) => isoDay(Date.UTC(year, month, i + 1))),
  ];
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export type QuickPick = { label: string; days: number | null };
export type DateField = {
  root: HTMLElement;
  /** The visible text box (the one that carries the id and the accessible name). */
  input: HTMLInputElement;
  /** YYYY-MM-DD, or '' when empty or not a real date. */
  value: string;
  /** Text was typed and it is not a real date. */
  readonly invalid: boolean;
  /** The sentence for the current problem, '' when none. */
  readonly problem: string;
  disabled: boolean;
};

export function dateField(options: {
  id?: string;
  label: string;
  /** The value is a UTC date: 「UTC」 sits beside the field. */
  utc?: boolean;
  quickPicks?: readonly QuickPick[];
  value?: string;
  now?: () => number;
}): DateField {
  const now = options.now ?? (() => Date.now());
  const input = h('input', {
    class: 'admin-date-input',
    attrs: {
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      maxlength: '10',
      placeholder: 'YYYY-MM-DD',
      'aria-label': options.label,
      'data-w': 's',
      ...(options.id ? { id: options.id } : {}),
    },
  });
  input.value = options.value ?? '';
  const toggle = h('button', {
    class: 'admin-date-toggle',
    text: '日历',
    attrs: {
      type: 'button',
      'aria-haspopup': 'true',
      'aria-expanded': 'false',
      'aria-label': `${options.label}：打开日历`,
    },
  });
  const say = h('span', { class: 'admin-date-problem', attrs: { role: 'status' } });
  say.hidden = true;
  const field = h(
    'span',
    { class: 'admin-date-box' },
    input,
    options.utc ? h('span', { class: 'admin-date-utc', text: 'UTC' }) : null,
    toggle,
  );
  const picks = options.quickPicks?.length
    ? h(
        'span',
        { class: 'admin-date-picks' },
        ...options.quickPicks.map((pick) => {
          const button = h('button', {
            class: 'admin-date-pick',
            text: pick.label,
            attrs: { type: 'button' },
          });
          button.addEventListener('click', () => {
            set(pick.days === null ? '' : dayFromToday(pick.days, now()));
            input.focus?.();
          });
          return button;
        }),
      )
    : null;
  const root = h('span', { class: 'admin-date' }, field, picks, say);

  const text = () => input.value.trim();
  const problem = () => (text() !== '' && !parseDate(text()).ok ? DATE_PROBLEM : '');
  const refresh = (final: boolean) => {
    // While typing a half-written date is not an error yet; a full-length one (or leaving the field) is judged.
    const bad = problem() !== '' && (final || text().length >= 10);
    input.setAttribute?.('aria-invalid', bad ? 'true' : 'false');
    input.setCustomValidity?.(problem());
    say.textContent = bad ? DATE_PROBLEM : '';
    say.hidden = !bad;
  };
  const set = (value: string) => {
    input.value = value;
    refresh(true);
    input.dispatchEvent?.(new Event('input', { bubbles: true }));
    input.dispatchEvent?.(new Event('change', { bubbles: true }));
  };
  input.addEventListener('input', () => refresh(false));
  input.addEventListener('blur', () => refresh(true));

  // ---- the calendar popover (built only when opened) --------------------------------------------------------------------
  let pop: HTMLElement | null = null;
  let shown = { year: 0, month: 0 };
  let focusDay = '';
  const close = (returnFocus: boolean) => {
    pop?.remove();
    pop = null;
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener?.('pointerdown', outside, true);
    if (returnFocus) toggle.focus?.();
  };
  const outside = (event: Event) => {
    if (pop && !root.contains(event.target as Node)) close(false);
  };
  const dayButtons = () => [...(pop?.querySelectorAll?.('.admin-date-day') ?? [])] as HTMLButtonElement[];
  const move = (day: string, deltaDays: number) => {
    const next = isoDay(Date.UTC(...ymd(day)) + deltaDays * DAY_MS);
    const [y, m] = ymd(next);
    focusDay = next;
    shown = { year: y, month: m };
    paintPop();
  };
  const shiftMonth = (delta: number) => {
    const target = new Date(Date.UTC(shown.year, shown.month + delta, 1));
    shown = { year: target.getUTCFullYear(), month: target.getUTCMonth() };
    focusDay = isoDay(Date.UTC(shown.year, shown.month, 1));
    paintPop();
  };
  const paintPop = () => {
    if (!pop) return;
    const chosen = parseDate(text());
    const today = isoDay(now());
    const prev = h('button', { class: 'admin-date-nav', text: '‹', attrs: { type: 'button', 'aria-label': '上个月' } });
    const next = h('button', { class: 'admin-date-nav', text: '›', attrs: { type: 'button', 'aria-label': '下个月' } });
    prev.addEventListener('click', () => shiftMonth(-1));
    next.addEventListener('click', () => shiftMonth(1));
    const weeks = monthGrid(shown.year, shown.month);
    const inMonth = weeks.flat().filter((d): d is string => d !== null);
    if (!inMonth.includes(focusDay))
      focusDay = chosen.ok && inMonth.includes(chosen.value) ? chosen.value : inMonth[0]!;
    const body = h(
      'div',
      { class: 'admin-date-grid', attrs: { role: 'grid', 'aria-label': `${shown.year} 年 ${shown.month + 1} 月` } },
      ...['一', '二', '三', '四', '五', '六', '日'].map((d) => h('span', { class: 'admin-date-wd', text: d })),
      ...weeks.flat().map((day) => {
        if (day === null) return h('span', { class: 'admin-date-gap' });
        const button = h('button', {
          class: `admin-date-day${chosen.ok && chosen.value === day ? ' is-chosen' : ''}${day === today ? ' is-today' : ''}`,
          text: String(Number(day.slice(8))),
          attrs: {
            type: 'button',
            'data-day': day,
            tabindex: day === focusDay ? '0' : '-1',
            'aria-label': day,
            ...(chosen.ok && chosen.value === day ? { 'aria-pressed': 'true' } : {}),
          },
        });
        button.addEventListener('click', () => {
          set(day);
          close(true);
        });
        button.addEventListener('keydown', (event) => {
          const key = (event as KeyboardEvent).key;
          const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
          if (key in step) {
            event.preventDefault();
            move(day, step[key]!);
          } else if (key === 'PageUp' || key === 'PageDown') {
            event.preventDefault();
            shiftMonth(key === 'PageUp' ? -1 : 1);
          } else if (key === 'Home' || key === 'End') {
            event.preventDefault();
            focusDay = key === 'Home' ? inMonth[0]! : inMonth.at(-1)!;
            paintPop();
          }
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(key))
            setTimeout(
              () =>
                dayButtons()
                  .find((b) => b.getAttribute('data-day') === focusDay)
                  ?.focus?.(),
              0,
            );
        });
        return button;
      }),
    );
    pop.replaceChildren(
      h(
        'div',
        { class: 'admin-date-head' },
        prev,
        h('strong', { text: `${shown.year} 年 ${shown.month + 1} 月` }),
        next,
      ),
      body,
    );
  };
  const open = () => {
    if (pop) return;
    const chosen = parseDate(text());
    const [y, m] = ymd(chosen.ok ? chosen.value : isoDay(now()));
    shown = { year: y, month: m };
    focusDay = chosen.ok ? chosen.value : isoDay(now());
    pop = h('div', {
      class: 'admin-date-pop',
      attrs: { role: 'group', 'aria-label': `${options.label}：日历（Esc 关闭，方向键移动）` },
    });
    pop.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') {
        event.stopPropagation();
        close(true);
      }
    });
    root.append(pop);
    toggle.setAttribute('aria-expanded', 'true');
    document.addEventListener?.('pointerdown', outside, true);
    paintPop();
    setTimeout(
      () =>
        dayButtons()
          .find((b) => b.getAttribute('data-day') === focusDay)
          ?.focus?.(),
      0,
    );
  };
  toggle.addEventListener('click', () => (pop ? close(true) : open()));
  input.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'ArrowDown' && (event as KeyboardEvent).altKey) {
      event.preventDefault();
      open();
    }
  });
  refresh(false);

  return {
    root,
    input,
    get value() {
      const parsed = parseDate(text());
      return parsed.ok ? parsed.value : '';
    },
    set value(next: string) {
      input.value = next;
      refresh(false);
    },
    get invalid() {
      return problem() !== '';
    },
    get problem() {
      return problem();
    },
    get disabled() {
      return input.disabled;
    },
    set disabled(on: boolean) {
      input.disabled = on;
      toggle.disabled = on;
    },
  };
}
