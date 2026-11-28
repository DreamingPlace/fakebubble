import type { ExportAdminClient, ExportFile, ExportFormat, ExportKind } from '../../../services/export-admin-api.ts';
import { h } from '../../cocreation/h.ts';
import { dateField } from '../ui/date-field.ts';
import { hoverValue } from '../ui/hover-value.ts';
import { segmented } from '../ui/segmented.ts';

/**
 * Part 57: the one 「导出」 button of a page (top right of its title row) and the dialog it opens: 格式 (CSV / Excel), 内容 when the
 * page has more than one table to export, 范围 (a UTC+8 date range or 7 / 30 / 90 天) and the page's own filters. Nothing is
 * explained in text: the words are on hover (docs/ADMIN_COPY.md). The server builds each file; a table over 50,000 rows comes as
 * several files, which this dialog asks for one after the other and hands to the browser. Nothing is kept anywhere.
 */
export type ExportField = {
  label: string;
  /** Hover text for the label. */
  tip?: string;
  build: () => { node: HTMLElement; read: () => Record<string, unknown> };
};
export type ExportChoice = {
  id: string;
  label: string;
  kind: ExportKind;
  /** 'dates': 开始 / 结束 (UTC+8 days, either may be empty); 'days': 7 / 30 / 90 天 (as 总览 and 消耗表); 'none'. */
  range: 'dates' | 'days' | 'none';
  /** The page's own state that the export must respect (the filters it is showing). */
  filters?: () => Record<string, unknown>;
  fields?: readonly ExportField[];
  /** The tables of the workbook, in order: a CSV carries one of them (which one is asked for). */
  sheets?: readonly string[];
  /** The table a CSV carries unless the person picks another (an index into `sheets`). */
  sheet?: number;
  tip?: string;
};
export type ExportSave = (file: {
  filename: string;
  mime: string;
  encoding: 'utf8' | 'base64';
  content: string;
}) => void;

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
/** Hands one file to the browser. Nothing is uploaded and nothing is stored. */
export const saveFile: ExportSave = (file) => {
  const part = file.encoding === 'base64' ? bytesOf(file.content) : file.content;
  const url = URL.createObjectURL(new Blob([part as BlobPart], { type: `${file.mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', file.filename);
  document.body.append(link);
  link.click();
  link.remove();
  // (not at once: a large file is still being handed to the browser, and the name it is saved under is read from the link)
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

export const selectField = (
  label: string,
  options: ReadonlyArray<{ value: string; label: string }>,
  key: string,
  tip?: string,
): ExportField => ({
  label,
  ...(tip ? { tip } : {}),
  build: () => {
    const select = h(
      'select',
      { class: 'ex-input', attrs: { 'aria-label': label, 'data-ex': key } },
      ...options.map((o) => h('option', { text: o.label, attrs: { value: o.value } })),
    );
    return { node: select, read: () => (select.value === '' ? {} : { [key]: select.value }) };
  },
});
export const textField = (
  label: string,
  key: string,
  options: { placeholder?: string; tip?: string; list?: boolean } = {},
): ExportField => ({
  label,
  ...(options.tip ? { tip: options.tip } : {}),
  build: () => {
    const input = h('input', {
      class: 'ex-input',
      attrs: {
        type: 'text',
        autocomplete: 'off',
        'aria-label': label,
        'data-ex': key,
        ...(options.placeholder ? { placeholder: options.placeholder } : {}),
      },
    });
    return {
      node: input,
      read: () => {
        const text = input.value.trim();
        if (text === '') return {};
        return { [key]: options.list ? text.split(/[\s,，、]+/).filter(Boolean) : text };
      },
    };
  },
});

export function exportButton(deps: {
  parent: HTMLElement;
  api: Pick<ExportAdminClient, 'file'> | undefined;
  /** Read when the dialog opens, so it reflects the page as it is then (its filters, who is signed in). */
  choices: () => readonly ExportChoice[];
  run: (task: () => Promise<void>) => Promise<unknown>;
  status: (text: string) => void;
  save?: ExportSave;
  now?: () => number;
}): HTMLButtonElement {
  const save = deps.save ?? saveFile;
  const button = h('button', {
    class: 'page-export',
    text: '导出',
    attrs: { type: 'button', 'aria-haspopup': 'dialog', 'aria-label': '导出' },
  });
  // (viewport: the button sits at the right edge of the title row, so the bubble must open inside the window)
  hoverValue(button, '把这一页的数据导出为 CSV 或 Excel 文件。', true);
  if (!deps.api) button.hidden = true;
  button.addEventListener('click', () => open());

  function open() {
    const opener = document.activeElement as HTMLElement | null;
    const options = deps.choices();
    if (options.length === 0) return;
    let choice = options[0]!;
    let format: ExportFormat = 'xlsx';
    let sheet = choice.sheet ?? 0;
    let days: 7 | 30 | 90 = 30;
    const from = dateField({ label: '开始日期', now: deps.now ?? (() => Date.now()) });
    const to = dateField({ label: '结束日期', now: deps.now ?? (() => Date.now()) });
    let built: Array<{ read: () => Record<string, unknown> }> = [];

    const backdrop = h('div', { class: 'admin-backdrop' });
    const body = h('div', { class: 'ex-body' });
    const go = h('button', { class: 'admin-primary', text: '导出', attrs: { type: 'button' } });
    const cancel = h('button', { class: 'admin-secondary', text: '取消', attrs: { type: 'button' } });
    const dialog = h(
      'div',
      { class: 'admin-dialog ex-dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '导出' } },
      h('h3', { text: '导出' }),
      body,
      h('div', { class: 'admin-dialog-actions' }, cancel, go),
    );
    let busy = false;
    const close = () => {
      if (busy) return;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      dialog.remove();
      opener?.focus?.();
    };
    const onKey = (event: Event) => {
      if ((event as KeyboardEvent).key === 'Escape') close();
    };
    const row = (label: string, control: Node, tip?: string) => {
      const name = h('span', { class: 'ex-label', text: label });
      if (tip) hoverValue(name, tip);
      return h('div', { class: 'ex-row' }, name, control);
    };

    function paint() {
      const rows: HTMLElement[] = [];
      if (options.length > 1) {
        const content = segmented(
          '内容',
          options.map((c) => ({ id: c.id, label: c.label })),
          choice.id,
          (id) => {
            choice = options.find((c) => c.id === id)!;
            sheet = choice.sheet ?? 0;
            paint();
          },
        );
        rows.push(row('内容', content.root));
      }
      const formats = segmented<ExportFormat>(
        '格式',
        [
          { id: 'xlsx', label: 'Excel（.xlsx）' },
          { id: 'csv', label: 'CSV' },
        ],
        format,
        (id) => {
          format = id;
          paint();
        },
      );
      rows.push(
        row('格式', formats.root, 'Excel 把全部表格放在一个文件里；CSV 一次一张表，用 Excel 打开中文也不会乱码。'),
      );
      if (format === 'csv' && choice.sheets && choice.sheets.length > 1) {
        const tables = segmented(
          '表格',
          choice.sheets.map((name, i) => ({ id: String(i), label: name })),
          String(Math.min(sheet, choice.sheets.length - 1)),
          (id) => {
            sheet = Number(id);
          },
        );
        rows.push(row('表格', tables.root));
      }
      if (choice.range === 'dates')
        rows.push(
          row(
            '范围',
            h(
              'span',
              { class: 'ex-range' },
              from.root,
              h('span', { class: 'ex-to', text: '至' }),
              to.root,
              h('span', { class: 'ex-zone', text: 'UTC+8' }),
            ),
            '按北京时间的日期；不填就是不限。',
          ),
        );
      if (choice.range === 'days') {
        const span = segmented<'7' | '30' | '90'>(
          '范围',
          [
            { id: '7', label: '7 天' },
            { id: '30', label: '30 天' },
            { id: '90', label: '90 天' },
          ],
          String(days) as '7' | '30' | '90',
          (id) => {
            days = Number(id) as 7 | 30 | 90;
          },
        );
        rows.push(row('范围', span.root, '到今天为止（UTC 日期）。'));
      }
      built = [];
      for (const field of choice.fields ?? []) {
        const made = field.build();
        built.push(made);
        rows.push(row(field.label, made.node, field.tip));
      }
      body.replaceChildren(...rows);
    }
    paint();

    cancel.addEventListener('click', close);
    backdrop.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    go.addEventListener('click', async () => {
      if (busy) return;
      if (choice.range === 'dates' && (from.invalid || to.invalid)) {
        deps.status(from.invalid ? from.problem : to.problem);
        return;
      }
      const filters: Record<string, unknown> = { ...(choice.filters?.() ?? {}) };
      if (choice.range === 'dates') {
        if (from.value) filters.from = from.value;
        if (to.value) filters.to = to.value;
      }
      if (choice.range === 'days') filters.range = days;
      for (const made of built) Object.assign(filters, made.read());
      busy = true;
      go.disabled = true;
      cancel.disabled = true;
      let done = false;
      await deps.run(async () => {
        let rows = 0;
        let parts = 1;
        for (let part = 1; part <= parts; part++) {
          go.textContent = parts > 1 ? `导出中 ${part} / ${parts}` : '导出中…';
          const file: ExportFile = await deps.api!.file({ kind: choice.kind, format, part, sheet, filters });
          parts = file.parts;
          rows += file.rows;
          save(file);
        }
        done = true;
        deps.status(
          parts > 1
            ? `已导出 ${rows.toLocaleString('en-US')} 行，分成 ${parts} 个文件。`
            : `已导出 ${rows.toLocaleString('en-US')} 行。`,
        );
      });
      busy = false;
      go.disabled = false;
      cancel.disabled = false;
      go.textContent = '导出';
      if (done) close();
    });
    deps.parent.append(backdrop, dialog);
    (body.querySelector('select, input, button') as HTMLElement | null)?.focus?.();
  }
  return button;
}
export type MakeExport = (choices: () => readonly ExportChoice[]) => HTMLButtonElement;
