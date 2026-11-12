import { parseColour } from '../brand/character-colour.ts';
import { skinFor, type Mode } from '../brand/palette-skin.ts';
import { dragOrder } from './ui/drag-order.ts';
import { dragHandle, liveRegion, movedSentence, removeButton } from './ui/item-controls.ts';

/**
 * Part 24k-2: the colours of a character as a list: one 主 (the 主色 above, mirrored here) and then 点缀 in order, each a hex and a
 * name. At most 1 + 4 are stored; the player uses the 主 and the first 2 点缀. A small chip previews main / glow / accents as the
 * player will see them, at night and by day. Reorder by dragging the handle (or Alt+↑ / Alt+↓ on a focused row); one × removes a row. Rows are records (no selector queries) so the list runs on the component tests' DOM.
 */
export const PALETTE_MAX = 5;
export type PaletteEntry = { hex: string; name: string; role: 'main' | 'accent' };
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const later = (work: () => void) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => requestAnimationFrame(work)) : work();

export function previewChip(main: string | null, accents: readonly string[]) {
  const chip = node('div', 'pl-chip');
  chip.setAttribute?.('role', 'img');
  if (!main) {
    chip.dataset.state = 'empty';
    chip.setAttribute?.('aria-label', '未设置主色');
    return chip;
  }
  const names = ['主', '光', '点缀一', '点缀二'];
  for (const mode of ['night', 'day'] as Mode[]) {
    const skin = skinFor(main, accents, mode);
    const strip = node('div', 'pl-strip');
    strip.dataset.mode = mode;
    strip.append(node('b', 'pl-mode', mode === 'night' ? '夜' : '昼'));
    [skin.main, skin.glow, skin.accents[0], skin.accents[1]].forEach((colour, i) => {
      const dot = node('i', 'pl-dot');
      dot.style?.setProperty('--dot', colour);
      dot.title = `${names[i]} ${colour}`;
      strip.append(dot);
    });
    chip.append(strip);
  }
  chip.setAttribute?.('aria-label', '玩家会看到的 主 / 光 / 点缀，夜间和白天');
  return chip;
}

export type PaletteList = {
  node: HTMLElement;
  /** The stored palette: the 主 (when there is one) and then the 点缀, or null when there is no colour at all. */
  read: () => PaletteEntry[] | null;
  /** The main colour changed above: repaint the 主 row and the chip. */
  refresh: () => void;
  setDisabled: (disabled: boolean) => void;
};

type Row = {
  id: string;
  row: HTMLElement;
  tag: HTMLElement;
  swatch: HTMLElement;
  hex: HTMLInputElement;
  picker: HTMLInputElement;
  name: HTMLInputElement;
};

