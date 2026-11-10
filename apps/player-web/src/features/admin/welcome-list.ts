import {
  WELCOME_LIMITS,
  evenWeights,
  welcomeProblems,
  type WelcomeLine,
} from '../../../../../packages/contracts/web-welcomes.ts';
import { dragOrder } from './ui/drag-order.ts';

/**
 * Part 24k-2: the 欢迎内容 list. One row per line: the words and a whole percent; add (the lines split evenly), delete, reorder
 * (drag, or Alt+↑ / Alt+↓), a live total that must read 100%. Items follow the 24i list pattern (a grip, the fields, 删除).
 * Rows are kept as records (no selector queries), so the list also runs on the small DOM model the component tests use.
 */
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const later = (work: () => void) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => requestAnimationFrame(work)) : work();
export const newLineId = () =>
  `w-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 12)}`;

export type WelcomeList = {
  node: HTMLElement;
  /** The lines as typed (not validated). */
  read: () => WelcomeLine[];
  /** Located problems of what is typed, [] when valid. */
  problems: () => ReturnType<typeof welcomeProblems>;
  setDisabled: (disabled: boolean) => void;
};

type Row = {
  id: string;
  row: HTMLElement;
  no: HTMLElement;
  text: HTMLTextAreaElement;
  weight: HTMLInputElement;
  del: HTMLButtonElement;
};

export function welcomeList(initial: readonly WelcomeLine[], onChange: () => void): WelcomeList {
  const root = node('div', 'wl');
  const list = node('div', 'wl-rows');
  list.setAttribute?.('role', 'list');
  const foot = node('div', 'wl-foot');
  const total = node('output', 'wl-total');
  total.setAttribute?.('aria-live', 'polite');
  const evenBtn = node('button', 'wl-even', '平均分配');
  evenBtn.type = 'button';
  const addBtn = node('button', 'wl-add', '＋ 添加一条');
  addBtn.type = 'button';
  const message = node('p', 'wl-problem');
  message.setAttribute?.('role', 'status');
  foot.append(total, evenBtn, addBtn);
  root.append(list, message, foot);

  let rows: Row[] = [];
  let locked = false;
  const read = (): WelcomeLine[] =>
    rows.map((r) => ({
      id: r.id,
      text: r.text.value,
      weight: r.weight.value === '' ? Number.NaN : Number(r.weight.value),
    }));
  const paint = () => {
    const lines = read();
    const sum = lines.reduce((n, l) => n + (Number.isFinite(l.weight) ? l.weight : 0), 0);
    total.textContent = `合计 ${sum}%`;
    total.dataset.state = sum === 100 ? 'ok' : 'off';
    const found = welcomeProblems(lines);
    message.textContent = found[0]?.message ?? '';
    message.dataset.state = found.length ? 'bad' : 'ok';
    rows.forEach((r, i) => {
      r.row.dataset.invalid = String(found.some((p) => p.line === i + 1));
      r.no.textContent = String(i + 1);
      r.del.disabled = locked || rows.length <= WELCOME_LIMITS.minLines;
    });
    addBtn.disabled = locked || rows.length >= WELCOME_LIMITS.maxLines;
    evenBtn.disabled = locked || rows.length < 2;
    addBtn.title = rows.length >= WELCOME_LIMITS.maxLines ? '最多 8 条' : '';
  };
  const changed = () => {
    paint();
    onChange();
  };
  const setWeights = (weights: number[]) => rows.forEach((r, i) => (r.weight.value = String(weights[i])));

  const make = (line: WelcomeLine, enter: boolean): Row => {
    const row = node('div', 'wl-row');
    row.setAttribute?.('role', 'listitem');
    row.dataset.id = line.id;
    row.dataset.dragRow = '';
    const grip = node('span', 'wl-grip', '⋮⋮');
    grip.setAttribute?.('aria-hidden', 'true');
    const no = node('span', 'wl-no');
    const text = node('textarea', 'wl-text');
    text.rows = 2;
    text.maxLength = WELCOME_LIMITS.text;
    text.value = line.text;
    text.placeholder = '欢迎词';
    text.setAttribute?.('aria-label', '欢迎词');
    const weightWrap = node('label', 'wl-weight-wrap');
    const weight = node('input', 'wl-weight');
    weight.type = 'number';
    weight.min = '1';
    weight.max = '100';
    weight.step = '1';
    weight.value = String(line.weight);
    weight.setAttribute?.('aria-label', '出现比例（%）');
    weightWrap.append(weight, node('span', 'wl-pct', '%'));
    const del = node('button', 'wl-del', '删除');
    del.type = 'button';
    row.append(grip, no, text, weightWrap, del);
    const record: Row = { id: line.id, row, no, text, weight, del };
    text.addEventListener('input', changed);
    weight.addEventListener('input', changed);
    del.addEventListener('click', () => {
      if (rows.length <= WELCOME_LIMITS.minLines) return;
      const freed = Number(weight.value) || 0;
      const remove = () => {
        if (!rows.includes(record)) return;
        rows = rows.filter((r) => r !== record);
        row.remove();
        // the freed percent goes to the first line left, so the total keeps reading 100 until it is changed on purpose
        const first = rows[0];
        if (first && freed > 0) first.weight.value = String(Math.min(100, (Number(first.weight.value) || 0) + freed));
        changed();
      };
      if (reduced() || typeof row.addEventListener !== 'function') return remove();
      row.className = 'wl-row is-leaving';
      row.addEventListener('transitionend', remove, { once: true });
      setTimeout(remove, 260);
    });
    if (enter) {
      row.className = 'wl-row is-entering';
      later(() => (row.className = 'wl-row'));
    }
    return record;
  };

  for (const line of initial) {
    const r = make(line, false);
    rows.push(r);
    list.append(r.row);
  }
  addBtn.addEventListener('click', () => {
    if (rows.length >= WELCOME_LIMITS.maxLines) return;
    const r = make({ id: newLineId(), text: '', weight: 1 }, true);
    rows.push(r);
    list.append(r.row);
    // adding lines splits the percent evenly: 3 lines are 34 / 33 / 33
    setWeights(evenWeights(rows.length));
    changed();
    r.text.focus?.();
  });
  evenBtn.addEventListener('click', () => {
    setWeights(evenWeights(rows.length));
    changed();
  });
  dragOrder(list, {
    rows: () => rows.map((r) => r.row),
    idOf: (row) => row.dataset.id!,
    onOrder: (ids) => {
      rows = ids.map((id) => rows.find((r) => r.id === id)!);
      changed();
    },
    ignore: 'textarea,input,button',
  });
  paint();
  return {
    node: root,
    read,
    problems: () => welcomeProblems(read()),
    setDisabled: (disabled) => {
      locked = disabled;
      for (const c of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>(
        'input,textarea,button',
      )) {
        c.dataset.locked = String(disabled);
        c.disabled = disabled;
      }
      if (!disabled) paint();
    },
  };
}