export function paletteList(
  initial: readonly PaletteEntry[] | undefined,
  /** The 主色 as typed in the colour field above ('' when none, null when it does not parse). */
  mainHex: () => string | null,
  onChange: () => void,
): PaletteList {
  const root = node('div', 'pl');
  const head = node('div', 'pl-head');
  const hint = node('span', 'pl-hint', '规则');
  // A hover tip, not a sentence (a plain title: this list also runs on the component tests' small DOM, which has no bubble).
  hint.title = '主 ＋ 最多 4 个点缀；玩家用主和前 2 个点缀';
  head.append(node('strong', undefined, '色板'), hint);
  const mainRow = node('div', 'pl-row pl-main');
  const mainSwatch = node('i', 'pl-swatch');
  const mainText = node('output', 'pl-hex');
  const mainName = node('input', 'pl-name');
  mainName.type = 'text';
  mainName.maxLength = 24;
  mainName.placeholder = '名称（可选）';
  mainName.setAttribute?.('aria-label', '主色名称');
  mainName.value = initial?.find((e) => e.role === 'main')?.name ?? '';
  mainRow.append(node('span', 'pl-spacer'), node('span', 'pl-tag', '主'), mainSwatch, mainText, mainName);
  const list = node('div', 'pl-rows');
  const foot = node('div', 'pl-foot');
  const add = node('button', 'pl-add', '＋ 添加点缀');
  add.type = 'button';
  const chipHost = node('div', 'pl-chip-host');
  foot.append(add);
  const live = liveRegion();
  root.append(head, mainRow, list, foot, chipHost, live.node);

  let rows: Row[] = [];
  let rowCounter = 0;
  const parsed = (r: Row) => (r.hex.value.trim() === '' ? '' : parseColour(r.hex.value));
  const refresh = () => {
    const main = mainHex();
    mainText.textContent = main === null ? '颜色格式不对' : main === '' ? '未设置（见上方主色）' : main;
    mainSwatch.style?.setProperty('--dot', main || 'transparent');
    mainRow.dataset.state = main === null ? 'invalid' : main === '' ? 'empty' : 'ok';
    add.disabled = rows.length >= PALETTE_MAX - 1;
    rows.forEach((r, i) => {
      const p = parsed(r);
      r.hex.setAttribute?.('aria-invalid', String(p === null));
      r.swatch.style?.setProperty('--dot', p || 'transparent');
      r.tag.textContent = i < 2 ? `点缀${i + 1}` : `点缀${i + 1}·备`;
      r.row.dataset.used = String(i < 2);
    });
    chipHost.replaceChildren(
      previewChip(
        main || null,
        rows
          .map(parsed)
          .filter((hex): hex is string => !!hex)
          .slice(0, 2),
      ),
    );
  };
  const changed = () => {
    refresh();
    onChange();
  };
  const make = (entry: { hex: string; name: string }, enter: boolean): Row => {
    const row = node('div', 'pl-row');
    const tag = node('span', 'pl-tag');
    const swatch = node('i', 'pl-swatch');
    const hex = node('input', 'pl-hex-in');
    hex.type = 'text';
    hex.maxLength = 40;
    hex.placeholder = '#RRGGBB';
    hex.autocomplete = 'off';
    hex.value = entry.hex;
    hex.setAttribute?.('aria-label', '点缀色值');
    const picker = node('input', 'pl-picker');
    picker.type = 'color';
    picker.value = parseColour(entry.hex)?.toLowerCase() ?? '#ddd8f0';
    picker.setAttribute?.('aria-label', '取色');
    const name = node('input', 'pl-name');
    name.type = 'text';
    name.maxLength = 24;
    name.placeholder = '名称（可选）';
    name.value = entry.name;
    name.setAttribute?.('aria-label', '点缀名称');
    const grip = dragHandle('点缀色', 'ad-handle pl-grip');
    const del = removeButton('删除这个点缀色', 'ad-remove pl-del');
    row.dataset.dragRow = '';
    row.dataset.id = `pl-${++rowCounter}`;
    row.append(grip, tag, swatch, hex, picker, name, del);
    const record: Row = { id: row.dataset.id, row, tag, swatch, hex, picker, name };
    hex.addEventListener('input', () => {
      const p = parseColour(hex.value);
      if (p) picker.value = p.toLowerCase();
      changed();
    });
    picker.addEventListener('input', () => {
      hex.value = picker.value.toUpperCase();
      changed();
    });
    name.addEventListener('input', changed);
    del.addEventListener('click', () => {
      const remove = () => {
        if (!rows.includes(record)) return;
        rows = rows.filter((r) => r !== record);
        row.remove();
        changed();
      };
      if (reduced() || typeof row.addEventListener !== 'function') return remove();
      row.className = 'pl-row is-leaving';
      row.addEventListener('transitionend', remove, { once: true });
      setTimeout(remove, 260);
    });
    if (enter) {
      row.className = 'pl-row is-entering';
      later(() => (row.className = 'pl-row'));
    }
    return record;
  };
  for (const entry of (initial ?? []).filter((e) => e.role === 'accent').slice(0, PALETTE_MAX - 1)) {
    const r = make(entry, false);
    rows.push(r);
    list.append(r.row);
  }
  add.addEventListener('click', () => {
    if (rows.length >= PALETTE_MAX - 1) return;
    const r = make({ hex: '', name: '' }, true);
    rows.push(r);
    list.append(r.row);
    changed();
    r.hex.focus?.();
  });
  dragOrder(list, {
    rows: () => rows.map((r) => r.row),
    idOf: (row) => row.dataset.id!,
    onOrder: (ids) => {
      rows = ids.map((id) => rows.find((r) => r.id === id)!);
      changed();
    },
    handle: '.ad-handle',
    announce: (_row, to, total) => live.say(movedSentence('点缀色', to, total)),
  });
  mainName.addEventListener('input', onChange);
  refresh();
  return {
    node: root,
    refresh,
    read: () => {
      const main = mainHex();
      if (main === null) throw new Error('PALETTE_COLOUR_INVALID');
      const accents: PaletteEntry[] = [];
      for (const r of rows) {
        if (r.hex.value.trim() === '') continue;
        const hex = parseColour(r.hex.value);
        if (!hex) throw new Error('PALETTE_COLOUR_INVALID');
        accents.push({ hex, name: r.name.value.trim(), role: 'accent' });
      }
      const out: PaletteEntry[] = [
        ...(main ? [{ hex: main, name: mainName.value.trim(), role: 'main' as const }] : []),
        ...accents,
      ];
      return out.length ? out : null;
    },
    setDisabled: (disabled) => {
      for (const c of root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) {
        c.dataset.locked = String(disabled);
        c.disabled = disabled;
      }
      if (!disabled) refresh();
    },
  };
}
